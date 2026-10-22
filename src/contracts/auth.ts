import { z } from 'zod';
import { Sha256Schema, SignatureSchema, TimestampSchema } from './primitives.js';

export const OWNER_MAX_SKEW_MS = 60_000;
/** Uppercase HTTP method, exact encoded path+query, no host or fragment. */
export const OwnerSigningPayloadSchema = z.strictObject({
  method: z.string().regex(/^[A-Z]+$/),
  path: z.string().regex(/^\/(?!\/)[^\s#]*$/),
  bodySha256: Sha256Schema,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/),
  issuedAt: TimestampSchema,
});
export type OwnerSigningPayload = z.infer<typeof OwnerSigningPayloadSchema>;
export const OwnerSignedRequestSchema = z.strictObject({
  payload: OwnerSigningPayloadSchema, signature: SignatureSchema,
});
export type OwnerSignedRequest = z.infer<typeof OwnerSignedRequestSchema>;
/** Transport-provided actual values, not trusted fields copied from the signature envelope. */
export interface OwnerVerificationInput {
  signed: OwnerSignedRequest;
  method: string;
  path: string;
  bodyBytes: Uint8Array;
}
