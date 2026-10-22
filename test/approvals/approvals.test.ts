import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AppendReceiptSchema, BrokerError, GENESIS_PREV_HASH, MAX_U128, ReceiptEventSchema,
  requestDigest, sha256Hex, receiptHashInput, toDecimalText,
} from '../../src/contracts/index.js';
import type {
  AgentPolicy, AppendReceipt, OwnerPrincipal, PolicyEvaluationInput, ReceiptEvent, ReceiptLog,
  StandingApproval, StandingApprovalMatchInput, StoreTransaction, TransferRequest,
} from '../../src/contracts/index.js';
import {
  TransactionalApprovalService, consumeStandingApproval, listStandingApprovals,
  expirePending, matchStandingApproval, reserveStandingApproval, selectStandingApproval,
} from '../../src/approvals/index.js';
import { SqliteStore } from '../../src/storage/index.js';
import { PurePolicyEvaluator } from '../../src/policy/index.js';

const owner: OwnerPrincipal = { kind: 'owner' };
const agentId = 'agent-a';
const now = 100;
const signature = Buffer.alloc(64).toString('base64');
const publicKey = `ed25519:${'1'.repeat(32)}`;
const hash = '1'.repeat(32);

/** Fake signing only: every append still validates payload/scope, inserts through
 * the real transaction and participates in rollback. Never a production signer. */
class FakeReceiptLog implements ReceiptLog {
  calls = 0;
  failOn = Infinity;
  auditPublicKey(): string { return publicKey; }
  append(tx: StoreTransaction, input: AppendReceipt): ReceiptEvent {
    if (++this.calls === this.failOn) throw new BrokerError('AUDIT_UNAVAILABLE');
    const event = AppendReceiptSchema.parse(input);
    const head = tx.getReceiptHead(event.chainId);
    const preimage = { ...event, seq: (head?.seq ?? 0) + 1, prevHash: head?.hash ?? GENESIS_PREV_HASH };
    const receipt = ReceiptEventSchema.parse({ ...preimage, hash: sha256Hex(receiptHashInput(preimage)), signature });
    tx.insertReceipt(receipt);
    return receipt;
  }
  list(): never { throw new Error('unused fake method'); }
  verify(): never { throw new Error('unused fake method'); }
  verifyReceipt(): never { throw new Error('unused fake method'); }
}
const stores: SqliteStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const policy: AgentPolicy = {
  agentId, revision: 1, perTxMax: 100n, rolling24hMax: 1000n, lifetimeMax: 1000n,
  gasBudget24h: 100n, ratePerMinute: 10, maxOutstanding: 10,
  recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: 5n,
};
function request(id = 'request-1', overrides: Partial<TransferRequest> = {}): TransferRequest {
  const value: TransferRequest = {
    id, agentId, idempotencyKey: id, receiverId: 'recipient.testnet', amount: 10n,
    requestDigest: '', state: 'pending_approval', reasons: ['APPROVAL_REQUIRED'], policyRevision: 1,
    approvalRef: null, createdAt: now, updatedAt: now, expiresAt: 1000, signedAt: null,
    submittedAt: null, completedAt: null, txHash: null, gasBurnt: null, tokensBurnt: null, ...overrides,
  };
  return { ...value, requestDigest: requestDigest({ agentId: value.agentId, receiverId: value.receiverId,
    amount: toDecimalText(value.amount), memo: value.memo ?? null }) };
}
function insert(tx: StoreTransaction, value: TransferRequest): void {
  tx.insertRequest(value);
  tx.putHold({ requestId: value.id, agentId: value.agentId, principal: value.amount, feeReserve: 2n, status: 'active' });
}
function fixture(withRequest = true) {
  const store = new SqliteStore(':memory:', { accountId: 'custody.testnet' });
  stores.push(store);
  const receipts = new FakeReceiptLog();
  const service = new TransactionalApprovalService(owner, receipts);
  store.withImmediateTransaction((tx) => {
    tx.putAgent({ id: agentId, name: 'A', status: 'active', createdAt: 0 });
    tx.putPolicy(policy, null);
    tx.putWalletPolicy({ revision: 1, rolling24hMax: 10000n, safetyReserve: 1n }, null);
    tx.putBalance({ accountId: 'custody.testnet', total: 10000n, locked: 0n, storageReserve: 0n,
      spendable: 10000n, blockHash: hash, observedAt: now }, 10000);
    if (withRequest) insert(tx, request());
  });
  return { store, service, receipts };
}
function grant(overrides: Partial<StandingApproval> = {}): StandingApproval {
  return { id: 'grant-a', agentId, perTxMax: 10n, totalMax: 30n, usedTotal: 0n, expiresAt: 1000, ...overrides };
}
function matchInput(overrides: Partial<StandingApprovalMatchInput> = {}): StandingApprovalMatchInput {
  return { approval: grant(), agentId, receiverId: 'recipient.testnet', amount: 10n,
    reservedTotal: 0n, now, ...overrides };
}
function approveCommand() { return { requestId: 'request-1', approvalId: 'approval-1', now: 200, expiresAt: 900 }; }
function evaluation(store: SqliteStore, at = 200): PolicyEvaluationInput {
  return store.read((view) => ({ agent: view.getAgent(agentId)!, agentPolicy: view.getPolicy(agentId),
    walletPolicy: view.getWalletPolicy(), usage: view.getUsageSnapshot(agentId, at, 'request-1'),
    request: { agentId, receiverId: 'recipient.testnet', amount: 10n, feeReserve: 2n },
    requestId: 'request-1', requestDigest: request().requestDigest,
    standingApprovals: listStandingApprovals(view, agentId), requestApproval: view.getRequestApproval('request-1'), now: at,
  }));
}
function events(store: SqliteStore, chainId = 'owner') {
  return store.read((view) => view.listReceipts(chainId, 0, 1000));
}
function expectCode(operation: () => unknown, code = 'FORBIDDEN') {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}
function overrideTx(tx: StoreTransaction, overrides: Partial<StoreTransaction>): StoreTransaction {
  return new Proxy(tx, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

describe('owner-bound pending approval', () => {
  test('agent/invalid principals rejected before any transaction; frozen port is implemented', () => {
    const log = new FakeReceiptLog();
    for (const principal of [{ kind: 'agent', agentId, credentialId: 'cred' }, null, {}, { kind: 'owner', agentId }]) {
      expectCode(() => new TransactionalApprovalService(principal as OwnerPrincipal, log));
    }
    expect(log.calls).toBe(0);
  });

  test('binds immutable digest/revision/ID/expiry, preserves hold, emits exact owner and agent receipts', () => {
    const { store, service } = fixture();
    const approved = store.withImmediateTransaction((tx) => service.approve(tx, approveCommand()));
    expect(approved).toEqual({ ...request(), state: 'approved', reasons: [],
      approvalRef: { kind: 'request', id: 'approval-1' }, updatedAt: 200 });
    expect(store.read((view) => view.getRequestApproval(approved.id))).toEqual({
      id: 'approval-1', requestId: approved.id, agentId, requestDigest: approved.requestDigest,
      policyRevision: 1, approvedAt: 200, expiresAt: 900,
    });
    expect(store.read((view) => view.getHold(approved.id)?.status)).toBe('active');
    const payload = { requestId: approved.id, agentId, approvalId: 'approval-1',
      requestDigest: approved.requestDigest, policyRevision: 1, expiresAt: 900 };
    expect(events(store)).toMatchObject([{ chainId: 'owner', type: 'approved', at: 200, payload }]);
    expect(events(store, `agent:${agentId}`)).toMatchObject([{ chainId: `agent:${agentId}`, type: 'approved', at: 200, payload }]);
    const evaluator = new PurePolicyEvaluator({ matchStandingApproval });
    const input = evaluation(store);
    expect(evaluator.evaluate(input)).toEqual({ kind: 'allow', reasons: [] });
    for (const changed of [
      { ...input, requestDigest: request('changed', { amount: 11n }).requestDigest },
      { ...input, requestId: 'different-request' },
      { ...input, now: 900 },
      { ...input, requestApproval: { ...input.requestApproval!, agentId: 'other-agent' } },
    ]) expect(evaluator.evaluate(changed).kind).toBe('needs_approval');
    expectCode(() => store.withImmediateTransaction((tx) => service.approve(tx, approveCommand())));
    expect(events(store)).toHaveLength(1);
  });

  test.each(['amount', 'receiverId', 'memo', 'requestDigest'] as const)('recomputes digest: corrupt %s cannot be approved', (field) => {
    const { store, service } = fixture();
    store.withImmediateTransaction((tx) => {
      const original = tx.getRequest('request-1')!;
      const changed: TransferRequest = { ...original, ...(field === 'amount' ? { amount: 11n }
        : field === 'receiverId' ? { receiverId: 'evil.testnet' }
          : field === 'memo' ? { memo: 'changed' } : { requestDigest: 'f'.repeat(64) }) };
      // Deliberately simulate a corrupt storage adapter, bypassing B01's immutability.
      const corrupt = new Proxy(tx, { get(target, key) {
        if (key === 'getRequest') return () => changed;
        if (key === 'getHold') return () => ({ ...target.getHold(original.id)!, principal: changed.amount });
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      expectCode(() => service.approve(corrupt, approveCommand()));
    });
    expect(store.read((view) => view.getRequestApproval('request-1'))).toBeNull();
    expect(events(store)).toHaveLength(0);
  });

  test('new policy cannot approve old pending decision; existing approval never bypasses stricter current caps', () => {
    const { store, service } = fixture();
    store.withImmediateTransaction((tx) => tx.putPolicy({ ...policy, revision: 2, perTxMax: 9n }, 1));
    expectCode(() => store.withImmediateTransaction((tx) => service.approve(tx, approveCommand())));
    expect(store.read((view) => view.getRequest('request-1')?.state)).toBe('pending_approval');
    expect(events(store)).toHaveLength(0);

    const second = fixture();
    second.store.withImmediateTransaction((tx) => second.service.approve(tx, approveCommand()));
    second.store.withImmediateTransaction((tx) => tx.putPolicy({ ...policy, revision: 2, perTxMax: 9n }, 1));
    const evaluator = new PurePolicyEvaluator({ matchStandingApproval });
    expect(evaluator.evaluate(evaluation(second.store))).toEqual({ kind: 'deny', reasons: ['PER_TX_EXCEEDED'] });
    second.store.withImmediateTransaction((tx) => tx.putPolicy({ ...policy, revision: 3 }, 2));
    expect(evaluator.evaluate(evaluation(second.store))).toEqual({ kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] });
  });

  test('broker re-evaluation never lets request or standing grants bypass wallet limits, freeze or revocation', () => {
    const { store, service } = fixture();
    store.withImmediateTransaction((tx) => service.approve(tx, approveCommand()));
    const input = evaluation(store);
    const evaluator = new PurePolicyEvaluator({ matchStandingApproval });
    for (const requestApproval of [input.requestApproval, null]) {
      const authorized = { ...input, requestApproval, standingApprovals: [grant()] };
      expect(evaluator.evaluate(authorized).kind).toBe(requestApproval === null ? 'allow_via_standing_approval' : 'allow');
      for (const [changed, reason] of [
        [{ ...authorized, walletPolicy: { ...input.walletPolicy!, rolling24hMax: 9n } }, 'GLOBAL_CAP_EXCEEDED'],
        [{ ...authorized, usage: { ...input.usage, balance: { spendable: 1n, observedAt: now, validUntil: 1000 } } }, 'WALLET_CAPACITY'],
        [{ ...authorized, usage: { ...input.usage, agentFrozen: true } }, 'AGENT_FROZEN'],
        [{ ...authorized, usage: { ...input.usage, globalFrozen: true } }, 'GLOBAL_FROZEN'],
        [{ ...authorized, agent: { ...input.agent, status: 'revoked' as const } }, 'FORBIDDEN'],
      ] as const) expect(evaluator.evaluate(changed)).toEqual({ kind: 'deny', reasons: [reason] });
    }
    const revoked = fixture();
    revoked.store.withImmediateTransaction((tx) => tx.putAgent({ ...tx.getAgent(agentId)!, status: 'revoked' }));
    expectCode(() => revoked.store.withImmediateTransaction((tx) => revoked.service.approve(tx, approveCommand())));
    expect(revoked.store.read((view) => view.getRequestApproval('request-1'))).toBeNull();
  });

  test.each(['approve', 'reject'] as const)('%s at pending expiry expires and releases principal+fee atomically', (operation) => {
    const { store, service } = fixture();
    const value = store.withImmediateTransaction((tx) => operation === 'approve'
      ? service.approve(tx, { ...approveCommand(), now: 1000, expiresAt: 2000 })
      : service.reject(tx, { requestId: 'request-1', reason: 'no', now: 1000 }));
    expect(value).toMatchObject({ state: 'expired', updatedAt: 1000, completedAt: 1000, approvalRef: null });
    expect(store.read((view) => view.getHold(value.id)?.status)).toBe('released');
    expect(store.read((view) => view.getRequestApproval(value.id))).toBeNull();
    const entries = store.read((view) => view.listAccounting({ requestId: value.id }, { limit: 100 }).items);
    expect(entries.map(({ kind, amount, at }) => ({ kind, amount, at })).sort((a, b) => a.kind.localeCompare(b.kind)))
      .toEqual([{ kind: 'fee_released', amount: 2n, at: 1000 }, { kind: 'principal_released', amount: 10n, at: 1000 }]);
    expect(events(store)).toMatchObject([{ type: 'expired', payload: { requestId: value.id, agentId } }]);
    expect(events(store, `agent:${agentId}`)[0]?.type).toBe('expired');
    expect(store.read((view) => view.getUsageSnapshot(agentId, 1000).outstandingHolds)).toBe(0n);
    expectCode(() => store.withImmediateTransaction((tx) => service.approve(tx, { ...approveCommand(), now: 1001, expiresAt: 2000 })));
  });

  test('reject releases reservations and records reason once; cannot subsequently approve', () => {
    const { store, service } = fixture();
    const value = store.withImmediateTransaction((tx) => service.reject(tx, { requestId: 'request-1', reason: 'Owner declined', now: 200 }));
    expect(value).toMatchObject({ state: 'rejected', completedAt: 200 });
    expect(events(store)).toMatchObject([{ type: 'rejected', payload: { requestId: value.id, agentId, reason: 'Owner declined' } }]);
    expect(events(store, `agent:${agentId}`)).toHaveLength(1);
    expect(store.read((view) => view.getHold(value.id)?.status)).toBe('released');
    expect(store.read((view) => view.listAccounting({ requestId: value.id }, { limit: 100 }).items)).toHaveLength(2);
    expectCode(() => store.withImmediateTransaction((tx) => service.approve(tx, approveCommand())));
    expectCode(() => store.withImmediateTransaction((tx) => service.reject(tx, { requestId: value.id, reason: 'again', now: 201 })));
    expect(events(store)).toHaveLength(1);
  });

  test('approval expiry cannot extend pending lifetime; invalid/missing state, time, policy or hold fails closed', () => {
    const { store, service } = fixture();
    store.withImmediateTransaction((tx) => service.approve(tx, { ...approveCommand(), expiresAt: 2000 }));
    expect(store.read((view) => view.getRequestApproval('request-1')?.expiresAt)).toBe(1000);
    for (const chainId of ['owner', `agent:${agentId}`]) {
      expect(events(store, chainId)).toMatchObject([{ type: 'approved', payload: { expiresAt: 1000 } }]);
    }
    for (const command of [{ ...approveCommand(), expiresAt: 200 }, { ...approveCommand(), now: 99 },
      { ...approveCommand(), expiresAt: NaN }]) {
      const fresh = fixture();
      expectCode(() => fresh.store.withImmediateTransaction((tx) => fresh.service.approve(tx, command)));
    }
    expectCode(() => store.withImmediateTransaction((tx) => service.approve(tx, { ...approveCommand(), requestId: 'absent' })), 'NOT_FOUND');
    const fresh = fixture();
    fresh.store.withImmediateTransaction((tx) => tx.putHold({ ...tx.getHold('request-1')!, status: 'released' }));
    expectCode(() => fresh.store.withImmediateTransaction((tx) => fresh.service.approve(tx, approveCommand())));
    const expiredPolicy = fixture();
    expiredPolicy.store.withImmediateTransaction((tx) => tx.putPolicy({ ...policy, revision: 2, expiresAt: 200 }, 1));
    expectCode(() => expiredPolicy.store.withImmediateTransaction((tx) => expiredPolicy.service.approve(tx, approveCommand())), 'NO_POLICY');
  });

  test.each(['approve', 'reject', 'expired'] as const)('%s: second receipt failure rolls back approval/state/hold/accounting and first receipt', (operation) => {
    const { store, service, receipts } = fixture();
    receipts.failOn = 2;
    expectCode(() => store.withImmediateTransaction((tx) => operation === 'approve' ? service.approve(tx, approveCommand())
      : service.reject(tx, { requestId: 'request-1', reason: 'no', now: operation === 'expired' ? 1000 : 200 })), 'AUDIT_UNAVAILABLE');
    expect(store.read((view) => view.getRequest('request-1'))).toEqual(request());
    expect(store.read((view) => view.getRequestApproval('request-1'))).toBeNull();
    expect(store.read((view) => view.getHold('request-1')?.status)).toBe('active');
    expect(store.read((view) => view.listAccounting({}, { limit: 100 }).items)).toEqual([]);
    expect(events(store)).toEqual([]);
    expect(events(store, `agent:${agentId}`)).toEqual([]);
  });
});

describe('validation and owner-independent expiry regressions', () => {
  test('reject maps lone-surrogate reason to stable FORBIDDEN before writes', () => {
    const { store, service, receipts } = fixture();
    expectCode(() => store.withImmediateTransaction((tx) => service.reject(tx,
      { requestId: 'request-1', reason: '\ud800', now: 200 })));
    expect(receipts.calls).toBe(0);
    expect(store.read((view) => view.getRequest('request-1'))).toEqual(request());
    expect(store.read((view) => view.getHold('request-1')?.status)).toBe('active');
  });

  test('reserve validates time, request and approval ID before touching storage', () => {
    const { store } = fixture(false);
    const getStandingApproval = vi.fn(() => grant());
    store.withImmediateTransaction((tx) => {
      const view = overrideTx(tx, { getStandingApproval });
      for (const invalid of [NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expectCode(() => reserveStandingApproval(view, request(), 'grant-a', invalid));
      }
      for (const id of ['', '\ud800', 'x'.repeat(129)]) {
        expectCode(() => reserveStandingApproval(view, request(), id, now));
        expectCode(() => reserveStandingApproval(view, { ...request(), id }, 'grant-a', now));
      }
      expectCode(() => reserveStandingApproval(view, { ...request(), agentId: '' }, 'grant-a', now));
      expectCode(() => reserveStandingApproval(view, { ...request(), receiverId: 'bad account' }, 'grant-a', now));
      expectCode(() => reserveStandingApproval(view, { ...request(), amount: 0n }, 'grant-a', now), 'INVALID_AMOUNT');
      expectCode(() => reserveStandingApproval(view, { ...request(), amount: MAX_U128 + 1n }, 'grant-a', now), 'INVALID_AMOUNT');
    });
    expect(getStandingApproval).not.toHaveBeenCalled();
  });

  test('reserve reports missing standing approval as NOT_FOUND', () => {
    const { store } = fixture(false);
    expectCode(() => store.withImmediateTransaction((tx) => reserveStandingApproval(tx, request(), 'absent', now)), 'NOT_FOUND');
  });

  test('sweeper expires at the exact boundary without owner, releases both budgets and emits both receipts only once', () => {
    const { store, receipts } = fixture();
    expect(store.withImmediateTransaction((tx) => expirePending(tx, 'request-1', 999, receipts))).toEqual(request());
    expect(receipts.calls).toBe(0);
    // Expiry remains possible after revocation; there is no new spending.
    store.withImmediateTransaction((tx) => tx.putAgent({ ...tx.getAgent(agentId)!, status: 'revoked' }));
    const expired = store.withImmediateTransaction((tx) => expirePending(tx, 'request-1', 1000, receipts));
    expect(expired).toEqual({ ...request(), state: 'expired', updatedAt: 1000, completedAt: 1000 });
    expect(store.read((view) => view.getHold('request-1')?.status)).toBe('released');
    expect(store.read((view) => view.getUsageSnapshot(agentId, 1000))).toMatchObject({ outstandingHolds: 0n, agentOutstanding: 0 });
    const entries = store.read((view) => view.listAccounting({}, { limit: 100 }).items);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'principal_released', amount: 10n, at: 1000 }),
      expect.objectContaining({ kind: 'fee_released', amount: 2n, at: 1000 }),
    ]));
    for (const chainId of ['owner', `agent:${agentId}`]) {
      expect(events(store, chainId)).toMatchObject([{ type: 'expired', at: 1000,
        payload: { requestId: 'request-1', agentId, reason: 'Pending approval expired' } }]);
    }
    expect(store.withImmediateTransaction((tx) => expirePending(tx, 'request-1', 1001, receipts))).toEqual(expired);
    expect(receipts.calls).toBe(2);
    expect(store.read((view) => view.listAccounting({}, { limit: 100 }).items)).toHaveLength(2);
  });

  test('sweeper leaves no-expiry/nonpending work alone, validates inputs and rolls back on audit failure', () => {
    const { store, receipts } = fixture(false);
    store.withImmediateTransaction((tx) => {
      insert(tx, request('no-expiry', { expiresAt: null }));
      insert(tx, request('queued', { state: 'queued', reasons: [] }));
      for (const id of ['no-expiry', 'queued']) {
        expect(expirePending(tx, id, 2000, receipts)).toEqual(tx.getRequest(id));
        expect(tx.getHold(id)?.status).toBe('active');
      }
      expectCode(() => expirePending(tx, 'missing', now, receipts), 'NOT_FOUND');
      expectCode(() => expirePending(tx, '', now, receipts));
      expectCode(() => expirePending(tx, 'no-expiry', NaN, receipts));
    });
    expect(receipts.calls).toBe(0);
    const due = fixture();
    due.receipts.failOn = 2;
    expectCode(() => due.store.withImmediateTransaction((tx) => expirePending(tx, 'request-1', 1000, due.receipts)), 'AUDIT_UNAVAILABLE');
    expect(due.store.read((view) => view.getRequest('request-1'))).toEqual(request());
    expect(due.store.read((view) => view.getHold('request-1')?.status)).toBe('active');
    expect(due.store.read((view) => view.listAccounting({}, { limit: 100 }).items)).toEqual([]);
    expect(events(due.store)).toEqual([]);
    expect(events(due.store, `agent:${agentId}`)).toEqual([]);
  });
});

describe('pure standing approval bounds and settlement debit', () => {
  test('inclusive perTx and remaining-total limits match, with no input mutation', () => {
    const input = matchInput({ approval: grant({ recipients: ['recipient.testnet'], usedTotal: 10n }), reservedTotal: 10n });
    const before = structuredClone(input);
    Object.freeze(input.approval.recipients);
    Object.freeze(input.approval);
    Object.freeze(input);
    expect(matchStandingApproval(input)).toEqual({ kind: 'match', approvalId: 'grant-a' });
    expect(input).toEqual(before);
    expect(matchStandingApproval(matchInput({ amount: 1n, approval: grant({ perTxMax: 1n, totalMax: 1n }) })).kind).toBe('match');
  });

  test.each([
    { approval: grant({ agentId: 'other' }) },
    { approval: grant({ recipients: [] }) },
    { approval: grant({ recipients: ['other.testnet'] }) },
    { approval: grant({ perTxMax: 9n }) },
    { approval: grant({ usedTotal: 30n }) },
    { approval: grant({ usedTotal: 10n }), reservedTotal: 11n },
    { approval: grant({ expiresAt: now }) },
    { approval: grant({ revokedAt: 0 }) },
    { approval: grant({ revokedAt: now + 100 }) },
    { approval: grant({ perTxMax: MAX_U128, totalMax: MAX_U128, usedTotal: MAX_U128 - 1n }), reservedTotal: 1n, amount: 1n },
    { reservedTotal: MAX_U128 },
    { approval: grant({ perTxMax: 0n, totalMax: 0n }), amount: 1n },
  ])('does not match out-of-bounds grant %#', (overrides) => {
    expect(matchStandingApproval(matchInput(overrides))).toEqual({ kind: 'no_match', reasons: ['APPROVAL_REQUIRED'] });
  });

  test.each([0n, -1n, MAX_U128 + 1n, 1 as unknown as bigint])('invalid amount %s rejected rather than coerced', (amount) => {
    expectCode(() => matchStandingApproval(matchInput({ amount })), 'INVALID_AMOUNT');
    expectCode(() => consumeStandingApproval({ approval: grant(), amount, reservedAmount: 10n }), 'INVALID_AMOUNT');
  });

  test('selection deterministic over all grants; prototype-looking IDs have own reservations', () => {
    const approvals = [grant({ id: 'z' }), grant({ id: 'a', recipients: [] }), grant({ id: 'b' })];
    const input = { approvals, standingReserved: {}, agentId, receiverId: 'recipient.testnet', amount: 10n, now };
    expect(selectStandingApproval(input)).toEqual({ kind: 'match', approvalId: 'b' });
    expect(selectStandingApproval({ ...input, approvals: [...approvals].reverse() })).toEqual({ kind: 'match', approvalId: 'b' });
    expect(approvals.map((a) => a.id)).toEqual(['z', 'a', 'b']);
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect(selectStandingApproval({ ...input, approvals: [grant({ id })] }).kind).toBe('match');
      expect(selectStandingApproval({ ...input, approvals: [grant({ id })], standingReserved: { [id]: 30n } }).kind).toBe('no_match');
    }
  });

  test('selection isolates the requesting agent even if another agent has the smallest grant ID', () => {
    const input = { approvals: [grant({ id: 'a', agentId: 'other' }), grant({ id: 'z' })],
      standingReserved: {}, agentId, receiverId: 'recipient.testnet', amount: 10n, now };
    expect(selectStandingApproval(input)).toEqual({ kind: 'match', approvalId: 'z' });
    expect(selectStandingApproval({ ...input, approvals: input.approvals.slice(0, 1) })).toEqual({ kind: 'no_match', reasons: ['APPROVAL_REQUIRED'] });
  });

  test.each([
    [['a', 'B'], 'B'], [['\u00e9', 'e\u0301'], 'e\u0301'], [['2', '10'], '10'], [['\ue000', '\u{10000}'], '\u{10000}'],
  ] as const)('selection uses UTF-16 ordering for %j and agrees with B02', (ids, expected) => {
    const { store, service } = fixture(false);
    const approvals = ids.map((id) => grant({ id }));
    for (const ordered of [approvals, [...approvals].reverse()]) {
      const input = { approvals: ordered, standingReserved: {}, agentId, receiverId: 'recipient.testnet', amount: 10n, now: 200 };
      expect(selectStandingApproval(input)).toEqual({ kind: 'match', approvalId: expected });
      for (const evaluator of [new PurePolicyEvaluator(), new PurePolicyEvaluator({ matchStandingApproval: service.matchStandingApproval })]) {
        expect(evaluator.evaluate({ ...evaluation(store), standingApprovals: ordered })).toEqual({
          kind: 'allow_via_standing_approval', reasons: [], standingApprovalId: expected,
        });
      }
    }
  });

  test('instance matcher and consumer ports enforce bounds and debit successful principal', () => {
    const { service } = fixture(false);
    expect(service.matchStandingApproval(matchInput())).toEqual({ kind: 'match', approvalId: 'grant-a' });
    expect(service.matchStandingApproval(matchInput({ reservedTotal: 30n }))).toEqual({ kind: 'no_match', reasons: ['APPROVAL_REQUIRED'] });
    const approval = grant();
    expect(service.consumeStandingApproval({ approval, amount: 10n, reservedAmount: 10n })).toEqual({ ...approval, usedTotal: 10n });
    expect(approval.usedTotal).toBe(0n);
    expectCode(() => service.consumeStandingApproval({ approval, amount: 10n, reservedAmount: 9n }));
  });

  test('successful debit is monotonic and pure, including expired/revoked grants; requires covered reservation', () => {
    const original = grant({ usedTotal: 10n, expiresAt: 0, revokedAt: 0, recipients: [] });
    const before = structuredClone(original);
    const consumed = consumeStandingApproval({ approval: original, amount: 10n, reservedAmount: 10n });
    expect(consumed).toEqual({ ...original, usedTotal: 20n });
    expect(original).toEqual(before);
    expect(consumed).not.toBe(original);
    consumed.recipients!.push('changed.testnet');
    expect(original.recipients).toEqual([]);
    expect(consumeStandingApproval({ approval: consumed, amount: 10n, reservedAmount: 12n }).usedTotal).toBe(30n);
    expectCode(() => consumeStandingApproval({ approval: original, amount: 10n, reservedAmount: 9n }));
    expectCode(() => consumeStandingApproval({ approval: grant({ usedTotal: 21n }), amount: 10n, reservedAmount: 10n }));
    expect(consumeStandingApproval({ approval: grant({ totalMax: MAX_U128, usedTotal: MAX_U128 - 1n }), amount: 1n, reservedAmount: 1n }).usedTotal).toBe(MAX_U128);
    expectCode(() => consumeStandingApproval({ approval: grant({ totalMax: MAX_U128, usedTotal: MAX_U128 }), amount: 1n, reservedAmount: 1n }));
  });
});

describe('transactional standing grants, derived reservations and receipts', () => {
  function grantIn(store: SqliteStore, service: TransactionalApprovalService, overrides: Partial<StandingApproval> = {}) {
    const { usedTotal: _used, revokedAt: _revoked, ...value } = grant(overrides);
    return store.withImmediateTransaction((tx) => service.grantStandingApproval(tx, { ...value, now }));
  }

  test('owner grant starts at zero, serializes bounded amounts; duplicate cannot reset usage; revoke is immediate/idempotent', () => {
    const { store, service } = fixture(false);
    expect(grantIn(store, service, { recipients: ['recipient.testnet'] })).toEqual(grant({ recipients: ['recipient.testnet'] }));
    expect(events(store)).toMatchObject([{ type: 'standing_approval_granted', payload: { agentId,
      approval: { ...grant({ recipients: ['recipient.testnet'] }), perTxMax: '10', totalMax: '30', usedTotal: '0' } } }]);
    store.withImmediateTransaction((tx) => tx.putStandingApproval(consumeStandingApproval({ approval: tx.getStandingApproval('grant-a')!, amount: 10n, reservedAmount: 10n })));
    expectCode(() => grantIn(store, service));
    const revoked = store.withImmediateTransaction((tx) => service.revokeStandingApproval(tx, { approvalId: 'grant-a', now: 200 }));
    expect(revoked).toEqual(grant({ recipients: ['recipient.testnet'], usedTotal: 10n, revokedAt: 200 }));
    expect(matchStandingApproval(matchInput({ approval: revoked, now: 200 })).kind).toBe('no_match');
    expect(store.withImmediateTransaction((tx) => service.revokeStandingApproval(tx, { approvalId: 'grant-a', now: 300 }))).toEqual(revoked);
    expect(events(store)).toMatchObject([{ type: 'standing_approval_granted' }, { type: 'standing_approval_revoked',
      payload: { agentId, approvalId: 'grant-a', revokedAt: 200 } }]);
    expect(events(store, `agent:${agentId}`).map((event) => event.type)).toEqual(['standing_approval_granted', 'standing_approval_revoked']);
    expectCode(() => store.withImmediateTransaction((tx) => tx.putStandingApproval({ ...revoked, usedTotal: 0n })));
  });

  test('grant omits explicit undefined recipients from both stored record and canonical receipt payload', () => {
    const { store, service } = fixture(false);
    const approval = grantIn(store, service, { recipients: undefined });
    expect(approval).toEqual(grant());
    expect(Object.hasOwn(approval, 'recipients')).toBe(false);
    expect(Object.hasOwn(store.read((view) => view.getStandingApproval(approval.id))!, 'recipients')).toBe(false);
    for (const chainId of ['owner', `agent:${agentId}`]) {
      const event = events(store, chainId)[0]!;
      expect(event.type).toBe('standing_approval_granted');
      if (event.type !== 'standing_approval_granted') throw new Error('wrong receipt type');
      expect(Object.hasOwn(event.payload.approval, 'recipients')).toBe(false);
      expect(event.payload.approval).toEqual({ ...grant(), perTxMax: '10', totalMax: '30', usedTotal: '0' });
    }
  });

  test('byte-identical duplicate zero-usage grant is rejected without a second granted receipt', () => {
    const { store, service } = fixture(false);
    grantIn(store, service);
    expectCode(() => grantIn(store, service));
    expect(store.read((view) => view.getStandingApproval('grant-a'))).toEqual(grant());
    expect(events(store)).toHaveLength(1);
    expect(events(store, `agent:${agentId}`)).toHaveLength(1);
  });

  test('invalid bounds/expired grants, unknown/revoked agents and missing revoke targets denied', () => {
    const { store, service } = fixture(false);
    expectCode(() => grantIn(store, service, { perTxMax: -1n }), 'INVALID_AMOUNT');
    expectCode(() => grantIn(store, service, { totalMax: MAX_U128 + 1n }), 'INVALID_AMOUNT');
    expectCode(() => grantIn(store, service, { expiresAt: now }));
    expectCode(() => grantIn(store, service, { agentId: 'absent' }), 'NOT_FOUND');
    expectCode(() => store.withImmediateTransaction((tx) => service.revokeStandingApproval(tx, { approvalId: 'absent', now })), 'NOT_FOUND');
    store.withImmediateTransaction((tx) => tx.putAgent({ ...tx.getAgent(agentId)!, status: 'revoked' }));
    expectCode(() => grantIn(store, service));
    expect(events(store)).toEqual([]);
  });

  test('reservations derive from holds+refs, prevent oversubscription and exclude own hold at dispatch', () => {
    const { store, service } = fixture(false);
    grantIn(store, service, { totalMax: 10n });
    const first = request('first', { state: 'queued', reasons: [], amount: 6n });
    const second = request('second', { state: 'queued', reasons: [], amount: 5n });
    store.withImmediateTransaction((tx) => insert(tx, { ...first, approvalRef: reserveStandingApproval(tx, first, 'grant-a', now) }));
    expect(store.read((view) => view.getUsageSnapshot(agentId, now).standingReserved['grant-a'])).toBe(6n);
    expect(store.withImmediateTransaction((tx) => reserveStandingApproval(tx, first, 'grant-a', now))).toEqual({ kind: 'standing', id: 'grant-a' });
    expectCode(() => store.withImmediateTransaction((tx) => insert(tx, { ...second, approvalRef: reserveStandingApproval(tx, second, 'grant-a', now) })));
    expect(store.read((view) => view.getRequest(second.id))).toBeNull();
    store.withImmediateTransaction((tx) => {
      tx.updateRequest({ ...tx.getRequest(first.id)!, state: 'cancelled', completedAt: 200, updatedAt: 200 }, 'queued');
      tx.putHold({ ...tx.getHold(first.id)!, status: 'released' });
      insert(tx, { ...second, approvalRef: reserveStandingApproval(tx, second, 'grant-a', 200) });
    });
    expect(store.read((view) => view.getUsageSnapshot(agentId, 200).standingReserved['grant-a'])).toBe(5n);
    expect(store.read((view) => view.getStandingApproval('grant-a')?.usedTotal)).toBe(0n);
    store.withImmediateTransaction((tx) => service.revokeStandingApproval(tx, { approvalId: 'grant-a', now: 201 }));
    expectCode(() => store.withImmediateTransaction((tx) => reserveStandingApproval(tx, second, 'grant-a', 201)));
    expect(store.read((view) => view.getHold(second.id)?.status)).toBe('active'); // revocation does not erase holds
  });

  test('lists every relevant grant in one snapshot, including matches after page 1000', () => {
    const { store } = fixture(false);
    store.withImmediateTransaction((tx) => {
      for (let i = 0; i < 1001; i++) tx.putStandingApproval(grant({ id: String(i).padStart(4, '0'), recipients: i === 1000 ? undefined : [] }));
    });
    const all = store.read((view) => listStandingApprovals(view, agentId));
    expect(all).toHaveLength(1001);
    expect(selectStandingApproval({ approvals: all, standingReserved: {}, agentId,
      receiverId: 'recipient.testnet', amount: 10n, now })).toEqual({ kind: 'match', approvalId: '1000' });
    expect(store.read((view) => listStandingApprovals(view, 'other'))).toEqual([]);
  });

  test.each(['empty', 'mismatched', 'repeated'] as const)('paging rejects %s nonprogressing cursors instead of looping or silently accepting', (kind) => {
    const { store } = fixture(false);
    store.withImmediateTransaction((tx) => {
      const pages = vi.fn<StoreTransaction['listStandingApprovals']>();
      if (kind === 'repeated') pages.mockReturnValueOnce({ items: [grant()], nextCursor: 'grant-a' });
      pages.mockReturnValueOnce(kind === 'empty' ? { items: [], nextCursor: 'grant-a' }
        : { items: [grant()], nextCursor: kind === 'mismatched' ? 'not-the-last-id' : 'grant-a' });
      // Finite fallback ensures a removed guard fails an assertion, not a timeout.
      pages.mockReturnValue({ items: [], nextCursor: null });
      expectCode(() => listStandingApprovals(overrideTx(tx, { listStandingApprovals: pages }), agentId));
      expect(pages).toHaveBeenCalledTimes(kind === 'repeated' ? 2 : 1);
    });
  });

  test.each(['grant', 'revoke'] as const)('%s rolls back on audit failure', (operation) => {
    const { store, service, receipts } = fixture(false);
    if (operation === 'revoke') grantIn(store, service);
    receipts.failOn = receipts.calls + 2;
    expectCode(() => operation === 'grant' ? grantIn(store, service)
      : store.withImmediateTransaction((tx) => service.revokeStandingApproval(tx, { approvalId: 'grant-a', now: 200 })), 'AUDIT_UNAVAILABLE');
    expect(store.read((view) => view.getStandingApproval('grant-a'))).toEqual(operation === 'grant' ? null : grant());
    expect(events(store)).toHaveLength(operation === 'grant' ? 0 : 1);
    expect(events(store, `agent:${agentId}`)).toHaveLength(operation === 'grant' ? 0 : 1);
  });

  function successfulFixture() {
    const value = fixture(false);
    grantIn(value.store, value.service);
    value.store.withImmediateTransaction((tx) => {
      const req = request('request-1', { state: 'queued', reasons: [], approvalRef: { kind: 'standing', id: 'grant-a' } });
      insert(tx, req);
      const nonce = tx.allocateNonce(publicKey, 0n);
      const attempt = { id: 'attempt', requestId: req.id, nonce, publicKey, blockHash: hash, txHash: hash,
        signedTxBase64: 'AA==', status: 'signed' as const, receiptIds: [], gasBurnt: null, tokensBurnt: null,
        createdAt: 200, updatedAt: 200, nonExecutionEvidence: null };
      tx.putAttempt(attempt);
      tx.updateRequest({ ...req, state: 'signed', txHash: hash, signedAt: 200, updatedAt: 200 }, 'queued');
      tx.putAttempt({ ...attempt, status: 'submitted' });
      tx.updateRequest({ ...tx.getRequest(req.id)!, state: 'submitted', submittedAt: 201, updatedAt: 201 }, 'signed');
      tx.putAttempt({ ...attempt, status: 'succeeded', gasBurnt: 1n, tokensBurnt: 1n });
      tx.updateRequest({ ...tx.getRequest(req.id)!, state: 'succeeded', completedAt: 202, updatedAt: 202, gasBurnt: 1n, tokensBurnt: 1n }, 'submitted');
    });
    return value;
  }

  test.each(['failed', 'cancelled', 'submitted', 'outcome_unknown'] as const)('settlement rejects %s with a standing ref and active hold before any writes', (state) => {
    const { store, service, receipts } = fixture(false);
    store.withImmediateTransaction((tx) => {
      const debit = vi.fn();
      const holdWrite = vi.fn();
      const req = request('request-1', { state, approvalRef: { kind: 'standing', id: 'grant-a' } });
      const view = overrideTx(tx, { getRequest: () => req, getStandingApproval: () => grant(),
        getHold: () => ({ requestId: req.id, agentId, principal: req.amount, feeReserve: 2n, status: 'active' }),
        putStandingApproval: debit, putHold: holdWrite });
      expectCode(() => service.settleStandingApproval(view, req.id, 200));
      expect(debit).not.toHaveBeenCalled();
      expect(holdWrite).not.toHaveBeenCalled();
      expect(receipts.calls).toBe(0);
    });
  });

  test.each(['request-ref', 'hold-agent', 'approval-agent'] as const)('settlement rejects mismatched %s before any writes', (mismatch) => {
    const { store, service, receipts } = fixture(false);
    store.withImmediateTransaction((tx) => {
      const debit = vi.fn();
      const holdWrite = vi.fn();
      const req = request('request-1', { state: 'succeeded',
        approvalRef: { kind: mismatch === 'request-ref' ? 'request' : 'standing', id: 'grant-a' } });
      const view = overrideTx(tx, { getRequest: () => req,
        getStandingApproval: () => grant({ agentId: mismatch === 'approval-agent' ? 'other' : agentId }),
        getHold: () => ({ requestId: req.id, agentId: mismatch === 'hold-agent' ? 'other' : agentId,
          principal: req.amount, feeReserve: 2n, status: 'active' }),
        putStandingApproval: debit, putHold: holdWrite });
      expectCode(() => service.settleStandingApproval(view, req.id, 200));
      expect(debit).not.toHaveBeenCalled();
      expect(holdWrite).not.toHaveBeenCalled();
      expect(receipts.calls).toBe(0);
    });
  });

  test('successful settlement debits expired/revoked grant, removes reservation and emits used exactly once', () => {
    const { store, service } = successfulFixture();
    store.withImmediateTransaction((tx) => service.revokeStandingApproval(tx, { approvalId: 'grant-a', now: 300 }));
    const consumed = store.withImmediateTransaction((tx) => {
      const approval = service.settleStandingApproval(tx, 'request-1', 1000);
      tx.appendAccounting({ id: 'principal', requestId: 'request-1', agentId, kind: 'principal_committed', amount: 10n, at: 1000 });
      return approval;
    });
    expect(consumed).toEqual(grant({ usedTotal: 10n, revokedAt: 300 }));
    expect(store.read((view) => view.getHold('request-1')?.status)).toBe('committed');
    expect(store.read((view) => view.getUsageSnapshot(agentId, 1000).standingReserved['grant-a'] ?? 0n)).toBe(0n);
    const used = events(store).filter((event) => event.type === 'standing_approval_used');
    expect(used).toMatchObject([{ at: 1000, payload: { requestId: 'request-1', agentId, approvalId: 'grant-a', amount: '10' } }]);
    expect(events(store, `agent:${agentId}`).at(-1)?.type).toBe('standing_approval_used');
    expectCode(() => store.withImmediateTransaction((tx) => service.settleStandingApproval(tx, 'request-1', 1001)));
    expect(store.read((view) => view.getStandingApproval('grant-a')?.usedTotal)).toBe(10n);
    expect(events(store).filter((event) => event.type === 'standing_approval_used')).toHaveLength(1);
  });

  test('settlement audit failure rolls back debit, hold and event; no consumption for unexecuted work', () => {
    const { store, service, receipts } = successfulFixture();
    expectCode(() => store.withImmediateTransaction((tx) => service.settleStandingApproval(tx, 'request-1', 201)));
    receipts.failOn = receipts.calls + 2;
    expectCode(() => store.withImmediateTransaction((tx) => service.settleStandingApproval(tx, 'request-1', 1000)), 'AUDIT_UNAVAILABLE');
    expect(store.read((view) => view.getStandingApproval('grant-a')?.usedTotal)).toBe(0n);
    expect(store.read((view) => view.getHold('request-1')?.status)).toBe('active');
    expect(events(store).map((event) => event.type)).toEqual(['standing_approval_granted']);
    const fresh = fixture();
    expectCode(() => fresh.store.withImmediateTransaction((tx) => fresh.service.settleStandingApproval(tx, 'request-1', 200)));
  });
});
