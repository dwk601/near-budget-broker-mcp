import { afterEach, expect, it, vi } from 'vitest';
import { parseNear, NON_EXECUTION_MIN_AGE_MS as AGE } from '../../src/contracts/index.js';
import type { ChainOutcome, StoreReader, TransferRequest, TxAttempt } from '../../src/contracts/index.js';
import { RESOLUTION_WATCH_HORIZON_MS } from '../../src/broker/service.js';
import { Fixture, hash, owner } from './fixtures.js';
let f: Fixture;
afterEach(() => { vi.restoreAllMocks(); f?.close(); });
const success: ChainOutcome = { kind: 'succeeded', final: true, receiptIds: [], gasBurnt: 123n, tokensBurnt: 7n };
async function pending(offered = true) {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const request = await f.broker.requestTransfer(a, f.input('first'));
  if (offered) { f.chain.mode = 'unknown'; await f.broker.drain(); }
  else {
    const crashing = f.another({ hooks: { afterPersistSigned: async () => { throw new Error('crash'); } } });
    await expect(crashing.drain()).rejects.toThrow('crash');
  }
  return { a, request, attempt: f.store.read((r) => r.listAttempts(request.id)[0]!) };
}

it.each([true, false])('Q11 explicit force still vetoes visible success (offered=%s)', async (offered) => {
  const { request, attempt } = await pending(offered); f.chain.outcomes.set(attempt.txHash, success);
  await expect(f.broker.resolveAttempt(owner, request.id, 'force cannot hide success', true)).rejects.toHaveProperty('code', 'FORBIDDEN');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  expect(f.receipts.list('owner', 0, 100).filter((r) => r.type === 'failed')).toEqual([]);
});

it.each(['failed', 'pending'] as const)('F4 explicit force also vetoes visible %s', async (kind) => {
  const { request, attempt } = await pending();
  f.chain.outcomes.set(attempt.txHash, kind === 'pending' ? { kind } : { kind, final: true, receiptIds: [], gasBurnt: 123n, tokensBurnt: 7n, error: 'failed' });
  await expect(f.broker.resolveAttempt(owner, request.id, 'force must not hide execution', true)).rejects.toHaveProperty('code', 'FORBIDDEN');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
});

it.each(['invalid', 'expired'] as const)('Q02 %s rejection of a replay stays ambiguous without first-rejection provenance', async (mode) => {
  const { a, request } = await pending(); f.now += AGE; f.chain.mode = mode;
  await expect(f.broker.reconcile(owner, request.id)).resolves.toMatchObject({ requests: [expect.objectContaining({ id: request.id, state: 'outcome_unknown' })] });
  const stored = f.store.read((r) => r.listAttempts(request.id)[0]!);
  expect(stored.offerCount).toBe(2); expect(stored.firstRejection).toBeUndefined(); expect(stored.nonExecutionEvidence).toBeNull();
  expect((await f.broker.getRequest(a, request.id)).tokensBurnt).toBeNull();
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  expect(f.chain.built).toHaveLength(1); expect(new Set(f.chain.broadcasts).size).toBe(1);
});

it('Q36 Store refuses erasing definitive first-rejection provenance', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent(); f.chain.mode = 'invalid';
  const request = await f.broker.requestTransfer(a, f.input('invalid')); await f.broker.drain();
  const attempt = f.store.read((r) => r.listAttempts(request.id)[0]!); expect(attempt.firstRejection).toBe('INVALID_NONCE');
  expect(() => f.store.withImmediateTransaction((tx) => tx.putAttempt({ ...attempt, firstRejection: undefined }))).toThrow('FORBIDDEN');
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.firstRejection)).toBe('INVALID_NONCE');
});

it('Q19 late correction invalidates a warmed pre-payment preview balance cache', async () => {
  const { a, request, attempt } = await pending();
  await f.broker.resolveAttempt(owner, request.id, 'force preserves budget', true);
  f.now += 1001; await f.broker.previewTransfer(a, f.input('warm-cache'));
  f.chain.balance -= request.amount + 7n; f.chain.outcomes.set(attempt.txHash, success);
  await f.broker.reconcile(owner, request.id);
  await f.broker.unfreeze(owner, { scope: 'global' }, 'reviewed late execution');
  const view = vi.spyOn(f.chain, 'viewAccount'); await f.broker.requestTransfer(a, f.input('next'));
  expect(view).toHaveBeenCalledTimes(1);
  expect((await f.broker.walletStatus(owner)).balance?.spendable).toBe(f.chain.balance);
  expect(f.chain.balance).toBe(parseNear('1') - request.amount - 7n);
});

it('Q43 resolved-execution correction cannot alter immutable request amount', async () => {
  const { request, attempt } = await pending(); await f.broker.resolveAttempt(owner, request.id, 'force', true);
  const current = f.store.read((r) => r.getRequest(request.id)!); const stored = f.store.read((r) => r.listAttempts(request.id)[0]!);
  const finalAttempt: TxAttempt = { ...stored, resolutionWatch: false, status: 'succeeded', gasBurnt: 123n, tokensBurnt: 7n };
  const finalRequest: TransferRequest = { ...current, state: 'succeeded', amount: current.amount + 1n, gasBurnt: 123n, tokensBurnt: 7n };
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution(finalRequest, finalAttempt))).toThrow('FORBIDDEN');
  expect(f.store.read((r) => r.getRequest(request.id)?.amount)).toBe(request.amount);
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.txHash)).toBe(attempt.txHash);
});

it('Q39 a superseded watched proof cannot be corrected through the terminal-resolution seam', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent();
  const admitted = await f.broker.requestTransfer(a, f.input('superseded'));
  const request = f.store.read((r) => r.getRequest(admitted.id)!);
  async function build(id: string) {
    const nonce = f.store.withImmediateTransaction((tx) => tx.allocateNonce(f.chain.signer.publicKey, 0n));
    const signed = await f.chain.buildAndSignNativeTransfer({ signerId: 'broker.testnet', receiverId: request.receiverId, amount: request.amount,
      nonce, publicKey: f.chain.signer.publicKey, blockHash: hash('block') });
    return { id, requestId: request.id, nonce, publicKey: f.chain.signer.publicKey, blockHash: hash('block'), txHash: signed.txHash,
      signedTxBase64: signed.signedTxBase64, status: 'signed' as const, receiptIds: [], gasBurnt: null, tokensBurnt: null,
      createdAt: f.now, updatedAt: f.now, lastOfferedAt: null, offerCount: 0, nonExecutionEvidence: null, resolutionWatch: false };
  }
  const first = await build('prior');
  const proof: TxAttempt = { ...first, status: 'proven_not_executed', nonExecutionEvidence: 'legacy proof', resolutionWatch: true };
  f.store.withImmediateTransaction((tx) => { tx.putAttempt(first); tx.updateRequest({ ...request, state: 'signed', txHash: first.txHash }, 'queued'); tx.putAttempt(proof); });
  const replacement = await build('replacement');
  f.store.withImmediateTransaction((tx) => {
    tx.replaceUnexecutedAttempt(request.id, first.id, replacement);
    tx.putAttempt({ ...replacement, status: 'failed', gasBurnt: 0n, tokensBurnt: 0n, resolutionWatch: true });
    tx.updateRequest({ ...tx.getRequest(request.id)!, state: 'failed', gasBurnt: 0n, tokensBurnt: 0n }, 'signed');
  });
  const current = f.store.read((r) => r.getRequest(request.id)!);
  const staleFinal: TxAttempt = { ...proof, status: 'succeeded', gasBurnt: 123n, tokensBurnt: 7n, resolutionWatch: false };
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution({ ...current, state: 'succeeded', txHash: first.txHash,
    gasBurnt: 123n, tokensBurnt: 7n }, staleFinal))).toThrow('FORBIDDEN');
  expect(f.store.read((r) => r.getRequest(request.id)?.txHash)).toBe(replacement.txHash);
});

it('L1 automatic watches tail receipts instead of scanning failed requests, expire at the GC horizon, and support explicit late reconciliation', async () => {
  const { a, request, attempt } = await pending(); await f.broker.resolveAttempt(owner, request.id, 'force watch', true);
  let failedScans = 0; const read = f.store.read.bind(f.store);
  vi.spyOn(f.store, 'read').mockImplementation(<T>(fn: (r: StoreReader) => T): T => read((r) => fn(new Proxy(r, {
    get(target, key) { const value: unknown = Reflect.get(target, key); if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (key === 'listRequests' && (args[0] as { states?: string[] })?.states?.includes('failed')) failedScans++;
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  }))));
  const status = vi.spyOn(f.chain, 'txStatus'); await f.broker.reconcile(owner); await f.broker.reconcile(owner);
  expect(failedScans).toBe(0); expect(status).toHaveBeenCalledTimes(2);
  f.now += RESOLUTION_WATCH_HORIZON_MS + 1; status.mockClear();
  await f.broker.reconcile(owner); await f.broker.reconcile(owner); await f.another().start();
  expect(status).not.toHaveBeenCalled(); expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  f.chain.outcomes.set(attempt.txHash, success); await f.broker.reconcile(owner, request.id);
  expect((await f.broker.budgetStatus(a)).usage.agentLifetime).toBe(request.amount);
  expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(7n);
});

it('L2 transient broker attestation failure before any offer retries promptly with identical persisted bytes', async () => {
  f = new Fixture({ autoDispatch: false }); await f.init(); const a = await f.agent(); const request = await f.broker.requestTransfer(a, f.input('pre-send'));
  const verify = f.chain.verifyNetwork.bind(f.chain);
  const spy = vi.spyOn(f.chain, 'verifyNetwork');
  const broker = f.another({ hooks: { afterPersistSigned: async () => { spy.mockRejectedValueOnce(new Error('transient pre-send failure')); } } });
  await expect(broker.drain()).rejects.toHaveProperty('code', 'MAINNET_REFUSED');
  const stored = f.store.read((r) => r.listAttempts(request.id)[0]!);
  expect(stored.lastOfferedAt).toBeNull(); expect(stored.offerCount).toBe(0); expect(f.chain.broadcasts).toHaveLength(0);
  spy.mockImplementation(verify); await f.broker.drain(); // no Clock advance or 60-second pause
  expect(f.chain.broadcasts).toEqual([stored.signedTxBase64]); expect(f.chain.built).toHaveLength(1);
  expect((await f.broker.getRequest(a, request.id)).state).toBe('succeeded');
});

it('F5 final never-offered release gate rechecks the transaction snapshot after a stale preliminary read', async () => {
  const { a, request, attempt } = await pending(false);
  const immediate = f.store.withImmediateTransaction.bind(f.store); let injected = false;
  vi.spyOn(f.store, 'withImmediateTransaction').mockImplementation((operation) => {
    if (!injected) {
      injected = true;
      // Fault-inject durable intent AFTER the preliminary check but BEFORE the
      // release transaction. The normal pump prevents this race; the final
      // snapshot guard must independently reject it (including on future edits).
      immediate((tx) => {
        const stored = tx.listAttempts(request.id)[0]!;
        tx.putAttempt({ ...stored, offerCount: 1, lastOfferedAt: f.now });
        f.receipts.append(tx, { chainId: `agent:${a.agentId}`, type: 'submitted', at: f.now,
          payload: { requestId: request.id, agentId: a.agentId, attemptId: attempt.id, txHash: attempt.txHash, phase: 'intent' } });
      });
    }
    return immediate(operation);
  });
  await expect(f.broker.resolveAttempt(owner, request.id, 'stale never-offered snapshot', true)).rejects.toHaveProperty('code', 'FORBIDDEN');
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('active');
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.lastOfferedAt)).toBe(f.now);
});

it('F5 owner-chain index enrolls chain_proof resolutions and corrects late success on automatic restart', async () => {
  const { a, request, attempt } = await pending(); f.now += AGE;
  f.chain.outcomes.set(attempt.txHash, { kind: 'not_executed', evidence: 'positive exclusion', invalidNonce: true });
  await f.broker.reconcile(owner, request.id);
  await f.broker.revokeAgent(owner, a.agentId, 'no longer authorized');
  await f.broker.reconcile(owner, request.id);
  expect(f.receipts.list('owner', 0, 100).find((e) => e.type === 'failed')?.payload).toMatchObject({ resolution: { basis: 'chain_proof' } });
  expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
  f.chain.outcomes.set(attempt.txHash, success); await f.another().start();
  expect((await f.broker.getRequest(owner, request.id)).state).toBe('succeeded');
  expect(f.store.read((r) => r.getUsageSnapshot(a.agentId, f.now))).toMatchObject({ agentLifetime: request.amount, agentGas24h: 7n });
  expect((await f.broker.getFreeze(owner, { scope: 'global' }))?.frozen).toBe(true);
});

it('L3 forcing a never-offered attempt abandons it, releases all budget and creates no watch', async () => {
  const { a, request, attempt } = await pending(false);
  const result = await f.broker.resolveAttempt(owner, request.id, 'abandon unused bytes', true);
  expect(result.state).toBe('failed'); expect(f.store.read((r) => r.getHold(request.id)?.status)).toBe('released');
  expect((await f.broker.budgetStatus(a)).usage).toMatchObject({ agentLifetime: 0n, agentGas24h: 0n, agentOutstanding: 0 });
  expect(f.store.read((r) => r.listAttempts(request.id)[0]?.resolutionWatch)).toBe(false);
  const event = f.receipts.list('owner', 0, 100).find((r) => r.type === 'failed');
  expect(event?.payload).toMatchObject({ resolution: { attemptId: attempt.id, basis: 'never_offered', force: true, holdRetained: false } });
  expect(f.chain.broadcasts).toHaveLength(0);
});
