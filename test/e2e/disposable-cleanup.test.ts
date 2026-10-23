import assert from 'node:assert/strict';
import { it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, lstat, rm } from 'node:fs/promises';
import { KeyPair, SignedTransaction, baseEncode } from 'near-api-js';
import { parseNear } from '../../src/contracts/index.js';
import { summary } from '../../scripts/demo/harness.js';
import { Disposable } from '../live/native/disposable.js';
import { Testnet } from '../live/native/network.js';
import type { Outcome } from '../live/native/network.js';

for (const mode of ['lost-response', 'account-not-deleted', 'beneficiary-not-paid'] as const) {
  it(`disposable cleanup fault injection: ${mode}`, async () => {
    const parent = 'custody.testnet'; const id = 'b10-disposable.custody.testnet';
    let exists = false; let balance = parseNear('5'); const funding = parseNear('0.5');
    let key429 = true; let deleteOffers = 0; let createOffers = 0; let stopped = false; let delays = 0;
    const outcomes = new Map<string, Outcome>(); const deleteBytes: string[] = [];
    let life: Disposable; const logs: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const r = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, unknown> };
      const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: r.id, result });
      const missing = (name: string) => Response.json({ jsonrpc: '2.0', id: r.id, error: { cause: { name, info: {} } } });
      if (r.method === 'status') return ok({ chain_id: 'testnet' });
      if (r.method === 'block') return ok({ header: { hash: '11111111111111111111111111111111', height: 274288383 } });
      if (r.method === 'query') {
        if (r.params['request_type'] === 'view_access_key') {
          if (r.params['account_id'] === id && key429) { key429 = false; return new Response('', { status: 429 }); }
          return ok({ nonce: 274288383000000, permission: 'FullAccess', block_hash: '11111111111111111111111111111111' });
        }
        if (r.params['account_id'] === id && !exists) return missing('UNKNOWN_ACCOUNT');
        return ok({ amount: (r.params['account_id'] === parent ? balance : funding).toString(), locked: '0' });
      }
      if (r.method === 'tx') {
        if (r.params['sender_account_id'] === id) {
          assert(deleteOffers > 0, 'must submit unsent cleanup bytes before FINAL polling');
          if (deleteOffers === 1) throw new DOMException('unknown FINAL lookup held until deadline', 'TimeoutError');
        }
        return outcomes.has(String(r.params['tx_hash'])) ? ok(outcomes.get(String(r.params['tx_hash']))) : missing('UNKNOWN_TRANSACTION');
      }
      if (r.method === 'send_tx') {
        const bytes = String(r.params['signed_tx_base64']); const signed = SignedTransaction.decode(Buffer.from(bytes, 'base64')); const tx = signed.transaction;
        const hash = baseEncode(createHash('sha256').update(tx.encode()).digest());
        const outcome: Outcome = { transaction: { hash, signer_id: tx.signerId, nonce: Number(tx.nonce) }, final_execution_status: 'FINAL',
          status: { SuccessValue: '' }, transaction_outcome: { outcome: { tokens_burnt: '0' } }, receipts_outcome: [] };
        if (tx.signerId === parent) {
          // Prove BOTH keys and immutable signed creation bytes are durable BEFORE acceptance.
          const stat = await lstat(life.journalPath); assert.equal(stat.mode & 0o777, 0o600);
          const saved = JSON.parse(await readFile(life.journalPath, 'utf8')) as { id: string; recoverySecret: string; brokerSecret: string; create: { signedTxBase64: string } };
          assert.equal(saved.id, id); assert(saved.recoverySecret === life.recovery.toString(), 'recovery key persisted');
          assert(saved.brokerSecret === life.broker.toString(), 'broker key persisted'); assert(saved.create.signedTxBase64 === bytes, 'creation bytes persisted');
          assert(logs.some((line) => line.includes(`planned id=${id}`)), 'account ID recorded before submit');
          createOffers++; assert.equal(createOffers, 1, 'lost create must reconcile instead of funding twice');
          exists = true; balance -= funding; outcomes.set(hash, outcome);
          // Node accepted the funding; caller never receives success and is then aborted.
          throw new DOMException('simulated lost creation response', 'TimeoutError');
        }
        assert(stopped, 'daemon must stop before deleteAccount');
        assert.equal(tx.signerId, id); assert(tx.actions[0]?.deleteAccount);
        assert.equal(tx.actions[0].deleteAccount.beneficiaryId, parent);
        const saved = JSON.parse(await readFile(life.journalPath, 'utf8')) as { cleanup: { signedTxBase64: string } };
        assert(saved.cleanup.signedTxBase64 === bytes, 'delete bytes persisted');
        deleteOffers++; deleteBytes.push(bytes);
        // First cleanup offer gets 429 BEFORE acceptance; retry must use identical bytes.
        if (deleteOffers === 1) return new Response('', { status: 429 });
        exists = mode === 'account-not-deleted'; if (mode !== 'beneficiary-not-paid') balance += funding;
        outcomes.set(hash, outcome);
        // Second cleanup offer executed, but its acknowledgment is lost too.
        throw new DOMException('simulated lost deletion response', 'TimeoutError');
      }
      throw new Error('unexpected fake provisioning RPC');
    };
    life = await new Disposable(id, parent, new Testnet('http://127.0.0.1:1', fetcher), async () => { delays++; }, (line) => logs.push(line)).init();
    try {
      const abort = new AbortController();
      await assert.rejects(life.create(KeyPair.fromRandom('ed25519').toString(), abort.signal), { name: 'TimeoutError' });
      abort.abort(new Error('scenario timed out after accepted creation'));
      const stop = async () => { stopped = true; };
      // Simulate a process/test timeout: recover from disk, not the old in-memory keys.
      const resumed = await Disposable.resume(life.journalPath, life.network, async () => { delays++; }, (line) => logs.push(line));
      if (mode === 'lost-response') {
        await Promise.all([resumed.cleanup(stop), resumed.cleanup(stop)]); // finally/hook can race safely
        assert.equal(exists, false); assert.equal(balance, parseNear('5'));
        await assert.rejects(lstat(life.directory), { code: 'ENOENT' });
        summary('PASS disposable fault injection: accepted creation timeout + scenario abort + disk resume + cleanup 429/held FINAL lookup/lost ACK; funding returned and account absent');
      } else {
        await assert.rejects(resumed.cleanup(stop), /cleanup unconfirmed/);
        assert.equal((await lstat(life.journalPath)).mode & 0o777, 0o600, 'unconfirmed funds retain protected recovery record');
        summary(`PASS cleanup negative assertion: ${mode} cannot claim returned funding or destroy recovery record`);
      }
      assert.equal(createOffers, 1); assert.equal(deleteOffers, 2); assert.equal(new Set(deleteBytes).size, 1); assert(delays >= 2);
      assert(!logs.join('\n').includes(life.recovery.toString()) && !logs.join('\n').includes(life.broker.toString()), 'cleanup must never log keys');
    } finally {
      // This ledger is ONLY in memory; no real account/funds remain to recover.
      await rm(life.directory, { recursive: true, force: true });
    }
  }, 20_000);
}
