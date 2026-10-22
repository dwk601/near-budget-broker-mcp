import { afterEach, expect, it, vi } from 'vitest';
import { parseNear } from '../../src/contracts/index.js';
import { Fixture, owner } from './fixtures.js';

let f: Fixture;
afterEach(() => { vi.restoreAllMocks(); f?.close(); });

it('signed-but-unsent freeze survives a closed-DB restart without rebroadcast', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('signed-freeze'));
  const crashing = f.another({ hooks: { afterPersistSigned: async () => { throw new Error('crash'); } } });
  await expect(crashing.drain()).rejects.toThrow('crash');
  const stored = f.store.read((r) => r.listAttempts(request.id)[0]!);
  await f.broker.freeze(owner, { scope: 'global' }, 'pause signed');
  for (const s of f.stores) s.close();
  const restart = f.another(); await restart.start();
  expect(f.chain.broadcasts).toHaveLength(0); expect(f.chain.built).toHaveLength(1);
  await restart.unfreeze(owner, { scope: 'global' }, 'resume'); await restart.drain();
  expect(f.chain.broadcasts).toEqual([stored.signedTxBase64]); expect(f.chain.built).toHaveLength(1);
  expect((await restart.getRequest(a, request.id)).state).toBe('succeeded');
});

it('acceptance followed by lost status may rebroadcast only identical bytes, never pay twice', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('ack-lost'));
  const crash = f.another({ hooks: { afterBroadcast: async () => { throw new Error('crash'); } } });
  await expect(crash.drain()).rejects.toThrow('crash');
  const status = vi.spyOn(f.chain, 'txStatus').mockResolvedValueOnce({ kind: 'outcome_unknown', reason: 'indexer lag' });
  await f.another().start();
  expect(status).toHaveBeenCalledTimes(2);
  expect(f.chain.broadcasts).toHaveLength(2);
  expect(f.chain.broadcasts[0]).toBe(f.chain.broadcasts[1]);
  expect(f.chain.paid.size).toBe(1); expect(f.chain.built).toHaveLength(1);
  expect((await f.broker.getRequest(a, request.id)).state).toBe('succeeded');
});

it('audit failure after acceptance rolls back settlement and reconciliation charges exactly once', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('audit-final'));
  const original = f.receipts.append.bind(f.receipts);
  const audit = vi.spyOn(f.receipts, 'append').mockImplementation((tx, event) => {
    if (event.type === 'succeeded') throw new Error('audit unavailable');
    return original(tx, event);
  });
  await expect(f.broker.drain()).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
  expect(f.chain.paid.size).toBe(1);
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  expect(f.store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items.filter((e) => e.kind === 'gas_charged'))).toHaveLength(0);
  audit.mockImplementation(original); await f.broker.start(); await f.broker.start();
  expect(f.chain.broadcasts).toHaveLength(1);
  expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(7n);
  expect(f.store.read((r) => r.listAccounting({ requestId: request.id }, { limit: 100 }).items.filter((e) => e.kind === 'gas_charged'))).toHaveLength(1);
});

it('dispatch rechecks stricter wallet/agent hard caps without signing, even for an approved request', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('A', { approvalThreshold: 1n });
  const request = await f.broker.requestTransfer(a, f.input('policy-race'));
  await f.broker.approve(owner, request.id, f.now + 1000);
  const policy = (await f.broker.getPolicy(owner, a.agentId))!;
  await f.broker.setPolicy(owner, { ...policy, revision: 2, perTxMax: 1n }, 1);
  await f.broker.drain();
  expect((await f.broker.getRequest(a, request.id)).state).toBe('denied');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
  expect(f.chain.built).toHaveLength(0);
});

it('nonce uses max(persisted, chain)+1 and restart cannot reuse allocated-but-never-broadcast nonce', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  f.chain.nonce = 40n;
  await f.broker.requestTransfer(a, f.input('skip'));
  const sign = vi.spyOn(f.chain, 'buildAndSignNativeTransfer').mockRejectedValueOnce(new Error('custody locked'));
  await expect(f.broker.drain()).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE' });
  expect(f.store.read((r) => r.getLocalNonce(f.chain.signer.publicKey))).toBe(41n);
  sign.mockRestore(); await f.another().start();
  expect(f.chain.built[0]?.transfer.nonce).toBe(42n);
  expect(f.chain.paid.size).toBe(1);
});

it('network identity refusal is stable and produces zero signatures or broadcasts', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  await f.broker.requestTransfer(a, f.input('network'));
  f.chain.network = 'mainnet';
  await expect(f.broker.drain()).rejects.toMatchObject({ code: 'MAINNET_REFUSED' });
  expect(f.chain.built).toHaveLength(0); expect(f.chain.broadcasts).toHaveLength(0);
});

it('restart re-evaluation uses original held fees, not a newly reduced reserve configuration', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent('gas', { gasBudget24h: 10n });
  const request = await f.broker.requestTransfer(a, f.input('gas'));
  const policy = (await f.broker.getPolicy(owner, a.agentId))!;
  await f.broker.setPolicy(owner, { ...policy, revision: 2, gasBudget24h: 1n }, 1);
  const restart = f.another({ config: { ...f.options.config, feeReservePerTx: 0n } });
  await restart.start();
  expect((await restart.getRequest(a, request.id)).reasons).toContain('GAS_BUDGET_EXCEEDED');
  expect(f.chain.built).toHaveLength(0);
  expect((await restart.budgetStatus(a)).usage.agentLifetime).toBe(0n);
  expect((await restart.walletStatus(owner)).outstandingHolds).toBe(0n);
});

it('failed standing-approved transfer releases its reservation without debiting grant principal', async () => {
  f = new Fixture(); await f.init(); const a = await f.agent('standing', { approvalThreshold: 1n });
  const grant = await f.broker.grantStandingApproval(owner, { agentId: a.agentId, perTxMax: parseNear('0.001'), totalMax: parseNear('0.001'), expiresAt: f.now + 1000 });
  f.chain.fail = true;
  expect((await f.broker.requestTransfer(a, f.input('failed'))).state).toBe('failed');
  expect(f.store.read((r) => r.getStandingApproval(grant.id)?.usedTotal)).toBe(0n);
  f.chain.fail = false;
  expect((await f.broker.requestTransfer(a, f.input('success'))).state).toBe('succeeded');
  expect(f.store.read((r) => r.getStandingApproval(grant.id)?.usedTotal)).toBe(parseNear('0.001'));
  expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(14n);
});
