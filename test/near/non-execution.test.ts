import { expect, it } from 'vitest';
import { KeyPair, baseEncode } from 'near-api-js';
import { NativeNearChain } from '../../src/near/index.js';
import type { TxAttempt } from '../../src/contracts/index.js';
const hash = (i: number) => baseEncode(new Uint8Array(32).fill(i));
const pair = KeyPair.fromRandom('ed25519'); const publicKey = pair.getPublicKey().toString();
const unknown = { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} } } };
async function fixture(options: { nonce?: string; height?: string; validity?: string; txError?: unknown; second?: unknown; wrongHead?: boolean; gcAnchor?: boolean; now?: number; noSleepAdvance?: boolean } = {}) {
  let lookups = 0; let txHash = ''; let now = options.now ?? 120_000;
  const lookupTimes: number[] = [];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const req = JSON.parse(String(init?.body)) as { method: string; id: string; params: Record<string, unknown> };
    calls.push(req.method);
    let result: unknown;
    if (req.method === 'status') result = { chain_id: 'testnet' };
    if (req.method === 'block' && req.params['block_id'] && options.gcAnchor) return Response.json({ jsonrpc: '2.0', id: req.id,
      error: { cause: { name: 'UNKNOWN_BLOCK', info: {} } } });
    if (req.method === 'block') result = { header: { hash: req.params['block_id'] ?? hash(2), height: req.params['block_id'] ? '10' : options.height ?? '1110' } };
    if (req.method === 'query') result = { nonce: options.nonce ?? '0', block_hash: options.wrongHead ? hash(9) : hash(2) };
    if (req.method === 'EXPERIMENTAL_protocol_config') result = { transaction_validity_period: options.validity ?? '100' };
    if (req.method === 'tx') {
      lookups++; lookupTimes.push(now);
      const error = options.txError ?? unknown;
      const response = lookups === 2 && options.second ? options.second : error;
      return Response.json({ jsonrpc: '2.0', id: req.id, ...(response as object) });
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
  const chain = await NativeNearChain.connect({ accountId: 'broker.testnet', rpcUrl: 'http://fake.invalid', fetch: fetcher, clock: { now: () => now }, sleep: async (ms) => { if (!options.noSleepAdvance) now += ms; } });
  const signed = await chain.buildAndSignNativeTransfer({ signerId: 'broker.testnet', receiverId: 'bob.testnet', amount: 1n,
    nonce: 5n, publicKey, blockHash: hash(1) }, { publicKey, sign: async (bytes) => pair.sign(bytes).signature });
  txHash = signed.txHash;
  const attempt: TxAttempt = { id: 't', requestId: 'r', nonce: 5n, publicKey, blockHash: hash(1), signedTxBase64: signed.signedTxBase64,
    txHash, status: 'outcome_unknown', receiptIds: [], gasBurnt: null, tokensBurnt: null, createdAt: 1, updatedAt: 1, nonExecutionEvidence: null, lastOfferedAt: 1, offerCount: 1,
    firstRejection: options.nonce === '5' ? 'INVALID_NONCE' : 'EXPIRED_BLOCK_HASH' };
  return { chain, attempt, calls, lookupTimes };
}
it('Expired: retained anchor plus validity + 1000-block margin and spaced negative lookups yields proof', async () => {
  const { chain, attempt, calls, lookupTimes } = await fixture();
  expect(await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).toMatchObject({ kind: 'not_executed', invalidNonce: false,
    evidence: expect.stringContaining('1110 >= anchor') });
  expect(calls.filter((c) => c === 'tx')).toHaveLength(2);
  expect(lookupTimes[1]! - lookupTimes[0]!).toBeGreaterThanOrEqual(1_000);
});
it('InvalidNonce: negative lookup plus pinned final access-key nonce >= attempt yields proof', async () => {
  const { chain, attempt } = await fixture({ nonce: '5', height: '11' });
  expect(await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).toMatchObject({ kind: 'not_executed', invalidNonce: true,
    evidence: expect.stringContaining('nonce 5 >= attempt 5') });
});
it.each([
  { height: '1109' }, { validity: '0' }, { wrongHead: true, nonce: '5', height: '11' }, { noSleepAdvance: true },
  { txError: { error: { cause: { name: 'TIMEOUT_ERROR' } } } },
  { txError: { error: { message: 'UNKNOWN_TRANSACTION' } } },
  { second: { error: { cause: { name: 'TIMEOUT_ERROR' } } } },
])('never fabricates exclusion from boundary, malformed, timeout or unpinned evidence %#', async (options) => {
  const { chain, attempt } = await fixture(options);
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).kind).toBe('outcome_unknown');
});
it.each(['5', '0'])('N1 GC anchor forbids exclusion on BOTH nonce=%s and expired-block paths', async (nonce) => {
  const { chain, attempt, calls } = await fixture({ nonce, gcAnchor: true });
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).kind).toBe('outcome_unknown');
  expect(calls.filter((c) => c === 'query')).toHaveLength(0);
});
it.each([1, 60_000])('N1 minimum age rejects last offer too recent for final RPC visibility (now=%s)', async (now) => {
  const { chain, attempt } = await fixture({ nonce: '5', now });
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).kind).toBe('outcome_unknown');
});
it('N1 creation age does not substitute for durable last-offer age or missing metadata', async () => {
  const { chain, attempt } = await fixture({ nonce: '5' });
  for (const lastOfferedAt of [undefined, null, 120_001, 119_999]) {
    expect((await chain.txStatus(attempt.txHash, 'broker.testnet', { ...attempt, lastOfferedAt })).kind).toBe('outcome_unknown');
  }
});
it('a lagging final head cannot prove nonce exclusion before the retrievable anchor', async () => {
  const { chain, attempt } = await fixture({ nonce: '5', height: '9' });
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).kind).toBe('outcome_unknown');
});
it('prolonged lookup lag after an accepted/ambiguous offer never proves absence, even with retained anchor and consumed nonce', async () => {
  const { chain, attempt } = await fixture({ nonce: '5', height: '111' });
  for (const metadata of [{ offerCount: 1, firstRejection: undefined }, { offerCount: undefined, firstRejection: undefined },
    { offerCount: 2, firstRejection: 'INVALID_NONCE' as const }]) {
    expect((await chain.txStatus(attempt.txHash, 'broker.testnet', { ...attempt, ...metadata })).kind).toBe('outcome_unknown');
  }
});
it.each([undefined, 1, 3])('M1 generous expiry proves ambiguous bytes with offerCount=%s, even when the nonce is consumed', async (offerCount) => {
  const { chain, attempt, lookupTimes } = await fixture({ nonce: '5' });
  const result = await chain.txStatus(attempt.txHash, 'broker.testnet', { ...attempt, offerCount, firstRejection: undefined });
  expect(result).toMatchObject({ kind: 'not_executed', invalidNonce: false, evidence: expect.stringContaining('EXPIRY_PROOF') });
  expect(lookupTimes[1]! - lookupTimes[0]!).toBeGreaterThanOrEqual(1000);
});
it('M1 expiry needs signing age >= validity time, not merely the 60s last-offer gate', async () => {
  const { chain, attempt } = await fixture({ now: 80_000 });
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet', { ...attempt, firstRejection: undefined })).kind).toBe('outcome_unknown');
});
it('M1 expiry of ambiguous replayed bytes still fails closed on GC history', async () => {
  const { chain, attempt } = await fixture({ gcAnchor: true, nonce: '5' });
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet', { ...attempt, offerCount: 3, firstRejection: undefined })).kind).toBe('outcome_unknown');
});
it('persisted bytes must bind hash, signer, nonce and block, including on a fresh adapter', async () => {
  const { chain, attempt } = await fixture();
  for (const altered of [{ ...attempt, nonce: 6n }, { ...attempt, txHash: hash(7) }, { ...attempt, blockHash: hash(7) },
    { ...attempt, signedTxBase64: 'AA==' }, { ...attempt, publicKey: `ed25519:${hash(8)}` }]) {
    expect((await chain.txStatus(attempt.txHash, 'broker.testnet', altered)).kind).toBe('outcome_unknown');
  }
  expect((await chain.txStatus(attempt.txHash, 'other.testnet', attempt)).kind).toBe('outcome_unknown');
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet')).kind).toBe('outcome_unknown');
});
it.each([undefined, 'malformed'])('an observed transaction with outcome=%s remains pending, never absence evidence', async (transaction_outcome) => {
  const f = await fixture();
  const { chain } = await fixture({ txError: { result: { transaction: { hash: f.attempt.txHash, signer_id: 'broker.testnet' }, transaction_outcome } } });
  expect(await chain.txStatus(f.attempt.txHash, 'broker.testnet', f.attempt)).toEqual({ kind: 'pending' });
});
it('second positive lookup vetoes exclusion, even when execution accounting is incomplete', async () => {
  const f = await fixture();
  // Separate adapter is fine: proof derives from bytes, not an in-memory rejected-send cache.
  const matching = { result: { transaction: { hash: f.attempt.txHash, signer_id: 'broker.testnet' },
    transaction_outcome: { id: f.attempt.txHash }, final_execution_status: 'FINAL', status: { SuccessValue: '' } } };
  const { chain } = await fixture({ second: matching });
  expect(await chain.txStatus(f.attempt.txHash, 'broker.testnet', f.attempt)).toEqual({ kind: 'pending' });
});
