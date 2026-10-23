/** Process-only integration harness. No broker/store/auth internals or injected daemon seams. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, lstat, unlink } from 'node:fs/promises';
import { tmpdir, homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ReceiptEvent } from '../../src/contracts/index.js';
import { parseNear, sha256Hex } from '../../src/contracts/index.js';
import { permissionStatus } from '../fixtures/native/fixtures.js';
import { createServer } from 'node:net';

const exec = promisify(execFile);
export const near = (value: string) => parseNear(value).toString();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const summary = (line: string) => process.stdout.write(`${line}\n`);
export async function build() { await exec('npm', ['run', 'build'], { timeout: 120_000 }); }
export async function port(): Promise<number> {
  const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const address = s.address(); assert(address && typeof address !== 'string');
  const p = address.port; await new Promise<void>((r) => s.close(() => r())); return p;
}
export interface Transfer {
  id: string; agentId: string; state: string; reasons: string[]; amount: string;
  txHash: string | null; explorerUrl: string | null; signedAt: number | null;
  tokensBurnt: string | null; gasBurnt: string | null;
}
export class Agent {
  readonly connections = new Set<Client>();
  constructor(readonly harness: Harness, readonly id: string, readonly tokenPath: string) {}
  async connect(): Promise<Client> {
    const client = new Client({ name: 'bb-process-integration', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/main.js'), 'mcp'],
      env: { PATH: process.env['PATH'] ?? '', NODE_NO_WARNINGS: '1', BB_URL: this.harness.agentUrl, BB_TOKEN_FILE: this.tokenPath }, stderr: 'pipe' });
    // Capture neither protocol nor credentials in test logs.
    transport.stderr?.on('data', () => undefined);
    this.connections.add(client); this.harness.clients.add(client);
    try { await client.connect(transport); } catch (e) { await client.close(); throw e; }
    return client;
  }
  async call<T>(name: string, args: Record<string, unknown> = {}, client?: Client): Promise<T> {
    const c = client ?? [...this.connections].find((x) => this.harness.clients.has(x)) ?? await this.connect();
    const result = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const text = (result.content as { type: string; text?: string }[]).find((x) => x.type === 'text')?.text;
    assert(text, 'MCP text response required');
    const value = JSON.parse(text) as T & { code?: string; error?: { code: string } };
    if (result.isError) throw new Error(value.error?.code ?? value.code ?? 'MCP_ERROR');
    return value;
  }
  transfer(amount: string, key: string = randomUUID(), client?: Client, receiver = this.harness.receiver) {
    return this.call<Transfer>('request_transfer', { amount: near(amount), receiverId: receiver, idempotencyKey: key }, client);
  }
  async settled(input: Transfer): Promise<Transfer> {
    const deadline = Date.now() + (this.harness.options.rpcUrl.startsWith('http://127.') ? 20_000 : 300_000);
    let request = input;
    while (!['succeeded', 'failed', 'denied', 'cancelled', 'rejected', 'expired'].includes(request.state)) {
      assert(Date.now() < deadline, `settlement timeout: ${request.id} ${request.state}; ${this.harness.diagnostics}`);
      await sleep(250); request = await this.call<Transfer>('get_request', { requestId: input.id });
    }
    return request;
  }
  async paid(amount: string, key?: string, client?: Client): Promise<Transfer> {
    const r = await this.settled(await this.transfer(amount, key, client));
    assert.equal(r.state, 'succeeded', `payment ${r.id}: ${r.state} ${r.reasons.join(',')}`);
    assert(r.txHash); assert.equal(r.explorerUrl, `https://testnet.nearblocks.io/txns/${r.txHash}`);
    return r;
  }
  async receipts() { return this.call<ReceiptEvent[]>('list_receipts', { afterSeq: 0, limit: 1000 }); }
  async closeBridges() {
    for (const c of this.connections) { await c.close(); this.harness.clients.delete(c); }
    this.connections.clear();
  }
}
export interface HarnessOptions { rpcUrl: string; accountId: string; receiver: string; envelope: string; master: string }
export class Harness {
  dir = ''; dataDir = ''; configPath = ''; ownerKey = ''; agentUrl = ''; adminUrl = '';
  readonly passphrase = randomBytes(32).toString('base64url');
  readonly clients = new Set<Client>();
  child: ChildProcess | undefined;
  diagnostics = '';
  walletRevision = 0;
  keyLockPath = '';
  private ownedKeyLock: { dev: number; ino: number } | undefined;
  private stopping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  constructor(readonly options: HarnessOptions) {}
  get receiver() { return this.options.receiver; }
  private env(owner = false): NodeJS.ProcessEnv {
    // The daemon gets only its unlock FILE and owner PUBLIC key in config.
    return { PATH: process.env['PATH'], NODE_NO_WARNINGS: '1',
      ...(owner ? { BB_OWNER_PASSPHRASE: this.passphrase } : { BB_MASTER_SECRET_FILE: this.options.master }) };
  }
  async command(args: string[]): Promise<unknown> {
    try {
      const { stdout } = await exec(process.execPath, [resolve('dist/main.js'), ...args], { env: this.env(args[0] === 'owner'), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      return JSON.parse(stdout) as unknown;
    } catch (e) {
      // exec errors include environment/argv/output. Never forward the raw object.
      const err = e as { stderr?: string };
      let code = 'CLI_FAILED';
      try { code = (JSON.parse(err.stderr ?? '') as { error: { code: string } }).error.code; } catch { /* redacted */ }
      throw new Error(code);
    }
  }
  owner<T = unknown>(...args: string[]): Promise<T> {
    return this.command(['owner', ...args, '--key', this.ownerKey, '--url', this.adminUrl, '--json']) as Promise<T>;
  }
  async file(value: unknown): Promise<string> {
    const path = join(this.dir, `${randomUUID()}.json`); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return path;
  }
  async init() {
    this.dir = await mkdtemp(join(tmpdir(), 'bb-process-')); this.dataDir = join(this.dir, 'data');
    try {
      await mkdir(this.dataDir, { mode: 0o700 }); this.ownerKey = join(this.dir, 'owner.json');
      const owner = await this.command(['owner', 'init-owner-key', '--out', this.ownerKey, '--json']) as { publicKey: string };
      await copyFile(this.options.envelope, join(this.dataDir, 'custody.json')); await chmod(join(this.dataDir, 'custody.json'), 0o600);
      const envelope = JSON.parse(await readFile(this.options.envelope, 'utf8')) as { publicKey: string };
      this.keyLockPath = join(userInfo().homedir, '.budget-broker-locks', `${sha256Hex(envelope.publicKey)}.sqlite`);
      const agentPort = await port(); let adminPort = await port(); while (adminPort === agentPort) adminPort = await port();
      this.agentUrl = `http://127.0.0.1:${agentPort}`; this.adminUrl = `http://127.0.0.1:${adminPort}`;
      this.configPath = await this.file({ network: 'testnet', rpcUrl: this.options.rpcUrl, accountId: this.options.accountId,
        agentPort, adminPort, dataDir: this.dataDir, auditKeyPath: join(this.dataDir, 'audit.pem'),
        ownerPublicKey: owner.publicKey, safetyReserve: near('0.01'), feeReservePerTx: near('0.001') });
      await this.start(); await this.wallet('10'); return this;
    } catch (e) { await this.close(); throw e; }
  }
  async start() {
    assert(!this.closed, 'cannot start a closed harness');
    const existed = await lstat(this.keyLockPath).then(() => true, (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e; return false;
    });
    assert(!this.closed, 'cannot start a closed harness');
    const child = spawn(process.execPath, [resolve('dist/main.js'), 'daemon', '--config', this.configPath], { env: this.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child; let diagnostics = ''; this.diagnostics = ''; child.stdout!.resume(); child.stderr!.on('data', (b: Buffer) => { diagnostics += b.toString(); this.diagnostics = (this.diagnostics + b.toString()).slice(-4096); });
    const deadline = Date.now() + 20_000;
    while (!diagnostics.includes('daemon: ready')) {
      assert(child.exitCode === null && child.signalCode === null, `daemon exited: ${diagnostics.trim()}`);
      assert(Date.now() < deadline, 'daemon readiness timeout'); await sleep(25);
    }
    // Claim only a previously absent file after THIS child acquired the key lock.
    if (!existed && !this.ownedKeyLock) {
      const stat = await lstat(this.keyLockPath); assert(stat.isFile() && !stat.isSymbolicLink());
      this.ownedKeyLock = { dev: stat.dev, ino: stat.ino };
    }
  }
  async stop() {
    if (this.stopping) return this.stopping;
    const p = this.child;
    if (!p) return;
    this.stopping = (async () => {
      if (p.exitCode === null && p.signalCode === null) {
        const exited = once(p, 'close'); p.kill('SIGTERM');
        const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
        try { await exited; } finally { clearTimeout(timer); }
      }
      this.child = undefined;
    })();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  async restart() {
    for (const c of this.clients) await c.close(); this.clients.clear();
    await this.stop(); await this.start();
  }
  async close() {
    this.closed = true;
    return this.closing ??= (async () => {
      for (const c of this.clients) await c.close().catch(() => undefined); this.clients.clear();
      await this.stop();
      // No wildcard, no pre-existing files, no unlink while the child holds its lock.
      if (this.ownedKeyLock) {
        const stat = await lstat(this.keyLockPath);
        assert.equal(stat.dev, this.ownedKeyLock.dev); assert.equal(stat.ino, this.ownedKeyLock.ino);
        assert(stat.isFile() && !stat.isSymbolicLink(), 'owned key lock was replaced');
        await unlink(this.keyLockPath); this.ownedKeyLock = undefined;
      }
      if (this.dir) await rm(this.dir, { recursive: true, force: true });
    })();
  }
  async wallet(rolling24hMax: string) {
    await this.owner('wallet-policy', 'set', '--file', await this.file({ revision: ++this.walletRevision, rolling24hMax, safetyReserve: '0.01' }));
  }
  async agent(name: string, policy: Record<string, unknown> = {}): Promise<Agent> {
    const created = await this.owner<{ id: string }>('agent', 'create', name);
    const tokenPath = join(this.dir, `${created.id}.token`);
    await this.owner('token', 'issue', created.id, '--out', tokenPath);
    await this.owner('policy', 'set', '--file', await this.file({ agentId: created.id, revision: 1,
      perTxMax: '0.01', rolling24hMax: '1', lifetimeMax: '1', gasBudget24h: '0.1',
      ratePerMinute: 1000, maxOutstanding: 100, recipients: { mode: 'allowlist', accounts: [this.receiver] }, approvalThreshold: null, ...policy }));
    return new Agent(this, created.id, tokenPath);
  }
}
export interface Fixtures extends HarnessOptions { recoveryFile: string; directory: string }
export async function fixtures(): Promise<Fixtures> {
  const directory = process.env['BB_FIXTURES_DIR'] ?? join(homedir(), '.budget-broker', 'testnet-fixtures');
  for (const name of ['fixtures.env', 'manifest.json', 'broker-key.json', 'master.secret', 'recovery.json']) {
    assert.equal(await permissionStatus(join(directory, name)), 'ok', `missing/unsafe fixture: ${name}`);
  }
  assert.equal(await permissionStatus(directory, true), 'ok', 'unsafe fixtures directory');
  const env = Object.fromEntries((await readFile(join(directory, 'fixtures.env'), 'utf8')).trim().split('\n').map((line) => {
    const match = /^([A-Z_]+)='([^']*)'$/.exec(line); assert(match, 'unsupported fixture env syntax'); return [match[1]!, match[2]!];
  }));
  assert.equal(env['BB_NETWORK'], 'testnet');
  for (const n of ['BB_NETWORK', 'NEAR_NETWORK_ID', 'NEAR_ENV']) assert(!process.env[n] || process.env[n] === 'testnet', 'MAINNET_REFUSED');
  return { directory, rpcUrl: process.env['BB_RPC_URL'] ?? env['BB_RPC_URL']!, accountId: env['BB_ACCOUNT_ID']!,
    receiver: env['BB_RECEIVER_A_ID']!, envelope: join(directory, 'broker-key.json'), master: join(directory, 'master.secret'), recoveryFile: join(directory, 'recovery.json') };
}
export function denied(r: Transfer, code: string) {
  assert.equal(r.state, 'denied'); assert(r.reasons.includes(code), `${code} not in ${r.reasons.join(',')}`);
  assert.equal(r.signedAt, null); assert.equal(r.txHash, null); assert.equal(r.tokensBurnt, null);
}
export async function printPayment(a: Agent, r: Transfer) {
  const receipts = (await a.receipts()).filter((x) => 'requestId' in x.payload && x.payload.requestId === r.id);
  assert(receipts.length > 0, 'request receipts missing');
  const receipt = receipts.at(-1)!;
  summary(`receipt ${receipt.chainId}:${receipt.seq} hash=${receipt.hash} request=${r.id} state=${r.state}`);
  if (r.txHash) summary(`tx ${r.txHash} https://testnet.nearblocks.io/txns/${r.txHash}`);
}
export async function threeAgents(h: Harness, output = true) {
  const a = await h.agent('A allowed'); const b = await h.agent('B capped', { perTxMax: '0.002' }); const c = await h.agent('C killed');
  await h.owner('freeze', 'agent', c.id, 'demo kill switch');
  const allowed = await a.paid('0.001'); const capped = await b.transfer('0.003'); const frozen = await c.transfer('0.001');
  denied(capped, 'PER_TX_EXCEEDED'); denied(frozen, 'AGENT_FROZEN');
  for (const [agent, request] of [[a, allowed], [b, capped], [c, frozen]] as const) {
    const receipts = await agent.receipts();
    assert(receipts.some((x) => x.type === (request.state === 'succeeded' ? 'succeeded' : 'decision_denied')));
    if (output) await printPayment(agent, request);
  }
  summary('PASS 3-agent: A 0.001 paid; B 0.003 > 0.002 denied; C frozen denied; denial signedAt/txHash null');
  return { a, b, c, allowed, capped, frozen };
}
export async function standing(h: Harness, output = true) {
  const a = await h.agent('standing approval', { approvalThreshold: '0.002' });
  const grant = await h.owner<{ id: string }>('standing', 'grant', '--file', await h.file({ agentId: a.id,
    perTxMax: '0.005', totalMax: '0.010', expiresAt: Date.now() + 600_000 }));
  // The grant has its full 0.010 headroom: only its 0.005 per-tx bound blocks this.
  const overPerTx = await a.transfer('0.006'); assert.equal(overPerTx.state, 'pending_approval');
  assert.equal(overPerTx.signedAt, null); assert.equal(overPerTx.txHash, null);
  await a.call('cancel_request', { requestId: overPerTx.id });
  const first = await a.paid('0.004'); const second = await a.paid('0.004');
  const excess = await a.transfer('0.004'); assert.equal(excess.state, 'pending_approval');
  await a.call('cancel_request', { requestId: excess.id });
  await h.owner('standing', 'revoke', grant.id);
  // A fresh unused grant makes revocation independently observable (not just exhaustion).
  const unused = await h.owner<{ id: string }>('standing', 'grant', '--file', await h.file({ agentId: a.id,
    perTxMax: '0.005', totalMax: '0.010', expiresAt: Date.now() + 600_000 }));
  await h.owner('standing', 'revoke', unused.id);
  const revoked = await a.transfer('0.003'); assert.equal(revoked.state, 'pending_approval');
  const receipts = await a.receipts(); assert.equal(receipts.filter((x) => x.type === 'standing_approval_used').length, 2);
  if (output) for (const r of [overPerTx, first, second, excess, revoked]) await printPayment(a, r);
  await a.call('cancel_request', { requestId: revoked.id });
  summary('PASS standing: 0.006 > grant perTx 0.005 waits with full headroom; 0.004 twice without owner; total exhaustion waits; revoked grant waits');
  return { a, payments: [first, second] };
}
