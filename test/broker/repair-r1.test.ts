import { afterEach, expect, it, vi } from 'vitest';
import { NON_EXECUTION_MIN_AGE_MS, parseNear } from '../../src/contracts/index.js';
import { Fixture, owner } from './fixtures.js';

let f: Fixture;
afterEach(() => { vi.restoreAllMocks(); f?.close(); });
const success = { kind: 'succeeded' as const, final: true as const, receiptIds: [], gasBurnt: 123n, tokensBurnt: 12345n };

it('P1: late success preserves another active standing reservation and both executions settle exactly once', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init();
  const a = await f.agent('A', { approvalThreshold: 1n }); const b = await f.agent('B');
  const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('0.001'),
    totalMax: parseNear('0.0015'), expiresAt: f.now + 600_000 });
  const first = await f.broker.requestTransfer(a, f.input('late')); f.chain.mode = 'unknown'; await f.broker.drain();
  f.now += NON_EXECUTION_MIN_AGE_MS;
  // requestTransfer returns the original queued view; inspect the persisted hash.
  const firstHash = f.store.read((r) => r.getRequest(first.id)!.txHash!);
  f.chain.outcomes.set(firstHash, { kind: 'not_executed', evidence: 'fresh final exclusion', invalidNonce: true });
  await f.broker.resolveAttempt(owner, first.id, 'exclusion releases reservation');
  expect(f.store.read((r) => r.getHold(first.id)?.status)).toBe('released');
  const second = await f.broker.requestTransfer(a, f.input('reserved')); await f.broker.drain();
  const secondHash = f.store.read((r) => r.getRequest(second.id)!.txHash!);
  const queued = await f.broker.requestTransfer(b, f.input('unrelated'));
  f.chain.outcomes.set(firstHash, success); f.chain.outcomes.set(secondHash, success);
  await f.broker.reconcile(owner, first.id);
  // Inspect BEFORE second settlement: late accounting must not steal its hold.
  expect(f.store.read((r) => r.getStandingApproval(grant.id))).toMatchObject({ usedTotal: 0n, revokedAt: f.now });
  expect(f.store.read((r) => r.getHold(second.id)?.status)).toBe('active');
  await expect(f.broker.drain()).resolves.toBeUndefined();
  expect(f.store.read((r) => r.getStandingApproval(grant.id))).toMatchObject({ usedTotal: second.amount, revokedAt: f.now });
  for (const request of [first, second]) {
    expect(f.store.read((r) => r.getRequest(request.id))).toMatchObject({ state: 'succeeded', tokensBurnt: success.tokensBurnt });
    const entries = f.store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items);
    expect(entries.filter((e) => e.kind === 'principal_committed').map((e) => e.amount)).toEqual([request.amount]);
    expect(entries.filter((e) => e.kind === 'gas_charged' || e.kind === 'gas_correction').reduce((sum, e) => sum + e.amount, 0n)).toBe(success.tokensBurnt);
    expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('committed');
  }
  expect((await f.broker.getFreeze(owner, { scope: 'global' }))?.frozen).toBe(true);
  expect((await f.broker.getRequest(b, queued.id)).state).toBe('queued');
  const before = f.store.read((r) => r.listAccounting({}, { limit: 100 }).items);
  await f.broker.drain(); expect(f.store.read((r) => r.listAccounting({}, { limit: 100 }).items)).toEqual(before);
  await f.broker.unfreeze(owner, { scope: 'global' }, 'reviewed'); f.chain.mode = 'accepted'; await f.broker.drain();
  expect((await f.broker.getRequest(b, queued.id)).state).toBe('succeeded');
  expect(f.receipts.verify('owner').valid).toBe(true); expect(f.receipts.verify(`agent:${a.agentId}`).valid).toBe(true);
});

it('executed settlement with exhausted standing capacity records principal/gas, revokes and freezes instead of throwing', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('A', { approvalThreshold: 1n });
  const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('0.001'),
    totalMax: parseNear('0.0015'), expiresAt: f.now + 600_000 });
  const request = await f.broker.requestTransfer(a, f.input('executed')); f.chain.mode = 'unknown'; await f.broker.drain();
  // Simulate a legacy late correction that consumed capacity without respecting
  // this request's active reservation. Recovery must account even such databases.
  f.store.withImmediateTransaction((tx) => tx.putStandingApproval({ ...grant, usedTotal: request.amount }));
  const hash = f.store.read((r) => r.getRequest(request.id)!.txHash!); f.chain.outcomes.set(hash, success);
  await expect(f.broker.drain()).resolves.toBeUndefined();
  expect((await f.broker.getRequest(a, request.id))).toMatchObject({ state: 'succeeded', tokensBurnt: success.tokensBurnt });
  expect(f.store.read((r) => r.getStandingApproval(grant.id))).toMatchObject({ usedTotal: request.amount, revokedAt: f.now });
  expect((await f.broker.getFreeze(owner, { scope: 'global' }))?.frozen).toBe(true);
  const entries = f.store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items);
  expect(entries.filter((e) => e.kind === 'principal_committed').map((e) => e.amount)).toEqual([request.amount]);
  expect(entries.filter((e) => e.kind === 'gas_charged').map((e) => e.amount)).toEqual([success.tokensBurnt]);
  await f.broker.drain(); expect(f.store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items)).toEqual(entries);
});

it.each(['never-offered', 'owner-approved', 'proven-unexecuted', 'ambiguous'] as const)(
  'P2: unbound standing authorization cannot pin %s work or silently switch grants', async (variant) => {
    f = new Fixture({ autoDispatch: false }); await f.init();
    const a = await f.agent('A', { approvalThreshold: variant === 'owner-approved' ? 1n : null }); const b = await f.agent('B');
    const request = await f.broker.requestTransfer(a, f.input('A'));
    if (variant === 'owner-approved') await f.broker.approve(owner, request.id, f.now + 600_000);
    const offered = variant === 'ambiguous' || variant === 'proven-unexecuted';
    f.chain.mode = 'unknown';
    if (offered) await f.broker.drain();
    else {
      // Actual pre-intent failure, not an artificial state mutation.
      const verify = f.chain.verifyNetwork.bind(f.chain); let afterSign = false;
      const spy = vi.spyOn(f.chain, 'verifyNetwork').mockImplementation(async () => {
        if (afterSign) throw new Error('network unavailable before intent'); return verify();
      });
      const crashing = f.another({ hooks: { afterPersistSigned: async () => { afterSign = true; } } });
      await expect(crashing.drain()).rejects.toHaveProperty('code', 'MAINNET_REFUSED'); spy.mockRestore();
    }
    const attempt = f.store.read((r) => r.listAttempts(request.id)[0]!);
    if (variant === 'proven-unexecuted') {
      f.now += NON_EXECUTION_MIN_AGE_MS;
      f.chain.outcomes.set(attempt.txHash, { kind: 'not_executed', evidence: 'fresh final exclusion', invalidNonce: true });
      await f.broker.reconcile(owner, request.id);
    }
    const policy = (await f.broker.getPolicy(owner, a.agentId))!;
    await f.broker.setPolicy(owner, { ...policy, revision: 2, approvalThreshold: 1n }, 1);
    const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: request.amount,
      totalMax: request.amount * 2n, expiresAt: f.now + 600_000 });
    const queued = await f.broker.requestTransfer(b, f.input('B')); f.chain.mode = 'accepted';
    const restart = f.another();
    for (let n = 0; n < 3; n++) await restart.drain();
    expect(f.store.read((r) => r.getStandingApproval(grant.id)?.usedTotal)).toBe(0n);
    if (variant === 'ambiguous') {
      expect((await f.broker.getRequest(a, request.id)).state).toBe('outcome_unknown');
      expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
      expect((await f.broker.getRequest(b, queued.id)).state).toBe('queued');
      expect(f.chain.broadcasts).toHaveLength(1);
    } else {
      expect((await f.broker.getRequest(a, request.id))).toMatchObject({ state: 'failed', tokensBurnt: 0n });
      expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
      expect((await f.broker.getRequest(b, queued.id)).state).toBe('succeeded');
      expect(f.chain.broadcasts).toHaveLength(offered ? 2 : 1);
      expect(f.receipts.list('owner', 0, 100).find((r) => r.type === 'failed')?.payload).toMatchObject({
        resolution: { basis: offered ? 'chain_proof' : 'never_offered', holdRetained: false },
      });
    }
  });

it('stopDispatch finishes only the invoked attempt, leaves the backlog durable and permits restart', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const requests = [];
  for (let n = 0; n < 8; n++) { requests.push(await f.broker.requestTransfer(a, f.input(`backlog-${n}`))); f.now++; }
  const status = f.chain.txStatus.bind(f.chain);
  vi.spyOn(f.chain, 'txStatus').mockImplementation(async (hash) => { f.broker.stopDispatch(); return status(hash); });
  await f.broker.drain(); await f.broker.drain();
  expect(f.chain.broadcasts).toHaveLength(1);
  expect((await f.broker.getRequest(a, requests[0]!.id)).state).toBe('succeeded');
  for (const request of requests.slice(1)) expect((await f.broker.getRequest(a, request.id)).state).toBe('queued');
  await f.another().start(); expect(f.chain.broadcasts).toHaveLength(requests.length);
});

it('stopDispatch before send intent never invokes a new broadcast and restart recovers signed bytes', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('stop-before-offer'));
  const broker = f.another({ hooks: { afterPersistSigned: async () => { broker.stopDispatch(); } } });
  await broker.drain(); expect(f.chain.broadcasts).toHaveLength(0);
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.lastOfferedAt)).toBeNull();
  await f.another().start(); expect((await f.broker.getRequest(a, request.id)).state).toBe('succeeded');
  expect(f.chain.built).toHaveLength(1);
});
