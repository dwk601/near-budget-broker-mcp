import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SqliteStore } from '../../src/storage/index.js';
import { ACCOUNT, KEY, NOW, agent, request, attempt } from './fixtures.js';
import type { TransferRequest, TxAttempt } from '../../src/contracts/index.js';
let store: SqliteStore; let dir: string;
afterEach(() => { store?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
function seed() {
  dir = mkdtempSync(join(tmpdir(), 'bb-proof-storage-')); store = new SqliteStore(join(dir, 'db'), { accountId: ACCOUNT });
  const r = request(); const a = { ...attempt(), lastOfferedAt: NOW - 60_000 };
  store.withImmediateTransaction((tx) => {
    tx.putAgent(agent()); tx.insertRequest(r); tx.putHold({ requestId: r.id, agentId: r.agentId, principal: r.amount, feeReserve: 10n, status: 'active' });
    tx.allocateNonce(KEY, 0n); tx.putAttempt(a); tx.updateRequest({ ...r, state: 'signed', txHash: a.txHash }, 'queued');
  });
  return { r: store.read((r) => r.getRequest('r')!), a };
}
it.each(['submitted', 'succeeded', 'failed'] as const)('current exclusion proof can be corrected to observed %s without losing prior evidence', (status) => {
  const { r, a } = seed();
  const proof: TxAttempt = { ...a, status: 'proven_not_executed', nonExecutionEvidence: 'retained history observation' };
  store.withImmediateTransaction((tx) => tx.putAttempt(proof));
  const corrected = { ...proof, status, gasBurnt: status === 'submitted' ? null : 123n, tokensBurnt: status === 'submitted' ? null : 7n };
  store.withImmediateTransaction((tx) => tx.putAttempt(corrected));
  expect(store.read((tx) => tx.listAttempts(r.id)[0])).toMatchObject(corrected);
});
it('proof correction cannot reset signing identity or erase evidence/last offer', () => {
  const { a } = seed(); const proof: TxAttempt = { ...a, status: 'proven_not_executed', nonExecutionEvidence: 'retained evidence' };
  store.withImmediateTransaction((tx) => tx.putAttempt(proof));
  for (const bad of [{ ...proof, status: 'signed' as const }, { ...proof, status: 'succeeded' as const, gasBurnt: 1n, tokensBurnt: 1n, nonExecutionEvidence: null },
    { ...proof, status: 'succeeded' as const, gasBurnt: 1n, tokensBurnt: 1n, lastOfferedAt: null },
    { ...proof, status: 'failed' as const, gasBurnt: null, tokensBurnt: null }]) {
    expect(() => store.withImmediateTransaction((tx) => tx.putAttempt(bad))).toThrow('FORBIDDEN');
  }
});
it.each(['active', 'released'] as const)('late execution corrects only an explicit resolved watch with hold=%s and remains append-only/idempotent', (holdStatus) => {
  const { r, a } = seed();
  const resolved: TransferRequest = { ...r, state: 'failed', gasBurnt: 0n, tokensBurnt: 0n };
  const watched: TxAttempt = { ...a, status: 'failed', gasBurnt: 0n, tokensBurnt: 0n, resolutionWatch: true };
  store.withImmediateTransaction((tx) => {
    tx.putAttempt(watched); tx.updateRequest(resolved, 'signed');
    if (holdStatus === 'released') tx.putHold({ ...tx.getHold(r.id)!, status: 'released' });
    // Legacy zero charge is retained, never rewritten.
    tx.appendAccounting({ id: 'old-zero', requestId: r.id, agentId: r.agentId, kind: 'gas_charged', amount: 0n, at: NOW });
  });
  const finalAttempt: TxAttempt = { ...watched, status: 'succeeded', gasBurnt: 123n, tokensBurnt: 7n, resolutionWatch: false };
  const finalRequest: TransferRequest = { ...resolved, state: 'succeeded', gasBurnt: 123n, tokensBurnt: 7n };
  expect(() => store.withImmediateTransaction((tx) => tx.updateRequest(finalRequest, 'failed'))).toThrow('FORBIDDEN');
  store.withImmediateTransaction((tx) => {
    tx.correctResolvedExecution(finalRequest, finalAttempt);
    tx.appendAccounting({ id: 'actual-principal', requestId: r.id, agentId: r.agentId, kind: 'principal_committed', amount: r.amount, at: NOW });
    tx.appendAccounting({ id: 'actual-gas', requestId: r.id, agentId: r.agentId, kind: 'gas_correction', amount: 7n, at: NOW });
  });
  expect(store.read((tx) => tx.getUsageSnapshot(r.agentId, NOW))).toMatchObject({ agentLifetime: r.amount, agentGas24h: 7n, outstandingHolds: 0n });
  expect(store.read((tx) => tx.listAccounting({ requestId: r.id }, { limit: 100 }).items.find((e) => e.id === 'old-zero')?.amount)).toBe(0n);
  expect(() => store.withImmediateTransaction((tx) => tx.correctResolvedExecution(finalRequest, finalAttempt))).toThrow('FORBIDDEN');
});
it('offer counts cannot go backwards or turn missing legacy provenance into a first-offer rejection', () => {
  const { a } = seed();
  expect(() => store.withImmediateTransaction((tx) => tx.putAttempt({ ...a, offerCount: 1 }))).toThrow('FORBIDDEN');
  const offered = { ...a, offerCount: 2, lastOfferedAt: NOW };
  store.withImmediateTransaction((tx) => tx.putAttempt(offered));
  for (const bad of [{ ...offered, offerCount: 1 }, { ...offered, offerCount: undefined },
    { ...offered, firstRejection: 'INVALID_NONCE' as const }]) {
    expect(() => store.withImmediateTransaction((tx) => tx.putAttempt(bad))).toThrow('FORBIDDEN');
  }
});
it('generic failed attempts cannot use the resolution correction seam', () => {
  const { r, a } = seed();
  store.withImmediateTransaction((tx) => { tx.putAttempt({ ...a, status: 'failed', gasBurnt: 0n, tokensBurnt: 0n }); tx.updateRequest({ ...r, state: 'failed' }, 'signed'); });
  expect(() => store.withImmediateTransaction((tx) => tx.correctResolvedExecution({ ...r, state: 'succeeded', gasBurnt: 1n, tokensBurnt: 1n },
    { ...a, status: 'succeeded', resolutionWatch: false, gasBurnt: 1n, tokensBurnt: 1n }))).toThrow('FORBIDDEN');
});
