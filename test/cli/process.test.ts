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
    const master = randomBytes(32); const masterPath = join(f.dir, 'master'); await writeFile(masterPath, master, { mode: 0o600 });
    await new EncryptedFileCustody().createEncryptedKeyFile(join(f.config.dataDir, 'custody.json'), KeyPair.fromRandom('ed25519').toString(), master); master.fill(0);
    const configPath = join(f.dir, 'config.json'); await writeFile(configPath, json({ ...f.config, rpcUrl: `http://127.0.0.1:${rpcPort}` }));
    const start = () => spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'daemon', '--config', configPath], { env: { ...process.env, BB_MASTER_SECRET_FILE: masterPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = ''; child = start(); child.stderr!.on('data', (b: Buffer) => { diagnostics += b.toString(); });
    await waitFor(() => diagnostics.includes('ready') || child!.exitCode !== null);
    expect(diagnostics).toContain('ready');
    second = start(); second.stderr!.resume(); expect(await stopped(second)).toEqual([1, null]);
    child.kill('SIGTERM'); expect(await stopped(child)).toEqual([0, null]);
    await expect(readFile(join(f.config.dataDir, 'daemon.lock'))).rejects.toThrow();
    diagnostics = ''; child = start(); child.stderr!.on('data', (b: Buffer) => { diagnostics += b.toString(); });
    await waitFor(() => diagnostics.includes('ready')); child.kill('SIGTERM'); expect(await stopped(child)).toEqual([0, null]);
    expect(diagnostics).not.toContain('ed25519:');
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
