import { z } from 'zod';
import { YoctoNearSchema } from './amounts.js';
import { AccountIdSchema, CountSchema, IdSchema, TimestampSchema } from './primitives.js';
import { ReasonCodeSchema } from './errors.js';
import { AgentSchema } from './agents.js';
import { Sha256Schema } from './primitives.js';

export const RecipientPolicySchema = z.strictObject({
  mode: z.enum(['allow_all', 'allowlist']), accounts: z.array(AccountIdSchema),
});
export const AgentPolicySchema = z.strictObject({
  agentId: IdSchema, revision: CountSchema.min(1),
  perTxMax: YoctoNearSchema, rolling24hMax: YoctoNearSchema, lifetimeMax: YoctoNearSchema,
  /** Monetary gas charge in yoctoNEAR, not gas units. */
  gasBudget24h: YoctoNearSchema,
  ratePerMinute: CountSchema, maxOutstanding: CountSchema,
  recipients: RecipientPolicySchema, approvalThreshold: YoctoNearSchema.nullable(),
  expiresAt: TimestampSchema.optional(),
});
export type AgentPolicy = z.infer<typeof AgentPolicySchema>;
export const WalletPolicySchema = z.strictObject({
  revision: CountSchema.min(1), rolling24hMax: YoctoNearSchema, safetyReserve: YoctoNearSchema,
});
export type WalletPolicy = z.infer<typeof WalletPolicySchema>;
export const StandingApprovalSchema = z.strictObject({
  id: IdSchema, agentId: IdSchema, recipients: z.array(AccountIdSchema).optional(),
  perTxMax: YoctoNearSchema, totalMax: YoctoNearSchema, usedTotal: YoctoNearSchema,
  expiresAt: TimestampSchema, revokedAt: TimestampSchema.optional(),
}).refine((approval) => approval.usedTotal <= approval.totalMax, 'usedTotal exceeds totalMax');
export type StandingApproval = z.infer<typeof StandingApprovalSchema>;
export const RequestApprovalSchema = z.strictObject({
  id: IdSchema, requestId: IdSchema, agentId: IdSchema, requestDigest: Sha256Schema,
  policyRevision: CountSchema.min(1), approvedAt: TimestampSchema, expiresAt: TimestampSchema,
});
export type RequestApproval = z.infer<typeof RequestApprovalSchema>;
/** Totals include active reservations, excluding the request being re-evaluated.
 * settled principal counts only successful transfers; actual gas counts even failures.
 * standing reserved amounts count pending uses to prevent approval oversubscription.
 */
export const UsageSnapshotSchema = z.strictObject({
  agentRolling24h: YoctoNearSchema, agentLifetime: YoctoNearSchema,
  agentGas24h: YoctoNearSchema, agentRequestsLastMinute: CountSchema,
  agentOutstanding: CountSchema, walletRolling24h: YoctoNearSchema,
  outstandingHolds: YoctoNearSchema,
  balance: z.strictObject({ spendable: YoctoNearSchema, observedAt: TimestampSchema, validUntil: TimestampSchema }).nullable(),
  standingReserved: z.record(z.string(), YoctoNearSchema),
  globalFrozen: z.boolean(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
export const PolicyRequestSchema = z.strictObject({
  agentId: IdSchema, receiverId: AccountIdSchema, amount: YoctoNearSchema.positive(), feeReserve: YoctoNearSchema,
});
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;
export const PolicyEvaluationInputSchema = z.strictObject({
  agent: AgentSchema, agentPolicy: AgentPolicySchema.nullable(), walletPolicy: WalletPolicySchema.nullable(),
  usage: UsageSnapshotSchema, request: PolicyRequestSchema,
  standingApprovals: z.array(StandingApprovalSchema),
  requestApproval: RequestApprovalSchema.nullable(),
  requestId: IdSchema.nullable(), requestDigest: Sha256Schema,
  now: TimestampSchema,
});
export type PolicyEvaluationInput = z.infer<typeof PolicyEvaluationInputSchema>;
export const PolicyDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('allow'), reasons: z.array(ReasonCodeSchema).length(0) }),
  z.strictObject({ kind: z.literal('deny'), reasons: z.array(ReasonCodeSchema).min(1) }),
  z.strictObject({ kind: z.literal('needs_approval'), reasons: z.tuple([z.literal('APPROVAL_REQUIRED')]) }),
  z.strictObject({ kind: z.literal('allow_via_standing_approval'), reasons: z.array(ReasonCodeSchema).length(0), standingApprovalId: IdSchema }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
