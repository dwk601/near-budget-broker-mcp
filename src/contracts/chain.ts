import { z } from 'zod';
import { YoctoNearSchema } from './amounts.js';
import { AccountIdSchema, Base64Schema, Ed25519PublicKeySchema, IdSchema, TimestampSchema } from './primitives.js';

export const NonceSchema = z.bigint().nonnegative();
export const ChainHashSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const TxAttemptSchema = z.strictObject({
  id: IdSchema, requestId: IdSchema, nonce: NonceSchema, publicKey: Ed25519PublicKeySchema,
  blockHash: ChainHashSchema, signedTxBase64: Base64Schema.min(1), txHash: ChainHashSchema,
  status: z.enum(['signed', 'submitted', 'succeeded', 'failed', 'outcome_unknown', 'proven_not_executed']),
  receiptIds: z.array(ChainHashSchema), gasBurnt: z.bigint().nonnegative().nullable(),
  tokensBurnt: YoctoNearSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
});
export type TxAttempt = z.infer<typeof TxAttemptSchema>;
export type OutboxEntry = TxAttempt;
export const AccountBalanceSchema = z.strictObject({
  accountId: AccountIdSchema, total: YoctoNearSchema, locked: YoctoNearSchema,
  storageReserve: YoctoNearSchema, spendable: YoctoNearSchema,
  blockHash: ChainHashSchema, observedAt: TimestampSchema,
});
export type AccountBalance = z.infer<typeof AccountBalanceSchema>;
export const AccessKeyViewSchema = z.strictObject({
  nonce: NonceSchema, publicKey: Ed25519PublicKeySchema, fullAccess: z.boolean(), blockHash: ChainHashSchema,
});
export type AccessKeyView = z.infer<typeof AccessKeyViewSchema>;
export const RecentBlockSchema = z.strictObject({ hash: ChainHashSchema, observedAt: TimestampSchema });
export type RecentBlock = z.infer<typeof RecentBlockSchema>;
export const NativeTransferToSignSchema = z.strictObject({
  signerId: AccountIdSchema, receiverId: AccountIdSchema, amount: YoctoNearSchema.positive(),
  nonce: NonceSchema.positive(), publicKey: Ed25519PublicKeySchema, blockHash: ChainHashSchema,
});
export type NativeTransferToSign = z.infer<typeof NativeTransferToSignSchema>;
/** SDK types stay behind the adapter; unsigned JSON is never a dispatch authority. */
export const SignedNativeTransferSchema = z.strictObject({
  transfer: NativeTransferToSignSchema, signedTxBase64: Base64Schema.min(1), txHash: ChainHashSchema,
});
export type SignedNativeTransfer = z.infer<typeof SignedNativeTransferSchema>;
export const ChainOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('succeeded'), final: z.literal(true), receiptIds: z.array(ChainHashSchema), gasBurnt: z.bigint().nonnegative(), tokensBurnt: YoctoNearSchema }),
  z.strictObject({ kind: z.literal('failed'), final: z.literal(true), receiptIds: z.array(ChainHashSchema), gasBurnt: z.bigint().nonnegative(), tokensBurnt: YoctoNearSchema, error: z.string() }),
  z.strictObject({ kind: z.literal('pending') }),
  z.strictObject({ kind: z.literal('outcome_unknown'), reason: z.string() }),
  /** Only positive non-execution evidence, never an RPC timeout or missing indexer row. */
  z.strictObject({ kind: z.literal('not_executed'), evidence: z.string().min(1), invalidNonce: z.boolean() }),
]);
export type ChainOutcome = z.infer<typeof ChainOutcomeSchema>;
export const EncryptedCustodyKeySchema = z.strictObject({
  version: z.literal(1), algorithm: z.literal('aes-256-gcm'), kdf: z.literal('scrypt'),
  saltBase64: Base64Schema.min(1), ivBase64: Base64Schema.min(1), tagBase64: Base64Schema.min(1),
  ciphertextBase64: Base64Schema.min(1), publicKey: Ed25519PublicKeySchema,
});
export type EncryptedCustodyKey = z.infer<typeof EncryptedCustodyKeySchema>;
