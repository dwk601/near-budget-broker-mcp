import { describe, expect, test, vi } from 'vitest';
import {
  MAX_U128, PolicyDecisionSchema, PolicyEvaluationInputSchema,
} from '../../src/contracts/index.js';
import type {
  AgentPolicy, PolicyDecision, PolicyEvaluationInput, ReasonCode, RequestApproval,
  StandingApproval, UsageSnapshot,
} from '../../src/contracts/index.js';
import { evaluatePolicy, previewPolicy, PurePolicyEvaluator } from '../../src/policy/index.js';

const NOW = 200_000_000;
const DAY = 86_400_000;
function fixture(): PolicyEvaluationInput {
  return {
    agent: { id: 'agent-a', name: 'A', status: 'active', createdAt: 1 },
    agentPolicy: { agentId: 'agent-a', revision: 2, perTxMax: 100n,
      rolling24hMax: 500n, lifetimeMax: 1_000n, gasBudget24h: 50n,
      ratePerMinute: 5, maxOutstanding: 3, recipients: { mode: 'allow_all', accounts: [] },
      approvalThreshold: null },
    walletPolicy: { revision: 1, rolling24hMax: 2_000n, safetyReserve: 10n },
    usage: { agentRolling24h: 100n, agentLifetime: 200n, agentGas24h: 5n,
      agentRequestsLastMinute: 1, agentOutstanding: 1, walletRolling24h: 300n,
      outstandingHolds: 50n, balance: { spendable: 5_000n, observedAt: NOW, validUntil: NOW + 10_000 },
      standingReserved: {}, agentFrozen: false, globalFrozen: false },
    request: { agentId: 'agent-a', receiverId: 'receiver.testnet', amount: 20n, feeReserve: 2n },
    standingApprovals: [], requestApproval: null, requestId: 'request-a', requestDigest: 'a'.repeat(64), now: NOW,
  };
}
function withPolicy(input: PolicyEvaluationInput, patch: Partial<AgentPolicy>): void {
  input.agentPolicy = { ...input.agentPolicy!, ...patch };
}
function grant(patch: Partial<StandingApproval> = {}): StandingApproval {
  return { id: 'grant-a', agentId: 'agent-a', perTxMax: 100n,
    totalMax: 200n, usedTotal: 30n, expiresAt: NOW + 1000, ...patch };
}
function requestGrant(patch: Partial<RequestApproval> = {}): RequestApproval {
  return { id: 'approval-a', requestId: 'request-a', agentId: 'agent-a',
    requestDigest: 'a'.repeat(64), policyRevision: 2, approvedAt: NOW - 1,
    expiresAt: NOW + 1, ...patch };
}
function expectDecision(input: PolicyEvaluationInput, expected: PolicyDecision): void {
  const result = evaluatePolicy(input);
  expect(result).toEqual(expected);
  expect(PolicyDecisionSchema.parse(result)).toEqual(result);
  expect(previewPolicy(input).decision).toEqual(result);
}
function deny(input: PolicyEvaluationInput, ...reasons: ReasonCode[]): void {
  expectDecision(input, { kind: 'deny', reasons });
}

describe('all hard admission rules', () => {
  test('baseline allows and conforms to the frozen input and output schemas', () => {
    const input = fixture();
    expect(PolicyEvaluationInputSchema.parse(input)).toEqual(input);
    expectDecision(input, { kind: 'allow', reasons: [] });
  });

  const rules: [string, (input: PolicyEvaluationInput) => void, ReasonCode][] = [
    ['revoked agent', (i) => { i.agent.status = 'revoked'; }, 'FORBIDDEN'],
    ['request agent mismatch', (i) => { i.request.agentId = 'other'; }, 'FORBIDDEN'],
    ['policy agent mismatch', (i) => { withPolicy(i, { agentId: 'other' }); }, 'FORBIDDEN'],
    ['global freeze', (i) => { i.usage.globalFrozen = true; }, 'GLOBAL_FROZEN'],
    ['agent freeze', (i) => { i.usage.agentFrozen = true; }, 'AGENT_FROZEN'],
    ['missing agent policy', (i) => { i.agentPolicy = null; }, 'NO_POLICY'],
    ['missing wallet policy', (i) => { i.walletPolicy = null; }, 'NO_POLICY'],
    ['expired policy at exact expiry', (i) => { withPolicy(i, { expiresAt: NOW }); }, 'NO_POLICY'],
    ['expired policy before now', (i) => { withPolicy(i, { expiresAt: NOW - 1 }); }, 'NO_POLICY'],
    ['recipient not listed', (i) => { withPolicy(i, { recipients: { mode: 'allowlist', accounts: ['other.testnet'] } }); }, 'RECIPIENT_NOT_ALLOWED'],
    ['empty recipient allowlist', (i) => { withPolicy(i, { recipients: { mode: 'allowlist', accounts: [] } }); }, 'RECIPIENT_NOT_ALLOWED'],
    ['per-transaction cap', (i) => { withPolicy(i, { perTxMax: 19n }); }, 'PER_TX_EXCEEDED'],
    ['agent rolling principal cap', (i) => { withPolicy(i, { rolling24hMax: 119n }); }, 'ROLLING_24H_EXCEEDED'],
    ['agent lifetime principal cap', (i) => { withPolicy(i, { lifetimeMax: 219n }); }, 'LIFETIME_EXCEEDED'],
    ['wallet rolling principal cap', (i) => { i.walletPolicy!.rolling24hMax = 319n; }, 'GLOBAL_CAP_EXCEEDED'],
    ['gas cap includes proposed fee reserve', (i) => { withPolicy(i, { gasBudget24h: 6n }); }, 'GAS_BUDGET_EXCEEDED'],
    ['rate cap includes proposed distinct admission', (i) => { withPolicy(i, { ratePerMinute: 1 }); }, 'RATE_LIMITED'],
    ['outstanding cap includes proposed hold', (i) => { withPolicy(i, { maxOutstanding: 1 }); }, 'MAX_OUTSTANDING'],
    ['wallet principal + fees + holds + safety', (i) => { i.usage.balance!.spendable = 81n; }, 'WALLET_CAPACITY'],
    ['missing balance', (i) => { i.usage.balance = null; }, 'WALLET_CAPACITY'],
    ['balance expired', (i) => { i.usage.balance!.validUntil = NOW - 1; }, 'WALLET_CAPACITY'],
    ['future balance observation', (i) => { i.usage.balance!.observedAt = NOW + 1; }, 'WALLET_CAPACITY'],
    ['stale despite extended validUntil', (i) => { i.usage.balance!.observedAt = NOW - 10_001; }, 'WALLET_CAPACITY'],
    ['zero amount', (i) => { i.request.amount = 0n; }, 'INVALID_AMOUNT'],
    ['negative amount', (i) => { i.request.amount = -1n; }, 'INVALID_AMOUNT'],
    ['out-of-u128 amount', (i) => { i.request.amount = MAX_U128 + 1n; }, 'INVALID_AMOUNT'],
  ];
  test.each(rules)('%s', (_name, mutate, code) => {
    const input = fixture();
    mutate(input);
    deny(input, code);
  });

  test.each(rules.filter(([, , code]) => code !== 'INVALID_AMOUNT'))(
    'standing and per-request approvals cannot override %s', (_name, mutate, code) => {
      const input = fixture();
      withPolicy(input, { approvalThreshold: 0n });
      input.standingApprovals = [grant()];
      input.requestApproval = requestGrant();
      mutate(input);
      deny(input, code);
    },
  );

  test('returns every applicable hard reason once in frozen vocabulary order, without approval reason', () => {
    const i = fixture();
    i.agent.status = 'revoked';
    i.usage.agentFrozen = true;
    i.usage.globalFrozen = true;
    i.usage.balance = null;
    withPolicy(i, { expiresAt: NOW, perTxMax: 0n, rolling24hMax: 0n, lifetimeMax: 0n,
      gasBudget24h: 0n, ratePerMinute: 0, maxOutstanding: 0,
      recipients: { mode: 'allowlist', accounts: [] }, approvalThreshold: 0n });
    i.walletPolicy!.rolling24hMax = 0n;
    i.standingApprovals = [grant()];
    deny(i, 'FORBIDDEN', 'AGENT_FROZEN', 'GLOBAL_FROZEN', 'NO_POLICY', 'PER_TX_EXCEEDED',
      'ROLLING_24H_EXCEEDED', 'LIFETIME_EXCEEDED', 'GLOBAL_CAP_EXCEEDED',
      'GAS_BUDGET_EXCEEDED', 'RATE_LIMITED', 'MAX_OUTSTANDING',
      'RECIPIENT_NOT_ALLOWED', 'WALLET_CAPACITY');
  });

  test('invalid amount and malformed balance do not mask independent hard failures', () => {
    const i = fixture();
    i.request.amount = 0n;
    i.usage.balance!.observedAt = NaN;
    i.usage.globalFrozen = true;
    i.usage.agentFrozen = true;
    i.agent.status = 'revoked';
    withPolicy(i, { gasBudget24h: 0n, ratePerMinute: 0, maxOutstanding: 0 });
    deny(i, 'FORBIDDEN', 'AGENT_FROZEN', 'GLOBAL_FROZEN', 'GAS_BUDGET_EXCEEDED',
      'RATE_LIMITED', 'MAX_OUTSTANDING', 'WALLET_CAPACITY', 'INVALID_AMOUNT');
  });

  test('missing wallet policy and balance report both failures', () => {
    const i = fixture(); i.walletPolicy = null; i.usage.balance = null;
    deny(i, 'NO_POLICY', 'WALLET_CAPACITY');
  });

  test('two missing policies produce only one NO_POLICY reason', () => {
    const i = fixture(); i.agentPolicy = null; i.walletPolicy = null;
    deny(i, 'NO_POLICY');
  });

  test('every positive monetary and count cap permits equality', () => {
    const i = fixture();
    withPolicy(i, { expiresAt: NOW + 1, perTxMax: 20n, rolling24hMax: 120n,
      lifetimeMax: 220n, gasBudget24h: 7n, ratePerMinute: 2, maxOutstanding: 2,
      recipients: { mode: 'allowlist', accounts: [i.request.receiverId] } });
    i.walletPolicy!.rolling24hMax = 320n;
    i.usage.balance!.spendable = 82n;
    i.usage.balance!.observedAt = NOW - 10_000;
    i.usage.balance!.validUntil = NOW;
    expectDecision(i, { kind: 'allow', reasons: [] });
  });

  test.each(['perTxMax', 'rolling24hMax', 'lifetimeMax', 'gasBudget24h', 'ratePerMinute', 'maxOutstanding'] as const)(
    'zero %s is not unlimited', (field) => {
      const i = fixture();
      const codes = { perTxMax: 'PER_TX_EXCEEDED', rolling24hMax: 'ROLLING_24H_EXCEEDED',
        lifetimeMax: 'LIFETIME_EXCEEDED', gasBudget24h: 'GAS_BUDGET_EXCEEDED',
        ratePerMinute: 'RATE_LIMITED', maxOutstanding: 'MAX_OUTSTANDING' } as const;
      if (field === 'ratePerMinute' || field === 'maxOutstanding') withPolicy(i, { [field]: 0 });
      else withPolicy(i, { [field]: 0n });
      deny(i, codes[field]);
    },
  );

  test('zero gas budget allows zero fees only when there is no gas usage', () => {
    const i = fixture(); i.usage.agentGas24h = 0n; i.request.feeReserve = 0n;
    withPolicy(i, { gasBudget24h: 0n });
    expectDecision(i, { kind: 'allow', reasons: [] });
    i.request.feeReserve = 1n; deny(i, 'GAS_BUDGET_EXCEEDED');
  });

  test('allow_all ignores accounts; allowlist matches exact accounts only', () => {
    const i = fixture(); withPolicy(i, { recipients: { mode: 'allow_all', accounts: ['other.testnet'] } });
    expectDecision(i, { kind: 'allow', reasons: [] });
    withPolicy(i, { recipients: { mode: 'allowlist', accounts: ['receiver'] } });
    deny(i, 'RECIPIENT_NOT_ALLOWED');
  });

  test('gas charges do not count as principal and fee reserve is not principal', () => {
    const i = fixture();
    withPolicy(i, { perTxMax: 20n, rolling24hMax: 120n, lifetimeMax: 220n, gasBudget24h: 7n });
    i.walletPolicy!.rolling24hMax = 320n;
    expectDecision(i, { kind: 'allow', reasons: [] });
  });
});

describe('wallet freshness and exact arithmetic', () => {
  test.each([0, 1, 100, 10_000, 60_000])('observed age %i obeys configured max age', (age) => {
    const i = fixture(); i.usage.balance!.observedAt = NOW - age;
    const evaluator = new PurePolicyEvaluator({ balanceMaxAgeMs: 100 });
    expect(evaluator.evaluate(i)).toEqual(age <= 100
      ? { kind: 'allow', reasons: [] } : { kind: 'deny', reasons: ['WALLET_CAPACITY'] });
    expect(evaluator.preview(i).decision).toEqual(evaluator.evaluate(i));
  });
  test.each([0, -1, 60_001, 1.5, NaN, Infinity])('invalid configured balance age %s fails closed', (age) => {
    expect(() => new PurePolicyEvaluator({ balanceMaxAgeMs: age })).toThrow(RangeError);
  });
  test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('invalid balance observation %s', (at) => {
    const i = fixture(); i.usage.balance!.observedAt = at; deny(i, 'WALLET_CAPACITY');
  });
  test.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('invalid balance expiry %s', (at) => {
    const i = fixture(); i.usage.balance!.validUntil = at; deny(i, 'WALLET_CAPACITY');
  });
  test.each([-1n, MAX_U128 + 1n])('invalid balance amount %s is WALLET_CAPACITY', (spendable) => {
    const i = fixture(); i.usage.balance!.spendable = spendable; deny(i, 'WALLET_CAPACITY');
  });
  test('negative effective wallet availability denies rather than underflowing', () => {
    const i = fixture(); i.usage.balance!.spendable = 0n; deny(i, 'WALLET_CAPACITY');
  });
  test('exact u128-sized request works without Number conversion', () => {
    const i = fixture();
    withPolicy(i, { perTxMax: MAX_U128, rolling24hMax: MAX_U128, lifetimeMax: MAX_U128 });
    i.walletPolicy = { revision: 1, rolling24hMax: MAX_U128, safetyReserve: 0n };
    Object.assign(i.usage, { agentRolling24h: 0n, agentLifetime: 0n, walletRolling24h: 0n, outstandingHolds: 0n });
    i.usage.balance!.spendable = MAX_U128;
    i.request.amount = MAX_U128; i.request.feeReserve = 0n;
    expectDecision(i, { kind: 'allow', reasons: [] });
    i.request.feeReserve = 1n; deny(i, 'WALLET_CAPACITY');
  });
  test('all overflowing accounting additions deny their corresponding caps', () => {
    const i = fixture();
    withPolicy(i, { perTxMax: MAX_U128, rolling24hMax: MAX_U128, lifetimeMax: MAX_U128, gasBudget24h: MAX_U128 });
    i.walletPolicy!.rolling24hMax = MAX_U128;
    Object.assign(i.usage, { agentRolling24h: MAX_U128, agentLifetime: MAX_U128,
      agentGas24h: MAX_U128, walletRolling24h: MAX_U128, outstandingHolds: MAX_U128 });
    i.usage.balance!.spendable = MAX_U128;
    deny(i, 'ROLLING_24H_EXCEEDED', 'LIFETIME_EXCEEDED', 'GLOBAL_CAP_EXCEEDED', 'GAS_BUDGET_EXCEEDED', 'WALLET_CAPACITY');
  });
  test('unsafe counts cannot round into an admission', () => {
    const i = fixture(); i.usage.agentOutstanding = Number.MAX_SAFE_INTEGER + 1; deny(i, 'FORBIDDEN');
  });
});

describe('approval gate (strictly greater than threshold)', () => {
  test.each([null, 20n, 21n])('threshold %s requires no approval', (threshold) => {
    const i = fixture(); withPolicy(i, { approvalThreshold: threshold });
    expectDecision(i, { kind: 'allow', reasons: [] });
  });
  test.each([0n, 19n])('threshold %s requires approval', (threshold) => {
    const i = fixture(); withPolicy(i, { approvalThreshold: threshold });
    expectDecision(i, { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });

  const invalidGrants: [string, Partial<StandingApproval>][] = [
    ['wrong agent', { agentId: 'other' }],
    ['recipient mismatch', { recipients: ['other.testnet'] }],
    ['empty recipients', { recipients: [] }],
    ['per-tx exhausted', { perTxMax: 19n }],
    ['zero per-tx', { perTxMax: 0n }],
    ['total exhausted', { usedTotal: 200n }],
    ['remaining less than amount', { usedTotal: 181n }],
    ['zero total', { totalMax: 0n, usedTotal: 0n }],
    ['expiry exactly now', { expiresAt: NOW }],
    ['expiry in past', { expiresAt: NOW - 1 }],
    ['revoked', { revokedAt: NOW - 1 }],
    ['revoked at zero', { revokedAt: 0 }],
  ];
  test.each(invalidGrants)('standing approval %s cannot satisfy gate', (_name, patch) => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n }); i.standingApprovals = [grant(patch)];
    expectDecision(i, { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });
  test.each([undefined, ['receiver.testnet']])('standing grant recipients %s match', (recipients) => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.standingApprovals = [grant(recipients === undefined ? {} : { recipients })];
    expectDecision(i, { kind: 'allow_via_standing_approval', standingApprovalId: 'grant-a', reasons: [] });
  });
  test('standing reservations + used + proposed amount equal totalMax are accepted, one yocto more is not', () => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.standingApprovals = [grant({ perTxMax: 20n })]; i.usage.standingReserved['grant-a'] = 150n;
    expectDecision(i, { kind: 'allow_via_standing_approval', standingApprovalId: 'grant-a', reasons: [] });
    i.usage.standingReserved['grant-a'] = 151n;
    expectDecision(i, { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });
  test('overflowing standing reservation sum never wraps into approval', () => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.standingApprovals = [grant({ totalMax: MAX_U128, usedTotal: MAX_U128 })];
    i.usage.standingReserved['grant-a'] = 1n;
    expectDecision(i, { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });
  test.each(['constructor', 'toString', '__proto__'])('prototype-shaped grant ID %s is not an implicit reservation', (id) => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n }); i.standingApprovals = [grant({ id })];
    expectDecision(i, { kind: 'allow_via_standing_approval', standingApprovalId: id, reasons: [] });
  });
  test.each(['constructor', 'toString', '__proto__'])('own prototype-shaped reservation %s counts in full', (id) => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.standingApprovals = [grant({ id })];
    i.usage.standingReserved = Object.fromEntries([[id, 151n]]);
    const before = structuredClone(i);
    expectDecision(i, { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
    expect(i).toEqual(before);
  });
  test.each([-1n, MAX_U128 + 1n, '151'])('invalid __proto__ reservation %s cannot be silently dropped', (value) => {
    const i = fixture();
    i.usage.standingReserved = Object.fromEntries([['__proto__', value]]) as Record<string, bigint>;
    deny(i, 'INVALID_AMOUNT');
  });
  test('uses an explicitly injected B12 matcher only after hard caps and local grant checks', () => {
    const matcher = vi.fn(() => ({ kind: 'match' as const, approvalId: 'grant-a' }));
    const evaluator = new PurePolicyEvaluator({ matchStandingApproval: matcher });
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n }); i.standingApprovals = [grant()];
    expect(evaluator.evaluate(i).kind).toBe('allow_via_standing_approval');
    expect(matcher).toHaveBeenCalledExactlyOnceWith({ approval: i.standingApprovals[0], agentId: i.agent.id,
      receiverId: i.request.receiverId, amount: i.request.amount, reservedTotal: 0n, now: NOW });
    matcher.mockClear(); withPolicy(i, { perTxMax: 0n });
    expect(evaluator.evaluate(i)).toEqual({ kind: 'deny', reasons: ['PER_TX_EXCEEDED'] });
    expect(matcher).not.toHaveBeenCalled();
    withPolicy(i, { perTxMax: 100n }); i.standingApprovals[0]!.revokedAt = NOW;
    expect(evaluator.evaluate(i).kind).toBe('needs_approval'); expect(matcher).not.toHaveBeenCalled();
  });
  test('an injected matcher may reject an otherwise valid grant', () => {
    const evaluator = new PurePolicyEvaluator({ matchStandingApproval: () => ({ kind: 'no_match', reasons: ['APPROVAL_REQUIRED'] }) });
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n }); i.standingApprovals = [grant()];
    expect(evaluator.evaluate(i)).toEqual({ kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });
  test('an injected matcher cannot substitute a different approval ID', () => {
    const evaluator = new PurePolicyEvaluator({ matchStandingApproval: () => ({ kind: 'match', approvalId: 'other' }) });
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n }); i.standingApprovals = [grant()];
    expect(evaluator.evaluate(i).kind).toBe('needs_approval');
  });
  test('a matching digest-bound request approval allows without consuming standing approval', () => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.requestApproval = requestGrant({ approvedAt: NOW }); i.standingApprovals = [grant()];
    expectDecision(i, { kind: 'allow', reasons: [] });
  });
  test.each([
    { requestId: 'other' }, { agentId: 'other' }, { requestDigest: 'b'.repeat(64) },
    { policyRevision: 1 }, { expiresAt: NOW }, { expiresAt: NOW - 1 }, { approvedAt: NOW + 1 },
  ] satisfies Partial<RequestApproval>[] )('request approval mismatch %s requires a fresh grant', (patch) => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n }); i.requestApproval = requestGrant(patch);
    expectDecision(i, { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });
  test('null request ID cannot match a request approval', () => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.requestId = null; i.requestApproval = requestGrant();
    expectDecision(i, { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });
  test('invalid per-request approval still permits a valid standing grant', () => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.requestApproval = requestGrant({ policyRevision: 1 }); i.standingApprovals = [grant()];
    expectDecision(i, { kind: 'allow_via_standing_approval', standingApprovalId: 'grant-a', reasons: [] });
  });
});

/** These are explicit Store-port vectors, not a replacement Store implementation.
 * The frozen evaluator has no settled/hold timestamps to filter. Build snapshots
 * according to the documented aggregation contract and assert their decisions. */
describe('windowed usage snapshot contract vectors', () => {
  type Event = { at: number; principal: bigint; fee: bigint; success: boolean };
  function snapshot(now: number, settled: Event[], holds: { principal: bigint; fee: bigint }[], admissions: number[]): UsageSnapshot {
    const u = fixture().usage;
    const inDay = settled.filter((event) => event.at > now - DAY && event.at <= now);
    const held = holds.reduce((total, hold) => total + hold.principal, 0n);
    u.agentRolling24h = inDay.reduce((total, event) => total + (event.success ? event.principal : 0n), held);
    u.walletRolling24h = u.agentRolling24h;
    u.agentLifetime = settled.filter((event) => event.at <= now && event.success)
      .reduce((total, event) => total + event.principal, held);
    u.agentGas24h = inDay.reduce((total, event) => total + event.fee,
      holds.reduce((total, hold) => total + hold.fee, 0n));
    u.outstandingHolds = holds.reduce((total, hold) => total + hold.principal + hold.fee, 0n);
    u.agentOutstanding = holds.length;
    u.agentRequestsLastMinute = admissions.filter((at) => at > now - 60_000 && at <= now).length;
    u.balance = { spendable: 5_000n, observedAt: now, validUntil: now + 10_000 };
    return u;
  }
  test.each([-1, 0, 1, DAY, DAY + 1])('24h settled boundary offset %i uses exclusive cutoff / inclusive now', (offset) => {
    const i = fixture();
    withPolicy(i, { rolling24hMax: 20n, gasBudget24h: 2n });
    i.usage = snapshot(NOW, [{ at: NOW - DAY + offset, principal: 1n, fee: 1n, success: true }], [], []);
    if (offset > 0 && offset <= DAY) deny(i, 'ROLLING_24H_EXCEEDED', 'GAS_BUDGET_EXCEEDED');
    else expectDecision(i, { kind: 'allow', reasons: [] });
  });
  test.each([-1, 0, 1, 60_000, 60_001])('minute boundary offset %i uses exclusive cutoff / inclusive now', (offset) => {
    const i = fixture(); withPolicy(i, { ratePerMinute: 1 });
    i.usage = snapshot(NOW, [], [], [NOW - 60_000 + offset]);
    if (offset > 0 && offset <= 60_000) deny(i, 'RATE_LIMITED');
    else expectDecision(i, { kind: 'allow', reasons: [] });
  });
  test('failed executions charge gas but not principal', () => {
    const i = fixture(); withPolicy(i, { gasBudget24h: 2n, rolling24hMax: 20n, lifetimeMax: 20n });
    i.usage = snapshot(NOW, [{ at: NOW, principal: 999n, fee: 1n, success: false }], [], []);
    deny(i, 'GAS_BUDGET_EXCEEDED');
  });
  test.each(['pending_approval', 'queued', 'signed', 'submitted', 'outcome_unknown'])(
    '%s active holds stay reserved arbitrarily beyond 24h', (_state) => {
      for (const now of [NOW, NOW + DAY, NOW + DAY * 365]) {
        const i = fixture(); i.now = now;
        withPolicy(i, { rolling24hMax: 20n, lifetimeMax: 20n, gasBudget24h: 2n, maxOutstanding: 1 });
        i.walletPolicy!.rolling24hMax = 20n;
        // Holds deliberately have no time filter; settled rows can age out.
        i.usage = snapshot(now, [], [{ principal: 1n, fee: 1n }], []);
        deny(i, 'ROLLING_24H_EXCEEDED', 'LIFETIME_EXCEEDED', 'GLOBAL_CAP_EXCEEDED', 'GAS_BUDGET_EXCEEDED', 'MAX_OUTSTANDING');
      }
    },
  );
  test('re-evaluation uses own-hold-excluded totals and does not subtract a second time', () => {
    const i = fixture(); withPolicy(i, { rolling24hMax: 20n, lifetimeMax: 20n, gasBudget24h: 2n,
      ratePerMinute: 1, maxOutstanding: 1, approvalThreshold: 0n });
    i.walletPolicy = { revision: 1, rolling24hMax: 20n, safetyReserve: 0n };
    i.usage = snapshot(NOW, [], [], []); i.usage.balance!.spendable = 22n;
    i.standingApprovals = [grant({ totalMax: 20n, usedTotal: 0n })];
    expectDecision(i, { kind: 'allow_via_standing_approval', standingApprovalId: 'grant-a', reasons: [] });
    i.usage.agentRolling24h = 1n;
    deny(i, 'ROLLING_24H_EXCEEDED');
  });
});

describe('preview, purity and determinism', () => {
  test('preview returns pre-request own remaining quotas, not wallet data', () => {
    const i = fixture();
    expect(previewPolicy(i)).toEqual({ decision: { kind: 'allow', reasons: [] }, policyRevision: 2, at: NOW,
      remaining: { perTx: 100n, rolling24h: 400n, lifetime: 800n, gas24h: 45n,
        requestsPerMinute: 4, outstandingSlots: 2 } });
  });
  test.each(['missing', 'expired', 'revoked', 'frozen'] as const)('own remaining is zero for %s policy/agent', (state) => {
    const i = fixture();
    if (state === 'missing') i.agentPolicy = null;
    if (state === 'expired') withPolicy(i, { expiresAt: NOW });
    if (state === 'revoked') i.agent.status = 'revoked';
    if (state === 'frozen') i.usage.agentFrozen = true;
    expect(previewPolicy(i).remaining).toEqual({ perTx: 0n, rolling24h: 0n, lifetime: 0n, gas24h: 0n,
      requestsPerMinute: 0, outstandingSlots: 0 });
  });
  test('overdrawn remaining quotas clamp to zero without signed monetary output', () => {
    const i = fixture(); withPolicy(i, { rolling24hMax: 0n, lifetimeMax: 0n, gasBudget24h: 0n, ratePerMinute: 0, maxOutstanding: 0 });
    expect(previewPolicy(i).remaining).toEqual({ perTx: 100n, rolling24h: 0n, lifetime: 0n, gas24h: 0n,
      requestsPerMinute: 0, outstandingSlots: 0 });
  });
  test('repeat calls and reversed grant order choose the same stable approval ID, without mutation or ambient clock', () => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n });
    i.standingApprovals = [grant({ id: 'z' }), grant({ id: 'a' }), grant({ id: 'A' })];
    const before = structuredClone(i);
    function freeze(value: unknown): void {
      if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze); Object.freeze(value);
      }
    }
    freeze(i);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('ambient clock forbidden'); });
    try {
      for (let count = 0; count < 10; count++) {
        expectDecision(i, { kind: 'allow_via_standing_approval', standingApprovalId: 'A', reasons: [] });
        expectDecision({ ...i, standingApprovals: [...i.standingApprovals].reverse() },
          { kind: 'allow_via_standing_approval', standingApprovalId: 'A', reasons: [] });
      }
      expect(i).toEqual(before);
    } finally { clock.mockRestore(); }
  });
  test('preview returns fresh objects and never reserves or debits a grant', () => {
    const i = fixture(); withPolicy(i, { approvalThreshold: 0n }); i.standingApprovals = [grant()];
    const before = structuredClone(i);
    const preview = previewPolicy(i); preview.remaining.perTx = 0n;
    expect(previewPolicy(i).remaining.perTx).toBe(100n);
    expect(i).toEqual(before);
  });
});
