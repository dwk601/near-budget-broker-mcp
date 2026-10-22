import { z } from 'zod';
import { AccountIdSchema, IdSchema, TimestampSchema } from './primitives.js';
import { YoctoNearSchema } from './amounts.js';
import { StandingApprovalSchema } from './policy.js';
import { ReasonCodeSchema } from './errors.js';

export const ApproveRequestCommandSchema = z.strictObject({
  requestId: IdSchema, approvalId: IdSchema, expiresAt: TimestampSchema, now: TimestampSchema,
});
export type ApproveRequestCommand = z.infer<typeof ApproveRequestCommandSchema>;
export const RejectRequestCommandSchema = z.strictObject({
  requestId: IdSchema, reason: z.string().min(1), now: TimestampSchema,
});
export type RejectRequestCommand = z.infer<typeof RejectRequestCommandSchema>;
export const StandingApprovalGrantSchema = z.strictObject({
  agentId: IdSchema, recipients: z.array(AccountIdSchema).optional(),
  perTxMax: YoctoNearSchema, totalMax: YoctoNearSchema, expiresAt: TimestampSchema,
});
export type StandingApprovalGrant = z.infer<typeof StandingApprovalGrantSchema>;
export const GrantStandingApprovalCommandSchema = StandingApprovalGrantSchema.extend({ id: IdSchema, now: TimestampSchema });
export type GrantStandingApprovalCommand = z.infer<typeof GrantStandingApprovalCommandSchema>;
export const RevokeStandingApprovalCommandSchema = z.strictObject({ approvalId: IdSchema, now: TimestampSchema });
export type RevokeStandingApprovalCommand = z.infer<typeof RevokeStandingApprovalCommandSchema>;
/** Pure matching checks recipient/agent/perTx/total+reservations/expiry/revocation.
 * It does NOT authorize bypassing hard policy caps or a freeze. */
export const StandingApprovalMatchInputSchema = z.strictObject({
  approval: StandingApprovalSchema, agentId: IdSchema, receiverId: AccountIdSchema,
  amount: YoctoNearSchema.positive(), reservedTotal: YoctoNearSchema, now: TimestampSchema,
});
export type StandingApprovalMatchInput = z.infer<typeof StandingApprovalMatchInputSchema>;
export const StandingApprovalMatchSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('match'), approvalId: IdSchema }),
  z.strictObject({ kind: z.literal('no_match'), reasons: z.array(ReasonCodeSchema).min(1) }),
]);
export type StandingApprovalMatch = z.infer<typeof StandingApprovalMatchSchema>;
/** Pure successful-settlement debit. Must have amount <= reservedAmount and
 * usedTotal+amount <= totalMax. Even an expired/revoked grant must charge an
 * already-executed transfer. Caller releases reservation in the SAME transaction. */
export const StandingApprovalConsumeInputSchema = z.strictObject({
  approval: StandingApprovalSchema, amount: YoctoNearSchema.positive(), reservedAmount: YoctoNearSchema,
});
export type StandingApprovalConsumeInput = z.infer<typeof StandingApprovalConsumeInputSchema>;
