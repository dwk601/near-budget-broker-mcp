import { createPublicKey } from 'node:crypto';
import { expect, it } from 'vitest';
import { decodeAuditPublicKey, encodeAuditPublicKey } from '../../../src/audit/core/index.js';

it.each([
  [1, 'ed25519:1eHrr5tJQgXhkTPxMWqcr7SPG75dmZMwi3GJmrN7CnD'],
  [2, 'ed25519:119T2Kpn9vrHUMin5PKYQXcSgwAzEmXtsTWy2m9Tz97'],
  [31, 'ed25519:1111111111111111111111111111111j'],
  [32, 'ed25519:11111111111111111111111111111111'],
] as const)('preserves %i leading-zero bytes against fixed base58 vectors', (zeros, expected) => {
  // Codec vectors, not deployment keys or assertions about curve-point validity.
  const raw = Buffer.concat([Buffer.alloc(zeros), Buffer.alloc(32 - zeros, 42)]);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } });
  expect(encodeAuditPublicKey(key)).toBe(expected);
  const decoded = decodeAuditPublicKey(expected);
  expect(decoded.asymmetricKeyType).toBe('ed25519');
  expect(Buffer.from(decoded.export({ format: 'jwk' }).x!, 'base64url')).toEqual(raw);
  expect(encodeAuditPublicKey(decoded)).toBe(expected);
});
