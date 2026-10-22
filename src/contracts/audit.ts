import { z } from 'zod';
import { CountSchema, JsonObjectSchema, Sha256Schema, SignatureSchema, TimestampSchema } from './primitives.js';

export const RECEIPT_EVENT_TYPES = [
  'decision_allowed', 'decision_denied', 'approval_required', 'approved', 'rejected',
  'standing_approval_used', 'queued', 'submitted', 'succeeded', 'failed', 'outcome_unknown',
  'cancelled', 'freeze', 'unfreeze', 'policy_updated', 'credential_issued', 'credential_revoked',
] as const;
export const ReceiptEventTypeSchema = z.enum(RECEIPT_EVENT_TYPES);
export type ReceiptEventType = z.infer<typeof ReceiptEventTypeSchema>;
export const OWNER_CHAIN_ID = 'owner' as const;
export const GENESIS_PREV_HASH = '0'.repeat(64);
export const ChainIdSchema = z.string().regex(/^(owner|agent:.+)$/).max(134);
export type ChainId = z.infer<typeof ChainIdSchema>;
/** Hash these fields only; sign the 32 decoded hash bytes. */
export const ReceiptPreimageSchema = z.strictObject({
  chainId: ChainIdSchema, seq: CountSchema.min(1), prevHash: Sha256Schema,
  type: ReceiptEventTypeSchema, at: TimestampSchema, payload: JsonObjectSchema,
});
export type ReceiptPreimage = z.infer<typeof ReceiptPreimageSchema>;
export const ReceiptEventSchema = ReceiptPreimageSchema.extend({ hash: Sha256Schema, signature: SignatureSchema });
export type ReceiptEvent = z.infer<typeof ReceiptEventSchema>;
export const AppendReceiptSchema = ReceiptPreimageSchema.omit({ seq: true, prevHash: true });
export type AppendReceipt = z.infer<typeof AppendReceiptSchema>;
export const ReceiptVerificationSchema = z.strictObject({
  valid: z.boolean(), chainId: ChainIdSchema, checked: CountSchema,
  firstInvalidSeq: CountSchema.min(1).nullable(), reason: z.string().nullable(),
});
export type ReceiptVerification = z.infer<typeof ReceiptVerificationSchema>;
