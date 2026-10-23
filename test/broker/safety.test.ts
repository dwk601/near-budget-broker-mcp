import { afterEach, expect, it, vi } from 'vitest';
import { NON_EXECUTION_MIN_AGE_MS as AGE, parseNear } from '../../src/contracts/index.js';
import type { ChainOutcome, StoreReader } from '../../src/contracts/index.js';
import { Fixture, owner } from './fixtures.js';
const delay = () => new Promise<void>((r) => setTimeout(r, 10));
function gate() { let release!: () => void; return { wait: new Promise<void>((r) => { release = r; }), release: () => release() }; }
const exclusion: ChainOutcome = { kind: 'not_executed', evidence: 'retained anchor + aged definitive UNKNOWN_TRANSACTION + final consumed nonce', invalidNonce: true };
const success: ChainOutcome = { kind: 'succeeded', final: true, receiptIds: [], gasBurnt: 123n, tokensBurnt: 7n };
let f: Fixture;
afterEach(() => { vi.restoreAllMocks(); f?.close(); });
async function ambiguous() {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent(); f.chain.mode = 'unknown';
  const request = await f.broker.requestTransfer(a, f.input('ambiguous')); await f.broker.drain();
  return { a, request, attempt: f.store.read((r) => r.listAttempts(request.id)[0]!) };
}
async function proof() {
  const context = await ambiguous(); f.now += AGE;
  f.chain.outcomes.set(context.attempt.txHash, exclusion); await f.broker.reconcile(owner, context.request.id);
  expect(f.store.read((r) => r.listAttempts(context.request.id)[0]?.status)).toBe('proven_not_executed');
  return context;
}

it('N1 a new offer cannot immediately acquire exclusion proof or retry-reset its minimum-age clock', async () => {
  const { request, attempt } = await ambiguous();
  f.chain.outcomes.set(attempt.txHash, exclusion);
  for (let i = 0; i < 5; i++) { f.now += 10; await f.broker.reconcile(owner); }
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.status)).toBe('outcome_unknown');
  expect(f.chain.broadcasts).toHaveLength(1);
  f.now += AGE; await f.broker.reconcile(owner);
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.status)).toBe('proven_not_executed');
});

it.each(['succeeded', 'failed', 'pending'] as const)('N2 stale persisted proof is corrected on newly visible %s without another offer', async (kind) => {
  const { a, request, attempt } = await proof();
  f.chain.outcomes.set(attempt.txHash, kind === 'pending' ? { kind } : kind === 'succeeded' ? success
    : { kind, final: true, gasBurnt: 55n, tokensBurnt: 3n, receiptIds: [], error: 'failed' });
  await f.another().start();
  expect((await f.broker.getRequest(a, request.id)).state).toBe(kind === 'pending' ? 'submitted' : kind);
  expect(f.chain.built).toHaveLength(1); expect(f.chain.broadcasts).toHaveLength(1);
  const stored = f.store.read((r) => r.listAttempts(request.id)[0]!);
  expect(stored.nonExecutionEvidence).toBe(exclusion.kind === 'not_executed' ? exclusion.evidence : '');
  if (kind !== 'pending') {
    expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('committed');
    expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(kind === 'succeeded' ? 7n : 3n);
  }
});

it('N2 rechecks AFTER asynchronous signing immediately before replacement persistence', async () => {
  const { a, request, attempt } = await proof(); const build = f.chain.buildAndSignNativeTransfer.bind(f.chain);
  vi.spyOn(f.chain, 'buildAndSignNativeTransfer').mockImplementation(async (input) => {
    const signed = await build(input); f.chain.outcomes.set(attempt.txHash, success); return signed;
  });
  await f.broker.reconcile(owner, request.id);
  expect((await f.broker.getRequest(a, request.id)).state).toBe('succeeded');
  expect(f.chain.broadcasts).toHaveLength(1); expect(f.store.read((r) => r.listAttempts(request.id))).toHaveLength(1);
  expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(request.amount);
});

it('N2 final in-lane recheck vetoes execution becoming visible immediately after the outside proof', async () => {
  const { a, request, attempt } = await proof(); let lookups = 0;
  const status = f.chain.txStatus.bind(f.chain);
  vi.spyOn(f.chain, 'txStatus').mockImplementation(async (hash) => {
    const outcome = await status(hash);
    if (hash === attempt.txHash && ++lookups === 2) f.chain.outcomes.set(hash, success);
    return outcome;
  });
  await f.broker.reconcile(owner, request.id);
  expect((await f.broker.getRequest(a, request.id)).state).toBe('succeeded');
  expect(f.chain.broadcasts).toHaveLength(1); expect(f.store.read((r) => r.listAttempts(request.id))).toHaveLength(1);
});

it('N2 refuses replacement when the proof recheck becomes unreachable; audit and holds remain intact', async () => {
  const { request } = await proof(); const status = vi.spyOn(f.chain, 'txStatus');
  status.mockResolvedValueOnce(exclusion).mockRejectedValueOnce(new Error('lagging pool switched nodes'));
  await f.broker.reconcile(owner);
  expect(f.store.read((r) => r.listAttempts(request.id))).toHaveLength(1); expect(f.chain.broadcasts).toHaveLength(1);
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
});

it('N3 default resolution refuses valid/in-flight, recent and unreachable transactions, not just positive execution', async () => {
  const { request, attempt } = await ambiguous();
  await expect(f.broker.resolveAttempt(owner, request.id, 'unknown is not proof')).rejects.toHaveProperty('code', 'FORBIDDEN');
  f.chain.outcomes.set(attempt.txHash, exclusion);
  await expect(f.broker.resolveAttempt(owner, request.id, 'too recent')).rejects.toHaveProperty('code', 'FORBIDDEN');
  f.now += AGE; vi.spyOn(f.chain, 'txStatus').mockRejectedValue(new Error('offline'));
  await expect(f.broker.resolveAttempt(owner, request.id, 'RPC unavailable')).rejects.toHaveProperty('code', 'FORBIDDEN');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
});

it.each(['succeeded', 'failed'] as const)('N3 forced resolution retains budget, survives restart and accounts late %s exactly once', async (kind) => {
  const { a, request, attempt } = await ambiguous();
  const policy = (await f.broker.getPolicy(owner, a.agentId))!;
  await f.broker.setPolicy(owner, { ...policy, revision: 2, lifetimeMax: request.amount }, 1);
  expect((await f.broker.resolveAttempt(owner, request.id, 'explicit emergency force', true)).state).toBe('failed');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  const denied = await f.broker.requestTransfer(a, f.input('cannot-spend-retained-budget'));
  expect(denied.reasons).toContain('LIFETIME_EXCEEDED');
  const receipts = await f.broker.exportReceipts(owner, `agent:${a.agentId}`, 0, 100);
  expect(receipts.find((r) => r.type === 'failed')?.payload).toMatchObject({ resolution: { force: true, holdRetained: true } });
  for (const store of f.stores) store.close();
  f.chain.outcomes.set(attempt.txHash, kind === 'succeeded' ? success
    : { kind, final: true, receiptIds: [], gasBurnt: 222n, tokensBurnt: 17n, error: 'late failure' });
  const restart = f.another(); await restart.reconcile(owner, request.id); await restart.reconcile(owner, request.id);
  expect((await restart.getRequest(a, request.id))).toMatchObject({ state: kind, tokensBurnt: kind === 'succeeded' ? 7n : 17n });
  const usage = await restart.budgetStatus(a);
  expect(usage.usage.agentLifetime).toBe(kind === 'succeeded' ? request.amount : 0n);
  expect(usage.usage.agentGas24h).toBe(kind === 'succeeded' ? 7n : 17n);
  expect((await restart.getFreeze(owner, { scope: 'global' }))?.frozen).toBe(true);
  const store = f.stores.at(-1)!;
  expect(store.read((r) => r.getHold(request.id)?.status)).toBe('committed');
  expect(store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items.filter((e) => e.kind === 'gas_charged'))).toHaveLength(1);
  const corrected = await restart.exportReceipts(owner, `agent:${a.agentId}`, 0, 100);
  expect(corrected.filter((r) => (r.type === 'succeeded' || r.type === 'failed') && r.payload.lateResolution)).toHaveLength(1);
  expect(f.chain.broadcasts).toHaveLength(1);
});

it('N3 forced watch releases only on mature exclusion, keeps watching after expiry, and corrects a late historical execution', async () => {
  const { a, request, attempt } = await ambiguous();
  await f.broker.resolveAttempt(owner, request.id, 'force while uncertain', true);
  f.chain.outcomes.set(attempt.txHash, exclusion);
  await f.broker.reconcile(owner); expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  f.now += AGE; await f.broker.reconcile(owner);
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.resolutionWatch)).toBe(true);
  f.now += 86_400_000; f.chain.outcomes.set(attempt.txHash, success);
  await f.another().start();
  expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(request.amount);
  expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(7n);
  expect(f.chain.broadcasts).toHaveLength(1);
});

it('N3 resolved-execution correction rolls back on audit failure and charges on the next retry', async () => {
  const { a, request, attempt } = await proof();
  await f.broker.resolveAttempt(owner, request.id, 'proven safe resolution');
  f.chain.outcomes.set(attempt.txHash, success);
  const append = f.receipts.append.bind(f.receipts);
  const audit = vi.spyOn(f.receipts, 'append').mockImplementation((tx, event) => {
    if (event.type === 'succeeded') throw new Error('audit unavailable'); return append(tx, event);
  });
  await expect(f.broker.reconcile(owner)).rejects.toHaveProperty('code', 'AUDIT_UNAVAILABLE');
  expect((await f.broker.getRequest(a, request.id)).state).toBe('failed');
  expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(0n);
  audit.mockRestore(); await f.broker.reconcile(owner); await f.broker.reconcile(owner);
  expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(request.amount);
  expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(7n);
});

it.each(['failed', 'proven_not_executed'] as const)('N3 legacy zero-charge resolution (%s) is enrolled after restart and corrected append-only', async (status) => {
  const { a, request, attempt } = await ambiguous();
  f.store.withImmediateTransaction((tx) => {
    const current = tx.getRequest(request.id)!;
    const old = { ...attempt, status, gasBurnt: status === 'failed' ? 0n : null, tokensBurnt: status === 'failed' ? 0n : null,
      nonExecutionEvidence: status === 'proven_not_executed' ? 'Legacy retained proof' : null };
    delete old.resolutionWatch;
    tx.putAttempt(old); tx.updateRequest({ ...current, state: 'failed', gasBurnt: 0n, tokensBurnt: 0n }, current.state);
    tx.putHold({ ...tx.getHold(request.id)!, status: 'released' });
    tx.appendAccounting({ id: 'legacy-zero', requestId: request.id, agentId: a.agentId, kind: 'gas_charged', amount: 0n, at: f.now });
    for (const chainId of ['owner', `agent:${a.agentId}`]) f.receipts.append(tx, { chainId, type: 'failed', at: f.now,
      payload: { requestId: request.id, agentId: a.agentId, txHash: attempt.txHash, receiptIds: [], gasBurnt: '0', tokensBurnt: '0', reason: 'Legacy owner attestation',
        resolution: { attemptId: attempt.id, basis: 'owner_attested', evidence: 'Legacy unavailable RPC' } } });
  });
  f.chain.outcomes.set(attempt.txHash, success); await f.another().start();
  expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(7n);
  expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(request.amount);
  const entries = f.store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items);
  expect(entries.find((e) => e.id === 'legacy-zero')?.amount).toBe(0n);
  expect(entries.find((e) => e.kind === 'gas_correction')?.amount).toBe(7n);
  expect(f.receipts.verify(`agent:${a.agentId}`).valid).toBe(true);
});

it('a late execution overrunning a standing grant is charged and revokes stale grant capacity even after owner unfreeze', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('standing', { approvalThreshold: 1n });
  const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('0.001'), totalMax: parseNear('0.0015'), expiresAt: f.now + 300_000 });
  f.chain.mode = 'unknown'; const first = await f.broker.requestTransfer(a, f.input('first')); await f.broker.drain();
  const attempt = f.store.read((r) => r.listAttempts(first.id)[0]!); f.now += AGE; f.chain.outcomes.set(attempt.txHash, exclusion);
  await f.broker.resolveAttempt(owner, first.id, 'default definite exclusion');
  f.chain.mode = 'accepted'; await f.broker.requestTransfer(a, f.input('second')); await f.broker.drain();
  f.chain.outcomes.set(attempt.txHash, success); await f.broker.reconcile(owner, first.id);
  expect(f.store.read((r) => r.getStandingApproval(grant.id)?.revokedAt)).toBe(f.now);
  expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(parseNear('0.002'));
  await f.broker.unfreeze(owner, { scope: 'global' }, 'reviewed');
  expect((await f.broker.requestTransfer(a, f.input('no-stale-capacity', parseNear('0.0005')))).state).toBe('pending_approval');
});

it('N4 30 hostile stale requests across two connections share one slow failing RPC and do not starve freeze', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent(); const second = f.another();
  const entered = gate(); const blocked = gate();
  const view = vi.spyOn(f.chain, 'viewAccount').mockImplementation(async () => { entered.release(); await blocked.wait; throw new Error('offline'); });
  const requests = Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? f.broker : second).requestTransfer(a, f.input(String(i)))));
  await entered.wait; const freeze = f.broker.freeze(owner, { scope: 'global' }, 'kill switch');
  await delay(); blocked.release(); await freeze;
  expect(view).toHaveBeenCalledTimes(1); await requests;
  await f.broker.requestTransfer(a, f.input('negative-cache')); expect(view).toHaveBeenCalledTimes(1);
  view.mockRestore(); f.now += 250;
  await f.broker.unfreeze(owner, { scope: 'global' }, 'resume');
  expect((await second.requestTransfer(a, f.input('recovered'))).state).toBe('queued');
});

it('N13/N15 never-offered work pauses on stale balance/offline RPC, retains hold and later resumes the same bytes', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('unsent'));
  const crashing = f.another({ hooks: { afterPersistSigned: async () => { throw new Error('crash'); } } });
  await expect(crashing.drain()).rejects.toThrow('crash'); const attempt = f.store.read((r) => r.listAttempts(request.id)[0]!);
  f.now += 1001; f.chain.accountError = true; await f.another().start();
  expect((await f.broker.getRequest(a, request.id)).state).toBe('signed');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active'); expect(f.chain.broadcasts).toHaveLength(0);
  f.now += 250; f.chain.accountError = false; await f.another().start();
  expect((await f.broker.getRequest(a, request.id)).state).toBe('succeeded');
  expect(f.chain.broadcasts).toEqual([attempt.signedTxBase64]); expect(f.chain.built).toHaveLength(1);
});

it('N08/N20 freeze waits for in-flight rebroadcast; resolution cannot even query through its pump', async () => {
  const { request } = await ambiguous(); f.now += AGE;
  const entered = gate(); const blocked = gate(); let offering = false; let interleavedStatus = false;
  const broadcast = f.chain.broadcast.bind(f.chain); const status = f.chain.txStatus.bind(f.chain);
  vi.spyOn(f.chain, 'broadcast').mockImplementation(async (bytes) => { offering = true; entered.release(); await blocked.wait; offering = false; return broadcast(bytes); });
  vi.spyOn(f.chain, 'txStatus').mockImplementation(async (hash) => { if (offering) interleavedStatus = true; return status(hash); });
  const reconciling = f.broker.reconcile(owner); await entered.wait;
  let frozen = false; let resolved = false;
  const freeze = f.broker.freeze(owner, { scope: 'global' }, 'freeze in flight').then(() => { frozen = true; });
  const resolve = f.broker.resolveAttempt(owner, request.id, 'explicit force after serialization', true).then(() => { resolved = true; });
  await delay(); const inside = { frozen, resolved, interleavedStatus }; blocked.release();
  const completed = await Promise.allSettled([reconciling, freeze, resolve]);
  expect(completed.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  expect(inside).toEqual({ frozen: false, resolved: false, interleavedStatus: false });
  expect(f.chain.broadcasts[0]).toBe(f.chain.broadcasts[1]);
});

it('N17 concurrent drains across connections serialize status and offer work, not just nonce allocation', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  await f.broker.requestTransfer(a, f.input('1')); await f.broker.requestTransfer(a, f.input('2'));
  const second = f.another(); const entered = gate(); const blocked = gate(); let offering = false; let queriesInside = 0;
  const broadcast = f.chain.broadcast.bind(f.chain); const status = f.chain.txStatus.bind(f.chain);
  vi.spyOn(f.chain, 'broadcast').mockImplementation(async (bytes) => { offering = true; entered.release(); await blocked.wait; offering = false; return broadcast(bytes); });
  vi.spyOn(f.chain, 'txStatus').mockImplementation(async (hash) => { if (offering) queriesInside++; return status(hash); });
  const first = f.broker.drain(); await entered.wait;
  const others = Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? second : f.broker).drain()));
  await delay(); const during = queriesInside; blocked.release(); await Promise.all([first, others]);
  expect(during).toBe(0); expect(f.chain.paid.size).toBe(2); expect(f.chain.built.map((b) => b.transfer.nonce)).toEqual([1n, 2n]);
});

it('N29 reconcile by ID neither probes an earlier unrelated ambiguous item nor a different resolved watch', async () => {
  const { a, request } = await ambiguous(); f.now += AGE;
  const b = await f.agent('B'); const queued = await f.broker.requestTransfer(b, f.input('queued'));
  const status = vi.spyOn(f.chain, 'txStatus');
  expect((await f.broker.reconcile(owner, queued.id)).requests).toEqual([]); expect(status).not.toHaveBeenCalled();
  await f.broker.resolveAttempt(owner, request.id, 'forced watch', true); status.mockClear();
  expect((await f.broker.reconcile(owner, queued.id)).requests).toEqual([]); expect(status).not.toHaveBeenCalled();
  expect((await f.broker.getRequest(a, request.id)).state).toBe('failed');
});

it('N7 reoffers update a durable last-offer timestamp, reuse one intent and never scan a new-format receipt chain', async () => {
  const { a, request } = await ambiguous(); let scans = 0; const read = f.store.read.bind(f.store);
  const spy = vi.spyOn(f.store, 'read').mockImplementation(<T>(fn: (r: StoreReader) => T): T => read((r) => fn(new Proxy(r, {
    get(target, key) { const value: unknown = Reflect.get(target, key); if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { if (key === 'listReceipts' && args[0] !== 'owner') scans++; return Reflect.apply(value, target, args) as unknown; }; },
  }))));
  for (let i = 0; i < 3; i++) { f.now += AGE; await f.broker.reconcile(owner, request.id); }
  spy.mockRestore(); expect(scans).toBe(0); expect(f.chain.broadcasts).toHaveLength(4);
  expect((await f.broker.listReceipts(a, 0, 100)).filter((r) => r.type === 'submitted' && r.payload.phase === 'intent')).toHaveLength(1);
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.lastOfferedAt)).toBe(f.now);
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.offerCount)).toBe(4);
});

it('N8 stale previews coalesce and cache RPC without persisting any rows or receipts', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const before = f.store.read((r) => r.getWalletStatus(f.now));
  const view = vi.spyOn(f.chain, 'viewAccount');
  const result = await Promise.all(Array.from({ length: 30 }, (_, i) => f.broker.previewTransfer(a, f.input(String(i)))));
  expect(result.every((p) => p.decision.kind === 'allow')).toBe(true); expect(view).toHaveBeenCalledTimes(1);
  await f.broker.previewTransfer(a, f.input('cached')); expect(view).toHaveBeenCalledTimes(1);
  expect(f.store.read((r) => r.getWalletStatus(f.now))).toEqual(before);
  expect(f.store.read((r) => r.listRequests({}, { limit: 100 }).items)).toEqual([]);
});

it('a preview RPC started before settlement cannot overwrite the later conservative debit', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('settle'));
  const statusEntered = gate(); const statusBlocked = gate(); const status = f.chain.txStatus.bind(f.chain);
  vi.spyOn(f.chain, 'txStatus').mockImplementation(async (hash) => { statusEntered.release(); await statusBlocked.wait; return status(hash); });
  const draining = f.broker.drain(); await statusEntered.wait; f.now += 1001;
  const viewEntered = gate(); const viewBlocked = gate(); const view = f.chain.viewAccount.bind(f.chain);
  const balance = await view('broker.testnet');
  const rpc = vi.spyOn(f.chain, 'viewAccount').mockImplementation(async () => { viewEntered.release(); await viewBlocked.wait;
    return { ...balance, total: parseNear('1'), spendable: parseNear('1') }; });
  const preview = f.broker.previewTransfer(a, f.input('preview')); await viewEntered.wait;
  statusBlocked.release(); await draining;
  const settled = (await f.broker.walletStatus(owner)).balance;
  expect(settled?.spendable).toBe(parseNear('1') - request.amount - 7n);
  viewBlocked.release(); await preview;
  expect((await f.broker.walletStatus(owner)).balance).toEqual(settled);
  rpc.mockImplementation(view);
  await f.broker.requestTransfer(a, f.input('after-preview'));
  expect((await f.broker.walletStatus(owner)).balance?.spendable).toBe(f.chain.balance);
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('N9 a global freeze at the send gate leaves a signed never-offered request, not outcome_unknown', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent(); const request = await f.broker.requestTransfer(a, f.input('gate'));
  const broker = f.another({ hooks: { afterPersistSigned: async () => f.store.withImmediateTransaction((tx) => tx.putFreeze({ scope: 'global', frozen: true, at: f.now, reason: 'gate' })) } });
  await broker.drain(); expect((await f.broker.getRequest(a, request.id)).state).toBe('signed');
  expect(f.chain.broadcasts).toHaveLength(0); expect(f.store.read((r) => r.listAttempts(request.id)[0]?.lastOfferedAt)).toBeNull();
  const receipts = await f.broker.listReceipts(a, 0, 100);
  expect(receipts.some((r) => r.type === 'submitted' || r.type === 'outcome_unknown')).toBe(false);
  await f.broker.unfreeze(owner, { scope: 'global' }, 'resume'); await f.broker.drain(); expect(f.chain.built).toHaveLength(1); expect(f.chain.paid.size).toBe(1);
});
