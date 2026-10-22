import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { BrokerError, Ed25519PublicKeySchema } from '../contracts/index.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 here encodes public key bytes only, never monetary values or secrets. */
export function encodePublicKey(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new BrokerError('FORBIDDEN');
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let text = '';
  while (value > 0n) {
    text = ALPHABET[Number(value % 58n)]! + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = '1' + text;
  }
  return `ed25519:${text}`;
}

export function decodeOwnerPublicKey(publicKey: string): KeyObject {
  try {
    const text = Ed25519PublicKeySchema.parse(publicKey).slice('ed25519:'.length);
    let value = 0n;
    for (const char of text) value = value * 58n + BigInt(ALPHABET.indexOf(char));
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const nonzero = value === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
    const bytes = Buffer.concat([Buffer.alloc(text.match(/^1*/)?.[0].length ?? 0), nonzero]);
    if (bytes.length !== 32 || encodePublicKey(bytes) !== publicKey) throw new Error();
    return createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') } });
  } catch { throw new BrokerError('FORBIDDEN'); }
}
