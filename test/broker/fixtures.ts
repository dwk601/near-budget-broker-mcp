import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseEncode } from 'near-api-js';
import { BrokerService } from '../../src/broker/index.js';
import type { BrokerOptions } from '../../src/broker/index.js';
import { SqliteStore } from '../../src/storage/index.js';
import { AuditSigner, ReceiptLog } from '../../src/audit/core/index.js';
import { CheckpointLog } from '../../src/audit/checkpoints/index.js';
import { TransactionalApprovalService } from '../../src/approvals/index.js';
import { RequestAuthenticator, generateOwnerKeypair } from '../../src/auth/index.js';
import { parseNear } from '../../src/contracts/index.js';
import type {
  AccountBalance, AgentPolicy, AgentPrincipal, BroadcastResult, ChainOutcome, Clock,
  CustodySigner, NativeTransferToSign, NearChain, OwnerPrincipal, SignedNativeTransfer,
  Store, StoreReader, StoreTransaction,
} from '../../src/contracts/index.js';

export const owner: OwnerPrincipal = { kind: 'owner' };
export const hash = (s: string): string => baseEncode(createHash('sha256').update(s).digest());
export class FakeChain implements NearChain {
  readonly signer: CustodySigner = { publicKey: `ed25519:${hash('custody')}`, sign: async () => new Uint8Array(64) };
  readonly clock: Clock;
  balance = parseNear('1');
  nonce = 0n;
  built: SignedNativeTransfer[] = [];
  broadcasts: string[] = [];
  outcomes = new Map<string, ChainOutcome>();
  paid = new Set<string>();
  mode: 'accepted' | 'unknown' | 'throw' | 'invalid' | 'expired' = 'accepted';
  fail = false;
  fee = 7n;
  accountError = false;
  network: 'testnet' | 'mainnet' = 'testnet';
  constructor(clock: Clock) { this.clock = clock; }
  async verifyNetwork(): Promise<'testnet'> { if (this.network !== 'testnet') throw new Error('wrong network'); return 'testnet'; }
  async viewAccount(accountId: string): Promise<AccountBalance> {
    if (this.accountError) throw new Error('offline');
    return { accountId, total: this.balance, locked: 0n, storageReserve: 0n,
      spendable: this.balance, observedAt: this.clock.now(), blockHash: hash('block') };
  }
  async viewAccessKey(_account: string, publicKey: string) { return { publicKey, nonce: this.nonce, fullAccess: true, blockHash: hash('block') }; }
  async recentBlockHash() { return { hash: hash('block'), observedAt: this.clock.now() }; }
  async buildAndSignNativeTransfer(transfer: NativeTransferToSign) {
    const txHash = hash(`${transfer.nonce}:${transfer.receiverId}:${transfer.amount}`);
    const signed = { transfer, txHash, signedTxBase64: Buffer.from(txHash).toString('base64') };
    this.built.push(signed);
    return signed;
  }
  encodeSignedTx(tx: SignedNativeTransfer) { return Buffer.from(tx.signedTxBase64, 'base64'); }
  decodeSignedTx(bytes: Uint8Array) { return this.built.find((t) => t.txHash === Buffer.from(bytes).toString())!; }
  async broadcast(bytes: string): Promise<BroadcastResult> {
    this.broadcasts.push(bytes);
    const signed = this.built.find((t) => t.signedTxBase64 === bytes)!;
    if (!signed) throw new Error('not persisted');
    const txHash = signed.txHash;
    if (this.mode === 'throw') throw new Error('network');
    if (this.mode === 'unknown') return { kind: 'outcome_unknown', txHash, reason: 'timeout' };
    if (this.mode === 'invalid' || this.mode === 'expired') return { kind: 'rejected', txHash,
      code: this.mode === 'invalid' ? 'INVALID_NONCE' : 'EXPIRED_BLOCK_HASH', reason: 'node rejected THIS send' };
    if (!this.paid.has(txHash)) {
      if (signed.transfer.nonce <= this.nonce) throw new Error('nonce error');
      this.nonce = signed.transfer.nonce;
      this.paid.add(txHash);
      this.balance -= (this.fail ? 0n : signed.transfer.amount) + this.fee;
      this.outcomes.set(txHash, this.fail
        ? { kind: 'failed', final: true, receiptIds: [hash('receipt')], gasBurnt: 123n, tokensBurnt: this.fee, error: 'failed' }
        : { kind: 'succeeded', final: true, receiptIds: [hash('receipt')], gasBurnt: 123n, tokensBurnt: this.fee });
    }
    return { kind: 'accepted', txHash };
  }
  async txStatus(txHash: string): Promise<ChainOutcome> { return this.outcomes.get(txHash) ?? { kind: 'outcome_unknown', reason: 'no positive evidence' }; }
  classifyOutcome(value: unknown) { return value as ChainOutcome; }
}
export class Fixture {
  dir = mkdtempSync(join(tmpdir(), 'bb-broker-'));
  now = 1_700_000_000_000;
  clock = { now: () => this.now };
  chain = new FakeChain(this.clock);
  audit = AuditSigner.generate();
  stores: SqliteStore[] = [];
  store: Store;
  receipts: ReceiptLog;
  broker: BrokerService;
  options: BrokerOptions;
  afterTransition?: (r: StoreReader) => void;
  constructor(extra: Partial<BrokerOptions> = {}) {
    this.store = this.open();
    this.receipts = new ReceiptLog(this.store, this.audit);
    this.options = { store: this.store, chain: this.chain, signer: this.chain.signer,
      receipts: this.receipts, checkpoints: new CheckpointLog(this.store, this.audit),
      approvals: new TransactionalApprovalService(owner, this.receipts), clock: this.clock,
      config: { accountId: 'broker.testnet', balanceMaxAgeMs: 1000, feeReservePerTx: 10n }, ...extra };
    this.broker = new BrokerService(this.options);
  }
  open(): Store {
    const store = new SqliteStore(join(this.dir, 'state.sqlite'), { accountId: 'broker.testnet' });
    this.stores.push(store);
    return {
      read: <T>(fn: (r: StoreReader) => T) => store.read(fn),
      withImmediateTransaction: <T>(fn: (tx: StoreTransaction) => T) => {
        const result = store.withImmediateTransaction(fn);
        if (this.afterTransition) store.read(this.afterTransition);
        return result;
      }, close: () => store.close(),
    };
  }
  another(extra: Partial<BrokerOptions> = {}) {
    const store = this.open();
    const receipts = new ReceiptLog(store, this.audit);
    return new BrokerService({ ...this.options, store, receipts,
      approvals: new TransactionalApprovalService(owner, receipts), checkpoints: new CheckpointLog(store, this.audit), ...extra });
  }
  async init(global = parseNear('1')) {
    await this.broker.setWalletPolicy(owner, { revision: 1, rolling24hMax: global, safetyReserve: 0n }, null);
    await this.broker.start();
  }
  async agent(name = 'agent', override: Partial<AgentPolicy> = {}): Promise<AgentPrincipal> {
    const agent = await this.broker.createAgent(owner, name);
    await this.broker.setPolicy(owner, { agentId: agent.id, revision: 1, perTxMax: parseNear('0.1'), rolling24hMax: parseNear('1'),
      lifetimeMax: parseNear('1'), gasBudget24h: parseNear('1'), ratePerMinute: 1000, maxOutstanding: 1000,
      recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: null, ...override }, null);
    const credential = await this.broker.issueToken(owner, agent.id);
    const auth = new RequestAuthenticator({ store: this.store, clock: this.clock, ownerPublicKey: generateOwnerKeypair().publicKey });
    return auth.authenticateAgent(credential.token);
  }
  input(idempotencyKey: string, amount = parseNear('0.001')) { return { idempotencyKey, receiverId: 'receiver.testnet', amount }; }
  close() { for (const s of this.stores) s.close(); rmSync(this.dir, { recursive: true, force: true }); }
}
