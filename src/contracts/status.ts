import { z } from 'zod';
import { AgentSchema, FreezeSchema } from './agents.js';
import { AgentPolicySchema, UsageSnapshotSchema, WalletPolicySchema } from './policy.js';
import { CountSchema, TimestampSchema } from './primitives.js';
import { YoctoNearSchema } from './amounts.js';
import { AccountBalanceSchema } from './chain.js';

/** This projection MUST NOT grow wallet/global fields. Strict schemas reject leakage. */
export const AgentUsageSchema = UsageSnapshotSchema.pick({
  agentRolling24h: true, agentLifetime: true, agentGas24h: true,
  agentRequestsLastMinute: true, agentOutstanding: true,
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export const AgentRemainingSchema = z.strictObject({
  perTx: YoctoNearSchema, rolling24h: YoctoNearSchema, lifetime: YoctoNearSchema,
  gas24h: YoctoNearSchema, requestsPerMinute: CountSchema, outstandingSlots: CountSchema,
});
export type AgentRemaining = z.infer<typeof AgentRemainingSchema>;
/** Remaining is max(0, own cap - own usage); all zero when no effective policy.
 * Not a capacity/approval promise. No wallet policy, balance, aggregate usage or global freeze. */
export const BudgetStatusSchema = z.strictObject({
  agent: AgentSchema, policy: AgentPolicySchema.nullable(), agentFrozen: z.boolean(),
  usage: AgentUsageSchema, remaining: AgentRemainingSchema, at: TimestampSchema,
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;
/** Owner only. Never include this object in agent tool responses or receipts. */
export const WalletStatusSchema = z.strictObject({
  policy: WalletPolicySchema.nullable(), balance: AccountBalanceSchema.nullable(),
  balanceValidUntil: TimestampSchema.nullable(), walletRolling24h: YoctoNearSchema,
  outstandingHolds: YoctoNearSchema, globalFreeze: FreezeSchema.nullable(), at: TimestampSchema,
}).refine((status) => status.globalFreeze === null || status.globalFreeze.scope === 'global', 'Expected global freeze');
export type WalletStatus = z.infer<typeof WalletStatusSchema>;
