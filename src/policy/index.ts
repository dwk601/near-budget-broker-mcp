import { z } from 'zod';
import {
  DEFAULT_BALANCE_MAX_AGE_MS, ERROR_CODES, MAX_U128,
  PolicyEvaluationInputSchema, PolicyRequestSchema, UsageSnapshotSchema,
} from '../contracts/index.js';
import type {
  AgentRemaining, ApprovalService, PolicyDecision, PolicyEvaluationInput,
  PolicyEvaluator, ReasonCode, StandingApproval, TransferPreview,
} from '../contracts/index.js';

export interface PolicyEvaluatorOptions {
  /** Must be the daemon's configured freshness bound, not a caller-supplied age. */
  balanceMaxAgeMs?: number;
  /** Optional B12 pure matcher. Local grant bounds are always enforced as well. */
  matchStandingApproval?: ApprovalService['matchStandingApproval'];
}

/** Internal/advisory projection. Remaining quotas are BEFORE the proposed request,
 * clamped at zero, and are not a promise of capacity or authorization. No wallet
 * balance, wallet-wide usage or other agents' budgets are exposed here. */
export interface PolicyPreview extends TransferPreview { remaining: AgentRemaining }

// Invalid transfer amounts and invalid/missing balance observations have explicit
// decision codes. Keep validating the other fields so these do not mask freezes
// or independent hard-cap failures.
// Zod records discard the own key "__proto__". IDs are arbitrary strings, so
// validate every own reservation value without discarding a real reservation.
const ReservationsSchema = z.custom<Record<string, bigint>>((value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Object.values(value).every((amount: unknown) =>
    typeof amount === 'bigint' && amount >= 0n && amount <= MAX_U128));
const EvaluationSchema = PolicyEvaluationInputSchema.extend({
  request: PolicyRequestSchema.extend({ amount: z.bigint() }),
  usage: UsageSnapshotSchema.extend({ balance: z.unknown(), standingReserved: ReservationsSchema }),
});

function ordered(reasons: ReadonlySet<ReasonCode>): ReasonCode[] {
  // The frozen vocabulary order is the single deterministic reason ordering.
  return ERROR_CODES.filter((code) => reasons.has(code));
}

/** Checked u128 addition: no wrapping, saturation, or float conversion. */
function sum(...amounts: bigint[]): bigint | null {
  let total = 0n;
  for (const amount of amounts) {
    if (amount < 0n || amount > MAX_U128 - total) return null;
    total += amount;
  }
  return total;
}

function exceeds(cap: bigint, ...amounts: bigint[]): boolean {
  const total = sum(...amounts);
  return total === null || total > cap;
}

function remaining(cap: bigint, used: bigint): bigint {
  return used >= cap ? 0n : cap - used;
}

function zeroRemaining(): AgentRemaining {
  return { perTx: 0n, rolling24h: 0n, lifetime: 0n, gas24h: 0n,
    requestsPerMinute: 0, outstandingSlots: 0 };
}

/** A PolicyEvaluator consumes Store's already-windowed totals verbatim:
 * settled activity is in (now-24h, now], rate in (now-60s, now]; ALL active holds
 * (including pending approval and outcome_unknown, however old) remain included.
 * Store must exclude the re-evaluated request from every applicable total.
 * There are intentionally no timestamps/hold lists in this frozen input port.
 */
export class PurePolicyEvaluator implements PolicyEvaluator {
  private readonly balanceMaxAgeMs: number;
  private readonly matcher: PolicyEvaluatorOptions['matchStandingApproval'];

  constructor(options: PolicyEvaluatorOptions = {}) {
    const age = options.balanceMaxAgeMs ?? DEFAULT_BALANCE_MAX_AGE_MS;
    if (!Number.isSafeInteger(age) || age < 1 || age > 60_000) {
      throw new RangeError('balanceMaxAgeMs must be an integer in 1..60000');
    }
    this.balanceMaxAgeMs = age;
    this.matcher = options.matchStandingApproval;
  }

  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    return this.assess(input).decision;
  }

  preview(input: PolicyEvaluationInput): PolicyPreview {
    return this.assess(input);
  }

  private assess(input: PolicyEvaluationInput): PolicyPreview {
    const parsed = EvaluationSchema.safeParse(input);
    if (!parsed.success) {
      // Domain ports normally receive validated records. Still fail closed for
      // malformed monetary values, timestamps, counters or balance observations.
      const invalid = new Set<ReasonCode>();
      const monetary = new Set(['amount', 'feeReserve', 'perTxMax', 'rolling24hMax',
        'lifetimeMax', 'gasBudget24h', 'approvalThreshold', 'safetyReserve',
        'agentRolling24h', 'agentLifetime', 'agentGas24h', 'walletRolling24h',
        'outstandingHolds', 'standingReserved', 'totalMax', 'usedTotal']);
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'usage' && issue.path[1] === 'balance') invalid.add('WALLET_CAPACITY');
        else if (issue.path.some((part) => monetary.has(String(part)))) invalid.add('INVALID_AMOUNT');
        else invalid.add('FORBIDDEN');
      }
      return { decision: { kind: 'deny', reasons: ordered(invalid) },
        remaining: zeroRemaining(), policyRevision: null, at: input.now };
    }

    const balanceResult = UsageSnapshotSchema.shape.balance.safeParse(parsed.data.usage.balance);
    const data: PolicyEvaluationInput = { ...parsed.data,
      usage: { ...parsed.data.usage, balance: balanceResult.success ? balanceResult.data : null,
        standingReserved: Object.fromEntries(Object.entries(parsed.data.usage.standingReserved)) } };
    const { agent, agentPolicy: policy, walletPolicy, usage, request, now } = data;
    const reasons = new Set<ReasonCode>();
    const validAmount = request.amount > 0n && request.amount <= MAX_U128;
    if (!validAmount) reasons.add('INVALID_AMOUNT');
    if (agent.status === 'revoked' || request.agentId !== agent.id
      || (policy !== null && policy.agentId !== agent.id)) reasons.add('FORBIDDEN');
    if (usage.globalFrozen) reasons.add('GLOBAL_FROZEN');
    if (usage.agentFrozen) reasons.add('AGENT_FROZEN');
    const effectivePolicy = policy !== null && (policy.expiresAt === undefined || now < policy.expiresAt);
    if (!effectivePolicy || walletPolicy === null) reasons.add('NO_POLICY');

    // Collect ALL independently evaluable hard failures; never stop at the first
    // cap or let an approval suppress a hard failure, even for an expired policy.
    if (policy !== null) {
      if (policy.recipients.mode === 'allowlist' && !policy.recipients.accounts.includes(request.receiverId)) {
        reasons.add('RECIPIENT_NOT_ALLOWED');
      }
      if (validAmount) {
        if (request.amount > policy.perTxMax) reasons.add('PER_TX_EXCEEDED');
        if (exceeds(policy.rolling24hMax, usage.agentRolling24h, request.amount)) reasons.add('ROLLING_24H_EXCEEDED');
        if (exceeds(policy.lifetimeMax, usage.agentLifetime, request.amount)) reasons.add('LIFETIME_EXCEEDED');
      }
      if (exceeds(policy.gasBudget24h, usage.agentGas24h, request.feeReserve)) reasons.add('GAS_BUDGET_EXCEEDED');
      // Compare before incrementing to avoid unsafe counter arithmetic.
      if (usage.agentRequestsLastMinute >= policy.ratePerMinute) reasons.add('RATE_LIMITED');
      if (usage.agentOutstanding >= policy.maxOutstanding) reasons.add('MAX_OUTSTANDING');
    }
    const balance = usage.balance;
    if (balance === null || balance.observedAt > now || balance.validUntil < balance.observedAt
      || now > balance.validUntil || now - balance.observedAt > this.balanceMaxAgeMs) reasons.add('WALLET_CAPACITY');
    if (walletPolicy !== null && validAmount) {
      if (exceeds(walletPolicy.rolling24hMax, usage.walletRolling24h, request.amount)) reasons.add('GLOBAL_CAP_EXCEEDED');
      const required = sum(request.amount, request.feeReserve, usage.outstandingHolds, walletPolicy.safetyReserve);
      if (balance !== null && (required === null || required > balance.spendable)) reasons.add('WALLET_CAPACITY');
    }

    let decision: PolicyDecision;
    if (reasons.size > 0) decision = { kind: 'deny', reasons: ordered(reasons) };
    else if (policy === null || policy.approvalThreshold === null || request.amount <= policy.approvalThreshold) {
      decision = { kind: 'allow', reasons: [] };
    } else if (this.requestApprovalMatches(data)) {
      decision = { kind: 'allow', reasons: [] };
    } else {
      // Pick the smallest ID in UTF-16 code-unit order, independent of supplied
      // grant order and locale. Never sort/mutate the caller's array.
      let match: string | null = null;
      for (const approval of data.standingApprovals) {
        if (this.standingApprovalMatches(approval, data)
          && (match === null || approval.id < match)) match = approval.id;
      }
      decision = match === null
        ? { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] }
        : { kind: 'allow_via_standing_approval', reasons: [], standingApprovalId: match };
    }

    const quotas = effectivePolicy && agent.status === 'active' && !usage.agentFrozen
      && request.agentId === agent.id && policy.agentId === agent.id
      ? { perTx: policy.perTxMax,
        rolling24h: remaining(policy.rolling24hMax, usage.agentRolling24h),
        lifetime: remaining(policy.lifetimeMax, usage.agentLifetime),
        gas24h: remaining(policy.gasBudget24h, usage.agentGas24h),
        requestsPerMinute: Math.max(0, policy.ratePerMinute - usage.agentRequestsLastMinute),
        outstandingSlots: Math.max(0, policy.maxOutstanding - usage.agentOutstanding) }
      : zeroRemaining();
    return { decision, remaining: quotas, policyRevision: policy?.revision ?? null, at: now };
  }

  private requestApprovalMatches(input: PolicyEvaluationInput): boolean {
    const { requestApproval: approval, agentPolicy: policy, now } = input;
    return approval !== null && policy !== null && input.requestId !== null
      && approval.requestId === input.requestId && approval.agentId === input.agent.id
      && approval.requestDigest === input.requestDigest && approval.policyRevision === policy.revision
      && approval.approvedAt <= now && now < approval.expiresAt;
  }

  private standingApprovalMatches(approval: StandingApproval, input: PolicyEvaluationInput): boolean {
    const { request, usage, now } = input;
    // Own-property access: IDs like "constructor" must not read Object.prototype.
    const reservedTotal = Object.hasOwn(usage.standingReserved, approval.id)
      ? usage.standingReserved[approval.id]! : 0n;
    if (approval.agentId !== input.agent.id || approval.revokedAt !== undefined || now >= approval.expiresAt
      || (approval.recipients !== undefined && !approval.recipients.includes(request.receiverId))
      || request.amount > approval.perTxMax
      || exceeds(approval.totalMax, approval.usedTotal, reservedTotal, request.amount)) return false;
    if (this.matcher === undefined) return true;
    const match = this.matcher({ approval, agentId: input.agent.id, receiverId: request.receiverId,
      amount: request.amount, reservedTotal, now });
    return match.kind === 'match' && match.approvalId === approval.id;
  }
}

/** Convenience pure entry points use the frozen default balance freshness bound.
 * Daemons with a different configured bound should construct PurePolicyEvaluator.
 */
export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
  return new PurePolicyEvaluator().evaluate(input);
}

export function previewPolicy(input: PolicyEvaluationInput): PolicyPreview {
  return new PurePolicyEvaluator().preview(input);
}
