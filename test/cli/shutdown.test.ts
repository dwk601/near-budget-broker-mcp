import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { SqliteStore } from '../../src/storage/index.js';
import { OwnerClient } from '../../src/cli/client.js';
import { json } from '../../src/daemon/wire.js';
import { fakeRpc } from '../e2e/fake-rpc.js';
import { fixture } from './helpers.js';

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('shutdown probe timed out'); await delay(10); }
}

it('SIGTERM stops a slow real daemon at the invoked payment, preserves queued backlog, and restart dispatches it', async () => {
  const f = await fixture(); const rpc = await fakeRpc(); const client = new Client({ name: 'shutdown-test', version: '1' });
  let child: ChildProcess | undefined; let exit: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  let release!: () => void; let gate = new Promise<void>((done) => { release = done; });
  let polling = false; let blockFirstPoll = true;
  // Delay every RPC and park the first FINAL poll AFTER its send_tx. This gives
  // an exact signal boundary: the one allowed in-flight send already happened.
  const proxy = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString(); const method = (JSON.parse(body) as { method: string }).method;
      if (method === 'tx' && blockFirstPoll) { polling = true; await gate; }
      await delay(25);
      const response = await fetch(rpc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.setHeader('content-type', 'application/json'); res.end(await response.text());
    } catch { res.statusCode = 500; res.end(); }
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  try {
    const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('no proxy address');
    await mkdir(f.config.dataDir, { mode: 0o700 });
    const master = randomBytes(32); const masterPath = join(f.dir, 'master'); await writeFile(masterPath, master, { mode: 0o600 });
    await new EncryptedFileCustody().createEncryptedKeyFile(join(f.config.dataDir, 'custody.json'), KeyPair.fromRandom('ed25519').toString(), master); master.fill(0);
    const configPath = join(f.dir, 'config.json');
    await writeFile(configPath, json({ ...f.config, rpcUrl: `http://127.0.0.1:${address.port}` }));
    // Isolate all lock files/journals in the owned temp directory, even on failure.
    const preload = join(f.dir, 'home.cjs');
    await writeFile(preload, `const os=require('node:os'); const original=os.userInfo; os.userInfo=(o)=>({...original(o),homedir:${JSON.stringify(f.dir)}}); require('node:module').syncBuiltinESMExports();`);
    let output = '';
    const start = async (waitReady = true) => {
      output = '';
      child = spawn(process.execPath, ['--require', preload, '--import', 'tsx', 'src/main.ts', 'daemon', '--config', configPath], {
        env: { ...process.env, BB_MASTER_SECRET_FILE: masterPath, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      exit = new Promise((done) => child!.once('close', (code, signal) => done([code, signal])));
      child.stdout!.resume(); child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      if (waitReady) {
        await until(() => output.includes('ready') || child!.exitCode !== null);
        expect(output).toBe('Budget Broker daemon: ready\n');
      }
    };
    await start();
    const owner = new OwnerClient(`http://127.0.0.1:${f.config.adminPort}`, f.owner.secretKey);
    const agent = await owner.call('createAgent', { name: 'shutdown backlog' }) as { id: string };
    await owner.call('setPolicy', { policy: { agentId: agent.id, revision: 1, perTxMax: '100', rolling24hMax: '10000', lifetimeMax: '10000',
      gasBudget24h: '10000', ratePerMinute: 1000, maxOutstanding: 1000, recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: null }, expectedRevision: null });
    await owner.call('setWalletPolicy', { policy: { revision: 1, rolling24hMax: '10000', safetyReserve: '0' }, expectedRevision: null });
    const issued = await owner.call('issueToken', { agentId: agent.id }) as { token: string };
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${f.config.agentPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${issued.token}` } },
    }) as Transport);
    for (let n = 0; n < 16; n++) {
      const result = await client.callTool({ name: 'request_transfer', arguments: { idempotencyKey: `shutdown-${n}`, receiverId: 'receiver.testnet', amount: '1' } });
      expect(result.isError).not.toBe(true);
    }
    await until(() => polling); expect(rpc.sends).toHaveLength(1);
    const before = rpc.sends.length; const at = Date.now();
    child!.kill('SIGTERM');
    await delay(150); blockFirstPoll = false; release();
    await until(() => child!.exitCode !== null || child!.signalCode !== null);
    expect(await exit).toEqual([0, null]); expect(Date.now() - at).toBeLessThan(3000);
    expect(rpc.sends).toHaveLength(before); // ZERO new send_tx after SIGTERM.
    const db = new SqliteStore(join(f.config.dataDir, 'broker.sqlite'), { accountId: f.config.accountId });
    try {
      const rows = db.read((r) => r.listRequests({}, { limit: 100 }).items);
      expect(rows.filter((r) => r.state === 'succeeded')).toHaveLength(1);
      expect(rows.filter((r) => r.state === 'queued')).toHaveLength(15);
      for (const row of rows.filter((r) => r.state === 'queued')) {
        expect(row.txHash).toBeNull(); expect(db.read((r) => r.getHold(row.id)?.status)).toBe('active');
      }
    } finally { db.close(); }
    await client.close();
    // SIGTERM during startup recovery must also stop the pump, even though the
    // daemon has not yet returned its close handle or announced readiness.
    polling = false; blockFirstPoll = true; gate = new Promise<void>((done) => { release = done; });
    await start(false); await until(() => polling); expect(rpc.sends).toHaveLength(2);
    const startupStop = Date.now(); child!.kill('SIGTERM'); await delay(150); blockFirstPoll = false; release();
    await until(() => child!.exitCode !== null || child!.signalCode !== null);
    expect(await exit).toEqual([0, null]); expect(Date.now() - startupStop).toBeLessThan(3000);
    expect(rpc.sends).toHaveLength(2);
    await start(); // Startup recovery drains durable work with a fresh stop flag.
    expect(rpc.sends).toHaveLength(16); expect(new Set(rpc.sends.map((s) => s.hash)).size).toBe(16);
    expect(rpc.violations).toEqual([]);
    child!.kill('SIGTERM'); await until(() => child!.exitCode !== null); expect(await exit).toEqual([0, null]);
  } finally {
    blockFirstPoll = false; release(); await client.close();
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    await new Promise<void>((done) => { proxy.closeAllConnections(); proxy.close(() => done()); });
    await rpc.close(); await f.cleanup();
  }
}, 30_000);
