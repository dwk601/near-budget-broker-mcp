import { z } from 'zod';
import { CountSchema, IdSchema, Sha256Schema, SignatureSchema, TimestampSchema, AccountIdSchema } from './primitives.js';
import { DecimalTextSchema } from './amounts.js';
import { AgentSchema, FreezeSchema } from './agents.js';
import { AgentPolicySchema, StandingApprovalSchema, WalletPolicySchema } from './policy.js';
import { ApprovalRefSchema } from './transfers.js';
import { ChainHashSchema } from './chain.js';
import { ReasonCodeSchema } from './errors.js';

export const OWNER_CHAIN_ID = 'owner' as const;
export const GENESIS_PREV_HASH = '0'.repeat(64);
export const ChainIdSchema = z.string().regex(/^(owner|agent:.+)$/).max(134);
export type ChainId = z.infer<typeof ChainIdSchema>;
const request = { requestId: IdSchema, agentId: IdSchema };
const decision = {
  ...request, receiverId: AccountIdSchema, amount: DecimalTextSchema,
  requestDigest: Sha256Schema, policyRevision: CountSchema.min(1).nullable(), approvalRef: ApprovalRefSchema.nullable(),
};
const settlement = {
  ...request, txHash: ChainHashSchema, receiptIds: z.array(ChainHashSchema),
  gasBurnt: DecimalTextSchema, tokensBurnt: DecimalTextSchema,
};
/** Receipt payloads are JSON wire records: amounts/gas use decimal TEXT. */
export const StandingApprovalWireSchema = z.strictObject({
  ...StandingApprovalSchema.shape, perTxMax: DecimalTextSchema, totalMax: DecimalTextSchema, usedTotal: DecimalTextSchema,
}).refine((approval) => !DecimalTextSchema.safeParse(approval.usedTotal).success
  || !DecimalTextSchema.safeParse(approval.totalMax).success
  || BigInt(approval.usedTotal) <= BigInt(approval.totalMax), 'usedTotal exceeds totalMax');
export const AgentPolicyWireSchema = AgentPolicySchema.extend({
  perTxMax: DecimalTextSchema, rolling24hMax: DecimalTextSchema, lifetimeMax: DecimalTextSchema,
  gasBudget24h: DecimalTextSchema, approvalThreshold: DecimalTextSchema.nullable(),
});
export const WalletPolicyWireSchema = WalletPolicySchema.extend({ rolling24hMax: DecimalTextSchema, safetyReserve: DecimalTextSchema });
export const RECEIPT_PAYLOAD_SCHEMAS = {
  decision_allowed: z.strictObject({ ...decision, reasons: z.array(ReasonCodeSchema).length(0) }),
  decision_denied: z.strictObject({ ...decision, reasons: z.array(ReasonCodeSchema).min(1) }),
  approval_required: z.strictObject({ ...decision, reasons: z.tuple([z.literal('APPROVAL_REQUIRED')]) }),
  approved: z.strictObject({ ...request, approvalId: IdSchema, requestDigest: Sha256Schema,
    policyRevision: CountSchema.min(1), expiresAt: TimestampSchema }),
  rejected: z.strictObject({ ...request, reason: z.string().min(1) }),
  expired: z.strictObject({ ...request, reason: z.string().min(1) }),
  cancelled: z.strictObject({ ...request, reason: z.string().min(1) }),
  standing_approval_granted: z.strictObject({ agentId: IdSchema, approval: StandingApprovalWireSchema })
    .refine((payload) => payload.agentId === payload.approval.agentId, 'Approval agent mismatch'),
  standing_approval_revoked: z.strictObject({ agentId: IdSchema, approvalId: IdSchema, revokedAt: TimestampSchema }),
  standing_approval_used: z.strictObject({ ...request, approvalId: IdSchema, amount: DecimalTextSchema }),
  queued: z.strictObject(request),
  submitted: z.strictObject({ ...request, attemptId: IdSchema, txHash: ChainHashSchema,
    phase: z.enum(['intent', 'acknowledged']) }),
  succeeded: z.strictObject(settlement),
  failed: z.strictObject({ ...settlement, reason: z.string().min(1),
    /** Explicit zero-execution resolution, not a measured chain failure. */
    resolution: z.strictObject({ attemptId: IdSchema, basis: z.enum(['owner_attested', 'chain_proof', 'never_offered']),
      evidence: z.string().min(1) }).optional() })
    .refine((p) => p.resolution === undefined || (p.gasBurnt === '0' && p.tokensBurnt === '0'
      && p.receiptIds.length === 0 && p.reason.length <= 1024 && p.reason.trim().length > 0), 'Resolution requires zero execution'),
  outcome_unknown: z.strictObject({ ...request, attemptId: IdSchema, txHash: ChainHashSchema, reason: z.string().min(1) }),
  freeze: FreezeSchema.refine((freeze) => freeze.frozen, 'Expected frozen=true'),
  unfreeze: FreezeSchema.refine((freeze) => !freeze.frozen, 'Expected frozen=false'),
  policy_updated: z.discriminatedUnion('scope', [
    z.strictObject({ scope: z.literal('agent'), policy: AgentPolicyWireSchema }),
    z.strictObject({ scope: z.literal('wallet'), policy: WalletPolicyWireSchema }),
  ]),
  agent_created: z.strictObject({ agent: AgentSchema }),
  agent_revoked: z.strictObject({ agentId: IdSchema, reason: z.string().min(1) }),
  credential_issued: z.strictObject({ agentId: IdSchema, credentialId: IdSchema }),
  credential_revoked: z.strictObject({ agentId: IdSchema, credentialId: IdSchema }),
} as const;
export const RECEIPT_EVENT_TYPES = [
  'decision_allowed', 'decision_denied', 'approval_required', 'approved', 'rejected',
  'expired', 'cancelled', 'standing_approval_granted', 'standing_approval_revoked',
  'standing_approval_used', 'queued', 'submitted', 'succeeded', 'failed', 'outcome_unknown',
  'freeze', 'unfreeze', 'policy_updated', 'agent_created', 'agent_revoked', 'credential_issued', 'credential_revoked',
] as const satisfies readonly (keyof typeof RECEIPT_PAYLOAD_SCHEMAS)[];
export const ReceiptEventTypeSchema = z.enum(RECEIPT_EVENT_TYPES);
export type ReceiptEventType = z.infer<typeof ReceiptEventTypeSchema>;
/** Wallet policy/global freeze stay owner-only; agent chains bind event identity. */
function checkChainScope(event: { chainId: string; type: string; payload: unknown }, ctx: z.RefinementCtx): void {
  if (event.chainId === OWNER_CHAIN_ID) return;
  const payload = event.payload as Record<string, unknown>;
  let agentId: unknown = payload['agentId'];
  if (event.type === 'agent_created') agentId = (payload['agent'] as { id: string }).id;
  if (event.type === 'policy_updated') agentId = payload['scope'] === 'agent'
    ? (payload['policy'] as { agentId: string }).agentId : undefined;
  if (agentId !== event.chainId.slice('agent:'.length)) {
    ctx.addIssue({ code: 'custom', message: 'Receipt payload is not scoped to this agent chain' });
  }
}
function variant<T extends ReceiptEventType, S extends z.ZodType>(type: T, payload: S) {
  const append = { chainId: ChainIdSchema, type: z.literal(type), at: TimestampSchema, payload };
  const preimage = { ...append, seq: CountSchema.min(1), prevHash: Sha256Schema };
  return {
    append: z.strictObject(append), preimage: z.strictObject(preimage),
    event: z.strictObject({ ...preimage, hash: Sha256Schema, signature: SignatureSchema }),
  };
}
const variants = [
  variant('decision_allowed', RECEIPT_PAYLOAD_SCHEMAS.decision_allowed),
  variant('decision_denied', RECEIPT_PAYLOAD_SCHEMAS.decision_denied),
  variant('approval_required', RECEIPT_PAYLOAD_SCHEMAS.approval_required),
  variant('approved', RECEIPT_PAYLOAD_SCHEMAS.approved),
  variant('rejected', RECEIPT_PAYLOAD_SCHEMAS.rejected),
  variant('expired', RECEIPT_PAYLOAD_SCHEMAS.expired),
  variant('cancelled', RECEIPT_PAYLOAD_SCHEMAS.cancelled),
  variant('standing_approval_granted', RECEIPT_PAYLOAD_SCHEMAS.standing_approval_granted),
  variant('standing_approval_revoked', RECEIPT_PAYLOAD_SCHEMAS.standing_approval_revoked),
  variant('standing_approval_used', RECEIPT_PAYLOAD_SCHEMAS.standing_approval_used),
  variant('queued', RECEIPT_PAYLOAD_SCHEMAS.queued),
  variant('submitted', RECEIPT_PAYLOAD_SCHEMAS.submitted),
  variant('succeeded', RECEIPT_PAYLOAD_SCHEMAS.succeeded),
  variant('failed', RECEIPT_PAYLOAD_SCHEMAS.failed),
  variant('outcome_unknown', RECEIPT_PAYLOAD_SCHEMAS.outcome_unknown),
  variant('freeze', RECEIPT_PAYLOAD_SCHEMAS.freeze),
  variant('unfreeze', RECEIPT_PAYLOAD_SCHEMAS.unfreeze),
  variant('policy_updated', RECEIPT_PAYLOAD_SCHEMAS.policy_updated),
  variant('agent_created', RECEIPT_PAYLOAD_SCHEMAS.agent_created),
  variant('agent_revoked', RECEIPT_PAYLOAD_SCHEMAS.agent_revoked),
  variant('credential_issued', RECEIPT_PAYLOAD_SCHEMAS.credential_issued),
  variant('credential_revoked', RECEIPT_PAYLOAD_SCHEMAS.credential_revoked),
] as const;
/** Hash only the preimage fields; sign the 32 decoded hash bytes. */
export const ReceiptPreimageSchema = z.discriminatedUnion('type', [variants[0].preimage, ...variants.slice(1).map((item) => item.preimage)])
  .superRefine(checkChainScope);
export type ReceiptPreimage = z.infer<typeof ReceiptPreimageSchema>;
export const ReceiptEventSchema = z.discriminatedUnion('type', [variants[0].event, ...variants.slice(1).map((item) => item.event)])
  .superRefine(checkChainScope);
export type ReceiptEvent = z.infer<typeof ReceiptEventSchema>;
export const AppendReceiptSchema = z.discriminatedUnion('type', [variants[0].append, ...variants.slice(1).map((item) => item.append)])
  .superRefine(checkChainScope);
export type AppendReceipt = z.infer<typeof AppendReceiptSchema>;
export const ReceiptVerificationSchema = z.strictObject({
  valid: z.boolean(), chainId: ChainIdSchema, checked: CountSchema,
  firstInvalidSeq: CountSchema.min(1).nullable(), reason: z.string().nullable(),
});
export type ReceiptVerification = z.infer<typeof ReceiptVerificationSchema>;
