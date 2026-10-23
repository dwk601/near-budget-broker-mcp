import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { TransferRequest, TxAttempt } from '../../src/contracts/index.js';
import { Fixture, hash, owner } from './fixtures.js';
let f: Fixture;
afterEach(() => f?.close());

async function correction() {
  f = new Fixture({ autoDispatch: false }); await f.init(); const agent = await f.agent(); f.chain.mode = 'invalid';
  const view = await f.broker.requestTransfer(agent, { ...f.input('resolved'), memo: 'original memo' }); await f.broker.drain();
  f.store.withImmediateTransaction((tx) => {
    const old = tx.listAttempts(view.id)[0]!;
    tx.putAttempt({ ...old, status: 'proven_not_executed', nonExecutionEvidence: 'original exclusion evidence' });
  });
  await f.broker.resolveAttempt(owner, view.id, 'retain unresolved reservation', true);
  const request = f.store.read((r) => r.getRequest(view.id)!);
  const attempt = f.store.read((r) => r.listAttempts(view.id)[0]!);
  expect(attempt.firstRejection).toBe('INVALID_NONCE');
  expect(attempt.resolutionWatch).toBe(true);
  const finalRequest: TransferRequest = { ...request, state: 'succeeded', gasBurnt: 123n, tokensBurnt: 7n, updatedAt: f.now + 1, completedAt: f.now + 1 };
  const finalAttempt: TxAttempt = { ...attempt, status: 'succeeded', gasBurnt: 123n, tokensBurnt: 7n,
    updatedAt: f.now + 1, receiptIds: [hash('receipt')], resolutionWatch: false };
  return { request, attempt, finalRequest, finalAttempt };
}
function corrupt(table: 'requests' | 'attempts', id: string, patch: Record<string, unknown>) {
  // Fault injection into this test's private temp DB, not a production bypass.
  // Some identity guards are redundant for healthy rows (lookup uses that ID).
  // Corrupt JSON identity while retaining the SQL lookup key to exercise each
  // independent fail-closed guard rather than falsely count equivalent mutants.
  const db = new DatabaseSync(join(f.dir, 'state.sqlite'));
  try {
    const data = JSON.parse(String(db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id)!['data'])) as Record<string, unknown>;
    db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify({ ...data, ...patch }), id);
  } finally { db.close(); }
}
const requestKeys = ['id', 'agentId', 'idempotencyKey', 'requestDigest', 'receiverId', 'amount', 'memo', 'createdAt',
  'approvalRef', 'policyRevision', 'reasons', 'expiresAt', 'signedAt', 'submittedAt'] as const;
const attemptKeys = ['id', 'requestId', 'nonce', 'publicKey', 'blockHash', 'signedTxBase64', 'txHash', 'createdAt',
  'lastOfferedAt', 'offerCount', 'firstRejection', 'nonExecutionEvidence'] as const;

it('F4 control: an unchanged immutable identity permits genuine final correction', async () => {
  const c = await correction();
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution(c.finalRequest, c.finalAttempt))).not.toThrow();
  expect(f.store.read((r) => r.getRequest(c.request.id)?.state)).toBe('succeeded');
});
it.each(requestKeys)('F4 correction preserves request immutable %s independently', async (key) => {
  const c = await correction();
  const values = { agentId: 'different-agent', idempotencyKey: 'different-key', requestDigest: 'f'.repeat(64), receiverId: 'different.testnet',
    amount: c.request.amount + 1n, memo: 'changed memo', createdAt: c.request.createdAt + 1,
    approvalRef: { kind: 'request', id: 'different-approval' }, policyRevision: 2, reasons: ['FORBIDDEN'],
    expiresAt: f.now + 999, signedAt: f.now + 2, submittedAt: f.now + 2 };
  if (key === 'id') {
    corrupt('requests', c.request.id, { id: 'corrupt-request-id' });
    corrupt('attempts', c.attempt.id, { requestId: 'corrupt-request-id' });
    c.finalAttempt.requestId = 'corrupt-request-id'; // satisfy the separate requestId binding
  } else Object.assign(c.finalRequest, { [key]: values[key] });
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution(c.finalRequest, c.finalAttempt))).toThrow('FORBIDDEN');
});
it.each(attemptKeys)('F4 correction preserves attempt immutable %s independently', async (key) => {
  const c = await correction();
  const values = { nonce: c.attempt.nonce + 1n, publicKey: `ed25519:${hash('other-key')}`, blockHash: hash('other-block'),
    signedTxBase64: 'AA==', txHash: hash('other-hash'), createdAt: c.attempt.createdAt + 1,
    lastOfferedAt: null, offerCount: 0, firstRejection: undefined, nonExecutionEvidence: null };
  if (key === 'id') corrupt('attempts', c.attempt.id, { id: 'corrupt-attempt-id' });
  else if (key === 'requestId') corrupt('attempts', c.attempt.id, { requestId: 'corrupt-request-id' });
  else Object.assign(c.finalAttempt, { [key]: values[key] });
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution(c.finalRequest, c.finalAttempt))).toThrow('FORBIDDEN');
});
it('F4 correction requestId binding is independent of the attempt immutable comparison', async () => {
  const c = await correction();
  corrupt('attempts', c.attempt.id, { requestId: 'different-request-id' });
  c.finalAttempt.requestId = 'different-request-id'; // matches stored prior, but NOT this request
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution(c.finalRequest, c.finalAttempt))).toThrow('FORBIDDEN');
});
it('F4 correction refuses an already committed hold', async () => {
  const c = await correction();
  f.store.withImmediateTransaction((tx) => tx.putHold({ ...tx.getHold(c.request.id)!, status: 'committed' }));
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution(c.finalRequest, c.finalAttempt))).toThrow('FORBIDDEN');
});
it.each(['gasBurnt', 'tokensBurnt'] as const)('F4 request and final attempt must agree on actual %s', async (key) => {
  const c = await correction(); c.finalRequest[key] = c.finalAttempt[key]! + 1n;
  expect(() => f.store.withImmediateTransaction((tx) => tx.correctResolvedExecution(c.finalRequest, c.finalAttempt))).toThrow('FORBIDDEN');
});
