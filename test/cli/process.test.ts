import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { json } from '../../src/daemon/wire.js';
import { fixture, port } from './helpers.js';
import { OwnerClient } from '../../src/cli/client.js';
import { initOwnerKey, unlockOwnerKey } from '../../src/cli/keys.js';

async function stopped(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  if ((child.exitCode !== null || child.signalCode !== null)
    && [child.stdout, child.stderr].every((stream) => !stream || stream.destroyed || stream.readableEnded)) return [child.exitCode, child.signalCode];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([once(child, 'close'), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Child did not exit in 10s')), 10_000);
    })]) as [number | null, NodeJS.Signals | null];
  } finally { if (timer) clearTimeout(timer); }
}
async function kill(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL'); await stopped(child);
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Child did not become ready'); await new Promise((r) => setTimeout(r, 20)); }
}

it('real main daemon unlocks file secret, refuses a second process, SIGTERM exits 0 and releases locks', async () => {
  const f = await fixture(); const rpcPort = await port(); let child: ChildProcess | undefined; let second: ChildProcess | undefined;
  let collision: ReturnType<typeof createServer> | undefined; let network = 'testnet'; let rpcStatus = 200;
  const rpc = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string };
    res.statusCode = rpcStatus; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'status' ? { chain_id: network } : null }));
  });
  await new Promise<void>((r) => rpc.listen(rpcPort, '127.0.0.1', r));
  try {
    await mkdir(f.config.dataDir, { mode: 0o700 });
    const master = Buffer.from(`BB_MASTER_CANARY_${randomBytes(24).toString('hex')}`); const secretForms = [master.toString(), master.toString('hex'), master.toString('base64')];
    const masterPath = join(f.dir, 'master'); await writeFile(masterPath, master, { mode: 0o600 });
    await new EncryptedFileCustody().createEncryptedKeyFile(join(f.config.dataDir, 'custody.json'), KeyPair.fromRandom('ed25519').toString(), master); master.fill(0);
    const ownerPath = join(f.dir, 'owner'); const passphrase = 'PROCESS_OWNER_PASSPHRASE_CANARY';
    f.config.ownerPublicKey = await initOwnerKey(ownerPath, passphrase);
    const ownerSecret = await unlockOwnerKey(ownerPath, passphrase);
    const configPath = join(f.dir, 'config.json'); await writeFile(configPath, json({ ...f.config, rpcUrl: `http://127.0.0.1:${rpcPort}` }));
    // Isolate the OS-account home in this TEST process only. Production has no
    // HOME/env override for key locks; this preload never enters the package.
    const preload = join(f.dir, 'isolated-home.cjs');
    await writeFile(preload, `const os=require('node:os'); const original=os.userInfo; os.userInfo=(o)=>({...original(o),homedir:${JSON.stringify(f.dir)}}); require('node:module').syncBuiltinESMExports();`);
    let allOutput = ''; const captured = new Map<ChildProcess, { out: string; err: string }>();
    const start = (extra: NodeJS.ProcessEnv = {}, path = configPath, jsonOutput = false) => {
      const p = spawn(process.execPath, ['--require', preload, '--import', 'tsx', 'src/main.ts', 'daemon', '--config', path, ...(jsonOutput ? ['--json'] : [])], { env: { ...process.env, NODE_NO_WARNINGS: '1', BB_DIAG_CANARY: 'ENV_DUMP_MUST_NOT_LEAK', BB_MASTER_SECRET_FILE: masterPath, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = { out: '', err: '' }; captured.set(p, output);
      p.stdout!.on('data', (b: Buffer) => { output.out += b.toString(); allOutput += b.toString(); });
      p.stderr!.on('data', (b: Buffer) => { output.err += b.toString(); allOutput += b.toString(); });
      return p;
    };
    let diagnostics = ''; child = start(); child.stderr!.on('data', (b: Buffer) => { diagnostics += b.toString(); });
    await waitFor(() => diagnostics.includes('ready') || child!.exitCode !== null);
    expect(diagnostics).toBe('Budget Broker daemon: ready\n');
    second = start(); expect(await stopped(second)).toEqual([1, null]);
    expect(captured.get(second)).toEqual({ out: '', err: 'Budget Broker: LOCK_HELD\n' });
    // Different data dirs and ports, SAME decrypted custody key: must refuse.
    const otherDir = join(f.dir, 'other-data'); await mkdir(otherDir, { mode: 0o700 });
    await copyFile(join(f.config.dataDir, 'custody.json'), join(otherDir, 'custody.json'));
    const otherPath = join(f.dir, 'other-config');
    await writeFile(otherPath, json({ ...f.config, dataDir: otherDir, auditKeyPath: join(otherDir, 'audit.pem'), rpcUrl: `http://127.0.0.1:${rpcPort}`, agentPort: await port(), adminPort: await port() }));
    second = start({ HOME: otherDir }, otherPath); expect(await stopped(second)).toEqual([1, null]);
    expect(captured.get(second)).toEqual({ out: '', err: 'Budget Broker: LOCK_HELD\n' });
    const url = `http://127.0.0.1:${f.config.adminPort}`;
    const owner = new OwnerClient(url, ownerSecret);
    const created = await owner.call('createAgent', { name: 'real CLI token' }) as { id: string };
    const tokenPath = join(f.dir, 'real-token');
    second = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'owner', 'token', 'issue', created.id, '--out', tokenPath, '--key', ownerPath, '--url', url, '--json'], { env: { ...process.env, BB_OWNER_PASSPHRASE: passphrase }, stdio: ['pipe', 'pipe', 'pipe'] });
    let issuedOut = ''; let issuedErr = '';
    second.stdout!.on('data', (b: Buffer) => { issuedOut += b.toString(); }); second.stderr!.on('data', (b: Buffer) => { issuedErr += b.toString(); });
    expect(await stopped(second)).toEqual([0, null]);
    const token = (await readFile(tokenPath, 'utf8')).trim();
    expect(JSON.parse(issuedOut)).toEqual({ path: tokenPath, credentialId: expect.any(String) });
    expect(issuedErr).toBe(''); expect(`${issuedOut}${issuedErr}`).not.toContain(token); expect(`${issuedOut}${issuedErr}`).not.toContain(token.slice('bb_agent_'.length));
    expect(`${issuedOut}${issuedErr}`).not.toContain(passphrase);
    await owner.call('freeze', { target: { scope: 'global' }, reason: 'survive SIGKILL' });
    child.kill('SIGKILL'); expect(await stopped(child)).toEqual([null, 'SIGKILL']);
    // Kernel release must recover with the SAME lock file still present.
    await readFile(join(f.config.dataDir, 'daemon.lock'));
    diagnostics = ''; child = start(); child.stderr!.on('data', (b: Buffer) => { diagnostics += b.toString(); });
    await waitFor(() => diagnostics.includes('ready')); expect(await owner.call('getFreeze', { target: { scope: 'global' } })).toMatchObject({ frozen: true });
    child.kill('SIGTERM'); expect(await stopped(child)).toEqual([0, null]);
    const invalid = join(f.dir, 'invalid-config'); await writeFile(invalid, json({ ...f.config, masterSecret: 'never echo this' }));
    const notDirectory = join(f.dir, 'not-directory'); await writeFile(notDirectory, '');
    const badData = join(f.dir, 'bad-data-config'); await writeFile(badData, json({ ...f.config, dataDir: notDirectory }));
    const rpcDown = join(f.dir, 'rpc-down-config'); await writeFile(rpcDown, json({ ...f.config, rpcUrl: `http://127.0.0.1:${await port()}` }));
    const badLockDir = join(f.dir, 'bad-lock-data'); await mkdir(badLockDir, { mode: 0o700 });
    await writeFile(join(badLockDir, 'daemon.lock'), ''); await chmod(join(badLockDir, 'daemon.lock'), 0o640);
    const badLock = join(f.dir, 'bad-lock-config'); await writeFile(badLock, json({ ...f.config, dataDir: badLockDir }));
    collision = createServer(); await new Promise<void>((r) => collision!.listen(f.config.agentPort, '127.0.0.1', r));
    for (const [extra, path, reason] of [
      [{ BB_MASTER_SECRET_FILE: join(f.dir, 'missing') }, configPath, 'BAD_MASTER_SECRET'],
      [{ BB_MASTER_SECRET: secretForms[0] }, configPath, 'MASTER_SECRET_ENV_REFUSED'],
      [{}, invalid, 'BAD_CONFIG'],
      [{}, badData, 'DATA_DIR_UNAVAILABLE'],
      [{}, rpcDown, 'RPC_UNAVAILABLE'],
      [{}, configPath, 'LISTEN_FAILED'],
      [{}, badLock, 'LOCK_UNAVAILABLE'],
    ] as const) {
      for (const asJson of [false, true]) {
        second = start(extra, path, asJson);
        expect(await stopped(second)).toEqual([1, null]);
        expect(captured.get(second)).toEqual({ out: '', err: asJson ? `${json({ error: { code: 'BROKER_UNAVAILABLE', reason } })}\n` : `Budget Broker: ${reason}\n` });
      }
    }
    rpcStatus = 503; second = start({}, configPath, true); expect(await stopped(second)).toEqual([1, null]);
    expect(captured.get(second)).toEqual({ out: '', err: `${json({ error: { code: 'BROKER_UNAVAILABLE', reason: 'RPC_UNAVAILABLE' } })}\n` });
    rpcStatus = 200; network = 'mainnet'; second = start({}, configPath, true); expect(await stopped(second)).toEqual([1, null]);
    expect(captured.get(second)).toEqual({ out: '', err: `${json({ error: { code: 'MAINNET_REFUSED' } })}\n` });
    for (const secret of secretForms) expect(allOutput).not.toContain(secret);
    expect(allOutput).not.toContain('ed25519:'); expect(allOutput).not.toContain('never echo this');
    expect(allOutput).not.toContain(f.dir); expect(allOutput).not.toContain('ENV_DUMP_MUST_NOT_LEAK');
  } finally {
    await kill(second); await kill(child);
    if (collision) await new Promise<void>((r) => collision!.close(() => r()));
    await new Promise<void>((r) => rpc.close(() => r())); await f.cleanup();
  }
}, 30_000);

it('real main mcp exits 0 on SIGTERM with stdin still open and no upstream daemon', async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    const tokenPath = join(f.dir, 'token'); await writeFile(tokenPath, `bb_agent_${randomBytes(32).toString('base64url')}`, { mode: 0o600 });
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'mcp'], { env: { ...process.env, BB_URL: `http://127.0.0.1:${f.config.agentPort}`, BB_TOKEN_FILE: tokenPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout!.on('data', (b: Buffer) => { output += b.toString(); }); child.stderr!.resume();
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
    await waitFor(() => output.includes('"id":1'));
    child.kill('SIGTERM'); expect(await stopped(child)).toEqual([0, null]);
    expect(output).not.toContain('bb_agent_');
    // EOF can precede asynchronous token-file loading; main must not miss it.
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'mcp'], { env: { ...process.env, BB_URL: `http://127.0.0.1:${f.config.agentPort}`, BB_TOKEN_FILE: tokenPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.resume(); child.stderr!.resume(); child.stdin!.end();
    expect(await stopped(child)).toEqual([0, null]);
  } finally { await kill(child); await f.cleanup(); }
}, 20_000);
