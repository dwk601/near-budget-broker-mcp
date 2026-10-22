import {
  actions, baseDecode, createTransaction, JsonRpcProvider, KeyPairSigner, PublicKey,
} from 'near-api-js';
import { AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigSchema, parseNear } from '../../../src/contracts/index.js';

export const RPC_URL = 'https://test.rpc.fastnear.com';
// Same backend and public-only request as near-cli-rs sponsor-by-faucet-service:
// https://github.com/near/near-cli-rs/blob/master/src/config/mod.rs
// https://github.com/near/near-cli-rs/blob/master/src/commands/account/create_account/sponsor_by_faucet_service/mod.rs
export const FAUCET_URL = 'https://helper.nearprotocol.com/account';
export interface AccountInfo { balance: bigint; keys: Record<string, boolean> }
export interface FixtureNetwork {
  verifyNetwork(): Promise<void>;
  account(id: string): Promise<AccountInfo | null>;
  faucet(id: string, publicKey: string): Promise<void>;
  addBroker(id: string, recoverySecret: string, brokerPublic: string): Promise<void>;
  createReceiver(custody: string, recoverySecret: string, id: string, publicKey: string): Promise<void>;
}
export class FixtureFailure extends Error {}
export function assertTestnet(network: string, rpcUrl: string): void {
  if (network !== 'testnet' || !ConfigSchema.shape.rpcUrl.safeParse(rpcUrl).success) {
    throw new FixtureFailure('MAINNET_REFUSED');
  }
}

export class TestnetNetwork implements FixtureNetwork {
  readonly provider: JsonRpcProvider;
  constructor(readonly rpcUrl: string, readonly fetcher: typeof fetch = fetch) {
    assertTestnet('testnet', rpcUrl);
    this.provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
  }
  async verifyNetwork(): Promise<void> {
    // Do not infer network identity from the URL or account suffix.
    const response = await this.fetcher(this.rpcUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'fixtures', method: 'status', params: [] }),
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    const body = await response.json() as { result?: { chain_id?: unknown } };
    if (!response.ok || body.result?.chain_id !== 'testnet') throw new FixtureFailure('MAINNET_REFUSED');
  }
  async account(id: string): Promise<AccountInfo | null> {
    try {
      const state = await this.provider.viewAccount({ accountId: id, blockQuery: { finality: 'final' } });
      const list = await this.provider.viewAccessKeyList({ accountId: id, finalityQuery: { finality: 'final' } });
      return { balance: state.amount + state.locked,
        keys: Object.fromEntries(list.keys.map((key) => [key.public_key, key.access_key.permission === 'FullAccess'])) };
    } catch (error) {
      if (error instanceof AccountDoesNotExistError) return null;
      throw error;
    }
  }
  async faucet(id: string, publicKey: string): Promise<void> {
    await this.verifyNetwork();
    let response: Response;
    try {
      response = await this.fetcher(FAUCET_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
        signal: AbortSignal.timeout(60_000), redirect: 'error',
      });
    } catch (error) {
      // Never print arbitrary server bodies/errors (or SDK objects holding keys).
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timeout after 60000ms' : 'fetch failed';
      throw new FixtureFailure(`BLOCKED: faucet POST ${FAUCET_URL}: ${reason}`);
    }
    if (!response.ok) throw new FixtureFailure(`BLOCKED: faucet POST ${FAUCET_URL}: HTTP ${response.status}`);
    const body = await response.json() as { status?: { SuccessValue?: string } };
    if (body.status?.SuccessValue === undefined || body.status.SuccessValue === Buffer.from('false').toString('base64')) {
      throw new FixtureFailure(`BLOCKED: faucet POST ${FAUCET_URL}: no successful account-creation outcome`);
    }
    // Confirm final chain state rather than trusting a faucet acknowledgment.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await this.account(id)) return;
      await delay(1000);
    }
    throw new FixtureFailure('BLOCKED: faucet account absent at finality after 30 checks');
  }
  private async send(custody: string, recoverySecret: string, receiverId: string, setupActions: ReturnType<typeof actions.transfer>[]): Promise<void> {
    await this.verifyNetwork();
    const signer = KeyPairSigner.fromSecretKey(recoverySecret as `ed25519:${string}`);
    const publicKey = await signer.getPublicKey();
    const key = await this.provider.viewAccessKey({ accountId: custody, publicKey, finalityQuery: { finality: 'final' } });
    if (key.permission !== 'FullAccess') throw new FixtureFailure('Recovery full-access key missing');
    const transaction = createTransaction(custody, publicKey, receiverId, key.nonce + 1n, setupActions, baseDecode(key.block_hash));
    const { signedTransaction } = await signer.signTransaction(transaction);
    await this.verifyNetwork();
    // Fixture setup only, never broker dispatch: no implicit nonce allocation or retry-signing.
    const result = await this.provider.sendTransactionUntil(signedTransaction, 'FINAL');
    if (!result.status || typeof result.status !== 'object' || !('SuccessValue' in result.status)) {
      throw new FixtureFailure('Fixture setup transaction did not succeed');
    }
  }
  async addBroker(id: string, recoverySecret: string, brokerPublic: string): Promise<void> {
    await this.send(id, recoverySecret, id, [actions.addFullAccessKey(PublicKey.fromString(brokerPublic))]);
  }
  async createReceiver(custody: string, recoverySecret: string, id: string, publicKey: string): Promise<void> {
    await this.send(custody, recoverySecret, id, [actions.createAccount(), actions.transfer(parseNear('0.1')),
      actions.addFullAccessKey(PublicKey.fromString(publicKey))]);
  }
}
