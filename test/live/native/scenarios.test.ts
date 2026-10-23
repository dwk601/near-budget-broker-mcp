import assert from 'node:assert/strict';
import { beforeAll, afterAll, it } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { actions, KeyPair } from 'near-api-js';
import { formatNear, parseNear } from '../../../src/contracts/index.js';
import { Agent, Harness, build, denied, fixtures, near, printPayment, sleep, standing, summary, threeAgents } from '../../../scripts/demo/harness.js';
import type { Fixtures, Transfer } from '../../../scripts/demo/harness.js';
import { Testnet, tokensBurnt } from './network.js';

type Snapshot = { sender: bigint; receiver: bigint };
let f: Fixtures; let h: Harness; let network: Testnet; let unavailable = 'BB_LIVE is not 1';
let initial: Snapshot; let observedPrincipal = 0n; let observedFees = 0n;
const enabled = process.env['BB_LIVE'] === '1';
beforeAll(async () => {
  if (!enabled) return;
  try { f = await fixtures(); }
  catch {
    unavailable = 'missing/unsafe testnet fixtures';
    if (process.env['BB_REQUIRE_LIVE'] === '1') throw new Error('BB_REQUIRE_LIVE=1: missing/unsafe testnet fixtures');
    return;
  }
  // A present fixture with a broken network is a failure, never a silent skip.
  await build(); network = new Testnet(f.rpcUrl); await network.attest();
  initial = await network.snapshot(f.accountId, f.receiver);
  assert(initial.sender > parseNear('1.5'), 'testnet funding must exceed 1.5 NEAR');
  h = await new Harness(f).init(); unavailable = '';
}, 120_000);
afterAll(async () => { await h?.close(); }, 90_000);
function scenario(name: string, body: () => Promise<void>) {
  it(name, async (ctx) => {
    if (unavailable) { summary(`SKIP live ${name}: ${unavailable}`); ctx.skip(); return; }
    try { await body(); summary(`PASS live ${name}`); }
    catch (e) { summary(`FAIL live ${name}`); throw e; }
  }, 600_000);
}
async function reconcile(label: string, agents: Agent[], payments: Transfer[], before: Snapshot) {
  const unique = [...new Map(payments.map((r) => [r.id, r])).values()];
  let principal = 0n; let fees = 0n; const nonces: bigint[] = [];
  for (const r of unique) {
    assert.equal(r.state, 'succeeded'); assert(r.txHash); assert(r.tokensBurnt !== null);
    const outcome = await network.tx(r.txHash, f.accountId);
    assert.equal(outcome.final_execution_status, 'FINAL'); assert.equal(outcome.status.SuccessValue, '');
    assert.equal(tokensBurnt(outcome).toString(), r.tokensBurnt, 'request actual fees equal final chain fee graph');
    if (typeof outcome.transaction.nonce === 'number') assert(Number.isSafeInteger(outcome.transaction.nonce));
    nonces.push(BigInt(outcome.transaction.nonce)); principal += BigInt(r.amount); fees += tokensBurnt(outcome);
    await printPayment(agents.find((a) => a.id === r.agentId)!, r);
  }
  const after = await network.snapshot(f.accountId, f.receiver);
  assert.equal(after.receiver - before.receiver, principal, `${label}: receiver delta`);
  assert.equal(before.sender - after.sender, principal + fees, `${label}: sender delta == principal + actual tokensBurnt`);
  assert.equal((await h.owner<{ outstandingHolds: string }>('status')).outstandingHolds, '0', 'no open holds after settlement');
  for (const a of agents) {
    const status = await a.call<{ usage: { agentGas24h: string; agentOutstanding: number } }>('budget_status');
    const charged = unique.filter((r) => r.agentId === a.id).reduce((n, r) => n + BigInt(r.tokensBurnt!), 0n);
    assert.equal(status.usage.agentGas24h, charged.toString(), 'actual gas charged only to requesting agent');
    assert.equal(status.usage.agentOutstanding, 0);
  }
  observedPrincipal += principal; observedFees += fees;
  summary(`PASS reconciliation ${label}: principal=${formatNear(principal)} fees=${formatNear(fees)} NEAR; exact sender/receiver deltas; zero open holds; per-agent gas=tokensBurnt`);
  return nonces;
}
scenario('(a) 3-agent on-chain demo', async () => {
  const before = await network.snapshot(f.accountId, f.receiver); const demo = await threeAgents(h);
  await reconcile('3-agent', [demo.a, demo.b, demo.c], [demo.allowed], before);
});
scenario('(b) nonce concurrency: 20 simultaneous payments', async () => {
  const a = await h.agent('nonce concurrency'); const before = await network.snapshot(f.accountId, f.receiver);
  const requested = await Promise.all(Array.from({ length: 20 }, () => a.transfer('0.001')));
  const paid = await Promise.all(requested.map((r) => a.settled(r)));
  assert.equal(paid.filter((r) => r.state === 'succeeded').length, 20);
  assert(!paid.some((r) => r.reasons.includes('NONCE_CONFLICT')));
  assert.equal(paid.reduce((n, r) => n + BigInt(r.amount), 0n), parseNear('0.020'));
  const nonces = await reconcile('20 concurrent', [a], paid, before);
  assert.equal(new Set(nonces).size, 20);
  const sorted = [...nonces].sort((a, b) => a < b ? -1 : 1);
  // Gaps are legal: the contract promises monotonicity, not consecutiveness.
  const submissionReceipts = (await a.receipts()).filter((r) => r.type === 'submitted' && r.payload.phase === 'intent');
  assert.equal(submissionReceipts.length, 20);
  const byHash = new Map(paid.map((r, i) => [r.txHash, nonces[i]!]));
  for (let i = 1; i < submissionReceipts.length; i++) {
    const previous = submissionReceipts[i - 1]!; const current = submissionReceipts[i]!;
    assert(previous.type === 'submitted' && current.type === 'submitted');
    assert(byHash.get(current.payload.txHash)! > byHash.get(previous.payload.txHash)!, 'receipt dispatch order has monotonic chain nonces');
  }
  summary(`PASS nonces: ${sorted.join(',')} (20 distinct; zero surfaced nonce errors)`);
});
scenario('(c) contention: two 0.007 caps / global 0.010', async () => {
  const base = await h.owner<{ walletRolling24h: string }>('status');
  await h.wallet(formatNear(BigInt(base.walletRolling24h) + parseNear('0.010')));
  const a = await h.agent('contention A', { rolling24hMax: '0.007', lifetimeMax: '0.007' });
  const b = await h.agent('contention B', { rolling24hMax: '0.007', lifetimeMax: '0.007' });
  const before = await network.snapshot(f.accountId, f.receiver);
  const requests = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).transfer('0.001')));
  const results = await Promise.all(requests.map((r) => (r.agentId === a.id ? a : b).settled(r)));
  const paid = results.filter((r) => r.state === 'succeeded'); assert.equal(paid.length, 10);
  const refused = results.filter((r) => r.state === 'denied'); assert.equal(refused.length, 10);
  for (const r of refused) { assert(r.reasons.some((c) => ['GLOBAL_CAP_EXCEEDED', 'LIFETIME_EXCEEDED', 'ROLLING_24H_EXCEEDED'].includes(c))); assert.equal(r.signedAt, null); }
  for (const agent of [a, b]) assert(paid.filter((r) => r.agentId === agent.id).length <= 7);
  await reconcile('contention 0.010', [a, b], paid, before); await h.wallet('10');
});
scenario('(d) wallet solvency: excess WALLET_CAPACITY', async () => {
  await h.wallet('1000');
  const a = await h.agent('solvency', { perTxMax: '1000', rolling24hMax: '1000', lifetimeMax: '1000' });
  const before = await network.snapshot(f.accountId, f.receiver);
  const excess = await a.transfer(formatNear(before.sender + parseNear('1'))); denied(excess, 'WALLET_CAPACITY');
  const valid = await a.paid('0.001'); await printPayment(a, excess);
  await reconcile('solvency: only affordable principal dispatched', [a], [valid], before); await h.wallet('10');
});
scenario('(e,h) balance reconciliation and exact requesting-agent gas', async () => {
  const a = await h.agent('reconcile A'); const b = await h.agent('reconcile B');
  const before = await network.snapshot(f.accountId, f.receiver);
  const paid = [await a.paid('0.001'), await b.paid('0.002')];
  await reconcile('isolated agent gas attribution', [a, b], paid, before);
});
scenario('(f) idempotency: 20 retries / two clients / daemon restart', async () => {
  const a = await h.agent('idempotency'); const clients = [await a.connect(), await a.connect()]; const key = randomUUID();
  const before = await network.snapshot(f.accountId, f.receiver);
  const first = await Promise.all(Array.from({ length: 10 }, (_, i) => a.transfer('0.001', key, clients[i % 2])));
  assert.equal(new Set(first.map((r) => r.id)).size, 1);
  const paid = await a.settled(first[0]!); assert.equal(paid.state, 'succeeded');
  await h.restart(); const restarted = [await a.connect(), await a.connect()];
  const replay = await Promise.all(Array.from({ length: 10 }, (_, i) => a.transfer('0.001', key, restarted[i % 2])));
  for (const r of replay) { assert.equal(r.id, paid.id); assert.equal(r.txHash, paid.txHash); assert.equal(r.state, 'succeeded'); }
  await assert.rejects(a.transfer('0.002', key), /IDEMPOTENCY_CONFLICT/);
  const requests = await h.owner<{ items: Transfer[] }>('requests', 'list', a.id); assert.equal(requests.items.length, 1);
  assert.equal((await a.receipts()).filter((r) => r.type === 'succeeded').length, 1);
  await reconcile('idempotency exactly one payment', [a], [paid], before);
});
scenario('(g) per-agent and global freeze survive restart', async () => {
  const a = await h.agent('frozen A'); const b = await h.agent('operational B');
  const before = await network.snapshot(f.accountId, f.receiver);
  await h.owner('freeze', 'agent', a.id, 'isolated freeze'); denied(await a.transfer('0.001'), 'AGENT_FROZEN');
  const paid = await b.paid('0.001');
  await h.owner('freeze', 'global', 'global kill switch');
  denied(await a.transfer('0.001'), 'GLOBAL_FROZEN'); denied(await b.transfer('0.001'), 'GLOBAL_FROZEN');
  await h.restart(); denied(await b.transfer('0.001'), 'GLOBAL_FROZEN');
  await h.owner('unfreeze', 'global', 'resume test'); denied(await a.transfer('0.001'), 'AGENT_FROZEN');
  await reconcile('freeze', [a, b], [paid], before);
});
scenario('(i) standing approval on chain', async () => {
  const before = await network.snapshot(f.accountId, f.receiver); const result = await standing(h);
  await reconcile('standing', [result.a], result.payments, before);
});
scenario('(j) disposable account emergency broker-key deletion and recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-disposable-')); const recovery = KeyPair.fromRandom('ed25519'); const broker = KeyPair.fromRandom('ed25519');
  const id = `b10-${randomBytes(6).toString('hex')}.${f.accountId}`;
  const parentRecovery = JSON.parse(await readFile(f.recoveryFile, 'utf8')) as { account_id: string; private_key: string };
  assert.equal(parentRecovery.account_id, f.accountId);
  const disposable = new Harness({ ...f, accountId: id, envelope: join(dir, 'envelope') }); let created = false; let cleaned = false;
  try {
    const create = await network.recovery(f.accountId, parentRecovery.private_key, id, [actions.createAccount(), actions.transfer(parseNear('0.5')),
      actions.addFullAccessKey(recovery.getPublicKey()), actions.addFullAccessKey(broker.getPublicKey())]); created = true;
    summary(`disposable create ${id} https://testnet.nearblocks.io/txns/${create.transaction.hash}`);
    const raw = join(dir, 'broker'); await writeFile(raw, broker.toString(), { mode: 0o600 });
    await disposable.command(['init-custody', '--key-file', raw, '--master-file', f.master, '--out', disposable.options.envelope, '--json']);
    await disposable.init(); const a = await disposable.agent('disposable broker'); const paid = await a.paid('0.001'); await printPayment(a, paid);
    const remove = await network.recovery(id, recovery.toString(), id, [actions.deleteKey(broker.getPublicKey())]);
    summary(`disposable delete broker key https://testnet.nearblocks.io/txns/${remove.transaction.hash}`);
    const keys = await network.keys(id); assert(!keys.some((k) => k.public_key === broker.getPublicKey().toString()));
    assert(keys.some((k) => k.public_key === recovery.getPublicKey().toString()));
    const before = await network.snapshot(id, f.receiver); const blocked = await a.transfer('0.001');
    await sleep(5000); const next = await a.call<Transfer>('get_request', { requestId: blocked.id });
    assert.equal(next.state, 'queued'); assert.equal(next.txHash, null, 'removed key prevents even signing/dispatch'); assert.equal(next.signedAt, null);
    assert(disposable.diagnostics.includes('BROKER_UNAVAILABLE'), 'failed missing-key lookup reported by real daemon');
    const after = await network.snapshot(id, f.receiver); assert.equal(after.receiver, before.receiver); assert.equal(after.sender, before.sender);
    await printPayment(a, next); await a.call('cancel_request', { requestId: next.id });
    summary('PASS emergency: removed broker key leaves next request queued/unsigned; zero dispatch; owner recovery key intact');
    await disposable.close();
    const proof = await network.recovery(id, recovery.toString(), f.receiver, [actions.transfer(1n)]);
    summary(`disposable recovery still works https://testnet.nearblocks.io/txns/${proof.transaction.hash}`);
    const cleanup = await network.recovery(id, recovery.toString(), id, [actions.deleteAccount(f.accountId)]); cleaned = true;
    summary(`disposable cleanup beneficiary=${f.accountId} https://testnet.nearblocks.io/txns/${cleanup.transaction.hash}`);
  } finally {
    await disposable.close();
    try {
      if (created && !cleaned) {
        const cleanup = await network.recovery(id, recovery.toString(), id, [actions.deleteAccount(f.accountId)]); cleaned = true;
        summary(`disposable cleanup after failure https://testnet.nearblocks.io/txns/${cleanup.transaction.hash}`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
    assert(!created || cleaned, 'disposable cleanup required');
  }
  const final = await network.snapshot(f.accountId, f.receiver); const spend = initial.sender - final.sender;
  assert(spend > 0n && spend < parseNear('1.5'), 'entire run net custody spend <1.5 NEAR including disposable funding returned');
  summary(`PASS live spend: net=${formatNear(spend)} NEAR (<1.5); ordinary principal=${formatNear(observedPrincipal)} fees=${formatNear(observedFees)}; disposable funded 0.5 and deleted back to custody`);
});
