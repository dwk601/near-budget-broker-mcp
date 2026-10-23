import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { actions, baseEncode, createTransaction, KeyPair, Signature, SignedTransaction } from 'near-api-js';
import { NativeNearChain, allocateNonce, allocateStoreNonce, isDefinitiveFirstRejection } from '../../src/near/index.js';
import { BrokerError } from '../../src/contracts/index.js';
import type { CustodySigner, NativeTransferToSign, Store, StoreTransaction } from '../../src/contracts/index.js';

const hash = (fill: number): string => baseEncode(new Uint8Array(32).fill(fill));
const block = hash(1);
const pair = KeyPair.fromRandom('ed25519');
const key = pair.getPublicKey().toString();
const signer: CustodySigner = { publicKey: key, sign: async (bytes) => pair.sign(bytes).signature };
const transfer: NativeTransferToSign = { signerId: 'broker.testnet', receiverId: 'bob.testnet', amount: 1n,
  nonce: 9007199254740993n, publicKey: key, blockHash: block };

type Request = { id: string; method: string; params: Record<string, unknown> | unknown[] };
function fakeRpc(handler: (request: Request) => unknown | Promise<unknown> = () => undefined) {
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Request;
    requests.push(request);
    const result = await handler(request);
    if (result instanceof Response) return result;
    return Response.json({ jsonrpc: '2.0', id: request.id,
      ...(result && typeof result === 'object' && 'error' in result ? result : { result: result ?? { chain_id: 'testnet' } }) });
  };
  return { requests, fetcher, connect: () => NativeNearChain.connect({ rpcUrl: 'http://rpc.test.invalid',
    accountId: transfer.signerId, fetch: fetcher, clock: { now: () => 1234 }, timeoutMs: 20 }) };
}
function rpcReject(invalid: unknown) {
  // Captured testnet envelope: cause is present but its info is empty.
  return { error: { name: 'HANDLER_ERROR', cause: { info: {}, name: 'INVALID_TRANSACTION' },
    code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: invalid } } } };
}
function finalOutcome(failed = false) {
  const outcome = (id: string, gas: string, tokens: string, children: string[] = []) => ({
    id, block_hash: block, proof: [], outcome: { executor_id: 'broker.testnet', logs: [],
      gas_burnt: gas, tokens_burnt: tokens, receipt_ids: children, status: { SuccessValue: '' } },
  });
  return { final_execution_status: 'FINAL', status: failed ? { Failure: { ActionError: { kind: 'AccountDoesNotExist' } } } : { SuccessValue: '' },
    transaction: { hash: hash(2), signer_id: transfer.signerId },
    transaction_outcome: outcome(hash(2), '9007199254740993', '10000000000000000000001', [hash(3)]),
    receipts_outcome: [outcome(hash(3), '9007199254740995', '20000000000000000000002', [hash(4)]),
      outcome(hash(4), '1', '3')],
  };
}

describe('native explicit nonce and persisted signed bytes', () => {
  it('encodes/decodes byte-identically with stable unsigned transaction hash and valid signature', async () => {
    const rpc = fakeRpc(); const chain = await rpc.connect();
    const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    const bytes = chain.encodeSignedTx(signed);
    const decoded = chain.decodeSignedTx(bytes);
    expect(decoded).toEqual(signed);
    expect(chain.encodeSignedTx(decoded)).toEqual(bytes);
    const sdk = SignedTransaction.decode(bytes);
    expect(sdk.transaction.nonce).toBe(transfer.nonce);
    expect(sdk.transaction.actions).toHaveLength(1);
    expect(sdk.transaction.actions[0]?.transfer?.deposit).toBe(1n);
    expect(decoded.txHash).toBe(baseEncode(createHash('sha256').update(sdk.transaction.encode()).digest()));
    expect(pair.verify(createHash('sha256').update(sdk.transaction.encode()).digest(), Uint8Array.from(sdk.signature.ed25519Signature!.data))).toBe(true);
    expect(rpc.requests.map((r) => r.method)).toEqual(['status', 'status']);
    expect(() => chain.encodeSignedTx({ ...signed, txHash: hash(6) })).toThrow('FORBIDDEN');
    expect(() => chain.encodeSignedTx({ ...signed, transfer: { ...transfer, amount: 2n } })).toThrow('FORBIDDEN');
    expect(() => chain.decodeSignedTx(Buffer.concat([bytes, Buffer.from([0])]))).toThrow('FORBIDDEN');
    const corrupted = Buffer.from(bytes); corrupted[corrupted.length - 1]! ^= 1;
    expect(() => chain.decodeSignedTx(corrupted)).toThrow('FORBIDDEN');
  });
  it('rejects non-native actions, multiple actions, zero/u128 overflow, wrong signer, and key mismatch', async () => {
    const chain = await fakeRpc().connect();
    for (const actionList of [[actions.createAccount()], [actions.transfer(1n), actions.transfer(1n)]]) {
      const tx = createTransaction(transfer.signerId, pair.getPublicKey(), transfer.receiverId, 1n, actionList, new Uint8Array(32));
      const signature = pair.sign(createHash('sha256').update(tx.encode()).digest()).signature;
      const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: signature }) });
      expect(() => chain.decodeSignedTx(signed.encode())).toThrow('FORBIDDEN');
    }
    for (const input of [{ ...transfer, amount: 0n }, { ...transfer, amount: 1n << 128n },
      { ...transfer, nonce: 1n << 64n }, { ...transfer, signerId: 'other.testnet' },
      { ...transfer, publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() }]) {
      await expect(chain.buildAndSignNativeTransfer(input, signer)).rejects.toThrow();
    }
  });
});

describe('testnet startup and send attestation', () => {
  it.each(['mainnet', 'localnet', 'TESTNET', undefined])('refuses chain_id %s', async (chain_id) => {
    await expect(fakeRpc(() => ({ chain_id })).connect()).rejects.toThrow('MAINNET_REFUSED');
  });
  it('refuses unknown identity and re-attests before signing/broadcast without sending', async () => {
    await expect(fakeRpc(() => { throw new Error('offline'); }).connect()).rejects.toThrow('MAINNET_REFUSED');
    let network = 'testnet';
    const rpc = fakeRpc(() => ({ chain_id: network })); const chain = await rpc.connect();
    const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    network = 'mainnet'; const sign = vi.fn(signer.sign);
    await expect(chain.buildAndSignNativeTransfer(transfer, { publicKey: key, sign })).rejects.toThrow('MAINNET_REFUSED');
    expect(sign).not.toHaveBeenCalled();
    await expect(chain.broadcast(signed.signedTxBase64)).rejects.toThrow('MAINNET_REFUSED');
    expect(rpc.requests.every((r) => r.method === 'status')).toBe(true);
  });
});

describe('prepared submission boundaries', () => {
  it('prepare performs no submit and the prepared closure is one-shot', async () => {
    const rpc = fakeRpc((r) => r.method === 'send_tx' ? { final_execution_status: 'INCLUDED' } : undefined);
    const chain = await rpc.connect(); const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    const submit = await chain.prepareBroadcast(signed.signedTxBase64);
    expect(rpc.requests.filter((r) => r.method === 'send_tx')).toHaveLength(0);
    await expect(submit()).resolves.toMatchObject({ kind: 'accepted', txHash: signed.txHash });
    await expect(submit()).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(rpc.requests.filter((r) => r.method === 'send_tx')).toHaveLength(1);
  });
  it('prepare refuses valid signed bytes for a different custody account', async () => {
    const rpc = fakeRpc(); const chain = await rpc.connect(); const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    const other = await NativeNearChain.connect({ accountId: 'other.testnet', rpcUrl: 'http://rpc.test.invalid', fetch: rpc.fetcher });
    await expect(other.prepareBroadcast(signed.signedTxBase64)).rejects.toHaveProperty('code', 'FORBIDDEN');
    expect(rpc.requests.filter((r) => r.method === 'send_tx')).toHaveLength(0);
  });
});

describe('InvalidNonce details and first-rejection provenance', () => {
  it.each([-1n, 0n, 1n])('preserves payload details; ak_nonce offset %s is definitive only when strictly greater', async (offset) => {
    const tx_nonce = transfer.nonce.toString(); const ak_nonce = (transfer.nonce + offset).toString();
    const rpc = fakeRpc((r) => r.method === 'send_tx' ? rpcReject({ InvalidNonce: { tx_nonce, ak_nonce } }) : undefined);
    const chain = await rpc.connect(); const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    const result = await chain.broadcast(signed.signedTxBase64);
    expect(result.kind).toBe('rejected'); if (result.kind !== 'rejected') return;
    expect(result.reason.startsWith('{')).toBe(true);
    expect(JSON.parse(result.reason)).toEqual({ code: 'INVALID_NONCE', tx_nonce, ak_nonce });
    expect(isDefinitiveFirstRejection(result, transfer.nonce)).toBe(offset > 0n);
    expect(isDefinitiveFirstRejection(result, transfer.nonce + 1n)).toBe(false);
  });
  it.each([{}, { tx_nonce: '01', ak_nonce: '4' }, { tx_nonce: '3' }])('malformed nonce details are never definitive %#', async (details) => {
    const rpc = fakeRpc((r) => r.method === 'send_tx' ? rpcReject({ InvalidNonce: details }) : undefined);
    const chain = await rpc.connect(); const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    const result = await chain.broadcast(signed.signedTxBase64);
    expect(result).toMatchObject({ kind: 'rejected', code: 'INVALID_NONCE' });
    expect(isDefinitiveFirstRejection(result, transfer.nonce)).toBe(false);
  });
});

describe('final account/key/block views', () => {
  it.each([[0n, 900n], [50n, 950n], [200n, 1000n]])('storage reserve overlaps staked %s', async (locked, spendable) => {
    const rpc = fakeRpc((r) => {
      if (r.method === 'query') return { amount: '1000', locked: locked.toString(), storage_usage: 10, block_hash: block };
      if (r.method === 'EXPERIMENTAL_protocol_config') {
        expect(r.params).toEqual({ block_id: block });
        return { runtime_config: { storage_amount_per_byte: '10' } };
      }
      return undefined;
    });
    const chain = await rpc.connect();
    expect(await chain.viewAccount('broker.testnet')).toEqual({ accountId: 'broker.testnet', total: 1000n + locked,
      locked, storageReserve: 100n, spendable, blockHash: block, observedAt: 1234 });
    expect(rpc.requests[1]?.params).toEqual({ request_type: 'view_account', account_id: 'broker.testnet', finality: 'final' });
  });
  it('preserves a real unquoted u64 JSON nonce and fetches final block', async () => {
    const rpc = fakeRpc((r) => {
      if (r.method === 'query') return new Response(`{"jsonrpc":"2.0","id":"${r.id}","result":{"nonce":9007199254740993,"permission":"FullAccess","block_hash":"${block}"}}`);
      if (r.method === 'block') { expect(r.params).toEqual({ finality: 'final' }); return { header: { hash: block } }; }
      return undefined;
    });
    const chain = await rpc.connect();
    expect(await chain.viewAccessKey('broker.testnet', key)).toEqual({ nonce: 9007199254740993n, publicKey: key, fullAccess: true, blockHash: block });
    expect(await chain.recentBlockHash()).toEqual({ hash: block, observedAt: 1234 });
  });
});

describe('broadcast values (never a blind retry)', () => {
  it.each([
    ['accepted', undefined, 'accepted', undefined],
    ['InvalidNonce', rpcReject({ InvalidNonce: { tx_nonce: 3, ak_nonce: 4 } }), 'rejected', 'INVALID_NONCE'],
    ['Expired', rpcReject('Expired'), 'rejected', 'EXPIRED_BLOCK_HASH'],
    ['legacy nonce', { error: { code: -32000, message: 'Server error', data: { TxExecutionError: {
      InvalidTxError: { InvalidNonce: { tx_nonce: 3, ak_nonce: 4 } },
    } } } }, 'rejected', 'INVALID_NONCE'],
    ['legacy expired', { error: { code: -32000, message: 'Server error', data: {
      TxExecutionError: { InvalidTxError: 'Expired' },
    } } }, 'rejected', 'EXPIRED_BLOCK_HASH'],
    ['SignerDoesNotExist', rpcReject({ SignerDoesNotExist: { signer_id: 'missing.testnet' } }), 'rejected', 'RPC_REJECTED'],
    ['timeout RPC', { error: { name: 'HANDLER_ERROR', cause: { info: {}, name: 'TIMEOUT_ERROR' },
      code: -32000, message: 'Server error', data: 'Timeout' } }, 'outcome_unknown', undefined],
    ['unclassified', { error: { message: 'InvalidNonce' } }, 'outcome_unknown', undefined],
    ['alternate cause.info', { error: { cause: { name: 'INVALID_TRANSACTION', info: {
      InvalidTxError: { InvalidNonce: { tx_nonce: 3, ak_nonce: 4 } },
    } } } }, 'rejected', 'INVALID_NONCE'],
    ['data wins over cause.info', { error: { ...rpcReject('Expired').error, cause: {
      name: 'INVALID_TRANSACTION', info: { InvalidTxError: { InvalidNonce: { tx_nonce: 3, ak_nonce: 4 } } },
    } } }, 'rejected', 'EXPIRED_BLOCK_HASH'],
    ['wrong hash', { final_execution_status: 'INCLUDED', transaction: { hash: hash(8), signer_id: transfer.signerId } }, 'outcome_unknown', undefined],
    ['NONE is not inclusion', { final_execution_status: 'NONE' }, 'outcome_unknown', undefined],
  ])('%s', async (_name, response, kind, code) => {
    let signedHash = '';
    const rpc = fakeRpc((r) => {
      // A real async send always acknowledges even an invalid transaction.
      // Regression: reverting to broadcast_tx_async must NOT pass rejection tests.
      if (r.method === 'broadcast_tx_async') return signedHash;
      return r.method === 'send_tx' ? response ?? { final_execution_status: 'INCLUDED',
        transaction: { hash: signedHash, signer_id: transfer.signerId } } : undefined;
    });
    const chain = await rpc.connect(); const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    signedHash = signed.txHash;
    const result = await chain.broadcast(signed.signedTxBase64);
    expect(result).toMatchObject({ kind, txHash: signedHash, ...(code ? { code } : {}) });
    expect(rpc.requests.filter((r) => r.method === 'broadcast_tx_async')).toHaveLength(0);
    expect(rpc.requests.filter((r) => r.method === 'send_tx').map((r) => r.params)).toEqual([
      { signed_tx_base64: signed.signedTxBase64, wait_until: 'INCLUDED' },
    ]);
  });
  it('canonicalizes equivalent base64 pad-bit aliases before submitting exact bytes', async () => {
    const rpc = fakeRpc((r) => r.method === 'send_tx' ? { final_execution_status: 'INCLUDED' } : undefined);
    const chain = await rpc.connect();
    let signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    if (!signed.signedTxBase64.endsWith('=')) {
      signed = await chain.buildAndSignNativeTransfer({ ...transfer, receiverId: 'bobb.testnet' }, signer);
    }
    const canonical = signed.signedTxBase64;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const padIndex = canonical.indexOf('=');
    expect(padIndex).toBeGreaterThan(0);
    const last = alphabet.indexOf(canonical[padIndex - 1]!);
    const alias = canonical.slice(0, padIndex - 1) + alphabet[last + 1]! + canonical.slice(padIndex);
    expect(alias).not.toBe(canonical);
    expect(Buffer.from(alias, 'base64')).toEqual(Buffer.from(canonical, 'base64'));
    expect(await chain.broadcast(alias)).toEqual({ kind: 'accepted', txHash: signed.txHash });
    expect(rpc.requests.at(-1)).toMatchObject({ method: 'send_tx', params: {
      signed_tx_base64: canonical, wait_until: 'INCLUDED',
    } });
  });
  it.each(['timeout', 'network', 'http'])('%s -> outcome_unknown', async (mode) => {
    const rpc = fakeRpc((r) => {
      if (r.method !== 'send_tx') return undefined;
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'http') return new Response('unavailable', { status: 503 });
      throw new Error('private RPC details');
    });
    const chain = await rpc.connect(); const signed = await chain.buildAndSignNativeTransfer(transfer, signer);
    expect(await chain.broadcast(signed.signedTxBase64)).toEqual({ kind: 'outcome_unknown', txHash: signed.txHash,
      reason: 'Broadcast acknowledgment unavailable' });
  });
});

describe('provider errors stay behind the adapter boundary', () => {
  it.each(['account', 'access key', 'block', 'protocol config'])('redacts %s errors to a stable broker code', async (view) => {
    const providerSecret = 'injected-private-provider-body';
    const rpc = fakeRpc((r) => {
      if (r.method === 'status') return undefined;
      if (view === 'protocol config' && r.method === 'query') {
        return { amount: '1000', locked: '0', storage_usage: 10, block_hash: block };
      }
      return { error: { code: -32000, message: providerSecret, data: providerSecret } };
    });
    const chain = await rpc.connect();
    try {
      if (view === 'access key') await chain.viewAccessKey(transfer.signerId, key);
      else if (view === 'block') await chain.recentBlockHash();
      else await chain.viewAccount(transfer.signerId);
      expect.unreachable('provider error must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(BrokerError);
      expect(error).toHaveProperty('code', 'BROKER_UNAVAILABLE');
      expect(error).not.toHaveProperty('response');
      expect(error).not.toHaveProperty('cause');
      expect(String(error) + JSON.stringify(error) + inspect(error)).not.toContain(providerSecret);
    }
  });
});

describe('final execution accounting', () => {
  it.each([false, true])('aggregates transaction and every receipt on failure=%s', async (failed) => {
    const rpc = fakeRpc((r) => r.method === 'tx' ? finalOutcome(failed) : undefined);
    const chain = await rpc.connect();
    expect(await chain.txStatus(hash(2), transfer.signerId)).toEqual({ kind: failed ? 'failed' : 'succeeded', final: true,
      gasBurnt: 18014398509481989n, tokensBurnt: 30000000000000000000006n, receiptIds: [hash(3), hash(4)],
      ...(failed ? { error: 'Transaction execution failed' } : {}) });
    expect(rpc.requests.at(-1)?.params).toEqual({ tx_hash: hash(2), sender_account_id: transfer.signerId, wait_until: 'FINAL' });
  });
  it('preserves unquoted gas integers from real JSON shape', async () => {
    const response = JSON.stringify(finalOutcome()).replace(/"gas_burnt":"([0-9]+)"/g, '"gas_burnt":$1');
    const rpc = fakeRpc((r) => r.method === 'tx' ? new Response(`{"jsonrpc":"2.0","id":"${r.id}","result":${response}}`) : undefined);
    const chain = await rpc.connect();
    expect(await chain.txStatus(hash(2), transfer.signerId)).toHaveProperty('gasBurnt', 18014398509481989n);
  });
  it('keeps missing/malformed/optimistic data unknown or pending, never not_executed', async () => {
    const chain = await fakeRpc().connect();
    expect(chain.classifyOutcome({ ...finalOutcome(), final_execution_status: 'EXECUTED_OPTIMISTIC' })).toEqual({ kind: 'pending' });
    for (const response of [null, {}, { ...finalOutcome(), transaction_outcome: {} },
      { ...finalOutcome(), receipts_outcome: [finalOutcome().receipts_outcome[0], finalOutcome().receipts_outcome[0]] },
      { ...finalOutcome(), receipts_outcome: [finalOutcome().receipts_outcome[0]] },
      { ...finalOutcome(), status: { SuccessValue: '', Failure: {} } }]) {
      expect(chain.classifyOutcome(response).kind).toBe('outcome_unknown');
    }
    const missing = await fakeRpc((r) => r.method === 'tx' ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } } : undefined).connect();
    expect((await missing.txStatus(hash(2), transfer.signerId)).kind).toBe('outcome_unknown');
    const wrong = await fakeRpc((r) => r.method === 'tx' ? finalOutcome() : undefined).connect();
    expect((await wrong.txStatus(hash(6), transfer.signerId)).kind).toBe('outcome_unknown');
  });
});

describe('nonce allocation with injected persistence', () => {
  it('persists max(local,chain)+1, survives caller restart, never decrements', () => {
    let persisted = 50n;
    const persist = (n: bigint) => { persisted = n; };
    expect(allocateNonce(persisted, 4n, persist)).toBe(51n);
    expect(allocateNonce(persisted, 100n, persist)).toBe(101n);
    expect(allocateNonce(persisted, 100n, persist)).toBe(102n);
    expect(() => allocateNonce(persisted, 0n, () => { throw new Error('disk'); })).toThrow('disk');
    expect(persisted).toBe(102n);
    expect(() => allocateNonce(-1n, 0n, persist)).toThrow('NONCE_CONFLICT');
    expect(() => allocateNonce((1n << 64n) - 1n, 0n, persist)).toThrow('NONCE_CONFLICT');
  });
  it('delegates atomic persistence to Store port and checks its rule', () => {
    const tx = { getLocalNonce: () => 9n, allocateNonce: vi.fn(() => 10n) };
    const store = { withImmediateTransaction: (operation: (tx: StoreTransaction) => unknown) => operation(tx as unknown as StoreTransaction) } as Store;
    expect(allocateStoreNonce(store, key, 2n)).toBe(10n);
    expect(tx.allocateNonce).toHaveBeenCalledWith(key, 2n);
    tx.allocateNonce.mockReturnValue(9n);
    expect(() => allocateStoreNonce(store, key, 2n)).toThrow('NONCE_CONFLICT');
  });
});
