import type { KeyObject } from 'node:crypto';
import {
  ChainIdSchema, GENESIS_PREV_HASH, ReceiptEventSchema, canonicalJson, receiptHashInput, sha256Hex,
} from '../../contracts/index.js';
import type { ChainId, Ed25519PublicKey, ReceiptEvent, ReceiptVerification } from '../../contracts/index.js';
import { decodeAuditPublicKey, verifyHashSignature } from './crypto.js';

export function verificationResult(chainId: ChainId, checked: number, reason: string | null, seq: number | null = null): ReceiptVerification {
  return { valid: reason === null, chainId, checked, firstInvalidSeq: seq, reason };
}

/** Does not assert completeness or linkage to an unavailable predecessor. */
export function receiptProblem(receipt: ReceiptEvent, key: KeyObject): string | null {
  try {
    // Check the original object before schema parsing could discard non-JSON properties.
    canonicalJson(receipt);
    const event = ReceiptEventSchema.parse(receipt);
    const { hash, signature, ...preimage } = event;
    if (event.seq === 1 && event.prevHash !== GENESIS_PREV_HASH) return 'Invalid genesis';
    if (sha256Hex(receiptHashInput(preimage)) !== hash) return 'Receipt hash mismatch';
    if (!verifyHashSignature(hash, signature, key)) return 'Invalid receipt signature';
    return null;
  } catch { return 'Malformed receipt'; }
}

/** Offline verification uses an explicitly trusted key, never key material in an event.
 * A valid single receipt is not proof of history completeness. */
export function verifyReceipt(receipt: ReceiptEvent, trustedAuditPublicKey: Ed25519PublicKey): ReceiptVerification {
  const chainId = ChainIdSchema.parse(receipt.chainId);
  const seq = Number.isSafeInteger(receipt.seq) && receipt.seq >= 1 ? receipt.seq : 1;
  let key: KeyObject;
  try { key = decodeAuditPublicKey(trustedAuditPublicKey); }
  catch { return verificationResult(chainId, 0, 'Invalid audit public key', seq); }
  const reason = receiptProblem(receipt, key);
  return verificationResult(chainId, reason === null ? 1 : 0, reason, reason === null ? null : seq);
}

/** Verify a full genesis-to-head export in its supplied order (never sort it).
 * A removed suffix needs an externally pinned checkpoint/head to detect it.
 * Iterables allow the live log to stream pages in one Store read snapshot.
 */
export function verifyReceiptChain(
  receipts: Iterable<ReceiptEvent>, chainId: ChainId, trustedAuditPublicKey: Ed25519PublicKey,
): ReceiptVerification {
  ChainIdSchema.parse(chainId);
  let key: KeyObject;
  try { key = decodeAuditPublicKey(trustedAuditPublicKey); }
  catch { return verificationResult(chainId, 0, 'Invalid audit public key', 1); }
  let checked = 0;
  let prevHash = GENESIS_PREV_HASH;
  try {
    for (const receipt of receipts) {
      const expectedSeq = checked + 1;
      if (receipt.chainId !== chainId) return verificationResult(chainId, checked, 'Receipt chain mismatch', expectedSeq);
      if (receipt.seq !== expectedSeq) return verificationResult(chainId, checked, 'Receipt sequence mismatch', expectedSeq);
      if (receipt.prevHash !== prevHash) return verificationResult(chainId, checked, 'Receipt linkage mismatch', expectedSeq);
      const reason = receiptProblem(receipt, key);
      if (reason !== null) return verificationResult(chainId, checked, reason, expectedSeq);
      checked++;
      prevHash = receipt.hash;
    }
    return verificationResult(chainId, checked, null);
  } catch { return verificationResult(chainId, checked, 'Receipt chain unavailable or malformed', checked + 1); }
}
