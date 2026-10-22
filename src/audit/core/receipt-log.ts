import {
  AgentPrincipalSchema, AppendReceiptSchema, BrokerError, ChainIdSchema, CountSchema,
  GENESIS_PREV_HASH, ReceiptEventSchema, canonicalJson, receiptHashInput, sha256Hex,
} from '../../contracts/index.js';
import type {
  AgentPrincipal, AppendReceipt, AuditSigner, ChainId, ReceiptEvent,
  ReceiptLog as ReceiptLogPort, ReceiptVerification, Store, StoreTransaction,
} from '../../contracts/index.js';
import { decodeAuditPublicKey } from './crypto.js';
import { receiptProblem, verificationResult, verifyReceipt, verifyReceiptChain } from './verification.js';

/** Trusted in-process port, not an authentication boundary. Use forAgent with an
 * authenticated principal before handing reads/verification to agent operations.
 */
export class ReceiptLog implements ReceiptLogPort {
  private readonly publicKey: string;
  private readonly ownChain: ChainId | null;
  constructor(private readonly store: Store, private readonly signer: AuditSigner, principal?: AgentPrincipal) {
    try {
      this.publicKey = signer.publicKey;
      decodeAuditPublicKey(this.publicKey);
    } catch { throw new BrokerError('AUDIT_UNAVAILABLE'); }
    this.ownChain = principal === undefined ? null : `agent:${AgentPrincipalSchema.parse(principal).agentId}`;
  }

  /** Principal must already have been authenticated. A scoped log cannot re-scope. */
  forAgent(principal: AgentPrincipal): ReceiptLog {
    const parsed = AgentPrincipalSchema.parse(principal);
    this.authorize(`agent:${parsed.agentId}`);
    return new ReceiptLog(this.store, this.signer, parsed);
  }

  auditPublicKey(): string { return this.publicKey; }

  private authorize(chainId: ChainId): void {
    // Reject before touching storage, including for nonexistent/cross-agent chains.
    if (this.ownChain !== null && chainId !== this.ownChain) throw new BrokerError('FORBIDDEN');
    if (!ChainIdSchema.safeParse(chainId).success) throw new BrokerError('FORBIDDEN');
  }

  append(tx: StoreTransaction, event: AppendReceipt): ReceiptEvent {
    this.authorize(event.chainId);
    try {
      canonicalJson(event);
      const input = AppendReceiptSchema.parse(event);
      const head = tx.getReceiptHead(input.chainId);
      if (head !== null && (head.chainId !== input.chainId || receiptProblem(head, decodeAuditPublicKey(this.publicKey)) !== null)) {
        throw new Error('Invalid receipt head');
      }
      const preimage = { ...input, seq: (head?.seq ?? 0) + 1, prevHash: head?.hash ?? GENESIS_PREV_HASH };
      const hash = sha256Hex(receiptHashInput(preimage));
      const signatureBytes = this.signer.signHash(Buffer.from(hash, 'hex'));
      if (!(signatureBytes instanceof Uint8Array) || signatureBytes.byteLength !== 64) throw new Error('Invalid signer output');
      const receipt = ReceiptEventSchema.parse({ ...preimage, hash, signature: Buffer.from(signatureBytes).toString('base64') });
      // Faulty/misconfigured signers must not persist unverifiable authorization.
      if (receiptProblem(receipt, decodeAuditPublicKey(this.publicKey)) !== null) throw new Error('Invalid signer output');
      tx.insertReceipt(receipt);
      return receipt;
    } catch {
      // Propagate synchronously: the caller's transaction MUST abort. Never return
      // an unsigned fallback or let admission/dispatch continue after audit failure.
      throw new BrokerError('AUDIT_UNAVAILABLE');
    }
  }

  list(chainId: ChainId, afterSeq: number, limit: number): ReceiptEvent[] {
    this.authorize(chainId);
    if (!CountSchema.safeParse(afterSeq).success || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new BrokerError('FORBIDDEN');
    }
    return this.store.read((view) => view.listReceipts(chainId, afterSeq, limit));
  }

  verify(chainId: ChainId): ReceiptVerification {
    this.authorize(chainId);
    return this.store.read((view) => {
      function* pages(): Generator<ReceiptEvent> {
        let afterSeq = 0;
        let pageSize = 1000;
        for (;;) {
          let page: ReceiptEvent[];
          try { page = view.listReceipts(chainId, afterSeq, pageSize); }
          catch (error) {
            // Readers may schema-validate a whole batch before returning any of
            // it. Retry singly to locate the first malformed persisted receipt,
            // rather than incorrectly labelling the start of that batch invalid.
            if (pageSize === 1) throw error;
            pageSize = 1;
            page = view.listReceipts(chainId, afterSeq, pageSize);
          }
          if (page.length === 0) return;
          for (const receipt of page) yield receipt;
          afterSeq = page[page.length - 1]!.seq;
        }
      }
      return verifyReceiptChain(pages(), chainId, this.publicKey);
    });
  }

  verifyReceipt(receipt: ReceiptEvent): ReceiptVerification {
    this.authorize(receipt.chainId);
    const result = verifyReceipt(receipt, this.publicKey);
    if (!result.valid || receipt.seq === 1) return result;
    // A single local receipt must also link to its stored predecessor. Offline
    // signature-only verification is exported separately; neither proves that
    // an unpinned suffix has not been removed.
    return this.store.read((view) => {
      try {
        const previous = view.listReceipts(receipt.chainId, receipt.seq - 2, 1)[0];
        if (previous === undefined || previous.chainId !== receipt.chainId || previous.seq !== receipt.seq - 1
          || previous.hash !== receipt.prevHash || receiptProblem(previous, decodeAuditPublicKey(this.publicKey)) !== null) {
          return verificationResult(receipt.chainId, 0, 'Receipt predecessor unavailable or invalid', receipt.seq);
        }
        return result;
      } catch { return verificationResult(receipt.chainId, 0, 'Receipt predecessor unavailable or invalid', receipt.seq); }
    });
  }
}
