import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BrokerService } from '../../src/broker/index.js';
import { BrokerError } from '../../src/contracts/index.js';
import { getDefaultResultOrder, setDefaultResultOrder } from 'node:dns';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from '../../src/cli/index.js';
import { startDaemon } from '../../src/daemon/index.js';
import { OwnerClient } from '../../src/cli/client.js';
import { initOwnerKey, unlockOwnerKey } from '../../src/cli/keys.js';
import { json } from '../../src/daemon/wire.js';
import { fixture } from './helpers.js';

it('authorization stays exit 3 for policy writes; only proven stale revisions exit 2; expired grants are local usage', async () => {
  const f = await fixture(); const keyPath = join(f.dir, 'owner'); const password = 'exit code test passphrase';
  f.config.ownerPublicKey = await initOwnerKey(keyPath, password); f.config.allowedHosts = ['127.0.0.1'];
  const env = { BB_OWNER_KEY_FILE: keyPath, BB_OWNER_PASSPHRASE: password, BB_ADMIN_URL: `http://127.0.0.1:${f.config.adminPort}` };
  const owner = new OwnerClient(env.BB_ADMIN_URL, await unlockOwnerKey(keyPath, password));
  const previousOrder = getDefaultResultOrder(); setDefaultResultOrder('ipv4first');
  const daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, log: () => {} });
  async function cli(args: string[], extraEnv = {}) {
    let out = ''; let err = '';
    const code = await runCli(['owner', ...args, '--json'], { env: { ...env, ...extraEnv }, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
    return { code, out, err };
  }
  try {
    const agent = await owner.call('createAgent', { name: 'exit codes' }) as { id: string };
    const policy = { agentId: agent.id, revision: 1, perTxMax: '0.1', rolling24hMax: '1', lifetimeMax: '1', gasBudget24h: '1', ratePerMinute: 10, maxOutstanding: 10,
      recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: null };
    const wallet = { revision: 1, rolling24hMax: '1', safetyReserve: '0' };
    const policyPath = join(f.dir, 'policy'); const walletPath = join(f.dir, 'wallet');
    for (const [group, path, value] of [['policy', policyPath, policy], ['wallet-policy', walletPath, wallet]] as const) {
      await writeFile(path, json(value)); expect((await cli([group, 'set', '--file', path])).code).toBe(0);
      const stale = await cli([group, 'set', '--file', path]); expect(stale.code).toBe(2); expect(JSON.parse(stale.err)).toEqual({ error: { code: 'USAGE' } });
      const current = JSON.parse(await readFile(path, 'utf8')) as { revision: number }; current.revision = 2; await writeFile(path, json(current));
      const denied = await cli([group, 'set', '--file', path], { BB_ADMIN_URL: `http://localhost:${f.config.adminPort}` });
      expect(denied).toEqual({ code: 3, out: '', err: `${json({ error: { code: 'FORBIDDEN' } })}\n` });
    }
    // An unknown agent is a broker authorization failure with no revision
    // conflict (both expected and persisted revision are null).
    const unknown = randomUUID(); await writeFile(policyPath, json({ ...policy, agentId: unknown }));
    expect(await owner.call('getPolicy', { agentId: unknown })).toBeNull();
    expect(await cli(['policy', 'set', '--file', policyPath])).toEqual({ code: 3, out: '', err: `${json({ error: { code: 'FORBIDDEN' } })}\n` });
    // Inject a non-CAS refusal at the broker port, AFTER real owner auth. Unlike
    // Host/Origin denials these reach both admin dispatch catch/translation paths.
    for (const [group, path, method, value] of [
      ['policy', policyPath, 'setPolicy', policy],
      ['wallet-policy', walletPath, 'setWalletPolicy', wallet],
    ] as const) {
      await writeFile(path, json({ ...value, revision: 2 })); // expected 1 == persisted 1
      const refusal = vi.spyOn(BrokerService.prototype, method).mockRejectedValue(new BrokerError('FORBIDDEN'));
      try {
        expect(await cli([group, 'set', '--file', path])).toEqual({ code: 3, out: '', err: `${json({ error: { code: 'FORBIDDEN' } })}\n` });
        expect(refusal).toHaveBeenCalledTimes(1);
      } finally { refusal.mockRestore(); }
    }
    expect((await cli(['status'], { BB_ADMIN_URL: `http://localhost:${f.config.adminPort}` })).code).toBe(3);
    await expect(owner.call('setWalletPolicy', { policy: { revision: 1, rolling24hMax: '1', safetyReserve: '0' }, expectedRevision: null })).rejects.toMatchObject({ code: 'POLICY_CHANGED' });
    const grant = join(f.dir, 'expired-grant'); await writeFile(grant, json({ agentId: agent.id, perTxMax: '0.1', totalMax: '1', expiresAt: 1 }));
    const invalid = await cli(['standing', 'grant', '--file', grant]); expect(invalid.code).toBe(2); expect(invalid.out).toBe(''); expect(JSON.parse(invalid.err)).toEqual({ error: { code: 'USAGE' } });
    expect(await owner.call('listStandingApprovals', { agentId: agent.id, query: { limit: 100 } })).toMatchObject({ items: [] });
  } finally { await daemon.close(); setDefaultResultOrder(previousOrder); await f.cleanup(); }
}, 30_000);

it('offline verification corruption (JSON, schema, signature, checkpoint) always exits 1, never usage/auth', async () => {
  const f = await fixture(); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, log: () => {} });
    const owner = new OwnerClient(`http://127.0.0.1:${f.config.adminPort}`, f.owner.secretKey);
    await owner.call('freeze', { target: { scope: 'global' }, reason: 'verification fixture' });
    const events = await owner.call('exportReceipts', { chainId: 'owner', afterSeq: 0, limit: 1000 }) as Record<string, unknown>[];
    const pins = await owner.call('listCheckpoints', { chainId: 'owner', afterSeq: 0, limit: 1000 }) as unknown[];
    const auditKey = await owner.call('auditPublicKey') as string;
    const path = join(f.dir, 'export'); const checkpoint = join(f.dir, 'checkpoint');
    const validEvents = json(events); const validPin = json(pins.at(-1));
    await writeFile(path, validEvents); await writeFile(checkpoint, validPin);
    await daemon.close(); daemon = undefined;
    const args = ['owner', 'receipts', 'verify', '--file', path, '--checkpoint', checkpoint, '--audit-key', auditKey, '--json'];
    const run = () => runCli(args, { env: {}, stdout: () => {}, stderr: () => {} });
    expect(await run()).toBe(0);
    const tampered = structuredClone(events); tampered[0]!['signature'] = Buffer.alloc(64).toString('base64');
    for (const corrupt of ['{', '{"a":1,"a":2}', json({ not: 'an array' }), json([{ ...events[0], type: 'invalid-schema' }]), json(tampered), '[]']) {
      await writeFile(path, corrupt); expect(await run(), corrupt).toBe(1);
    }
    await writeFile(path, validEvents);
    for (const corrupt of ['{', '{}', json({ ...(pins.at(-1) as object), headHash: '0'.repeat(64) })]) {
      await writeFile(checkpoint, corrupt); expect(await run()).toBe(1);
    }
    expect(await runCli(['owner', 'receipts', 'verify'], { env: {}, stdout: () => {}, stderr: () => {} })).toBe(2);
  } finally { await daemon?.close(); await f.cleanup(); }
});
