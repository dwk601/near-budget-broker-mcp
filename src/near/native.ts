import { createHash } from 'node:crypto';
import {
  actions, baseDecode, baseEncode, createTransaction, decodeSignedTransaction,
  encodeTransaction, PublicKey, Signature, SignedTransaction,
} from 'near-api-js';
import {
  AccountBalanceSchema, AccountIdSchema, AccessKeyViewSchema, Base64Schema, BrokerError,
  ChainHashSchema, ChainOutcomeSchema, ConfigSchema, MAX_U128,
  NativeTransferToSignSchema, SignedNativeTransferSchema,
} from '../contracts/index.js';
import type {
  AccountBalance, AccessKeyView, BroadcastResult, ChainOutcome, Clock, CustodySigner,
  NativeTransferToSign, NearChain, RecentBlock, SignedNativeTransfer,
} from '../contracts/index.js';
import { record, RpcClient, RpcFailure, unsigned } from './rpc.js';
import type { RpcFetch } from './rpc.js';

const U64_MAX = (1n << 64n) - 1n;
const digest = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();
const unknownOutcome = (): ChainOutcome => ({ kind: 'outcome_unknown', reason: 'Final execution evidence unavailable' });

function publicKey(text: string): PublicKey {
  try {
    const key = PublicKey.fromString(text);
    if (key.keyType !== 0 || key.data.length !== 32 || key.toString() !== text) throw new Error();
    return key;
  } catch { throw new BrokerError('FORBIDDEN'); }
}
function blockHash(text: string): Uint8Array {
  const bytes = baseDecode(ChainHashSchema.parse(text));
  if (bytes.length !== 32 || baseEncode(bytes) !== text) throw new BrokerError('FORBIDDEN');
  return bytes;
}
function nativeSigned(bytes: Uint8Array): SignedNativeTransfer {
  try {
    if (bytes.length > 4096) throw new Error();
    const signed = decodeSignedTransaction(bytes);
    if (!Buffer.from(encodeTransaction(signed)).equals(Buffer.from(bytes))) throw new Error();
    const tx = signed.transaction;
    const action = tx.actions[0];
    // v7.3.1 Borsh decodes actions/signatures as plain tagged records, not
    // class instances (despite declarations); do not rely on enum/getter fields.
    if (tx.actions.length !== 1 || !action || Object.keys(action).join() !== 'transfer' || !action.transfer) throw new Error();
    const transfer = NativeTransferToSignSchema.parse({
      signerId: tx.signerId, receiverId: tx.receiverId, amount: action.transfer.deposit,
      nonce: tx.nonce, publicKey: tx.publicKey.toString(), blockHash: baseEncode(Uint8Array.from(tx.blockHash)),
    });
    const pk = publicKey(transfer.publicKey);
    blockHash(transfer.blockHash);
    const hash = digest(tx.encode());
    const signature = signed.signature.ed25519Signature?.data;
    if (Object.keys(signed.signature).join() !== 'ed25519Signature' || !signature || signature.length !== 64
      || !pk.verify(hash, Uint8Array.from(signature))) throw new Error();
    return { transfer, signedTxBase64: Buffer.from(bytes).toString('base64'), txHash: baseEncode(hash) };
  } catch { throw new BrokerError('FORBIDDEN'); }
}
function fromBase64(text: string): SignedNativeTransfer {
  if (text.length > 5500 || !Base64Schema.safeParse(text).success) throw new BrokerError('FORBIDDEN');
  return nativeSigned(Buffer.from(text, 'base64'));
}

export interface NativeNearChainOptions {
  rpcUrl: string;
  accountId: string;
  clock?: Clock;
  fetch?: RpcFetch;
  timeoutMs?: number;
}

/** Native-only testnet adapter. Use connect() so startup cannot skip attestation.
 * No Account convenience methods, nonce retries, key changes or contract calls. */
export class NativeNearChain implements NearChain {
  readonly #rpc: RpcClient;
  readonly #accountId: string;
  readonly #clock: Clock;
  private constructor(options: NativeNearChainOptions) {
    try { ConfigSchema.shape.rpcUrl.parse(options.rpcUrl); }
    catch { throw new BrokerError('MAINNET_REFUSED'); }
    this.#accountId = AccountIdSchema.parse(options.accountId);
    this.#clock = options.clock ?? { now: () => Date.now() };
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new BrokerError('FORBIDDEN');
    this.#rpc = new RpcClient(options.rpcUrl, options.fetch ?? fetch, timeout);
  }
  static async connect(options: NativeNearChainOptions): Promise<NativeNearChain> {
    const chain = new NativeNearChain(options);
    await chain.verifyNetwork();
    return chain;
  }
  async verifyNetwork(): Promise<'testnet'> {
    try {
      const status = record(await this.#rpc.call('status', []));
      if (status['chain_id'] !== 'testnet') throw new Error();
      return 'testnet';
    } catch { throw new BrokerError('MAINNET_REFUSED'); }
  }
  async viewAccount(accountId: string): Promise<AccountBalance> {
    AccountIdSchema.parse(accountId);
    const state = record(await this.#rpc.call('query', { request_type: 'view_account', account_id: accountId, finality: 'final' }));
    // Pin the protocol config to the SAME final block as the account snapshot.
    const hash = ChainHashSchema.parse(state['block_hash']);
    blockHash(hash);
    const protocol = record(await this.#rpc.call('EXPERIMENTAL_protocol_config', { block_id: hash }));
    const runtime = record(protocol['runtime_config']);
    const amount = unsigned(state['amount']);
    const locked = unsigned(state['locked']);
    const storageReserve = unsigned(state['storage_usage'], U64_MAX) * unsigned(runtime['storage_amount_per_byte']);
    if (amount + locked > MAX_U128 || storageReserve > MAX_U128) throw new BrokerError('BROKER_UNAVAILABLE');
    // NEAR amount is liquid, locked is staked; staked tokens ALSO cover storage.
    // total=amount+locked; spendable=max(0,total-max(locked,storageReserve)).
    // Equivalently: amount - max(0, storageReserve-locked), clamped at zero.
    const reserve = locked > storageReserve ? locked : storageReserve;
    const total = amount + locked;
    return AccountBalanceSchema.parse({ accountId, total, locked, storageReserve,
      spendable: total > reserve ? total - reserve : 0n, blockHash: hash, observedAt: this.#clock.now() });
  }
  async viewAccessKey(accountId: string, key: string): Promise<AccessKeyView> {
    AccountIdSchema.parse(accountId); publicKey(key);
    const state = record(await this.#rpc.call('query', {
      request_type: 'view_access_key', account_id: accountId, public_key: key, finality: 'final',
    }));
    const hash = ChainHashSchema.parse(state['block_hash']);
    blockHash(hash);
    return AccessKeyViewSchema.parse({ nonce: unsigned(state['nonce'], U64_MAX), publicKey: key,
      fullAccess: state['permission'] === 'FullAccess', blockHash: hash });
  }
  async recentBlockHash(): Promise<RecentBlock> {
    const block = record(await this.#rpc.call('block', { finality: 'final' }));
    const hash = ChainHashSchema.parse(record(block['header'])['hash']);
    blockHash(hash);
    return { hash, observedAt: this.#clock.now() };
  }
  async buildAndSignNativeTransfer(input: NativeTransferToSign, signer: CustodySigner): Promise<SignedNativeTransfer> {
    const transfer = NativeTransferToSignSchema.parse(input);
    if (transfer.signerId !== this.#accountId || signer.publicKey !== transfer.publicKey || transfer.nonce > U64_MAX) throw new BrokerError('FORBIDDEN');
    const tx = createTransaction(transfer.signerId, publicKey(transfer.publicKey), transfer.receiverId,
      transfer.nonce, [actions.transfer(transfer.amount)], blockHash(transfer.blockHash));
    await this.verifyNetwork(); // Re-attest immediately before signing, not merely at construction.
    const signature = await signer.sign(digest(tx.encode()));
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: signature }) });
    return nativeSigned(signed.encode());
  }
  encodeSignedTx(transaction: SignedNativeTransfer): Uint8Array {
    const parsed = SignedNativeTransferSchema.parse(transaction);
    const decoded = fromBase64(parsed.signedTxBase64);
    if (parsed.txHash !== decoded.txHash || Object.entries(decoded.transfer).some(([key, value]) =>
      parsed.transfer[key as keyof NativeTransferToSign] !== value)) throw new BrokerError('FORBIDDEN');
    return Buffer.from(parsed.signedTxBase64, 'base64');
  }
  decodeSignedTx(bytes: Uint8Array): SignedNativeTransfer { return nativeSigned(bytes); }
  async broadcast(signedTxBase64: string): Promise<BroadcastResult> {
    const signed = fromBase64(signedTxBase64);
    if (signed.transfer.signerId !== this.#accountId) throw new BrokerError('FORBIDDEN');
    await this.verifyNetwork(); // A mismatch is a refusal, not a send attempt.
    const txHash = signed.txHash;
    try {
      const result = await this.#rpc.call('broadcast_tx_async', [signedTxBase64]);
      if (result === txHash) return { kind: 'accepted', txHash };
      return { kind: 'outcome_unknown', txHash, reason: 'Unrecognized broadcast acknowledgment' };
    } catch (error) {
      if (error instanceof RpcFailure) {
        // Structured node validation errors only; do not guess from arbitrary messages.
        const code = rejectionCode(error.response);
        if (code) return { kind: 'rejected', txHash, code, reason: code };
      }
      return { kind: 'outcome_unknown', txHash, reason: 'Broadcast acknowledgment unavailable' };
    }
  }
  async txStatus(txHash: string, signerId: string): Promise<ChainOutcome> {
    ChainHashSchema.parse(txHash); AccountIdSchema.parse(signerId);
    try {
      const result = await this.#rpc.call('tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' });
      const response = record(result);
      const tx = record(response['transaction']);
      if (tx['hash'] !== txHash || tx['signer_id'] !== signerId
        || record(response['transaction_outcome'])['id'] !== txHash) return unknownOutcome();
      return this.classifyOutcome(response);
    } catch { return unknownOutcome(); }
  }
  classifyOutcome(rpcResponse: unknown): ChainOutcome {
    try {
      const response = record(rpcResponse);
      // EXECUTED_OPTIMISTIC / INCLUDED_FINAL do NOT establish final receipt accounting.
      if (response['final_execution_status'] !== 'FINAL') {
        return ['NONE', 'INCLUDED', 'INCLUDED_FINAL', 'EXECUTED_OPTIMISTIC', 'EXECUTED'].includes(String(response['final_execution_status']))
          ? { kind: 'pending' } : unknownOutcome();
      }
      const status = record(response['status']);
      const succeeded = typeof status['SuccessValue'] === 'string';
      if (Object.keys(status).length !== 1 || (!succeeded && !('Failure' in status))) return unknownOutcome();
      if (!Array.isArray(response['receipts_outcome'])) return unknownOutcome();
      const receipts = response['receipts_outcome'] as unknown[];
      const outcomes = [response['transaction_outcome'], ...receipts];
      let gasBurnt = 0n; let tokensBurnt = 0n;
      const ids = new Set<string>();
      const children: string[] = [];
      for (const item of outcomes) {
        const outer = record(item);
        const id = ChainHashSchema.parse(outer['id']);
        if (ids.has(id)) return unknownOutcome(); // Never double-charge duplicated receipts.
        ids.add(id);
        const outcome = record(outer['outcome']);
        if (!Array.isArray(outcome['receipt_ids'])) return unknownOutcome();
        children.push(...outcome['receipt_ids'].map((child) => ChainHashSchema.parse(child)));
        gasBurnt += unsigned(outcome['gas_burnt'], U64_MAX);
        tokensBurnt += unsigned(outcome['tokens_burnt']);
        if (tokensBurnt > MAX_U128) return unknownOutcome();
      }
      // FINAL must include the entire receipt graph, including refund receipts.
      if (children.some((child) => !ids.has(child))) return unknownOutcome();
      const receiptIds = receipts.map((item) => ChainHashSchema.parse(record(item)['id']));
      return ChainOutcomeSchema.parse(succeeded
        ? { kind: 'succeeded', final: true, receiptIds, gasBurnt, tokensBurnt }
        : { kind: 'failed', final: true, receiptIds, gasBurnt, tokensBurnt, error: 'Transaction execution failed' });
    } catch { return unknownOutcome(); }
  }
}

function rejectionCode(error: unknown): 'INVALID_NONCE' | 'EXPIRED_BLOCK_HASH' | 'RPC_REJECTED' | null {
  try {
    const body = record(error);
    let invalid: unknown;
    if (body['cause'] !== undefined) {
      const cause = record(body['cause']);
      if (cause['name'] !== 'INVALID_TRANSACTION') return null;
      invalid = record(cause['info'])['InvalidTxError'];
    } else {
      // Legacy JSON-RPC structured validation errors (not free-form data strings).
      const data = record(body['data']);
      invalid = record(data['TxExecutionError'])['InvalidTxError'];
    }
    if (invalid === 'Expired') return 'EXPIRED_BLOCK_HASH';
    if (invalid && typeof invalid === 'object' && 'InvalidNonce' in invalid) return 'INVALID_NONCE';
    if (invalid && typeof invalid === 'object' && 'Expired' in invalid) return 'EXPIRED_BLOCK_HASH';
    return invalid === undefined ? null : 'RPC_REJECTED';
  } catch { return null; }
}
