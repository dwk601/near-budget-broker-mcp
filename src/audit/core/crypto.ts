import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { Ed25519PublicKeySchema } from '../../contracts/index.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Public-key encoding only; no custody/NEAR key material is involved. */
export function encodeAuditPublicKey(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || !jwk.x) throw new TypeError('Expected Ed25519');
  const bytes = Buffer.from(jwk.x, 'base64url');
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let text = '';
  while (value > 0n) {
    text = BASE58[Number(value % 58n)] + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = '1' + text;
  }
  return Ed25519PublicKeySchema.parse(`ed25519:${text}`);
}

export function decodeAuditPublicKey(publicKey: string): KeyObject {
  Ed25519PublicKeySchema.parse(publicKey);
  const text = publicKey.slice('ed25519:'.length);
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) throw new TypeError('Expected canonical base58 public key');
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16).padStart(2, '0');
  const body = value === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const leadingZeros = text.length - text.replace(/^1+/, '').length;
  const bytes = Buffer.concat([Buffer.alloc(leadingZeros), body]);
  if (bytes.length !== 32) throw new TypeError('Expected 32-byte Ed25519 public key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') }, format: 'jwk' });
}

export function verifyHashSignature(hash: string, signature: string, key: KeyObject): boolean {
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) return false;
  return verify(null, Buffer.from(hash, 'hex'), key, bytes);
}
