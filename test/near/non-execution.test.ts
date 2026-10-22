import { expect, it } from 'vitest';
import { KeyPair, baseEncode } from 'near-api-js';
import { NativeNearChain } from '../../src/near/index.js';
import type { TxAttempt } from '../../src/contracts/index.js';
const hash = (i: number) => baseEncode(new Uint8Array(32).fill(i));
const pair = KeyPair.fromRandom('ed25519'); const publicKey = pair.getPublicKey().toString();
const unknown = { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} } } };
async function fixture(options: { nonce?: string; height?: string; validity?: string; txError?: unknown; second?: unknown; wrongHead?: boolean } = {}) {
  let lookups = 0; let txHash = '';
  const calls: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const req = JSON.parse(String(init?.body)) as { method: string; id: string; params: Record<string, unknown> };
    calls.push(req.method);
    let result: unknown;
    if (req.method === 'status') result = { chain_id: 'testnet' };
    if (req.method === 'block') result = { header: { hash: req.params['block_id'] ?? hash(2), height: req.params['block_id'] ? '10' : options.height ?? '111' } };
    if (req.method === 'query') result = { nonce: options.nonce ?? '0', block_hash: options.wrongHead ? hash(9) : hash(2) };
    if (req.method === 'EXPERIMENTAL_protocol_config') result = { transaction_validity_period: options.validity ?? '100' };
    if (req.method === 'tx') {
      lookups++;
      const error = options.txError ?? unknown;
      const response = lookups === 2 && options.second ? options.second : error;
      return Response.json({ jsonrpc: '2.0', id: req.id, ...(response as object) });
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
  const chain = await NativeNearChain.connect({ accountId: 'broker.testnet', rpcUrl: 'http://fake.invalid', fetch: fetcher });
  const signed = await chain.buildAndSignNativeTransfer({ signerId: 'broker.testnet', receiverId: 'bob.testnet', amount: 1n,
    nonce: 5n, publicKey, blockHash: hash(1) }, { publicKey, sign: async (bytes) => pair.sign(bytes).signature });
  txHash = signed.txHash;
  const attempt: TxAttempt = { id: 't', requestId: 'r', nonce: 5n, publicKey, blockHash: hash(1), signedTxBase64: signed.signedTxBase64,
    txHash, status: 'outcome_unknown', receiptIds: [], gasBurnt: null, tokensBurnt: null, createdAt: 1, updatedAt: 1, nonExecutionEvidence: null };
  return { chain, attempt, calls };
}
it('Expired: exact negative lookup plus final head strictly beyond protocol validity yields proof', async () => {
  const { chain, attempt, calls } = await fixture();
  expect(await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).toMatchObject({ kind: 'not_executed', invalidNonce: false,
    evidence: expect.stringContaining('111 > anchor') });
  expect(calls.filter((c) => c === 'tx')).toHaveLength(2);
});
it('InvalidNonce: negative lookup plus pinned final access-key nonce >= attempt yields proof', async () => {
  const { chain, attempt } = await fixture({ nonce: '5', height: '11' });
  expect(await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).toMatchObject({ kind: 'not_executed', invalidNonce: true,
    evidence: expect.stringContaining('nonce 5 >= attempt 5') });
});
it.each([
  { height: '110' }, { validity: '0' }, { wrongHead: true },
  { txError: { error: { cause: { name: 'TIMEOUT_ERROR' } } } },
  { txError: { error: { message: 'UNKNOWN_TRANSACTION' } } },
  { second: { error: { cause: { name: 'TIMEOUT_ERROR' } } } },
])('never fabricates exclusion from boundary, malformed, timeout or unpinned evidence %#', async (options) => {
  const { chain, attempt } = await fixture(options);
  expect((await chain.txStatus(attempt.txHash, 'broker.testnet', attempt)).kind).toBe('outcome_unknown');
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
