import { afterEach, expect, it, vi } from 'vitest';
import * as approvals from '../../src/approvals/index.js';
import { parseNear } from '../../src/contracts/index.js';
import type { OwnerPrincipal, TxAttempt } from '../../src/contracts/index.js';
import { Fixture, hash, owner } from './fixtures.js';
const delay = (ms = 8) => new Promise<void>((r) => setTimeout(r, ms));
function gate() { let release!: () => void; return { wait: new Promise<void>((r) => { release = r; }), release: () => release() }; }
let f: Fixture;
afterEach(() => { vi.restoreAllMocks(); f?.close(); });

it('F1 latency: a freeze between attempts does not wait for the rest of the queue', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  for (let i = 0; i < 5; i++) { await f.broker.requestTransfer(a, f.input(String(i))); f.now++; }
  const second = gate(); let calls = 0;
  const broadcast = f.chain.broadcast.bind(f.chain);
  vi.spyOn(f.chain, 'broadcast').mockImplementation(async (bytes) => { if (++calls === 2) second.release(); await delay(15); return broadcast(bytes); });
  const draining = f.broker.drain(); await second.wait;
  await f.broker.freeze(owner, { scope: 'global' }, 'stop the queue');
  const atAck = calls;
  await draining;
  expect(atAck).toBe(2); expect(f.chain.broadcasts).toHaveLength(2); expect(f.chain.built).toHaveLength(2);
});

it.each(['freeze', 'unfreeze', 'freezeSelf', 'revokeAgent', 'setPolicy', 'setWalletPolicy', 'revokeStandingApproval', 'approve'] as const)(
  'serialization: %s shares the in-flight authorization/broadcast boundary', async (op) => {
    f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('A');
    const b = await f.agent('B', { approvalThreshold: 1n });
    const pending = await f.broker.requestTransfer(b, f.input('pending'));
    const grant = await f.broker.grantStandingApproval(owner, { agentId: b.agentId, perTxMax: 1n, totalMax: 1n, expiresAt: f.now + 10000 });
    const policy = (await f.broker.getPolicy(owner, a.agentId))!;
    await f.broker.requestTransfer(a, f.input('signed'));
    const entered = gate(); const blocked = gate();
    const broker = f.another({ hooks: { afterPersistSigned: async () => { entered.release(); await blocked.wait; } } });
    const draining = broker.drain(); await entered.wait;
    let done = false;
    const operations = {
      freeze: () => f.broker.freeze(owner, { scope: 'global' }, 'stop'),
      unfreeze: () => f.broker.unfreeze(owner, { scope: 'global' }, 'resume'),
      freezeSelf: () => f.broker.freezeSelf(a, 'self'),
      revokeAgent: () => f.broker.revokeAgent(owner, a.agentId, 'revoke'),
      setPolicy: () => f.broker.setPolicy(owner, { ...policy, revision: 2, perTxMax: 1n }, 1),
      setWalletPolicy: () => f.broker.setWalletPolicy(owner, { revision: 2, rolling24hMax: 0n, safetyReserve: 0n }, 1),
      revokeStandingApproval: () => f.broker.revokeStandingApproval(owner, grant.id),
      approve: () => f.broker.approve(owner, pending.id, f.now + 100),
    };
    const mutation = operations[op]().then(() => { done = true; });
    await delay(); const acknowledgedInside = done; blocked.release();
    await Promise.all([draining, mutation]);
    expect(acknowledgedInside).toBe(false);
    expect(f.chain.broadcasts.length).toBeGreaterThanOrEqual(1);
  },
);

it('F1 FINAL polling does not hold the freeze boundary', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  await f.broker.requestTransfer(a, f.input('status'));
  const entered = gate(); const blocked = gate(); const status = f.chain.txStatus.bind(f.chain);
  vi.spyOn(f.chain, 'txStatus').mockImplementation(async (hash) => { entered.release(); await blocked.wait; return status(hash); });
  const draining = f.broker.drain(); await entered.wait;
  let done = false; const freezing = f.broker.freeze(owner, { scope: 'global' }, 'stop').then(() => { done = true; });
  await delay(); const beforeRelease = done; blocked.release(); await Promise.all([draining, freezing]);
  expect(beforeRelease).toBe(true);
});

it('F2 latency: refresh between payments; stale-only capacity failure pauses rather than denies', async () => {
  f = new Fixture({ autoDispatch: false, config: { accountId: 'broker.testnet', feeReservePerTx: 10n, balanceMaxAgeMs: 10 } });
  await f.init(); const a = await f.agent();
  for (let i = 0; i < 5; i++) { await f.broker.requestTransfer(a, f.input(String(i))); f.now++; }
  const broadcast = f.chain.broadcast.bind(f.chain); const views = vi.spyOn(f.chain, 'viewAccount');
  vi.spyOn(f.chain, 'broadcast').mockImplementation(async (bytes) => { await delay(12); f.now += 12; return broadcast(bytes); });
  await f.broker.drain();
  expect(f.chain.broadcasts).toHaveLength(5); expect(views.mock.calls.length).toBeGreaterThanOrEqual(4);
  const pending = await f.broker.requestTransfer(a, f.input('offline'));
  f.now += 20; f.chain.accountError = true; await f.broker.drain();
  expect((await f.broker.getRequest(a, pending.id)).state).toBe('queued');
  expect(f.store.read((r) => r.getHold(pending.id)?.status)).toBe('active');
  f.chain.accountError = false; await f.broker.drain();
  expect((await f.broker.getRequest(a, pending.id)).state).toBe('succeeded');
});

it('F3a outcome_unknown rebroadcasts byte-identically and recovers without a new signature', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent(); f.chain.mode = 'throw';
  const request = await f.broker.requestTransfer(a, f.input('retry')); f.chain.mode = 'accepted';
  await f.another().reconcile(owner, request.id);
  expect(f.chain.broadcasts).toHaveLength(2); expect(f.chain.broadcasts[0]).toBe(f.chain.broadcasts[1]);
  expect(f.chain.built).toHaveLength(1); expect(f.chain.paid.size).toBe(1);
  expect((await f.broker.getRequest(a, request.id)).state).toBe('succeeded');
});

it('F3c owner-attested resolution requires auth/reason, vetoes any execution evidence, receipts both chains', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent(); f.chain.mode = 'unknown';
  const request = await f.broker.requestTransfer(a, f.input('resolve'));
  await expect(f.broker.resolveAttempt(a as unknown as OwnerPrincipal, request.id, 'owner says no')).rejects.toHaveProperty('code', 'FORBIDDEN');
  await expect(f.broker.resolveAttempt(owner, request.id, ' ')).rejects.toHaveProperty('code', 'FORBIDDEN');
  const attempt = f.store.read((r) => r.listAttempts(request.id)[0]!);
  for (const evidence of [{ kind: 'pending' as const }, { kind: 'succeeded' as const, final: true as const, receiptIds: [], gasBurnt: 1n, tokensBurnt: 1n },
    { kind: 'failed' as const, final: true as const, receiptIds: [], gasBurnt: 1n, tokensBurnt: 1n, error: 'failed' }]) {
    f.chain.outcomes.set(attempt.txHash, evidence);
    await expect(f.broker.resolveAttempt(owner, request.id, 'no payment')).rejects.toHaveProperty('code', 'FORBIDDEN');
  }
  f.chain.outcomes.delete(attempt.txHash);
  const spy = vi.spyOn(f.receipts, 'append');
  spy.mockImplementation(() => { throw new Error('audit'); });
  await expect(f.broker.resolveAttempt(owner, request.id, 'operator investigated')).rejects.toHaveProperty('code', 'AUDIT_UNAVAILABLE');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  spy.mockRestore();
  expect((await f.broker.resolveAttempt(owner, request.id, 'operator investigated')).state).toBe('failed');
  for (const chainId of ['owner', `agent:${a.agentId}`]) {
    const receipt = f.receipts.list(chainId, 0, 100).find((r) => r.type === 'failed');
    expect(receipt?.payload).toMatchObject({ reason: 'operator investigated', resolution: { attemptId: attempt.id, basis: 'owner_attested' } });
  }
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
  expect(f.chain.built).toHaveLength(1);
});

it('F4 proven non-execution plus revoked authorization fails with zero burn and unblocks B', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('A'); const b = await f.agent('B');
  const request = await f.broker.requestTransfer(a, f.input('proof')); f.chain.mode = 'unknown'; await f.broker.drain();
  const attempt = f.store.read((r) => r.listAttempts(request.id)[0]!);
  f.chain.outcomes.set(attempt.txHash, { kind: 'not_executed', evidence: 'final exclusion', invalidNonce: true });
  await f.broker.reconcile(owner); await f.broker.revokeAgent(owner, a.agentId, 'revoked');
  await f.broker.requestTransfer(b, f.input('B')); f.chain.mode = 'accepted'; await f.broker.drain();
  expect((await f.broker.getRequest(owner, request.id)).state).toBe('failed');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
  expect(f.store.read((r) => r.getRequest(request.id)?.tokensBurnt)).toBe(0n); expect(f.chain.paid.size).toBe(1);
});

it('F4 a stale/offline balance cannot pin a proven-unexecuted revoked request', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('proof-offline')); f.chain.mode = 'unknown'; await f.broker.drain();
  const attempt = f.store.read((r) => r.listAttempts(request.id)[0]!);
  f.chain.outcomes.set(attempt.txHash, { kind: 'not_executed', evidence: 'final exclusion', invalidNonce: true });
  await f.broker.reconcile(owner); await f.broker.revokeAgent(owner, a.agentId, 'permanent');
  f.now += 1001; f.chain.accountError = true;
  const views = vi.spyOn(f.chain, 'viewAccount'); await f.broker.reconcile(owner);
  expect((await f.broker.getRequest(owner, request.id)).state).toBe('failed');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released'); expect(views).not.toHaveBeenCalled();
});

it.each(['freeze', 'revoke'] as const)('F5 never-offered A is abandoned on agent %s without blocking B', async (action) => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('A'); const b = await f.agent('B');
  const request = await f.broker.requestTransfer(a, f.input('A'));
  const crashing = f.another({ hooks: { afterPersistSigned: async () => { throw new Error('crash'); } } });
  await expect(crashing.drain()).rejects.toThrow('crash');
  if (action === 'freeze') await f.broker.freeze(owner, { scope: 'agent', agentId: a.agentId }, 'A only');
  else await f.broker.revokeAgent(owner, a.agentId, 'A only');
  await f.broker.requestTransfer(b, f.input('B')); await f.another().start();
  expect((await f.broker.getRequest(owner, request.id)).state).toBe('failed'); expect(f.chain.paid.size).toBe(1);
  expect(f.chain.broadcasts).toHaveLength(1); expect(f.chain.built[1]?.transfer.nonce).toBe(2n);
  expect(f.receipts.list('owner', 0, 100).find((r) => r.type === 'failed')?.payload).toMatchObject({ resolution: { basis: 'never_offered' } });
});

it('agent freeze is rechecked at the signed send gate, not just queued admission', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  await f.broker.requestTransfer(a, f.input('send-gate'));
  const broker = f.another({ hooks: { afterPersistSigned: async () => {
    // Inject a durable snapshot at the gate to test defense-in-depth independently
    // of lane scheduling (ordinary owner writes use the serialized lane).
    f.store.withImmediateTransaction((tx) => tx.putFreeze({ scope: 'agent', agentId: a.agentId,
      frozen: true, at: f.now, reason: 'gate' }));
  } } });
  await broker.drain(); expect(f.chain.broadcasts).toHaveLength(0);
});

it('F5 an intent receipt forbids broker abandonment even if no send was observed by this process', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('intent')); f.chain.mode = 'unknown'; await f.broker.drain();
  await f.broker.freeze(owner, { scope: 'agent', agentId: a.agentId }, 'stop'); await f.another().start();
  expect((await f.broker.getRequest(a, request.id)).state).toBe('outcome_unknown');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
});

it('F7 benign policy revision reports POLICY_CHANGED instead of opaque FORBIDDEN', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('approval', { approvalThreshold: 1n });
  const request = await f.broker.requestTransfer(a, f.input('revision')); const policy = (await f.broker.getPolicy(owner, a.agentId))!;
  await f.broker.setPolicy(owner, { ...policy, revision: 2 }, 1);
  await expect(f.broker.approve(owner, request.id, f.now + 100)).rejects.toHaveProperty('code', 'POLICY_CHANGED');
});

it('F8 accepted plus pending stays submitted, preserves hold, and creates no unknown receipt', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent(); vi.spyOn(f.chain, 'txStatus').mockResolvedValue({ kind: 'pending' });
  const request = await f.broker.requestTransfer(a, f.input('pending'));
  expect(request.state).toBe('submitted'); expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  expect((await f.broker.listReceipts(a, 0, 100)).some((r) => r.type === 'outcome_unknown')).toBe(false);
  await f.broker.reconcile(owner); expect(f.chain.broadcasts).toHaveLength(1);
});

it('F9 preview refreshes ephemerally and leaves DB balance, requests, holds and receipts untouched', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent(); f.now += 1001;
  const before = f.store.read((r) => r.getWalletStatus(f.now)); const receipts = await f.broker.listReceipts(a, 0, 100);
  const spy = vi.spyOn(f.chain, 'viewAccount');
  expect((await f.broker.previewTransfer(a, f.input('preview'))).decision.kind).toBe('allow');
  expect(spy).toHaveBeenCalledTimes(1); expect(f.store.read((r) => r.getWalletStatus(f.now))).toEqual(before);
  expect(f.store.read((r) => r.findRequestByIdempotency(a.agentId, 'preview'))).toBeNull();
  expect(await f.broker.listReceipts(a, 0, 100)).toEqual(receipts);
});

it('F10 backwards clock skips newer pending approvals, then sweeps them once due', async () => {
  f = new Fixture({ autoDispatch: false, pendingApprovalTtlMs: 100 }); await f.init(); const a = await f.agent('clock', { approvalThreshold: 1n });
  const request = await f.broker.requestTransfer(a, f.input('clock')); f.now -= 10;
  await expect(f.broker.drain()).resolves.toBeUndefined(); expect((await f.broker.getRequest(a, request.id)).state).toBe('pending_approval');
  f.now += 110; await f.broker.drain(); expect((await f.broker.getRequest(a, request.id)).state).toBe('expired');
});

it('F11 signing reserves and uses the original standing grant, never a newly preferred grant', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('standing', { approvalThreshold: 1n });
  const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('1'), totalMax: parseNear('1'), expiresAt: f.now + 1000 });
  const request = await f.broker.requestTransfer(a, f.input('bound'));
  f.store.withImmediateTransaction((tx) => tx.putStandingApproval({ ...grant, id: '!preferred' }));
  const reserve = vi.spyOn(approvals, 'reserveStandingApproval'); reserve.mockClear();
  await f.broker.drain();
  expect(reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: request.id }), grant.id, expect.any(Number));
  expect((await f.broker.getRequest(a, request.id))).toMatchObject({ state: 'succeeded', approvalRef: { kind: 'standing', id: grant.id } });
  expect(f.store.read((r) => r.getStandingApproval('!preferred')?.usedTotal)).toBe(0n);
  expect(f.store.read((r) => r.getStandingApproval(grant.id)?.usedTotal)).toBe(request.amount);
});

it('a bound standing grant is still validated after a policy removes the approval threshold', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('standing', { approvalThreshold: 1n });
  const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('1'), totalMax: parseNear('1'), expiresAt: f.now + 1000 });
  const request = await f.broker.requestTransfer(a, f.input('bound'));
  const policy = (await f.broker.getPolicy(owner, a.agentId))!;
  await f.broker.setPolicy(owner, { ...policy, revision: 2, approvalThreshold: null }, 1);
  await f.broker.revokeStandingApproval(owner, grant.id); await f.broker.drain();
  expect((await f.broker.getRequest(a, request.id)).state).toBe('pending_approval'); expect(f.chain.built).toHaveLength(0);
});

it('F12 reconcile never dispatches queued work and returns only examined attempts', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const queued = await f.broker.requestTransfer(a, f.input('queued'));
  expect((await f.broker.reconcile(owner)).requests).toEqual([]); expect(f.chain.built).toHaveLength(0);
  f.chain.mode = 'unknown'; await f.broker.drain();
  await f.broker.requestTransfer(a, f.input('unrelated'));
  const result = await f.broker.reconcile(owner, queued.id);
  expect(result.requests.map((r) => r.id)).toEqual([queued.id]); expect(f.chain.built).toHaveLength(1);
});

it('queued expiry while frozen and expiry during signing never produce a broadcast', async () => {
  f = new Fixture({ autoDispatch: false, pendingApprovalTtlMs: 100 }); await f.init(); const a = await f.agent();
  const frozen = await f.broker.requestTransfer(a, f.input('frozen-expiry'));
  await f.broker.freeze(owner, { scope: 'global' }, 'stop'); f.now += 100; await f.broker.drain();
  expect((await f.broker.getRequest(a, frozen.id)).state).toBe('expired');
  await f.broker.unfreeze(owner, { scope: 'global' }, 'resume');
  const during = await f.broker.requestTransfer(a, f.input('sign-expiry'));
  const build = f.chain.buildAndSignNativeTransfer.bind(f.chain);
  vi.spyOn(f.chain, 'buildAndSignNativeTransfer').mockImplementation(async (t) => { const s = await build(t); f.now += 100; return s; });
  await f.broker.drain(); expect((await f.broker.getRequest(a, during.id)).state).toBe('expired'); expect(f.chain.broadcasts).toHaveLength(0);
});

it('revokeAgent revokes EVERY credential and dual receipts; revoked-token freezeSelf is refused', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent(); const extra = await f.broker.issueToken(owner, a.agentId);
  await f.broker.revokeAgent(owner, a.agentId, 'permanent');
  const credentials = f.store.read((r) => r.listCredentials(a.agentId, { limit: 100 }).items);
  expect(credentials.every((c) => c.revokedAt === f.now)).toBe(true); expect(credentials).toHaveLength(2);
  await expect(f.broker.freezeSelf(a, 'revoked')).rejects.toHaveProperty('code', 'UNAUTHENTICATED');
  expect(await f.broker.getFreeze(owner, { scope: 'agent', agentId: a.agentId })).toBeNull();
  for (const chainId of ['owner', `agent:${a.agentId}`]) {
    const receipts = f.receipts.list(chainId, 0, 100);
    expect(receipts.filter((r) => r.type === 'agent_revoked')).toHaveLength(1);
    expect(receipts.filter((r) => r.type === 'credential_revoked').map((r) => r.payload)).toEqual(expect.arrayContaining([
      { agentId: a.agentId, credentialId: a.credentialId }, { agentId: a.agentId, credentialId: extra.credential.id },
    ]));
  }
});

it('budgetStatus zeros every quota for frozen and expired policies', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent('status', { expiresAt: f.now + 10 });
  expect((await f.broker.budgetStatus(a)).remaining.perTx).toBeGreaterThan(0n);
  await f.broker.freezeSelf(a, 'stop');
  const zero = { perTx: 0n, rolling24h: 0n, lifetime: 0n, gas24h: 0n, requestsPerMinute: 0, outstandingSlots: 0 };
  expect((await f.broker.budgetStatus(a)).remaining).toEqual(zero);
  await f.broker.unfreeze(owner, { scope: 'agent', agentId: a.agentId }, 'resume'); f.now += 10;
  expect((await f.broker.budgetStatus(a)).remaining).toEqual(zero);
});

it('queued admission/approval receipts and all administrative dual events are present', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const r = await f.broker.requestTransfer(a, f.input('queued'));
  expect((await f.broker.listReceipts(a, 0, 100)).filter((e) => e.type === 'queued' && e.payload.requestId === r.id)).toHaveLength(1);
  const rotated = await f.broker.rotateToken(owner, a.credentialId); await f.broker.revokeToken(owner, rotated.credential.id);
  await f.broker.freeze(owner, { scope: 'agent', agentId: a.agentId }, 'stop');
  await f.broker.unfreeze(owner, { scope: 'agent', agentId: a.agentId }, 'resume');
  for (const chainId of ['owner', `agent:${a.agentId}`]) {
    const types = f.receipts.list(chainId, 0, 100).map((r) => r.type);
    for (const type of ['agent_created', 'policy_updated', 'credential_issued', 'credential_revoked', 'freeze', 'unfreeze']) expect(types).toContain(type);
  }
  const b = await f.agent('approval', { approvalThreshold: 1n });
  const pending = await f.broker.requestTransfer(b, f.input('approval'));
  await f.broker.approve(owner, pending.id, f.now + 100);
  expect((await f.broker.listReceipts(b, 0, 100)).filter((e) => e.type === 'queued')).toHaveLength(1);
});

it('settlement releases the exact unused fee reserve, including failed transfers', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent();
  const success = await f.broker.requestTransfer(a, f.input('success'));
  f.chain.fail = true; f.chain.fee = 2n; const failed = await f.broker.requestTransfer(a, f.input('failed'));
  for (const [request, amount] of [[success, 3n], [failed, 8n]] as const) {
    const entries = f.store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items);
    expect(entries.filter((e) => e.kind === 'fee_released').map((e) => e.amount)).toEqual([amount]);
  }
});

it.each(['nonce', 'signerId', 'receiverId', 'amount', 'publicKey', 'blockHash'] as const)('validates adapter output %s BEFORE persisting/broadcasting', async (field) => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('adapter')); const build = f.chain.buildAndSignNativeTransfer.bind(f.chain);
  vi.spyOn(f.chain, 'buildAndSignNativeTransfer').mockImplementation(async (t) => {
    const s = await build(t); const transfer = { ...s.transfer };
    if (field === 'amount' || field === 'nonce') transfer[field] += 1n;
    else if (field === 'blockHash') transfer.blockHash = hash('bad');
    else if (field === 'publicKey') transfer.publicKey = `ed25519:${hash('bad')}`;
    else transfer[field] = 'other.testnet';
    return { ...s, transfer };
  });
  await expect(f.broker.drain()).rejects.toHaveProperty('code', 'FORBIDDEN');
  expect(f.chain.broadcasts).toHaveLength(0); expect(f.store.read((r) => r.listAttempts(request.id))).toHaveLength(0);
});

it('refuses a non-full-access custody key before signing', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent(); await f.broker.requestTransfer(a, f.input('key'));
  vi.spyOn(f.chain, 'viewAccessKey').mockResolvedValue({ nonce: 0n, publicKey: f.chain.signer.publicKey, fullAccess: false, blockHash: hash('block') });
  await expect(f.broker.drain()).rejects.toHaveProperty('code', 'FORBIDDEN'); expect(f.chain.built).toHaveLength(0);
});

it('an accepted acknowledgment with the wrong txHash never creates an acknowledgment receipt', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent();
  vi.spyOn(f.chain, 'broadcast').mockResolvedValue({ kind: 'accepted', txHash: hash('different') });
  const request = await f.broker.requestTransfer(a, f.input('hash')); expect(request.state).toBe('outcome_unknown');
  expect((await f.broker.listReceipts(a, 0, 100)).filter((e) => e.type === 'submitted' && e.payload.phase === 'acknowledged')).toHaveLength(0);
});

it('queue selection is created-time order, not arbitrary IDs or last-read batch order', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  for (let i = 0; i < 4; i++) { await f.broker.requestTransfer(a, { ...f.input(String(i)), receiverId: `receiver${i}.testnet` }); f.now++; }
  await f.broker.drain(); expect(f.chain.built.map((s) => s.transfer.receiverId)).toEqual([0, 1, 2, 3].map((i) => `receiver${i}.testnet`));
});

it('recovery sorts unresolved attempts by numeric nonce, not ID paging order', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  for (let i = 1; i <= 2; i++) {
    const admitted = await f.broker.requestTransfer(a, f.input(String(i)));
    const request = f.store.read((r) => r.getRequest(admitted.id)!);
    const nonce = f.store.withImmediateTransaction((tx) => tx.allocateNonce(f.chain.signer.publicKey, 0n));
    const signed = await f.chain.buildAndSignNativeTransfer({ signerId: 'broker.testnet', receiverId: request.receiverId,
      amount: request.amount, nonce, publicKey: f.chain.signer.publicKey, blockHash: hash('block') });
    const attempt: TxAttempt = { id: i === 1 ? 'z' : 'a', requestId: request.id, nonce, publicKey: f.chain.signer.publicKey,
      blockHash: hash('block'), signedTxBase64: signed.signedTxBase64, txHash: signed.txHash, status: 'signed', receiptIds: [],
      gasBurnt: null, tokensBurnt: null, createdAt: f.now, updatedAt: f.now, nonExecutionEvidence: null };
    f.store.withImmediateTransaction((tx) => { tx.putAttempt(attempt); tx.updateRequest({ ...request, state: 'signed', txHash: attempt.txHash, signedAt: f.now }, 'queued'); });
  }
  await f.broker.drain(); expect(f.chain.broadcasts).toEqual(f.chain.built.map((s) => s.signedTxBase64)); expect(f.chain.paid.size).toBe(2);
});

it('approve refreshes stale balance before evaluating hard caps', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('approval', { approvalThreshold: 1n });
  const request = await f.broker.requestTransfer(a, f.input('refresh')); f.now += 1001;
  const views = vi.spyOn(f.chain, 'viewAccount');
  await expect(f.broker.approve(owner, request.id, f.now + 100)).resolves.toMatchObject({ state: 'queued' });
  expect(views).toHaveBeenCalledTimes(1);
});
