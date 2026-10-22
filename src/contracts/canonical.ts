import { createHash } from 'node:crypto';
import { AgentTokenSchema } from './agents.js';
import { OwnerSigningPayloadSchema } from './auth.js';
import type { OwnerSigningPayload } from './auth.js';
import { ReceiptPreimageSchema } from './audit.js';
import type { ReceiptPreimage } from './audit.js';
import { CheckpointPreimageSchema } from './checkpoints.js';
import type { CheckpointPreimage } from './checkpoints.js';
import { RequestDigestPreimageSchema } from './transfers.js';
import type { RequestDigestPreimage } from './transfers.js';

/** RFC 8785 on the shared restricted JSON domain (safe integer numbers only).
 * UTF-16 key ordering, no Unicode normalization, -0 -> 0. Build object text
 * directly: constructing a sorted JS object would reorder integer-like keys.
 * Reject lossy JSON.stringify cases instead of silently signing different data.
 * Raw JSON duplicate-key rejection belongs to the transport parser: once parsed,
 * duplicate keys are irrecoverably lost and cannot be detected by this helper. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function quote(text: string): string {
    if (!text.isWellFormed()) throw new TypeError('Canonical JSON rejects lone surrogates');
    return JSON.stringify(text);
  }
  function encode(item: unknown, depth: number): string {
    if (depth > 128) throw new TypeError('Canonical JSON depth exceeds 128');
    if (item === null) return 'null';
    if (typeof item === 'string') return quote(item);
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new TypeError('Canonical JSON requires safe integer numbers');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Canonical JSON requires JSON values');
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON requires plain objects/arrays');
    }
    if (ancestors.has(item)) throw new TypeError('Canonical JSON rejects cycles');
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')) throw new TypeError('Canonical JSON rejects symbol keys');
      function field(key: string): string {
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('Canonical JSON rejects accessors, hidden properties and array holes');
        }
        return encode(descriptor.value, depth + 1);
      }
      if (array) {
        if (keys.length !== item.length + 1) throw new TypeError('Canonical JSON rejects sparse/extended arrays');
        return `[${Array.from({ length: item.length }, (_, index) => field(String(index))).join(',')}]`;
      }
      return `{${(keys as string[]).sort().map((key) => `${quote(key)}:${field(key)}`).join(',')}}`;
    } finally { ancestors.delete(item); }
  }
  return encode(value, 0);
}
/** Strings are hashed as exact UTF-8, bytes as-is (no JSON quoting or hex decoding). */
export function sha256Hex(value: string | Uint8Array): string {
  if (typeof value === 'string' && !value.isWellFormed()) throw new TypeError('SHA-256 input has lone surrogates');
  return createHash('sha256').update(value).digest('hex');
}
export function requestDigest(preimage: Omit<RequestDigestPreimage, 'memo'> & { memo?: string | null }): string {
  // Absence and explicit null normalize identically; empty string is distinct.
  const normalized = { ...preimage, memo: preimage.memo ?? null };
  canonicalJson(normalized);
  return sha256Hex(canonicalJson(RequestDigestPreimageSchema.parse(normalized)));
}
export function hashAgentToken(token: string): string {
  return sha256Hex(AgentTokenSchema.parse(token));
}
export function ownerSigningBytes(payload: OwnerSigningPayload): Uint8Array {
  canonicalJson(payload);
  return Buffer.from(canonicalJson(OwnerSigningPayloadSchema.parse(payload)), 'utf8');
}
/** Exactly the preimage bytes, NOT a hash and NOT including hash/signature fields. */
export function receiptHashInput(preimage: ReceiptPreimage): Uint8Array {
  canonicalJson(preimage);
  return Buffer.from(canonicalJson(ReceiptPreimageSchema.parse(preimage)), 'utf8');
}
export function checkpointHashInput(preimage: CheckpointPreimage): Uint8Array {
  canonicalJson(preimage);
  return Buffer.from(canonicalJson(CheckpointPreimageSchema.parse(preimage)), 'utf8');
}
