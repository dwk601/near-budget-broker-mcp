import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { KeyPair, SignedTransaction, baseEncode } from 'near-api-js';
import { BrokerService } from '../../src/broker/index.js';
import { NativeNearChain } from '../../src/near/index.js';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { parseNear } from '../../src/contracts/index.js';
import { Fixture, hash, owner } from './fixtures.js';
let f: Fixture; let custody: EncryptedFileCustody;
afterEach(async () => { await custody?.lock(); f?.close(); });

it.each(['Expired', 'InvalidNonce', 'transient-attestation'] as const)(
  'real NativeNearChain + encrypted custody signer: %s recovers and unblocks another agent', async (mode) => {
    f = new Fixture({ autoDispatch: false });
    custody = new EncryptedFileCustody(); const master = Buffer.alloc(32, 42); const pair = KeyPair.fromRandom('ed25519');
    const signer = await custody.loadKey(await custody.encryptKey(pair.toString(), master), master); master.fill(0);
    let nonce = 0n; let height = 10n; let finalHash = hash('initial'); let rejected = false;
    let statusCountdown = -1; const sends: string[] = []; const paid = new Map<string, unknown>();
    const requests: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const r = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, unknown> };
      requests.push(r.method);
      await new Promise((r) => setTimeout(r, 1)); // genuinely asynchronous RPC latency
      let result: unknown;
      if (r.method === 'status') {
        if (statusCountdown-- === 0) return new Response('temporary unavailable', { status: 503 });
        result = { chain_id: 'testnet' };
      } else if (r.method === 'query') {
        result = r.params['request_type'] === 'view_account'
          ? { amount: parseNear('1').toString(), locked: '0', storage_usage: '0', block_hash: finalHash }
          : { nonce: nonce.toString(), permission: 'FullAccess', block_hash: r.params['block_id'] ?? finalHash };
      } else if (r.method === 'block') {
        const block = r.params['block_id'];
        result = { header: { hash: block ?? finalHash, height: block === hash('initial') ? '10' : height.toString() } };
      } else if (r.method === 'EXPERIMENTAL_protocol_config') result = { runtime_config: { storage_amount_per_byte: '1' }, transaction_validity_period: '100' };
      else if (r.method === 'send_tx') {
        const bytes = String(r.params['signed_tx_base64']); sends.push(bytes);
        const signed = SignedTransaction.decode(Buffer.from(bytes, 'base64')); const tx = signed.transaction;
        const txHash = baseEncode(createHash('sha256').update(tx.encode()).digest());
        expect(tx.actions).toHaveLength(1); expect(tx.actions[0]?.transfer?.deposit).toBe(parseNear('0.001'));
        expect(tx.publicKey.toString()).toBe(signer.publicKey); expect(tx.signerId).toBe('broker.testnet');
        if (mode !== 'transient-attestation' && !rejected) {
          rejected = true; finalHash = hash('later'); height = 111n;
          if (mode === 'InvalidNonce') nonce = 5n;
          return Response.json({ jsonrpc: '2.0', id: r.id, error: { data: { TxExecutionError: { InvalidTxError:
            mode === 'Expired' ? 'Expired' : { InvalidNonce: { tx_nonce: tx.nonce.toString(), ak_nonce: nonce.toString() } } } } } });
        }
        if (!paid.has(txHash)) {
          expect(tx.nonce).toBeGreaterThan(nonce); nonce = tx.nonce;
          const receiptId = hash(txHash + 'receipt');
          const outcome = (id: string, tokens: string, children: string[]) => ({ id,
            outcome: { gas_burnt: '11', tokens_burnt: tokens, receipt_ids: children } });
          paid.set(txHash, { final_execution_status: 'FINAL', transaction: { hash: txHash, signer_id: 'broker.testnet' },
            transaction_outcome: outcome(txHash, '3', [receiptId]), receipts_outcome: [outcome(receiptId, '4', [])], status: { SuccessValue: '' } });
        }
        result = { final_execution_status: 'INCLUDED', transaction: { hash: txHash, signer_id: 'broker.testnet' } };
      } else if (r.method === 'tx') {
        result = paid.get(String(r.params['tx_hash']));
        if (!result) return Response.json({ jsonrpc: '2.0', id: r.id, error: { cause: { name: 'UNKNOWN_TRANSACTION', info: {} } } });
      } else throw new Error('unexpected RPC');
      return Response.json({ jsonrpc: '2.0', id: r.id, result });
    };
    const chain = await NativeNearChain.connect({ accountId: 'broker.testnet', rpcUrl: 'http://offline.invalid', fetch: fetcher, clock: f.clock });
    f.options = { ...f.options, chain, signer };
    if (mode === 'transient-attestation') f.options.hooks = { afterPersistSigned: async () => { statusCountdown = 1; } };
    f.broker = new BrokerService(f.options);
    await f.init(); const a = await f.agent('A'); const b = await f.agent('B');
    const first = await f.broker.requestTransfer(a, f.input('A')); await f.broker.drain();
    expect((await f.broker.getRequest(a, first.id)).state).toBe('outcome_unknown');
    const original = f.store.read((r) => r.listAttempts(first.id)[0]!);
    if (mode === 'transient-attestation') expect(sends).toHaveLength(0);
    else expect(f.store.read((r) => r.listAttempts(first.id)[0]?.status)).toBe('proven_not_executed');
    await f.broker.requestTransfer(b, f.input('B'));
    const restart = f.another({ hooks: {} }); await restart.start();
    expect(paid.size).toBe(2); expect((await restart.getRequest(a, first.id)).state).toBe('succeeded');
    const attempts = f.store.read((r) => r.listAttempts(first.id));
    expect(attempts).toHaveLength(mode === 'transient-attestation' ? 1 : 2);
    if (mode === 'transient-attestation') expect(sends[0]).toBe(original.signedTxBase64);
    expect((await restart.budgetStatus(a)).usage.agentGas24h).toBe(7n);
    expect(requests).toContain('tx');
  },
);
