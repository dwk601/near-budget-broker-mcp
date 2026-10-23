import { createHash } from 'node:crypto';
import {
  actions, baseDecode, baseEncode, createTransaction, decodeSignedTransaction,
  encodeTransaction, PublicKey, Signature, SignedTransaction,
} from 'near-api-js';
import {
  AccountBalanceSchema, AccountIdSchema, AccessKeyViewSchema, Base64Schema, BrokerError,
  ChainHashSchema, ChainOutcomeSchema, ConfigSchema, MAX_U128,
  NativeTransferToSignSchema, SignedNativeTransferSchema, NON_EXECUTION_MIN_AGE_MS,
} from '../contracts/index.js';
import type {
  AccountBalance, AccessKeyView, BroadcastResult, ChainOutcome, Clock, CustodySigner,
  NativeTransferToSign, NearChain, RecentBlock, SignedNativeTransfer, TxAttempt,
} from '../contracts/index.js';
import { record, RpcClient, RpcFailure, unsigned } from './rpc.js';
import type { RpcFetch } from './rpc.js';
import { EXPIRY_SAFETY_BLOCKS, VALIDITY_BLOCK_MS, EXPIRY_LOOKUP_SPACING_MS } from './proof-policy.js';

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
  /** Test seam paired with Clock; production waits real elapsed time. */
  sleep?: (ms: number) => Promise<void>;
}

/** Native-only testnet adapter. Use connect() so startup cannot skip attestation.
 * No Account convenience methods, nonce retries, key changes or contract calls. */
export class NativeNearChain implements NearChain {
  readonly #rpc: RpcClient;
  readonly #accountId: string;
  readonly #clock: Clock;
  readonly #sleep: (ms: number) => Promise<void>;
  private constructor(options: NativeNearChainOptions) {
    try { ConfigSchema.shape.rpcUrl.parse(options.rpcUrl); }
    catch { throw new BrokerError('MAINNET_REFUSED'); }
    this.#accountId = AccountIdSchema.parse(options.accountId);
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
      // Async/NONE acknowledgment does not validate the transaction. Wait for
      // inclusion so nearcore can report InvalidNonce/Expired, without re-signing.
      const result = record(await this.#rpc.call('send_tx', {
        signed_tx_base64: signed.signedTxBase64, wait_until: 'INCLUDED',
      }));
      const transaction = result['transaction'];
      const matches = transaction === undefined || (record(transaction)['hash'] === txHash
        && record(transaction)['signer_id'] === signed.transfer.signerId);
      if (matches && ['INCLUDED', 'INCLUDED_FINAL', 'EXECUTED_OPTIMISTIC', 'EXECUTED', 'FINAL']
        .includes(String(result['final_execution_status']))) return { kind: 'accepted', txHash };
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
  async txStatus(txHash: string, signerId: string, attempt?: TxAttempt): Promise<ChainOutcome> {
    ChainHashSchema.parse(txHash); AccountIdSchema.parse(signerId);
    try {
      const result = await this.#rpc.call('tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' });
      return this.observedOutcome(record(result), txHash, signerId);
    } catch (error) {
      if (attempt && unknownTransaction(error)) return this.proveNotExecuted(txHash, signerId, attempt, this.#clock.now());
      return unknownOutcome();
    }
  }
  private async proveNotExecuted(txHash: string, signerId: string, attempt: TxAttempt, negativeAt: number): Promise<ChainOutcome> {
    try {
      await this.verifyNetwork();
      // Never accept caller metadata alone as evidence. Decode and verify the
      // exact persisted signature, then bind every proof field to that message.
      const signed = fromBase64(attempt.signedTxBase64);
      const t = signed.transfer;
      if (signed.txHash !== txHash || attempt.txHash !== txHash || t.signerId !== signerId
        || signerId !== this.#accountId || t.nonce !== attempt.nonce || t.publicKey !== attempt.publicKey
        || t.blockHash !== attempt.blockHash) return unknownOutcome();
      // Never infer non-execution from a fresh offer or missing legacy offer
      // metadata. RPC pools/indexers may lag inclusion by multiple final blocks.
      // A consumed nonce alone cannot disambiguate an accepted transaction.
      // Keep first-offer rejection provenance for the NONCE path. Independently,
      // an aged expiry proof may cover any offer count, including a lost 504.
      const nonceProof = attempt.offerCount === 1 && (attempt.firstRejection === 'INVALID_NONCE'
        || attempt.firstRejection === 'EXPIRED_BLOCK_HASH');
      const offered = attempt.lastOfferedAt;
      const now = this.#clock.now();
      if (offered === undefined || offered === null || !Number.isSafeInteger(offered)
        || offered > now || now - offered < NON_EXECUTION_MIN_AGE_MS) return unknownOutcome();
      // BOTH nonce and expiry paths require retained history at the anchor.
      // A GC'd executed transaction also has UNKNOWN_TRANSACTION + consumed nonce.
      const anchor = record(record(await this.#rpc.call('block', { block_id: t.blockHash }))['header']);
      if (anchor['hash'] !== t.blockHash) return unknownOutcome();
      const height = unsigned(anchor['height'], U64_MAX);
      const head = record(record(await this.#rpc.call('block', { finality: 'final' }))['header']);
      const headHash = ChainHashSchema.parse(head['hash']); blockHash(headHash);
      const headHeight = unsigned(head['height'], U64_MAX);
      if (headHeight < height) return unknownOutcome();
      let evidence: string | null = null;
      let invalidNonce = false;
      if (nonceProof) {
        try {
          const key = record(await this.#rpc.call('query', { request_type: 'view_access_key', account_id: signerId,
            public_key: t.publicKey, block_id: headHash }));
          if (key['block_hash'] === headHash) {
            const nonce = unsigned(key['nonce'], U64_MAX);
            if (nonce >= t.nonce) {
              invalidNonce = true;
              evidence = `FIRST_OFFER_REJECTED:${attempt.firstRejection}; UNKNOWN_TRANSACTION; retained anchor ${t.blockHash} height ${height}; final access key ${headHash} nonce ${nonce} >= attempt ${t.nonce}; last offer ${offered}`;
            }
          }
        } catch { /* An expiry proof does not depend on access-key availability. */ }
      }
      if (evidence === null) {
        const protocol = record(await this.#rpc.call('EXPERIMENTAL_protocol_config', { block_id: headHash }));
        const validity = unsigned(protocol['transaction_validity_period'], U64_MAX);
        // Signing age, unlike last-offer time, is not reset by identical replay.
        // Keep the separate 60s last-offer gate above for recent visibility lag.
        const signingAge = now - attempt.createdAt;
        if (!Number.isSafeInteger(signingAge) || signingAge < 0 || validity === 0n
          || BigInt(signingAge) < validity * VALIDITY_BLOCK_MS
          || headHeight < height + validity + EXPIRY_SAFETY_BLOCKS) return unknownOutcome();
        const elapsed = this.#clock.now() - negativeAt;
        if (elapsed < 0) return unknownOutcome();
        if (elapsed < EXPIRY_LOOKUP_SPACING_MS) await this.#sleep(EXPIRY_LOOKUP_SPACING_MS - elapsed);
        if (this.#clock.now() - negativeAt < EXPIRY_LOOKUP_SPACING_MS) return unknownOutcome();
        evidence = `EXPIRY_PROOF; UNKNOWN_TRANSACTION twice spaced >= ${EXPIRY_LOOKUP_SPACING_MS}ms; retained anchor ${t.blockHash} height ${height}; final head ${headHash} height ${headHeight} >= anchor + validity ${validity} + margin ${EXPIRY_SAFETY_BLOCKS}; signing age ${signingAge}ms; last offer ${offered}`;
      }
      // A second negative lookup AFTER the final nonce/expiry observation closes
      // the observation race. Timeout, malformed result, or any other error is
      // not a negative lookup. Execution always wins over exclusion evidence.
      try {
        const result = await this.#rpc.call('tx', { tx_hash: txHash, sender_account_id: signerId, wait_until: 'FINAL' });
        return this.observedOutcome(record(result), txHash, signerId);
      } catch (error) {
        if (!unknownTransaction(error)) return unknownOutcome();
      }
      return { kind: 'not_executed', evidence, invalidNonce };
    } catch { return unknownOutcome(); }
  }
  private observedOutcome(response: Record<string, unknown>, txHash: string, signerId: string): ChainOutcome {
    const tx = record(response['transaction']);
    if (tx['hash'] !== txHash || tx['signer_id'] !== signerId) return unknownOutcome();
    // Once a matching transaction is observed, incomplete/malformed accounting
    // must still veto owner or exclusion resolution. Never downgrade it to an
    // absence claim merely because the fee graph cannot be read yet.
    try {
      if (record(response['transaction_outcome'])['id'] !== txHash) return { kind: 'pending' };
      const outcome = this.classifyOutcome(response);
      return outcome.kind === 'outcome_unknown' ? { kind: 'pending' } : outcome;
    } catch { return { kind: 'pending' }; }
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

function unknownTransaction(error: unknown): boolean {
  try {
    return error instanceof RpcFailure && record(record(error.response)['cause'])['name'] === 'UNKNOWN_TRANSACTION';
  } catch { return false; }
}

function rejectionCode(error: unknown): 'INVALID_NONCE' | 'EXPIRED_BLOCK_HASH' | 'RPC_REJECTED' | null {
  try {
    const body = record(error);
    // near-api-js 7.3.1 parseHandlerError reads data.TxExecutionError even
    // when cause is present: real nodes commonly send cause.info = {}.
    let invalid: unknown;
    try { invalid = record(record(body['data'])['TxExecutionError'])['InvalidTxError']; }
    catch { /* An alternate RPC may put the enum in cause.info instead. */ }
    if (invalid === undefined && body['cause'] !== undefined) {
      const cause = record(body['cause']);
      if (cause['name'] !== 'INVALID_TRANSACTION') return null;
      invalid = record(cause['info'])['InvalidTxError'];
    }
    if (invalid === 'Expired') return 'EXPIRED_BLOCK_HASH';
    if (invalid && typeof invalid === 'object' && 'InvalidNonce' in invalid) return 'INVALID_NONCE';
    if (invalid && typeof invalid === 'object' && 'Expired' in invalid) return 'EXPIRED_BLOCK_HASH';
    return invalid === undefined ? null : 'RPC_REJECTED';
  } catch { return null; }
}
