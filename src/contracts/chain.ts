import { z } from 'zod';
import { YoctoNearSchema } from './amounts.js';
import { AccountIdSchema, Base64Schema, Ed25519PublicKeySchema, IdSchema, TimestampSchema, CountSchema } from './primitives.js';

export const NonceSchema = z.bigint().nonnegative();
export const ChainHashSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export type ChainHash = z.infer<typeof ChainHashSchema>;
/** Let final RPC/indexer visibility converge after the most recent offer.
 * This is a minimum safety delay, never configurable down by an agent. */
export const NON_EXECUTION_MIN_AGE_MS = 60_000;
export const OUTBOX_STATUSES = ['signed', 'submitted', 'outcome_unknown'] as const;
/** Expected RPC/transport failures are values, not untyped thrown errors.
 * A rejection applies to THIS send only, not proof an earlier send didn't execute. */
export const BroadcastResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), txHash: ChainHashSchema }),
  z.strictObject({ kind: z.literal('rejected'), txHash: ChainHashSchema,
    code: z.enum(['INVALID_NONCE', 'EXPIRED_BLOCK_HASH', 'RPC_REJECTED']), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('outcome_unknown'), txHash: ChainHashSchema, reason: z.string().min(1) }),
]);
export type BroadcastResult = z.infer<typeof BroadcastResultSchema>;
export const TxAttemptSchema = z.strictObject({
  id: IdSchema, requestId: IdSchema, nonce: NonceSchema, publicKey: Ed25519PublicKeySchema,
  blockHash: ChainHashSchema, signedTxBase64: Base64Schema.min(1), txHash: ChainHashSchema,
  status: z.enum(['signed', 'submitted', 'succeeded', 'failed', 'outcome_unknown', 'proven_not_executed']),
  receiptIds: z.array(ChainHashSchema), gasBurnt: z.bigint().nonnegative().nullable(),
  tokensBurnt: YoctoNearSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
  /** Positive chain-adapter evidence retained before any replacement is eligible. */
  nonExecutionEvidence: z.string().min(1).nullable(),
  /** Persisted BEFORE every offer; null proves no submission intent was written.
   * Missing on legacy records requires receipt recovery, never a freshness guess. */
  lastOfferedAt: TimestampSchema.nullable().optional(),
  /** Monotonic durable offer intents, incremented before invocation. Sole-first
   * definitive rejection provenance gates NONCE-based exclusion. EXPIRY may cover
   * any count only with retained anchor, full margin/age/spaced negatives AND an
   * access-key nonce pinned to the FINAL head strictly below this attempt. */
  offerCount: CountSchema.optional(),
  firstRejection: z.enum(['INVALID_NONCE', 'EXPIRED_BLOCK_HASH']).optional(),
  /** Eligibility for resolution watching. Automatic polling has a bounded GC
   * horizon; explicit reconcile(id) can still account later visibility. Released
   * holds use status-only checks, not repeated non-execution proofs. */
  resolutionWatch: z.boolean().optional(),
}).refine((attempt) => attempt.status !== 'proven_not_executed' || attempt.nonExecutionEvidence !== null,
  'proven_not_executed requires persisted positive evidence');
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
