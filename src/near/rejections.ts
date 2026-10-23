import { canonicalJson } from '../contracts/index.js';
import type { BroadcastResult } from '../contracts/index.js';
import { record, unsigned } from './rpc.js';
const U64_MAX = (1n << 64n) - 1n;
export interface RejectionDetails {
  code: 'INVALID_NONCE' | 'EXPIRED_BLOCK_HASH' | 'RPC_REJECTED';
  tx_nonce?: string;
  ak_nonce?: string;
}
/** Preserve bounded numeric InvalidNonce details, not arbitrary provider text.
 * Data retains precedence over cause.info, matching near-api-js classification. */
export function rejectionCode(error: unknown): RejectionDetails | null {
  try {
    const body = record(error); let invalid: unknown;
    try { invalid = record(record(body['data'])['TxExecutionError'])['InvalidTxError']; } catch { /* alternate envelope */ }
    if (invalid === undefined && body['cause'] !== undefined) {
      const cause = record(body['cause']);
      if (cause['name'] !== 'INVALID_TRANSACTION') return null;
      invalid = record(cause['info'])['InvalidTxError'];
    }
    if (invalid === 'Expired') return { code: 'EXPIRED_BLOCK_HASH' };
    if (invalid && typeof invalid === 'object' && 'InvalidNonce' in invalid) {
      try {
        const detail = record(invalid.InvalidNonce);
        return { code: 'INVALID_NONCE', tx_nonce: unsigned(detail['tx_nonce'], U64_MAX).toString(),
          ak_nonce: unsigned(detail['ak_nonce'], U64_MAX).toString() };
      } catch { return { code: 'INVALID_NONCE' }; }
    }
    if (invalid && typeof invalid === 'object' && 'Expired' in invalid) return { code: 'EXPIRED_BLOCK_HASH' };
    return invalid === undefined ? null : { code: 'RPC_REJECTED' };
  } catch { return null; }
}
export function rejectionReason(detail: RejectionDetails): string {
  return detail.tx_nonce === undefined ? detail.code : canonicalJson(detail);
}
/** Equality can mean these very bytes already executed through a retrying
 * gateway. Only STRICTLY greater ak_nonce, bound to this transaction's nonce,
 * can be recorded as definitive first-offer InvalidNonce provenance. */
export const FIRST_INVALID_NONCE_PREFIX = 'FIRST_INVALID_NONCE:';
export function invalidNonceEvidence(result: BroadcastResult, nonce: bigint): string | null {
  return isDefinitiveFirstRejection(result, nonce) && result.code === 'INVALID_NONCE' ? FIRST_INVALID_NONCE_PREFIX + result.reason : null;
}
export function hasInvalidNonceEvidence(evidence: string | null, nonce: bigint, txHash: string): boolean {
  if (!evidence?.startsWith(FIRST_INVALID_NONCE_PREFIX)) return false;
  return isDefinitiveFirstRejection({ kind: 'rejected', code: 'INVALID_NONCE', txHash,
    reason: evidence.slice(FIRST_INVALID_NONCE_PREFIX.length) }, nonce);
}
export function isDefinitiveFirstRejection(result: BroadcastResult, nonce: bigint): result is Extract<BroadcastResult, { kind: 'rejected' }> & { code: 'INVALID_NONCE' | 'EXPIRED_BLOCK_HASH' } {
  if (result.kind !== 'rejected') return false;
  if (result.code === 'EXPIRED_BLOCK_HASH') return true;
  if (result.code !== 'INVALID_NONCE') return false;
  try {
    const detail = record(JSON.parse(result.reason));
    if (canonicalJson(detail) !== result.reason || Object.keys(detail).sort().join(',') !== 'ak_nonce,code,tx_nonce'
      || detail['code'] !== result.code || typeof detail['ak_nonce'] !== 'string' || typeof detail['tx_nonce'] !== 'string') return false;
    const txNonce = unsigned(detail['tx_nonce'], U64_MAX); const akNonce = unsigned(detail['ak_nonce'], U64_MAX);
    return txNonce === nonce && akNonce > txNonce;
  } catch { return false; }
}
