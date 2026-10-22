import {
  BrokerError, ChainIdSchema, CountSchema, GENESIS_PREV_HASH, ReceiptEventSchema,
  TimestampSchema, canonicalJson, checkpointHashInput, receiptHashInput, sha256Hex,
} from '../../contracts/index.js';
import type {
  AuditSigner, ChainId, Checkpoint, CheckpointLog as CheckpointLogPort,
  CheckpointPreimage, CheckpointVerification, Ed25519PublicKey, ReceiptEvent,
  Store, StoreTransaction, Timestamp,
} from '../../contracts/index.js';
import { authenticateCheckpoint, verificationKey, verifyHash } from './verification.js';

function result(chainId: ChainId, checked: number, reason: string | null = null, firstInvalidSeq: number | null = null): CheckpointVerification {
  return { valid: reason === null, chainId, checked, firstInvalidSeq, reason };
}

/** Empty input has no chain ID: report owner/checked=0/firstInvalidSeq=null.
 * Verification requires a complete, single-chain checkpoint history from its
 * first checkpoint (not an arbitrary list page). No local list proves freshness. */
export function verifyCheckpoints(checkpoints: readonly Checkpoint[], pinned: Ed25519PublicKey): CheckpointVerification {
  const chainId = ChainIdSchema.safeParse(checkpoints[0]?.chainId).data ?? 'owner';
  if (checkpoints.length === 0) return result(chainId, 0, 'No checkpoints');
  let checked = 0;
  let invalidSeq: number | null = null;
  try {
    const key = verificationKey(pinned);
    let previous: Checkpoint | null = null;
    for (const input of checkpoints) {
      invalidSeq = CountSchema.min(1).safeParse(input?.seq).data ?? null;
      const checkpoint = authenticateCheckpoint(input, pinned, key);
      if (checkpoint.chainId !== chainId) return result(chainId, checked, 'Checkpoint chain mismatch', invalidSeq);
      if (checkpoint.previousCheckpointHash !== (previous?.hash ?? null)) {
        return result(chainId, checked, 'Checkpoint linkage mismatch', invalidSeq);
      }
      if (checkpoint.seq <= (previous?.seq ?? 0)) return result(chainId, checked, 'Checkpoint sequence not increasing', invalidSeq);
      previous = checkpoint;
      checked++;
    }
    return result(chainId, checked);
  } catch {
    return result(chainId, checked, 'Invalid checkpoint or pinned key', invalidSeq);
  }
}

export class CheckpointLog implements CheckpointLogPort {
  constructor(private readonly store: Store, private readonly signer: AuditSigner) {}

  /** The caller supplies Clock.now() and owns the surrounding transaction. A
   * failure must propagate out of that callback so every related write rolls back. */
  create(tx: StoreTransaction, chainId: ChainId, at: Timestamp): Checkpoint {
    try {
      ChainIdSchema.parse(chainId);
      TimestampSchema.parse(at);
      const head = tx.getReceiptHead(chainId);
      const previous = tx.getCheckpointHead(chainId);
      if (!head || head.chainId !== chainId || head.seq <= (previous?.seq ?? 0)) throw new Error('Empty or duplicate head');
      const key = verificationKey(this.signer.publicKey);
      if (previous) {
        authenticateCheckpoint(previous, this.signer.publicKey, key);
        if (previous.chainId !== chainId) throw new Error('Checkpoint chain mismatch');
      }
      const preimage: CheckpointPreimage = {
        version: 1, chainId, seq: head.seq, headHash: head.hash,
        previousCheckpointHash: previous?.hash ?? null, at, auditPublicKey: this.signer.publicKey,
      };
      const hash = sha256Hex(checkpointHashInput(preimage));
      const signature = Buffer.from(this.signer.signHash(Buffer.from(hash, 'hex'))).toString('base64');
      const checkpoint = authenticateCheckpoint({ ...preimage, hash, signature }, this.signer.publicKey, key);
      // Store performs CAS on previousCheckpointHash, increasing seq, and the
      // receipt hash at seq, atomically in this exact transaction.
      tx.insertCheckpoint(checkpoint);
      return checkpoint;
    } catch {
      throw new BrokerError('AUDIT_UNAVAILABLE');
    }
  }

  list(chainId: ChainId, afterSeq: number, limit: number): Checkpoint[] {
    ChainIdSchema.parse(chainId);
    CountSchema.parse(afterSeq);
    CountSchema.min(1).max(1000).parse(limit);
    return this.store.read((view) => view.listCheckpoints(chainId, afterSeq, limit));
  }

  verify(checkpoints: readonly Checkpoint[], trustedAuditPublicKey: Ed25519PublicKey): CheckpointVerification {
    return verifyCheckpoints(checkpoints, trustedAuditPublicKey);
  }
}

/** Internal/owner export: all pages share one read snapshot. Authorization is
 * the caller's responsibility; do not expose arbitrary chain IDs to agents. */
export function exportReceiptChain(store: Store, chainId: ChainId): ReceiptEvent[] {
  ChainIdSchema.parse(chainId);
  return store.read((view) => {
    const receipts: ReceiptEvent[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = view.listReceipts(chainId, afterSeq, 1000);
      if (page.length === 0) return receipts;
      for (const receipt of page) {
        if (receipt.chainId !== chainId || receipt.seq <= afterSeq) throw new BrokerError('AUDIT_UNAVAILABLE');
        receipts.push(receipt);
        afterSeq = receipt.seq;
      }
    }
  });
}

/** Verify a full genesis-to-head export against an INDEPENDENTLY retained
 * checkpoint and pinned public key. The retained checkpoint need not be the
 * first checkpoint; its earlier checkpoint history need not be retained.
 *
 * Success proves the chain includes the retained prefix. Extensions are allowed;
 * no verifier can detect deletion of receipts newer than the retained checkpoint.
 * checked counts verified receipts; firstInvalidSeq identifies a bad/missing
 * receipt (or the retained checkpoint seq when its authentication fails). */
export function verifyExportedChain(
  receipts: readonly ReceiptEvent[], retained: Checkpoint, pinned: Ed25519PublicKey,
): CheckpointVerification {
  const chainId = ChainIdSchema.safeParse(retained?.chainId).data ?? 'owner';
  let checked = 0;
  let invalidSeq = CountSchema.min(1).safeParse(retained?.seq).data ?? null;
  try {
    const key = verificationKey(pinned);
    const checkpoint = authenticateCheckpoint(retained, pinned, key);
    let previousHash = GENESIS_PREV_HASH;
    let reachedCheckpoint = false;
    for (const input of receipts) {
      invalidSeq = checked + 1;
      canonicalJson(input);
      const receipt = ReceiptEventSchema.parse(input);
      if (receipt.chainId !== chainId || receipt.seq !== checked + 1 || receipt.prevHash !== previousHash) {
        return result(chainId, checked, 'Receipt chain linkage mismatch', invalidSeq);
      }
      const { hash, signature, ...preimage } = receipt;
      if (sha256Hex(receiptHashInput(preimage)) !== hash || !verifyHash(hash, signature, key)) {
        return result(chainId, checked, 'Receipt hash or signature invalid', invalidSeq);
      }
      if (receipt.seq === checkpoint.seq) {
        if (receipt.hash !== checkpoint.headHash) return result(chainId, checked, 'Retained checkpoint head mismatch', invalidSeq);
        reachedCheckpoint = true;
      }
      previousHash = receipt.hash;
      checked++;
    }
    if (!reachedCheckpoint) return result(chainId, checked, 'History ends before retained checkpoint', checked + 1);
    return result(chainId, checked);
  } catch {
    return result(chainId, checked, 'Invalid export, checkpoint or pinned key', invalidSeq);
  }
}
