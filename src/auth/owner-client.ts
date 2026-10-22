import {
  createPrivateKey, generateKeyPairSync, randomBytes, sign,
} from 'node:crypto';
import {
  BrokerError, OwnerSignedRequestSchema, canonicalJson, ownerSigningBytes, sha256Hex,
} from '../contracts/index.js';
import type { Ed25519PublicKey, OwnerVerificationInput } from '../contracts/index.js';
import { encodePublicKey } from './owner-key.js';

/** Public key is config-compatible; secretKey is an Ed25519 PKCS#8 PEM, owner-side ONLY. */
export function generateOwnerKeypair(): { publicKey: Ed25519PublicKey; secretKey: string } {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return {
    publicKey: encodePublicKey(Buffer.from(jwk.x!, 'base64url')),
    secretKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export type OwnerRequestBody = string | Uint8Array;
export type OwnerRequestHeaders = {
  'x-bb-owner-nonce': string;
  'x-bb-owner-issued-at': string;
  'x-bb-owner-body-sha256': string;
  'x-bb-owner-signature': string;
};

/** Sign exact transport bytes. For JSON, send canonicalJson(body) as the body AND
 * pass that same string here. An absent HTTP body is the empty string/byte array.
 * Method must already be uppercase; path includes the exact encoded query. */
export function signOwnerRequest(
  secretKey: string, method: string, path: string, body: OwnerRequestBody,
): OwnerRequestHeaders {
  try {
    const key = createPrivateKey(secretKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error();
    const payload = {
      method, path, bodySha256: sha256Hex(body),
      nonce: randomBytes(32).toString('base64url'), issuedAt: Date.now(),
    };
    const signature = sign(null, ownerSigningBytes(payload), key).toString('base64');
    return {
      'x-bb-owner-nonce': payload.nonce,
      'x-bb-owner-issued-at': String(payload.issuedAt),
      'x-bb-owner-body-sha256': payload.bodySha256,
      'x-bb-owner-signature': signature,
    };
  } catch { throw new BrokerError('FORBIDDEN'); }
}

/** Transport adapter: header names are lowercase, values must be single strings.
 * Reject duplicate/raw headers at the HTTP boundary before calling this helper.
 * method/path/bodyBytes MUST come from the actual HTTP request, not its body. */
export function ownerRequestFromHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  method: string, path: string, bodyBytes: Uint8Array,
): OwnerVerificationInput {
  try {
    const nonce = headers['x-bb-owner-nonce'];
    const issuedAt = headers['x-bb-owner-issued-at'];
    const bodySha256 = headers['x-bb-owner-body-sha256'];
    const signature = headers['x-bb-owner-signature'];
    if (typeof issuedAt !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(issuedAt)) throw new Error();
    const signed = OwnerSignedRequestSchema.parse({
      payload: { method, path, bodySha256, nonce, issuedAt: Number(issuedAt) }, signature,
    });
    // Keep canonical validation shared, including malformed Unicode rejection.
    canonicalJson(signed);
    return { signed, method, path, bodyBytes };
  } catch { throw new BrokerError('UNAUTHENTICATED'); }
}
