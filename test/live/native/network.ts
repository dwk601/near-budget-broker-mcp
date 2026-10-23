import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { actions, baseDecode, baseEncode, createTransaction, KeyPairSigner } from 'near-api-js';
import { ConfigSchema } from '../../../src/contracts/index.js';

export interface Outcome {
  transaction: { hash: string; nonce: number | string; signer_id: string };
  final_execution_status: string; status: { SuccessValue?: string; Failure?: unknown };
  transaction_outcome: { outcome: { tokens_burnt: string } };
  receipts_outcome: { outcome: { tokens_burnt: string } }[];
}
export interface PreparedRecovery { signerId: string; txHash: string; signedTxBase64: string }
export class RpcFailure extends Error {
  constructor(readonly code: string) { super(`testnet RPC ${code}`); }
}
export class Testnet {
  constructor(readonly url: string, readonly fetcher: typeof fetch = fetch, readonly signal?: AbortSignal) {
    assert(ConfigSchema.shape.rpcUrl.safeParse(url).success, 'MAINNET_REFUSED');
  }
  async rpc<T>(method: string, params: unknown): Promise<T> {
    this.signal?.throwIfAborted();
    const response = await this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'B10', method, params }), redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(this.signal ? [this.signal] : [])]) });
    if (response.status !== 200) throw new RpcFailure(`HTTP_${response.status}`);
    const body = await response.json() as { result: T; error?: { cause?: { name?: unknown } } };
    if (body.error) {
      const name = body.error.cause?.name;
      // Never include arbitrary RPC bodies (or signing objects) in diagnostics.
      throw new RpcFailure(name === 'UNKNOWN_ACCOUNT' || name === 'UNKNOWN_TRANSACTION' ? name : 'FAILED');
    }
    return body.result;
  }
  async attest() { assert.equal((await this.rpc<{ chain_id: string }>('status', [])).chain_id, 'testnet', 'MAINNET_REFUSED'); }
  async account(account_id: string): Promise<{ amount: bigint; locked: bigint } | null> {
    try {
      const state = await this.rpc<{ amount: string; locked: string }>('query', { request_type: 'view_account', account_id, finality: 'final' });
      return { amount: BigInt(state.amount), locked: BigInt(state.locked) };
    } catch (e) { if (e instanceof RpcFailure && e.code === 'UNKNOWN_ACCOUNT') return null; throw e; }
  }
  async snapshot(sender: string, receiver: string) {
    const block = await this.rpc<{ header: { hash: string } }>('block', { finality: 'final' });
    const account = async (account_id: string) => this.rpc<{ amount: string; locked: string }>('query', { request_type: 'view_account', account_id, block_id: block.header.hash });
    const [s, r] = await Promise.all([account(sender), account(receiver)]);
    return { sender: BigInt(s.amount) + BigInt(s.locked), receiver: BigInt(r.amount) + BigInt(r.locked) };
  }
  tx(hash: string, sender: string) { return this.rpc<Outcome>('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' }); }
  async keys(account_id: string) {
    return (await this.rpc<{ keys: { public_key: string; access_key: { permission: unknown } }[] }>('query', { request_type: 'view_access_key_list', account_id, finality: 'final' })).keys;
  }
  /** Owner provisioning/recovery only, never agent payments. Preparation never broadcasts. */
  async prepareRecovery(signerId: string, secret: string, receiverId: string, setupActions: ReturnType<typeof actions.transfer>[]): Promise<PreparedRecovery> {
    await this.attest();
    const signer = KeyPairSigner.fromSecretKey(secret as `ed25519:${string}`); const publicKey = await signer.getPublicKey();
    const key = await this.rpc<{ nonce: number | string; block_hash: string; permission: unknown }>('query', {
      request_type: 'view_access_key', account_id: signerId, public_key: publicKey.toString(), finality: 'final' });
    assert.equal(key.permission, 'FullAccess');
    if (typeof key.nonce === 'number') assert(Number.isSafeInteger(key.nonce));
    const transaction = createTransaction(signerId, publicKey, receiverId, BigInt(key.nonce) + 1n, setupActions, baseDecode(key.block_hash));
    const { signedTransaction } = await signer.signTransaction(transaction);
    this.signal?.throwIfAborted();
    return { signerId, txHash: baseEncode(createHash('sha256').update(transaction.encode()).digest()),
      signedTxBase64: Buffer.from(signedTransaction.encode()).toString('base64') };
  }
  async submitRecovery(prepared: PreparedRecovery): Promise<Outcome> {
    await this.attest();
    const result = await this.rpc<Outcome>('send_tx', { signed_tx_base64: prepared.signedTxBase64, wait_until: 'FINAL' });
    return this.success(prepared, result);
  }
  success(prepared: PreparedRecovery, result: Outcome) {
    assert.equal(result.transaction.hash, prepared.txHash); assert.equal(result.transaction.signer_id, prepared.signerId);
    assert.equal(result.final_execution_status, 'FINAL'); assert.equal(result.status.SuccessValue, ''); return result;
  }
  /** Reconcile a lost response first; rebroadcast ONLY identical persisted bytes. */
  async finishRecovery(prepared: PreparedRecovery): Promise<Outcome> {
    try { return this.success(prepared, await this.tx(prepared.txHash, prepared.signerId)); }
    catch (e) {
      this.signal?.throwIfAborted();
      // Some public nodes hold FINAL lookups for unknown hashes until the client
      // times out. That is NOT exclusion evidence, but replaying identical signed
      // bytes is nonce-idempotent and does not require exclusion or re-signing.
      if (!(e instanceof RpcFailure && e.code === 'UNKNOWN_TRANSACTION') && !(e instanceof Error && e.name === 'TimeoutError')) throw e;
    }
    return this.submitRecovery(prepared);
  }
  async recovery(signerId: string, secret: string, receiverId: string, setupActions: ReturnType<typeof actions.transfer>[]): Promise<Outcome> {
    return this.submitRecovery(await this.prepareRecovery(signerId, secret, receiverId, setupActions));
  }
}
export const tokensBurnt = (o: Outcome) => [o.transaction_outcome, ...o.receipts_outcome].reduce((n, x) => n + BigInt(x.outcome.tokens_burnt), 0n);
