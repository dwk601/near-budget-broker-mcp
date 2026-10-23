import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { KeyPair, SignedTransaction, baseEncode } from 'near-api-js';
import { BrokerService } from '../../src/broker/index.js';
import { NativeNearChain } from '../../src/near/index.js';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { parseNear } from '../../src/contracts/index.js';
import { Fixture, hash, owner } from './fixtures.js';
let f: Fixture; let custody: EncryptedFileCustody;
afterEach(async () => { await custody?.lock(); f?.close(); });

it.each(['Expired', 'InvalidNonce', 'NotEnoughBalance', 'dropped-504', 'transient-attestation', 'released-watch', 'GC', 'persistent-lag', 'late-visible', 'late-during-sign'] as const)(
  'real NativeNearChain + encrypted custody signer: %s', async (mode) => {
    f = new Fixture({ autoDispatch: false });
    custody = new EncryptedFileCustody(); const master = Buffer.alloc(32, 42); const pair = KeyPair.fromRandom('ed25519');
    const signer = await custody.loadKey(await custody.encryptKey(pair.toString(), master), master); master.fill(0);
    let nonce = 0n; let height = 10n; let finalHash = hash('initial'); let rejected = false;
    const lagMode = mode === 'GC' || mode === 'persistent-lag' || mode === 'late-visible' || mode === 'late-during-sign';
    let hidden = lagMode; let hiddenHash = '';
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
        if (mode === 'GC' && block === hash('initial')) return Response.json({ jsonrpc: '2.0', id: r.id,
          error: { cause: { name: 'UNKNOWN_BLOCK', info: {} } } });
        result = { header: { hash: block ?? finalHash, height: block === hash('initial') ? '10' : height.toString() } };
      } else if (r.method === 'EXPERIMENTAL_protocol_config') result = { runtime_config: { storage_amount_per_byte: '1' }, transaction_validity_period: '100' };
      else if (r.method === 'send_tx') {
        const bytes = String(r.params['signed_tx_base64']); sends.push(bytes);
        const signed = SignedTransaction.decode(Buffer.from(bytes, 'base64')); const tx = signed.transaction;
        const txHash = baseEncode(createHash('sha256').update(tx.encode()).digest());
        expect(tx.actions).toHaveLength(1); expect(tx.actions[0]?.transfer?.deposit).toBe(parseNear('0.001'));
        expect(tx.publicKey.toString()).toBe(signer.publicKey); expect(tx.signerId).toBe('broker.testnet');
        if ((mode === 'Expired' || mode === 'InvalidNonce' || mode === 'NotEnoughBalance' || mode === 'dropped-504' || mode === 'released-watch') && !rejected) {
          rejected = true; finalHash = hash('later'); height = 1110n;
          if (mode === 'dropped-504') return new Response('not forwarded to chain', { status: 504 });
          if (mode === 'InvalidNonce') nonce = 5n;
          return Response.json({ jsonrpc: '2.0', id: r.id, error: { data: { TxExecutionError: { InvalidTxError:
            mode === 'Expired' || mode === 'released-watch' ? 'Expired' : mode === 'NotEnoughBalance' ? { NotEnoughBalance: { balance: '0' } }
              : { InvalidNonce: { tx_nonce: tx.nonce.toString(), ak_nonce: nonce.toString() } } } } } });
        }
        if (!paid.has(txHash)) {
          expect(tx.nonce).toBeGreaterThan(nonce); nonce = tx.nonce;
          const receiptId = hash(txHash + 'receipt');
          const outcome = (id: string, tokens: string, children: string[]) => ({ id,
            outcome: { gas_burnt: '11', tokens_burnt: tokens, receipt_ids: children } });
          if (lagMode && !hiddenHash) { hiddenHash = txHash; height = 1111n; finalHash = hash('later'); }
          paid.set(txHash, { final_execution_status: 'FINAL', transaction: { hash: txHash, signer_id: 'broker.testnet' },
            transaction_outcome: outcome(txHash, '3', [receiptId]), receipts_outcome: [outcome(receiptId, '4', [])], status: { SuccessValue: '' } });
        }
        if (lagMode && hidden && txHash === hiddenHash) return new Response('ack lost after execution', { status: 503 });
        result = { final_execution_status: 'INCLUDED', transaction: { hash: txHash, signer_id: 'broker.testnet' } };
      } else if (r.method === 'tx') {
        const lookup = String(r.params['tx_hash']);
        result = hidden && lookup === hiddenHash ? undefined : paid.get(lookup);
        if (!result) return Response.json({ jsonrpc: '2.0', id: r.id, error: { cause: { name: 'UNKNOWN_TRANSACTION', info: {} } } });
      } else throw new Error('unexpected RPC');
      return Response.json({ jsonrpc: '2.0', id: r.id, result });
    };
    const chain = await NativeNearChain.connect({ accountId: 'broker.testnet', rpcUrl: 'http://offline.invalid', fetch: fetcher, clock: f.clock, sleep: async (ms) => { f.now += ms; } });
    f.options = { ...f.options, chain, signer };
    if (mode === 'transient-attestation') f.options.hooks = { afterPersistSigned: async () => { statusCountdown = 1; } };
    f.broker = new BrokerService(f.options);
    await f.init(); const a = await f.agent('A', { lifetimeMax: parseNear('0.001') }); const b = await f.agent('B');
    const first = await f.broker.requestTransfer(a, f.input('A'));
    if (mode === 'transient-attestation') {
      // Fail REAL adapter status #2 after the broker's attest succeeds. Nothing
      // may be recorded as offered until the adapter's preflight also succeeds.
      const at = f.now;
      await expect(f.broker.drain()).rejects.toHaveProperty('code', 'MAINNET_REFUSED');
      const stored = f.store.read((r) => r.listAttempts(first.id)[0]!);
      expect(stored.offerCount).toBe(0); expect(stored.lastOfferedAt).toBeNull();
      expect((await f.broker.getRequest(a, first.id)).state).toBe('signed'); expect(sends).toHaveLength(0);
      await f.broker.requestTransfer(b, f.input('B'));
      const restart = f.another({ hooks: {} }); await restart.start();
      expect(f.now).toBe(at); expect(sends[0]).toBe(stored.signedTxBase64);
      expect(paid.size).toBe(2); expect(f.store.read((r) => r.listAttempts(first.id))).toHaveLength(1);
      expect((await restart.getRequest(a, first.id)).state).toBe('succeeded');
      return;
    }
    await f.broker.drain();
    expect((await f.broker.getRequest(a, first.id)).state).toBe('outcome_unknown');
    const original = f.store.read((r) => r.listAttempts(first.id)[0]!);
    f.now += 120_000; // signing age >= validity time; final head includes the 1000-block margin
    if (mode === 'released-watch') {
      await f.broker.resolveAttempt(owner, first.id, 'confirmed expiry');
      expect(f.store.read((r) => r.getHold(first.id)?.status)).toBe('released');
      requests.length = 0; const at = f.now;
      for (let i = 0; i < 3; i++) await f.broker.reconcile(owner);
      expect(requests).toEqual(['tx', 'tx', 'tx']); expect(f.now).toBe(at);
      const receiptId = hash(original.txHash + 'late');
      paid.set(original.txHash, { final_execution_status: 'FINAL', transaction: { hash: original.txHash, signer_id: 'broker.testnet' },
        transaction_outcome: { id: original.txHash, outcome: { gas_burnt: '11', tokens_burnt: '3', receipt_ids: [receiptId] } },
        receipts_outcome: [{ id: receiptId, outcome: { gas_burnt: '11', tokens_burnt: '4', receipt_ids: [] } }], status: { SuccessValue: '' } });
      await f.broker.reconcile(owner);
      expect((await f.broker.getRequest(a, first.id)).state).toBe('succeeded');
      expect((await f.broker.budgetStatus(a)).usage.agentGas24h).toBe(7n);
      expect((await f.broker.getFreeze(owner, { scope: 'global' }))?.frozen).toBe(true);
      expect(sends).toHaveLength(1); return;
    }
    if (mode === 'late-visible' || mode === 'late-during-sign') {
      // Fault-inject a persisted proof from the old unsafe adapter. The new
      // adapter never generates this proof for accepted/ambiguous bytes.
      f.store.withImmediateTransaction((tx) => tx.putAttempt({ ...original, status: 'proven_not_executed', nonExecutionEvidence: 'Legacy unsafe proof' }));
    } else {
      await f.broker.reconcile(owner, first.id);
      expect(f.store.read((r) => r.listAttempts(first.id)[0]?.status)).toBe(mode === 'GC' || mode === 'persistent-lag' ? 'outcome_unknown' : 'proven_not_executed');
    }
    if (mode === 'GC') {
      expect(paid.size).toBe(1); expect(f.store.read((r) => r.listAttempts(first.id))).toHaveLength(1);
      expect(new Set(sends).size).toBe(1); // GC never authorizes a new payment
    }
    if (mode === 'persistent-lag') {
      await f.broker.requestTransfer(b, f.input('B'));
      for (let i = 0; i < 3; i++) { f.now += 60_000; await f.another({ hooks: {} }).start(); }
      expect(paid.size).toBe(1); expect(new Set(sends).size).toBe(1);
      expect(f.store.read((r) => r.listAttempts(first.id))).toHaveLength(1);
      await expect(f.broker.resolveAttempt(owner, first.id, 'negative lookup is still not absence')).rejects.toHaveProperty('code', 'FORBIDDEN');
      expect((await f.broker.requestTransfer(a, f.input('cannot-pay-again'))).reasons).toContain('LIFETIME_EXCEEDED');
    }
    if (mode === 'GC' || mode === 'persistent-lag' || mode === 'late-visible') hidden = false;
    if (mode === 'late-during-sign') {
      // Model one final stale observation from an old adapter during recovery;
      // the mandatory AFTER-sign check uses the real adapter's positive result.
      vi.spyOn(chain, 'txStatus').mockResolvedValueOnce({ kind: 'not_executed', evidence: 'Legacy stale exclusion observation', invalidNonce: true });
      const build = chain.buildAndSignNativeTransfer.bind(chain);
      vi.spyOn(chain, 'buildAndSignNativeTransfer').mockImplementation(async (input, key) => {
        const signed = await build(input, key); hidden = false; return signed;
      });
    }
    await f.broker.requestTransfer(b, f.input('B'));
    const restart = f.another({ hooks: {} }); await restart.start();
    expect(paid.size).toBe(2); expect((await restart.getRequest(a, first.id)).state).toBe('succeeded');
    const attempts = f.store.read((r) => r.listAttempts(first.id));
    expect(attempts).toHaveLength(mode === 'Expired' || mode === 'InvalidNonce' || mode === 'NotEnoughBalance' || mode === 'dropped-504' ? 2 : 1);
    expect((await restart.budgetStatus(a)).usage.agentGas24h).toBe(7n);
    expect(requests).toContain('tx');
  },
);
