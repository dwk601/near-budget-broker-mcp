import assert from 'node:assert/strict';
import { it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import type { Checkpoint } from '../../src/contracts/index.js';
import { Harness, build, denied, near, standing, summary, threeAgents } from '../../scripts/demo/harness.js';
import { fakeRpc } from './fake-rpc.js';

it('built daemon + owner CLI + SDK through real stdio bridges: all offline scenarios', async () => {
  await build(); const rpc = await fakeRpc(); const dir = await mkdtemp(join(tmpdir(), 'bb-fake-rpc-'));
  const h = new Harness({ rpcUrl: rpc.url, accountId: 'broker.testnet', receiver: 'receiver.testnet', envelope: join(dir, 'envelope'), master: join(dir, 'master') });
  try {
    const raw = join(dir, 'raw-key'); await writeFile(raw, KeyPair.fromRandom('ed25519').toString(), { mode: 0o600 });
    await writeFile(h.options.master, randomBytes(32), { mode: 0o600 });
    await h.command(['init-custody', '--key-file', raw, '--master-file', h.options.master, '--out', h.options.envelope, '--json']);
    await h.init();
    const demo = await threeAgents(h, false);
    assert.equal(rpc.sends.length, 1); assert.equal(rpc.sends[0]!.amount.toString(), near('0.001'));
    for (const a of [demo.b, demo.c]) {
      const receipts = await a.receipts(); assert(!receipts.some((r) => ['queued', 'submitted', 'succeeded'].includes(r.type)));
    }
    summary('PASS offline dispatch: exactly one send_tx; denials have no signedAt, txHash, submission or gas');
    const approval = await standing(h, false);
    const ownerAgent = await h.agent('owner approval', { approvalThreshold: '0.002' });
    const pending = await ownerAgent.transfer('0.003'); assert.equal(pending.state, 'pending_approval');
    const sendsBefore = rpc.sends.length;
    await h.owner('approvals', 'approve', pending.id, String(Date.now() + 600_000));
    assert.equal((await ownerAgent.settled(pending)).state, 'succeeded'); assert.equal(rpc.sends.length, sendsBefore + 1);
    summary('PASS owner approval: pending request executes only after signed owner approval');
    const token = (await readFile(demo.a.tokenPath, 'utf8')).trim();
    const admin = await fetch(`${h.adminUrl}/admin/freeze`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ target: { scope: 'global' }, reason: 'hostile agent' }) });
    assert.equal(admin.status, 401); assert.equal((await admin.json() as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
    const tools = await (await demo.a.connect()).listTools(); assert(!tools.tools.some((t) => t.name.includes('admin')));
    summary('PASS agent bearer cannot call admin');
    const key = 'offline-bridge-restart'; const one = await demo.a.paid('0.001', key); const beforeRetry = rpc.sends.length;
    await demo.a.closeBridges();
    const replay = await demo.a.transfer('0.001', key); assert.equal(replay.id, one.id); assert.equal(replay.state, 'succeeded');
    assert.equal(rpc.sends.length, beforeRetry);
    await assert.rejects(demo.a.transfer('0.002', key), /IDEMPOTENCY_CONFLICT/);
    summary('PASS idempotency survives bridge restart; changed payload conflicts; no extra send');
    await h.owner('freeze', 'global', 'emergency');
    denied(await demo.a.transfer('0.001'), 'GLOBAL_FROZEN'); const killedAt = rpc.sends.length;
    await h.restart(); denied(await demo.a.transfer('0.001'), 'GLOBAL_FROZEN'); assert.equal(rpc.sends.length, killedAt);
    summary('PASS global kill switch blocks next send and survives daemon restart');
    const trustedKey = await h.owner<string>('audit-key');
    const exports: { file: string; checkpoint: string }[] = [];
    for (const chainId of ['owner', ...[demo.a, demo.b, demo.c, approval.a, ownerAgent].map((a) => `agent:${a.id}`)]) {
      const file = join(h.dir, `${exports.length}.receipts.json`); await h.owner('receipts', 'export', chainId, '--out', file);
      const checkpoints = await h.owner<Checkpoint[]>('checkpoints', 'list', chainId); assert(checkpoints.length > 0);
      const checkpoint = await h.file(checkpoints.at(-1)); exports.push({ file, checkpoint });
    }
    // Verification must really be offline, not a remote verify endpoint.
    await h.stop();
    for (const item of exports) {
      const result = await h.owner<{ valid: boolean }>('receipts', 'verify', '--file', item.file, '--checkpoint', item.checkpoint, '--audit-key', trustedKey);
      assert.equal(result.valid, true);
    }
    const first = exports[0]!; const tampered = JSON.parse(await readFile(first.file, 'utf8')) as { hash: string }[];
    tampered[0]!.hash = 'f'.repeat(64);
    await assert.rejects(h.owner('receipts', 'verify', '--file', await h.file(tampered), '--checkpoint', first.checkpoint, '--audit-key', trustedKey), /CLI_FAILED/);
    assert.deepEqual(rpc.violations, []);
    summary('PASS receipt export: owner + every agent chain verified offline against pinned audit key/checkpoints; tampering rejected');
  } catch (e) { summary(`FAIL offline rpc: sends=${rpc.sends.length} violations=${rpc.violations.join('; ')}`); throw e; }
  finally { await h.close(); await rpc.close(); await rm(dir, { recursive: true, force: true }); }
}, 180_000);
