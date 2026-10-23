import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { json } from '../../src/daemon/wire.js';
import { fixture, port } from './helpers.js';
import { OwnerClient } from '../../src/cli/client.js';
import { initOwnerKey, unlockOwnerKey } from '../../src/cli/keys.js';

async function stopped(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) return [child.exitCode, child.signalCode];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([once(child, 'exit'), new Promise<never>((_, reject) => {
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
  const rpc = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'status' ? { chain_id: 'testnet' } : null }));
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
    let allOutput = '';
    const start = (extra: NodeJS.ProcessEnv = {}, path = configPath) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'daemon', '--config', path], { env: { ...process.env, BB_MASTER_SECRET_FILE: masterPath, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
      p.stdout!.on('data', (b: Buffer) => { allOutput += b.toString(); }); p.stderr!.on('data', (b: Buffer) => { allOutput += b.toString(); });
      return p;
    };
    let diagnostics = ''; child = start(); child.stderr!.on('data', (b: Buffer) => { diagnostics += b.toString(); });
    await waitFor(() => diagnostics.includes('ready') || child!.exitCode !== null);
    expect(diagnostics).toContain('ready');
    second = start(); let held = ''; second.stderr!.on('data', (b: Buffer) => { held += b.toString(); }); expect(await stopped(second)).toEqual([1, null]); expect(held).toContain('LOCK_HELD');
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
    for (const [extra, path, reason] of [
      [{ BB_MASTER_SECRET_FILE: join(f.dir, 'missing') }, configPath, 'BAD_MASTER_SECRET'],
      [{ BB_MASTER_SECRET: secretForms[0] }, configPath, 'MASTER_SECRET_ENV_REFUSED'],
      [{}, invalid, 'BAD_CONFIG'],
    ] as const) {
      second = start(extra, path); let output = ''; second.stderr!.on('data', (b: Buffer) => { output += b.toString(); });
      expect(await stopped(second)).toEqual([1, null]); expect(output).toContain(reason);
    }
    for (const secret of secretForms) expect(allOutput).not.toContain(secret);
    expect(allOutput).not.toContain('ed25519:'); expect(allOutput).not.toContain('never echo this');
  } finally { await kill(second); await kill(child); await new Promise<void>((r) => rpc.close(() => r())); await f.cleanup(); }
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
