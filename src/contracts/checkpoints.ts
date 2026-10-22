import { z } from 'zod';
import { ChainIdSchema } from './audit.js';
import { CountSchema, Ed25519PublicKeySchema, Sha256Schema, SignatureSchema, TimestampSchema } from './primitives.js';

/** One signed chain-head attestation, chained to the prior checkpoint for that chain.
 * Embedded public key is metadata, NOT a trust root. Verifiers supply a trusted key. */
export const CheckpointPreimageSchema = z.strictObject({
  version: z.literal(1), chainId: ChainIdSchema, seq: CountSchema.min(1), headHash: Sha256Schema,
  previousCheckpointHash: Sha256Schema.nullable(), at: TimestampSchema, auditPublicKey: Ed25519PublicKeySchema,
});
export type CheckpointPreimage = z.infer<typeof CheckpointPreimageSchema>;
export const CheckpointSchema = CheckpointPreimageSchema.extend({ hash: Sha256Schema, signature: SignatureSchema });
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export const CheckpointVerificationSchema = z.strictObject({
  valid: z.boolean(), chainId: ChainIdSchema, checked: CountSchema,
  firstInvalidSeq: CountSchema.min(1).nullable(), reason: z.string().nullable(),
});
export type CheckpointVerification = z.infer<typeof CheckpointVerificationSchema>;
