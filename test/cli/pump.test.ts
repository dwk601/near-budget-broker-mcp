import { expect, it } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { startDaemon } from '../../src/daemon/index.js';
import { OwnerClient } from '../../src/cli/client.js';
import { initOwnerKey, unlockOwnerKey } from '../../src/cli/keys.js';
import { runCli } from '../../src/cli/index.js';
import { hash } from '../broker/fixtures.js';
import { fixture } from './helpers.js';

async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await get(); if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error('Scheduler did not make progress');
    await new Promise((r) => setTimeout(r, 20));
  }
}

it('scheduler drains/reconciles, resolve-attempt CLI preserves forced holds, late watches survive the next tick', async () => {
  const f = await fixture(); const keyPath = join(f.dir, 'owner'); const passphrase = 'long test passphrase';
  const agent = new Client({ name: 'pump-test', version: '1' });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    f.config.ownerPublicKey = await initOwnerKey(keyPath, passphrase);
    const url = `http://127.0.0.1:${f.config.adminPort}`;
    const owner = new OwnerClient(url, await unlockOwnerKey(keyPath, passphrase));
    f.chain.mode = 'unknown';
    daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, intervalMs: 20, log: () => {} });
    const created = await owner.call('createAgent', { name: 'pump' }) as { id: string };
    await owner.call('setPolicy', { policy: { agentId: created.id, revision: 1, perTxMax: '100', rolling24hMax: '1000', lifetimeMax: '1000', gasBudget24h: '1000',
      ratePerMinute: 10, maxOutstanding: 10, recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: null }, expectedRevision: null });
    await owner.call('setWalletPolicy', { policy: { revision: 1, rolling24hMax: '1000', safetyReserve: '0' }, expectedRevision: null });
    const issued = await owner.call('issueToken', { agentId: created.id }) as { token: string };
    await agent.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.config.agentPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}` } } }) as Transport);
    const response = await agent.callTool({ name: 'request_transfer', arguments: { idempotencyKey: 'pump', receiverId: 'receiver.testnet', amount: '1' } });
    expect(response.isError).not.toBe(true);
    const examined = await until(async () => (await owner.call('listRequests', { filter: {}, query: { limit: 100 } }) as { items: { id: string; state: string; txHash: string }[] }).items[0]!, (r) => r.state === 'outcome_unknown');
    expect(f.chain.broadcasts).toHaveLength(1);
    const env = { BB_OWNER_KEY_FILE: keyPath, BB_OWNER_PASSPHRASE: passphrase, BB_ADMIN_URL: url };
    let output = '';
    const args = ['owner', 'resolve-attempt', examined.id, 'operator accepts uncertainty', '--json'];
    expect(await runCli(args, { env, stdout: () => {}, stderr: () => {} })).toBe(3);
    expect(await runCli([...args, '--force'], { env, stdout: (s) => { output += s; }, stderr: () => {} })).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ state: 'failed' });
    expect(await owner.call('walletStatus')).toMatchObject({ outstandingHolds: '11' });
    const receipts = await owner.call('exportReceipts', { chainId: 'owner', afterSeq: 0, limit: 1000 }) as { type: string; payload: unknown }[];
    expect(receipts.find((r) => r.type === 'failed')?.payload).toMatchObject({ resolution: { force: true, holdRetained: true } });
    // The daemon must keep running resolution watches, not just drain the queue.
    f.chain.outcomes.set(examined.txHash, { kind: 'succeeded', final: true, receiptIds: [hash('late')], gasBurnt: 123n, tokensBurnt: 7n });
    const status = await until(() => owner.call('walletStatus') as Promise<{ globalFreeze: { frozen: boolean } | null }>, (s) => s.globalFreeze?.frozen === true);
    expect(status).toMatchObject({ outstandingHolds: '0', walletRolling24h: '1' });
    expect(f.chain.broadcasts).toHaveLength(1);
  } finally { await agent.close(); await daemon?.close(); await f.cleanup(); }
}, 20_000);
