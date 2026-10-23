import { expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { startDaemon } from '../../src/daemon/index.js';
import { runCli } from '../../src/cli/index.js';
import { initOwnerKey, unlockOwnerKey } from '../../src/cli/keys.js';
import { OwnerClient } from '../../src/cli/client.js';
import { SqliteStore } from '../../src/storage/index.js';
import { AuditSigner, ReceiptLog } from '../../src/audit/core/index.js';
import { json } from '../../src/daemon/wire.js';
import { fixture } from './helpers.js';

it('global kill switch, status, CAS revisions, request filters, ID pagination, and >1000-receipt offline export', async () => {
  const f = await fixture(); const keyPath = join(f.dir, 'owner'); const passphrase = 'regression test passphrase';
  f.config.ownerPublicKey = await initOwnerKey(keyPath, passphrase);
  const env = { BB_OWNER_PASSPHRASE: passphrase, BB_OWNER_KEY_FILE: keyPath, BB_ADMIN_URL: `http://127.0.0.1:${f.config.adminPort}` };
  const owner = new OwnerClient(env.BB_ADMIN_URL, await unlockOwnerKey(keyPath, passphrase));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  async function cli(...args: string[]): Promise<any> {
    let out = ''; let err = '';
    const code = await runCli(['owner', ...args, '--json'], { env, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
    expect(code, err).toBe(0); return JSON.parse(out);
  }
  try {
    // Both mkdir and chmod regressions to 0777 must fail this assertion.
    await import('node:fs/promises').then((fs) => fs.mkdir(f.config.dataDir, { mode: 0o777 }));
    await chmod(f.config.dataDir, 0o777);
    daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, intervalMs: 60_000, log: () => {} });
    expect((await stat(f.config.dataDir)).mode & 0o777).toBe(0o700);
    await cli('freeze', 'global', 'kill switch');
    expect(await owner.call('getFreeze', { target: { scope: 'global' } })).toMatchObject({ frozen: true });
    expect(await cli('status')).toMatchObject({ globalFreeze: { frozen: true }, policy: null, outstandingHolds: '0' });
    await cli('unfreeze', 'global', 'resume');
    expect(await owner.call('getFreeze', { target: { scope: 'global' } })).toMatchObject({ frozen: false });
    const a = await cli('agent', 'create', 'a'); const b = await cli('agent', 'create', 'b');
    const first = await cli('agent', 'list', '--limit', '1');
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBe(first.items[0].id);
    const second = await cli('agent', 'list', '--limit', '1', '--after', first.nextCursor);
    expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull(); expect(second.items[0].id).not.toBe(first.items[0].id);
    for (const id of [a.id, b.id]) {
      const issued = await owner.call('issueToken', { agentId: id }) as { token: string };
      const mcp = new Client({ name: 'regression', version: '1' });
      try {
        await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.config.agentPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}` } } }) as Transport);
        expect((await mcp.callTool({ name: 'request_transfer', arguments: { idempotencyKey: 'r', receiverId: 'receiver.testnet', amount: '1' } })).isError).not.toBe(true);
      } finally { await mcp.close(); }
    }
    expect((await cli('requests', 'list')).items).toHaveLength(2);
    for (const id of [a.id, b.id]) {
      const scoped = await cli('requests', 'list', id); expect(scoped.items).toHaveLength(1); expect(scoped.items[0].agentId).toBe(id);
    }
    const policyPath = join(f.dir, 'policy.json'); const walletPath = join(f.dir, 'wallet.json');
    const policy = { agentId: a.id, revision: 1, perTxMax: '0.1', rolling24hMax: '1', lifetimeMax: '1', gasBudget24h: '1', ratePerMinute: 10, maxOutstanding: 10, recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: null };
    for (const revision of [1, 2]) {
      await writeFile(policyPath, json({ ...policy, revision }));
      expect((await cli('policy', 'set', '--file', policyPath)).revision).toBe(revision);
      await writeFile(walletPath, json({ revision, rolling24hMax: '1', safetyReserve: '0' }));
      expect((await cli('wallet-policy', 'set', '--file', walletPath)).revision).toBe(revision);
    }
    for (const group of ['policy', 'wallet-policy']) expect(await runCli(['owner', group, 'set', '--file', group === 'policy' ? policyPath : walletPath], { env, stdout: () => {}, stderr: () => {} })).toBe(2);
    const invalidPolicy = join(f.dir, 'missing-field'); const { ratePerMinute: _omitted, ...missing } = policy;
    await writeFile(invalidPolicy, json(missing));
    for (const args of [['agent', 'create', ''], ['approvals', 'approve', a.id, 'abc'], ['approvals', 'approve', a.id, '1'], ['freeze', 'agent', 'not-a-uuid', 'reason'], ['freeze', 'global', '   '], ['policy', 'set', '--file', invalidPolicy]]) {
      let error = '';
      expect(await runCli(['owner', ...args, '--json'], { env, stdout: () => {}, stderr: (s) => { error += s; } }), error).toBe(2);
      expect(JSON.parse(error)).toEqual({ error: { code: 'USAGE' } });
    }
    // Seed actual signed receipt events, not mocked pages, to kill first-page-only exports.
    const store = new SqliteStore(join(f.config.dataDir, 'broker.sqlite'), { accountId: f.config.accountId });
    try {
      const receipts = new ReceiptLog(store, AuditSigner.load(f.config.auditKeyPath));
      store.withImmediateTransaction((tx) => {
        for (let i = 0; i < 1105; i++) receipts.append(tx, { chainId: 'owner', type: 'freeze', at: Date.now(), payload: { scope: 'global', frozen: true, reason: 'export regression', at: Date.now() } });
      });
      const expected = store.read((r) => r.getReceiptHead('owner')!.seq);
      const path = join(f.dir, 'export.json'); await cli('receipts', 'export', 'owner', '--out', path);
      const events = JSON.parse(await readFile(path, 'utf8')) as unknown[]; expect(events).toHaveLength(expected); expect(expected).toBeGreaterThan(1000);
      const checkpoints = await cli('checkpoints', 'list', 'owner'); const pin = join(f.dir, 'pin.json'); await writeFile(pin, json(checkpoints.at(-1)));
      const auditKey = await owner.call('auditPublicKey') as string;
      await daemon.close(); daemon = undefined;
      expect((await cli('receipts', 'verify', '--file', path, '--checkpoint', pin, '--audit-key', auditKey)).valid).toBe(true);
    } finally { store.close(); }
  } finally { await daemon?.close(); await f.cleanup(); }
}, 60_000);

it('CLI validates arguments and files before authentication; usage and local validation exit 2', async () => {
  const f = await fixture();
  try {
    const file = join(f.dir, 'bad-policy'); await writeFile(file, '{"revision":1}');
    for (const args of [[], ['unknown'], ['owner', 'freeze', 'agent', 'not-a-uuid', 'reason'], ['owner', 'approvals', 'approve', '00000000-0000-4000-8000-000000000000', 'abc'], ['owner', 'policy', 'set', '--file', file], ['owner', 'init-owner-key', '--out', join(f.dir, 'short')]]) {
      let stderr = '';
      expect(await runCli([...args, '--json'], { env: { BB_OWNER_PASSPHRASE: 'short' }, stdout: () => {}, stderr: (s) => { stderr += s; } }), stderr).toBe(2);
      expect(JSON.parse(stderr)).toEqual({ error: { code: 'USAGE' } });
    }
  } finally { await f.cleanup(); }
});
