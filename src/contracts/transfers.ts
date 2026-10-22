import { z } from 'zod';
import { DecimalTextSchema, YoctoNearSchema } from './amounts.js';
import { AccountIdSchema, IdSchema, CountSchema, TimestampSchema, Sha256Schema } from './primitives.js';
import { ReasonCodeSchema } from './errors.js';
import { ChainHashSchema } from './chain.js';
import { EXPLORER_BASE } from './config.js';
import type { ChainHash } from './chain.js';

export const TRANSFER_STATES = [
  'denied', 'pending_approval', 'approved', 'rejected', 'expired', 'cancelled', 'queued',
  'signed', 'submitted', 'succeeded', 'failed', 'outcome_unknown',
] as const;
export const TransferStateSchema = z.enum(TRANSFER_STATES);
export type TransferState = z.infer<typeof TransferStateSchema>;
/** No backwards transition from a signed/ambiguous attempt to a fresh queue. */
export const ALLOWED_TRANSITIONS = {
  denied: [],
  pending_approval: ['approved', 'rejected', 'expired', 'cancelled', 'denied'],
  approved: ['queued', 'cancelled', 'expired', 'denied', 'pending_approval'],
  rejected: [], expired: [], cancelled: [],
  queued: ['signed', 'cancelled', 'expired', 'denied', 'pending_approval'],
  signed: ['submitted', 'outcome_unknown', 'failed'],
  submitted: ['succeeded', 'failed', 'outcome_unknown'],
  succeeded: [], failed: [],
  outcome_unknown: ['submitted', 'succeeded', 'failed'],
} as const satisfies Record<TransferState, readonly TransferState[]>;
export const IdempotencyKeySchema = z.string().min(1).max(256);
export const TransferInputSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema, receiverId: AccountIdSchema,
  amount: YoctoNearSchema.positive(), memo: z.string().max(1024).optional(),
});
export type TransferInput = z.infer<typeof TransferInputSchema>;
/** JSON/MCP input: amount is decimal yoctoNEAR, not a NEAR decimal or JS number. */
export const TransferInputWireSchema = TransferInputSchema.extend({ amount: DecimalTextSchema.refine((s) => s !== '0', 'INVALID_AMOUNT') });
/** Digest preimage: absent memo becomes null; amount is decimal yoctoNEAR TEXT. */
export const RequestDigestPreimageSchema = z.strictObject({
  agentId: IdSchema, receiverId: AccountIdSchema, amount: DecimalTextSchema, memo: z.string().max(1024).nullable(),
});
export type RequestDigestPreimage = z.infer<typeof RequestDigestPreimageSchema>;
export const ApprovalRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), id: IdSchema }),
  z.strictObject({ kind: z.literal('standing'), id: IdSchema }),
]);
export type ApprovalRef = z.infer<typeof ApprovalRefSchema>;
export const TransferRequestSchema = z.strictObject({
  id: IdSchema, agentId: IdSchema, idempotencyKey: IdempotencyKeySchema, requestDigest: Sha256Schema,
  receiverId: AccountIdSchema, amount: YoctoNearSchema.positive(), memo: z.string().max(1024).optional(),
  state: TransferStateSchema, reasons: z.array(ReasonCodeSchema),
  policyRevision: CountSchema.min(1).nullable(), approvalRef: ApprovalRefSchema.nullable(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(), signedAt: TimestampSchema.nullable(),
  submittedAt: TimestampSchema.nullable(), completedAt: TimestampSchema.nullable(),
  txHash: ChainHashSchema.nullable(), gasBurnt: z.bigint().nonnegative().nullable(),
  tokensBurnt: YoctoNearSchema.nullable(),
});
export type TransferRequest = z.infer<typeof TransferRequestSchema>;
export function transferExplorerUrl(txHash: ChainHash | null): string | null {
  return txHash === null ? null : `${EXPLORER_BASE}${ChainHashSchema.parse(txHash)}`;
}
export const TransferViewSchema = TransferRequestSchema.extend({ explorerUrl: z.url().nullable() })
  .refine((view) => view.explorerUrl === transferExplorerUrl(view.txHash), 'Explorer URL must match txHash');
export type TransferView = z.infer<typeof TransferViewSchema>;
/** No same-state changes; replacement of proven-unexecuted attempts has a separate Store method. */
export function isAllowedTransition(from: TransferState, to: TransferState): boolean {
  const targets: readonly TransferState[] = ALLOWED_TRANSITIONS[from];
  return targets.includes(to);
}
export const HoldSchema = z.strictObject({
  requestId: IdSchema, agentId: IdSchema, principal: YoctoNearSchema, feeReserve: YoctoNearSchema,
  status: z.enum(['active', 'committed', 'released']),
});
export type Hold = z.infer<typeof HoldSchema>;
export const AccountingEntrySchema = z.strictObject({
  id: IdSchema, requestId: IdSchema, agentId: IdSchema,
  kind: z.enum(['principal_reserved', 'fee_reserved', 'principal_committed', 'gas_charged', 'gas_correction', 'principal_released', 'fee_released']),
  amount: YoctoNearSchema, at: TimestampSchema,
});
export type AccountingEntry = z.infer<typeof AccountingEntrySchema>;
