import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseNear, BudgetStatusSchema } from '../../src/contracts/index.js';
import type { OwnerPrincipal } from '../../src/contracts/index.js';
import { Fixture, owner } from './fixtures.js';

const fixtures: Fixture[] = [];
function fixture(...args: ConstructorParameters<typeof Fixture>) { const f = new Fixture(...args); fixtures.push(f); return f; }
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });

describe('admission, exact accounting and isolation', () => {
  it('demo: one native payment; per-tx and frozen denials are receipted without signing', async () => {
    const f = fixture(); await f.init();
    const a = await f.agent('A');
    const b = await f.agent('B', { perTxMax: parseNear('0.002') });
    const c = await f.agent('C');
    await f.broker.freeze(owner, { scope: 'agent', agentId: c.agentId }, 'kill switch');
    expect((await f.broker.requestTransfer(a, f.input('A'))).state).toBe('succeeded');
    const denied = await f.broker.requestTransfer(b, f.input('B', parseNear('0.003')));
    expect(denied.reasons).toContain('PER_TX_EXCEEDED');
    const frozen = await f.broker.requestTransfer(c, f.input('C'));
    expect(frozen.reasons).toContain('AGENT_FROZEN');
    expect(f.chain.built).toHaveLength(1); expect(f.chain.broadcasts).toHaveLength(1);
    for (const p of [a, b, c]) {
      const receipts = await f.broker.listReceipts(p, 0, 100);
      expect(receipts.some((r) => ['decision_allowed', 'decision_denied'].includes(r.type))).toBe(true);
      expect(f.receipts.verify(`agent:${p.agentId}`).valid).toBe(true);
      for (const receipt of receipts) expect((await f.broker.verifyReceipt(p, receipt)).valid).toBe(true);
    }
    expect(f.store.read((r) => r.getHold(denied.id))).toBeNull();
    await expect(f.broker.getRequest(b, denied.id + 'no')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const payment = await f.broker.requestTransfer(a, f.input('A'));
    await expect(f.broker.getRequest(b, payment.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.broker.cancelRequest(b, payment.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.broker.verifyReceipt(b, (await f.broker.listReceipts(a, 0, 100))[0]!)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const status = await f.broker.budgetStatus(a);
    expect(BudgetStatusSchema.safeParse(status).success).toBe(true);
    expect(Object.keys(status).sort()).toEqual(['agent', 'agentFrozen', 'at', 'policy', 'remaining', 'usage']);
  });
  it('20 simultaneous requests use one serialized key lane and strictly increasing distinct nonces', async () => {
    const f = fixture(); await f.init(); const a = await f.agent();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.broker.requestTransfer(a, f.input(String(i)))));
    expect(results.every((r) => r.state === 'succeeded')).toBe(true);
    expect(f.chain.built.map((b) => b.transfer.nonce)).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));
    expect(f.chain.paid.size).toBe(20);
    const u = f.store.read((r) => r.getUsageSnapshot(a.agentId, f.now));
    expect(u.agentLifetime).toBe(parseNear('0.020')); expect(u.agentGas24h).toBe(20n * 7n);
  });
  it('contention: every committed+reserved snapshot stays inside agent .007 and global .010', async () => {
    const f = fixture(); await f.init(parseNear('0.010'));
    const a = await f.agent('A', { rolling24hMax: parseNear('0.007'), lifetimeMax: parseNear('0.007') });
    const b = await f.agent('B', { rolling24hMax: parseNear('0.007'), lifetimeMax: parseNear('0.007') });
    let transitions = 0;
    f.afterTransition = (r) => {
      transitions++;
      for (const p of [a, b]) {
        const u = r.getUsageSnapshot(p.agentId, f.now);
        expect(u.agentLifetime).toBeLessThanOrEqual(parseNear('0.007'));
        expect(u.agentRolling24h).toBeLessThanOrEqual(parseNear('0.007'));
        expect(u.walletRolling24h).toBeLessThanOrEqual(parseNear('0.010'));
      }
    };
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => [a, b].map((p) => f.broker.requestTransfer(p, f.input(String(i))))).flat());
    expect(results.filter((r) => r.state === 'succeeded')).toHaveLength(10);
    expect(f.chain.broadcasts).toHaveLength(10); expect(transitions).toBeGreaterThan(40);
  });
  it('wallet solvency includes fee, safety reserve, all holds and settled cached-balance debits', async () => {
    const f = fixture({ autoDispatch: false }); f.chain.balance = parseNear('0.002') + 10n; await f.init(); const a = await f.agent();
    const one = await f.broker.requestTransfer(a, f.input('1')); expect(one.state).toBe('queued');
    const two = await f.broker.requestTransfer(a, f.input('2')); expect(two.reasons).toContain('WALLET_CAPACITY');
    await f.broker.drain();
    const three = await f.broker.requestTransfer(a, f.input('3')); expect(three.reasons).toContain('WALLET_CAPACITY');
    expect(f.chain.broadcasts).toHaveLength(1);
    await f.broker.setWalletPolicy(owner, { revision: 2, rolling24hMax: parseNear('1'), safetyReserve: parseNear('1') }, 1);
    expect((await f.broker.requestTransfer(a, f.input('4'))).reasons).toContain('WALLET_CAPACITY');
  });
  it('stale/unknown RPC balance fails closed and preview writes absolutely nothing', async () => {
    const f = fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
    const head = (await f.broker.listReceipts(a, 0, 100)).length;
    expect((await f.broker.previewTransfer(a, f.input('preview'))).decision.kind).toBe('allow');
    expect(f.store.read((r) => r.findRequestByIdempotency(a.agentId, 'preview'))).toBeNull();
    expect((await f.broker.listReceipts(a, 0, 100)).length).toBe(head);
    f.now += 1001; f.chain.accountError = true;
    expect((await f.broker.requestTransfer(a, f.input('stale'))).reasons).toContain('WALLET_CAPACITY');
    f.chain.accountError = false; f.now += 250; // short failure cache expires
    expect((await f.broker.requestTransfer(a, f.input('fresh'))).state).toBe('queued');
    expect(f.chain.built).toHaveLength(0);
  });
  it('atomic idempotency across connections, concurrent brokers, restart, and changed-payload conflicts', async () => {
    const f = fixture(); await f.init(); const a = await f.agent(); const second = f.another();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? f.broker : second).requestTransfer(a, f.input('key'))));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(f.chain.broadcasts).toHaveLength(1);
    for (const store of f.stores) store.close();
    const restart = f.another(); await restart.start();
    expect((await restart.requestTransfer(a, f.input('key'))).state).toBe('succeeded');
    await expect(restart.requestTransfer(a, { ...f.input('key'), memo: 'changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(restart.requestTransfer(a, f.input('key', 1n))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.chain.broadcasts).toHaveLength(1);
    expect((await restart.listReceipts(a, 0, 100)).filter((r) => r.type === 'decision_allowed')).toHaveLength(1);
  });
  it('actual tokensBurnt, including failed transactions and reserve overage, are charged exactly once', async () => {
    const f = fixture(); await f.init(); const a = await f.agent();
    const success = await f.broker.requestTransfer(a, f.input('ok'));
    f.chain.fail = true; f.chain.fee = 17n;
    const failed = await f.broker.requestTransfer(a, f.input('failed'));
    expect(success.tokensBurnt).toBe(7n); expect(failed.tokensBurnt).toBe(17n); expect(failed.state).toBe('failed');
    await f.broker.reconcile(owner); await f.broker.reconcile(owner);
    const usage = f.store.read((r) => r.getUsageSnapshot(a.agentId, f.now));
    expect(usage.agentLifetime).toBe(parseNear('0.001')); expect(usage.agentGas24h).toBe(24n); expect(usage.outstandingHolds).toBe(0n);
    const accounting = f.store.read((r) => r.listAccounting({ requestId: failed.id }, { limit: 100 }).items);
    expect(accounting.find((x) => x.kind === 'gas_charged')?.amount).toBe(17n);
    expect(accounting.find((x) => x.kind === 'principal_released')?.amount).toBe(failed.amount);
  });
});

describe('freeze, outbox, crash recovery and audit fail-closed', () => {
  it('freeze acknowledged before dispatch gate prevents signing/broadcast; persistent global versus agent scope', async () => {
    const f = fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('A'); const b = await f.agent('B');
    const request = await f.broker.requestTransfer(a, f.input('a'));
    let entered!: () => void; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const broker = f.another({ hooks: { beforeDispatch: async () => { entered(); await gate; } } });
    const draining = broker.drain(); await reached;
    await f.broker.freeze(owner, { scope: 'global' }, 'stop'); release(); await draining;
    expect(f.chain.broadcasts).toHaveLength(0); expect(f.chain.built).toHaveLength(0);
    const restart = f.another(); await restart.start(); expect(f.chain.broadcasts).toHaveLength(0);
    expect((await restart.getFreeze(owner, { scope: 'global' }))?.frozen).toBe(true);
    await restart.freezeSelf(a, 'self freeze');
    await restart.unfreeze(owner, { scope: 'global' }, 'resume other agents');
    await restart.requestTransfer(b, f.input('b')); await restart.drain();
    expect(f.chain.broadcasts).toHaveLength(1);
    expect((await restart.getRequest(a, request.id)).state).toBe('queued');
    await restart.unfreeze(owner, { scope: 'agent', agentId: a.agentId }, 'resume A'); await restart.drain();
    expect(f.chain.broadcasts).toHaveLength(2);
  });
  it.each(['before broadcast', 'after acceptance'] as const)('crash %s recovers stored bytes and pays at most once', async (when) => {
    const f = fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
    const request = await f.broker.requestTransfer(a, f.input('crash'));
    const crash = async () => { throw new Error('simulated process death'); };
    const crashing = f.another({ hooks: when === 'before broadcast' ? { afterPersistSigned: crash } : { afterBroadcast: crash } });
    await expect(crashing.drain()).rejects.toThrow('simulated process death');
    const attempt = f.store.read((r) => r.listAttempts(request.id)[0]!);
    expect(f.store.read((r) => r.getRequest(request.id)?.state)).toBe('signed');
    for (const store of f.stores) store.close();
    const restart = f.another(); await restart.start(); await restart.start();
    expect((await restart.getRequest(a, request.id)).state).toBe('succeeded');
    expect(f.chain.built).toHaveLength(1); expect(f.chain.paid.size).toBe(1);
    expect(f.chain.broadcasts).toEqual([attempt.signedTxBase64]);
    expect(f.stores.at(-1)!.read((r) => r.listOutbox({ limit: 100 }).items)).toHaveLength(0);
  });
  it.each(['unknown', 'throw', 'invalid', 'expired'] as const)('%s keeps full hold, pauses newer nonces, never blindly re-signs', async (mode) => {
    const f = fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
    const request = await f.broker.requestTransfer(a, f.input('unknown'));
    await f.broker.requestTransfer(a, f.input('later'));
    // Choose the oldest deterministically, rather than UUID tie-breaking.
    f.now++; // both are admitted; either can be first, so inspect its stored attempt below
    f.chain.mode = mode; await f.broker.drain();
    const [attempt] = f.store.read((r) => r.listOutbox({ limit: 100 }).items);
    expect(attempt).toBeDefined();
    const unknown = await f.broker.getRequest(a, attempt!.requestId);
    expect(unknown.state).toBe('outcome_unknown');
    expect(f.store.read((r) => r.getHold(unknown.id)?.status)).toBe('active');
    expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(parseNear('0.002'));
    await f.broker.freeze(owner, { scope: 'global' }, 'uncertain');
    const restart = f.another(); await restart.start(); await restart.reconcile(owner, request.id);
    expect(f.chain.built).toHaveLength(1); expect(f.chain.broadcasts).toHaveLength(1);
    await expect(restart.cancelRequest(a, unknown.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Final positive execution evidence can settle even when frozen.
    f.chain.outcomes.set(attempt!.txHash, { kind: 'failed', final: true, receiptIds: [], gasBurnt: 2n, tokensBurnt: 3n, error: 'failed' });
    await restart.reconcile(owner);
    expect((await restart.getRequest(a, unknown.id)).state).toBe('failed');
    expect(f.store.read((r) => r.getHold(unknown.id)?.status)).toBe('committed');
    expect((await restart.budgetStatus(a)).usage.agentLifetime).toBe(parseNear('0.001'));
    expect(f.chain.broadcasts).toHaveLength(1);
  });
  it('positive non-execution evidence alone permits replacement, retaining prior bytes and increasing nonce', async () => {
    const f = fixture(); await f.init(); const a = await f.agent();
    f.chain.mode = 'invalid';
    const request = await f.broker.requestTransfer(a, f.input('proof'));
    expect(request.state).toBe('outcome_unknown');
    const old = f.store.read((r) => r.listAttempts(request.id)[0]!);
    await f.broker.reconcile(owner); expect(f.chain.built).toHaveLength(1);
    f.now += 60_000;
    f.chain.outcomes.set(old.txHash, { kind: 'not_executed', evidence: 'final canonical chain exclusion proof', invalidNonce: true });
    await f.broker.reconcile(owner); // persist proof, crash/restart at this boundary
    expect(f.store.read((r) => r.listOutbox({ limit: 100 }).items)).toHaveLength(0);
    f.chain.mode = 'accepted'; const restart = f.another(); await restart.start();
    expect((await restart.getRequest(a, request.id)).state).toBe('succeeded');
    const attempts = f.store.read((r) => r.listAttempts(request.id));
    expect(attempts).toHaveLength(2);
    expect(attempts.find((a) => a.id === old.id)).toMatchObject({ signedTxBase64: old.signedTxBase64, status: 'proven_not_executed', nonExecutionEvidence: 'final canonical chain exclusion proof' });
    expect(f.chain.built.map((b) => b.transfer.nonce)).toEqual([1n, 2n]); expect(f.chain.paid.size).toBe(1);
  });
  it('audit append failure rolls back admission and pre-broadcast intent; recovery does not leak payment', async () => {
    const f = fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
    const original = f.receipts.append.bind(f.receipts);
    const spy = vi.spyOn(f.receipts, 'append').mockImplementation(() => { throw new Error('signer failed'); });
    await expect(f.broker.requestTransfer(a, f.input('audit'))).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(f.store.read((r) => r.findRequestByIdempotency(a.agentId, 'audit'))).toBeNull();
    expect(f.chain.broadcasts).toHaveLength(0); expect(f.chain.built).toHaveLength(0);
    spy.mockImplementation(original);
    const request = await f.broker.requestTransfer(a, f.input('audit'));
    spy.mockImplementation((tx, event) => { if (event.type === 'submitted') throw new Error('disk full'); return original(tx, event); });
    await expect(f.broker.drain()).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(f.chain.broadcasts).toHaveLength(0); expect(f.store.read((r) => r.getRequest(request.id)?.state)).toBe('signed');
    spy.mockImplementation(original); await f.broker.start();
    expect(f.chain.broadcasts).toHaveLength(1); expect(f.chain.built).toHaveLength(1);
  });
});

describe('owner approvals, lifecycle and checkpoints', () => {
  it('threshold reserves without dispatch; agent cannot approve; stricter policy rejects stale approval', async () => {
    const f = fixture(); await f.init(); const a = await f.agent('A', { approvalThreshold: 1n });
    const pending = await f.broker.requestTransfer(a, f.input('approval'));
    expect(pending.state).toBe('pending_approval'); expect(f.chain.broadcasts).toHaveLength(0);
    await expect(f.broker.approve(a as unknown as OwnerPrincipal, pending.id, f.now + 100)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.broker.approve(owner, pending.id, f.now + 100);
    expect(f.chain.broadcasts).toHaveLength(1);
    const stale = await f.broker.requestTransfer(a, f.input('stale'));
    const policy = (await f.broker.getPolicy(owner, a.agentId))!;
    await f.broker.setPolicy(owner, { ...policy, revision: 2, perTxMax: 1n }, 1);
    await expect(f.broker.approve(owner, stale.id, f.now + 100)).rejects.toMatchObject({ code: 'PER_TX_EXCEEDED' });
    await f.broker.reject(owner, stale.id, 'too large');
    expect(f.store.read((r) => r.getHold(stale.id)?.status)).toBe('released');
    expect(f.chain.broadcasts).toHaveLength(1);
  });
  it('approval checks freezes at approval AND dispatch, and pending sweeper releases reservations once', async () => {
    const f = fixture({ autoDispatch: false, pendingApprovalTtlMs: 200 }); await f.init();
    const a = await f.agent('A', { approvalThreshold: 1n });
    const pending = await f.broker.requestTransfer(a, f.input('wait'));
    await f.broker.freeze(owner, { scope: 'global' }, 'stop');
    await expect(f.broker.approve(owner, pending.id, f.now + 100)).rejects.toMatchObject({ code: 'GLOBAL_FROZEN' });
    await f.broker.unfreeze(owner, { scope: 'global' }, 'resume');
    await f.broker.approve(owner, pending.id, f.now + 100);
    await f.broker.freeze(owner, { scope: 'agent', agentId: a.agentId }, 'stop');
    await f.broker.drain(); expect(f.chain.broadcasts).toHaveLength(0);
    await f.broker.unfreeze(owner, { scope: 'agent', agentId: a.agentId }, 'resume');
    f.now += 101; await f.broker.drain(); // approved grant expired; goes back to approval
    expect((await f.broker.getRequest(a, pending.id)).state).toBe('pending_approval');
    f.now += 100; await f.broker.expirePending(); await f.broker.expirePending();
    expect((await f.broker.getRequest(a, pending.id)).state).toBe('expired');
    expect((await f.broker.budgetStatus(a)).usage.agentOutstanding).toBe(0);
    expect(f.chain.broadcasts).toHaveLength(0);
  });
  it('standing approvals reserve atomically, debit only success, and exhausted/revoked grants wait', async () => {
    const f = fixture(); await f.init(); const a = await f.agent('A', { approvalThreshold: 1n });
    const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('0.002'), totalMax: parseNear('0.002'), expiresAt: f.now + 1000 });
    const results = await Promise.all(['1', '2', '3'].map((key) => f.broker.requestTransfer(a, f.input(key))));
    expect(results.filter((r) => r.state === 'succeeded')).toHaveLength(2);
    expect(results.filter((r) => r.state === 'pending_approval')).toHaveLength(1);
    expect(f.store.read((r) => r.getStandingApproval(grant.id)?.usedTotal)).toBe(parseNear('0.002'));
    const other = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('0.002'), totalMax: parseNear('1'), expiresAt: f.now + 1000 });
    await f.broker.revokeStandingApproval(owner, other.id);
    expect((await f.broker.requestTransfer(a, f.input('revoked'))).state).toBe('pending_approval');
    expect(f.chain.broadcasts).toHaveLength(2);
  });
  it('standing revocation before signing blocks dispatch, cancel/reject release reservations', async () => {
    const f = fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('A', { approvalThreshold: 1n });
    const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('1'), totalMax: parseNear('1'), expiresAt: f.now + 1000 });
    const request = await f.broker.requestTransfer(a, f.input('revoke'));
    await f.broker.revokeStandingApproval(owner, grant.id); await f.broker.drain();
    expect((await f.broker.getRequest(a, request.id)).state).toBe('pending_approval');
    await f.broker.cancelRequest(a, request.id);
    expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
    expect(f.chain.built).toHaveLength(0);
  });
  it('tokens rotate/revoke durably, agent revocation is permanent, CAS and exports checkpoint the trusted chain', async () => {
    const f = fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
    const token = await f.broker.rotateToken(owner, a.credentialId);
    await expect(f.broker.budgetStatus(a)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const fresh = { ...a, credentialId: token.credential.id };
    const request = await f.broker.requestTransfer(fresh, f.input('revoke'));
    await f.broker.revokeAgent(owner, a.agentId, 'permanent');
    await f.broker.unfreeze(owner, { scope: 'agent', agentId: a.agentId }, 'not reactivation');
    await f.broker.drain(); expect(f.chain.broadcasts).toHaveLength(0);
    expect((await f.broker.getRequest(owner, request.id)).state).toBe('denied');
    await expect(f.broker.issueToken(owner, a.agentId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.broker.setWalletPolicy(owner, { revision: 1, rolling24hMax: 0n, safetyReserve: 0n }, null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const receipts = await f.broker.exportReceipts(owner, `agent:${a.agentId}`, 0, 100);
    expect(receipts.length).toBeGreaterThan(5);
    const checkpoint = f.store.read((r) => r.getCheckpointHead(`agent:${a.agentId}`));
    expect(checkpoint?.headHash).toBe(receipts.at(-1)?.hash);
    expect(await f.broker.auditPublicKey(owner)).toBe(f.audit.publicKey);
    expect(f.receipts.verify('owner').valid).toBe(true);
    // Repeated export at the same head does not manufacture a duplicate checkpoint.
    await f.broker.exportReceipts(owner, `agent:${a.agentId}`, 0, 100);
    expect(f.store.read((r) => r.listCheckpoints(`agent:${a.agentId}`, 0, 100))).toHaveLength(1);
  });
});
