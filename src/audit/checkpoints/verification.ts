import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  CheckpointSchema, Ed25519PublicKeySchema, canonicalJson, checkpointHashInput, sha256Hex,
} from '../../contracts/index.js';
import type { Checkpoint, Ed25519PublicKey } from '../../contracts/index.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Decode only the pinned verification key. No embedded key can establish trust. */
export function verificationKey(pinned: Ed25519PublicKey): KeyObject {
  Ed25519PublicKeySchema.parse(pinned);
  const text = pinned.slice('ed25519:'.length);
  let value = 0n;
  for (const char of text) value = value * 58n + BigInt(BASE58.indexOf(char));
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  if (bytes.length !== 32) throw new TypeError('Expected 32-byte Ed25519 public key');
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bytes)]),
    format: 'der', type: 'spki',
  });
}

export function verifyHash(hash: string, signature: string, key: KeyObject): boolean {
  return verify(null, Buffer.from(hash, 'hex'), key, Buffer.from(signature, 'base64'));
}

/** Authenticate one checkpoint, including a retained non-genesis checkpoint.
 * Linkage is checked separately when the complete checkpoint history is supplied. */
export function authenticateCheckpoint(input: Checkpoint, pinned: Ed25519PublicKey, key: KeyObject): Checkpoint {
  canonicalJson(input);
  const checkpoint = CheckpointSchema.parse(input);
  if (checkpoint.auditPublicKey !== pinned) throw new Error('Checkpoint audit key differs from pinned key');
  const { hash, signature, ...preimage } = checkpoint;
  if (sha256Hex(checkpointHashInput(preimage)) !== hash) throw new Error('Checkpoint hash mismatch');
  if (!verifyHash(hash, signature, key)) throw new Error('Checkpoint signature invalid');
  return checkpoint;
}
