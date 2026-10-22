import type { KeyObject } from 'node:crypto';
import {
  ChainIdSchema, GENESIS_PREV_HASH, OWNER_CHAIN_ID, ReceiptEventSchema, canonicalJson, receiptHashInput, sha256Hex,
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

/** Read identity without invoking hostile accessors; authorization precedes crypto. */
export function receiptChainId(receipt: unknown): ChainId | null {
  try {
    if (receipt === null || typeof receipt !== 'object') return null;
    const field = Object.getOwnPropertyDescriptor(receipt, 'chainId');
    if (field === undefined || !('value' in field)) return null;
    const parsed = ChainIdSchema.safeParse(field.value);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** Offline verification uses an explicitly trusted key, never key material in an event.
 * A valid single receipt is not proof of history completeness or committed membership.
 * Malformed identities use owner solely as a schema-valid error sentinel (valid=false).
 */
export function verifyReceipt(receipt: unknown, trustedAuditPublicKey: Ed25519PublicKey): ReceiptVerification {
  const chainId = receiptChainId(receipt);
  if (chainId === null) return verificationResult(OWNER_CHAIN_ID, 0, 'Malformed receipt identity', 1);
  let event: ReceiptEvent;
  try {
    canonicalJson(receipt);
    event = ReceiptEventSchema.parse(receipt);
  } catch { return verificationResult(chainId, 0, 'Malformed receipt', 1); }
  const seq = event.seq;
  let key: KeyObject;
  try { key = decodeAuditPublicKey(trustedAuditPublicKey); }
  catch { return verificationResult(chainId, 0, 'Invalid audit public key', seq); }
  const reason = receiptProblem(event, key);
  return verificationResult(chainId, reason === null ? 1 : 0, reason, reason === null ? null : seq);
}

/** Verify a full genesis-to-head export in its supplied order (never sort it).
 * A removed suffix needs an externally pinned checkpoint/head to detect it.
 * Iterables allow the live log to stream pages in one Store read snapshot.
 */
export function verifyReceiptChain(
  receipts: Iterable<ReceiptEvent>, chainId: ChainId, trustedAuditPublicKey: Ed25519PublicKey,
): ReceiptVerification {
  try {
    if (!ChainIdSchema.safeParse(chainId).success) return verificationResult(OWNER_CHAIN_ID, 0, 'Malformed chain identity', 1);
  } catch { return verificationResult(OWNER_CHAIN_ID, 0, 'Malformed chain identity', 1); }
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
