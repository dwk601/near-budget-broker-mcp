import assert from 'node:assert/strict';
import { actions, baseDecode, createTransaction, KeyPairSigner } from 'near-api-js';
import { ConfigSchema } from '../../../src/contracts/index.js';

export interface Outcome {
  transaction: { hash: string; nonce: number | string; signer_id: string };
  final_execution_status: string; status: { SuccessValue?: string; Failure?: unknown };
  transaction_outcome: { outcome: { tokens_burnt: string } };
  receipts_outcome: { outcome: { tokens_burnt: string } }[];
}
export class Testnet {
  constructor(readonly url: string) { assert(ConfigSchema.shape.rpcUrl.safeParse(url).success, 'MAINNET_REFUSED'); }
  async rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'B10', method, params }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `testnet RPC HTTP ${response.status}`);
    const body = await response.json() as { result: T; error?: unknown };
    // Never include arbitrary RPC bodies (or signing objects) in diagnostics.
    assert(!body.error, `testnet RPC ${method} failed`); return body.result;
  }
  async attest() { assert.equal((await this.rpc<{ chain_id: string }>('status', [])).chain_id, 'testnet', 'MAINNET_REFUSED'); }
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
  /** Owner provisioning/recovery only, never used for agent payments. Explicit nonce, no retry-signing. */
  async recovery(signerId: string, secret: string, receiverId: string, setupActions: ReturnType<typeof actions.transfer>[]): Promise<Outcome> {
    await this.attest();
    const signer = KeyPairSigner.fromSecretKey(secret as `ed25519:${string}`); const publicKey = await signer.getPublicKey();
    const key = await this.rpc<{ nonce: number | string; block_hash: string; permission: unknown }>('query', {
      request_type: 'view_access_key', account_id: signerId, public_key: publicKey.toString(), finality: 'final' });
    assert.equal(key.permission, 'FullAccess');
    if (typeof key.nonce === 'number') assert(Number.isSafeInteger(key.nonce));
    const transaction = createTransaction(signerId, publicKey, receiverId, BigInt(key.nonce) + 1n, setupActions, baseDecode(key.block_hash));
    const { signedTransaction } = await signer.signTransaction(transaction);
    await this.attest();
    const result = await this.rpc<Outcome>('send_tx', { signed_tx_base64: Buffer.from(signedTransaction.encode()).toString('base64'), wait_until: 'FINAL' });
    assert.equal(result.final_execution_status, 'FINAL'); assert.equal(result.status.SuccessValue, ''); return result;
  }
}
export const tokensBurnt = (o: Outcome) => [o.transaction_outcome, ...o.receipts_outcome].reduce((n, x) => n + BigInt(x.outcome.tokens_burnt), 0n);
