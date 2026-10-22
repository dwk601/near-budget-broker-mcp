import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startAgentHttpServer } from '../../../src/mcp/http/index.js';
import { MCP_AGENT_TOOL_NAMES } from '../../../src/contracts/index.js';
import { fakes, principalA, TOKEN_A, transferArgs } from '../local/fakes.js';

const fixture = fileURLToPath(new URL('./bridge-process.ts', import.meta.url));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const deps = fakes();
  const listener = await startAgentHttpServer({ ...deps, config: { bindHost: '127.0.0.1', agentPort: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: [] } });
  cleanup.push(listener.close);
  const port = (listener.server.address() as AddressInfo).port;
  const dir = await mkdtemp(join(tmpdir(), 'bb-bridge-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${TOKEN_A}\n`, { mode: 0o600 });
  return { ...deps, ...listener, dir, tokenFile, url: `http://127.0.0.1:${port}` };
}
async function sdkBridge(url: string, tokenFile: string) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', fixture], env: { BB_URL: url, BB_TOKEN_FILE: tokenFile }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const errors: Error[] = [];
  const client = new Client({ name: 'real-stdio-client', version: '1' });
  client.onerror = (error) => errors.push(error);
  cleanup.push(() => client.close());
  await client.connect(transport);
  return { client, errors, diagnostics: () => stderr };
}

describe('stdio -> HTTP bridge', () => {
  it('spawns a real process and proxies SDK list/call without token or protocol leakage', async () => {
    const { url, tokenFile, broker } = await setup();
    const { client, errors, diagnostics } = await sdkBridge(url, tokenFile);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...MCP_AGENT_TOOL_NAMES]);
    const result = await client.callTool({ name: 'request_transfer', arguments: transferArgs });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ agentId: 'A', amount: transferArgs.amount });
    expect(broker.requestTransfer).toHaveBeenCalledWith(principalA, { ...transferArgs, amount: BigInt(transferArgs.amount) });
    expect(errors).toEqual([]);
    expect(diagnostics()).not.toContain(TOKEN_A);
    expect(diagnostics()).toBe('');
  });

  it('returns structured BROKER_UNAVAILABLE with the daemon down, never fabricated success', async () => {
    const { url, tokenFile, close } = await setup();
    await close();
    const { client, diagnostics } = await sdkBridge(url, tokenFile);
    const result = await client.callTool({ name: 'request_transfer', arguments: transferArgs });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: 'BROKER_UNAVAILABLE', message: 'BROKER_UNAVAILABLE' } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({ code: 'BROKER_UNAVAILABLE', message: 'BROKER_UNAVAILABLE' });
    await expect(client.listTools()).rejects.toThrow('BROKER_UNAVAILABLE');
    expect(diagnostics()).toContain('BROKER_UNAVAILABLE');
    expect(diagnostics()).not.toContain(TOKEN_A);
  });

  it('does not cache authorization through revocation or fabricate success after a daemon outage', async () => {
    const { url, tokenFile, revoked, broker, close } = await setup();
    const { client } = await sdkBridge(url, tokenFile);
    await client.callTool({ name: 'budget_status', arguments: {} });
    revoked.add(TOKEN_A);
    expect((await client.callTool({ name: 'budget_status', arguments: {} })).isError).toBe(true);
    expect(broker.budgetStatus).toHaveBeenCalledTimes(1);
    await close();
    const result = await client.callTool({ name: 'request_transfer', arguments: transferArgs });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: 'BROKER_UNAVAILABLE', message: 'BROKER_UNAVAILABLE' } });
    expect(broker.requestTransfer).not.toHaveBeenCalled();
  });

  it('writes only JSON-RPC frames to raw stdout, including when the daemon is unreachable, and exits on EOF', async () => {
    const { url, tokenFile, close } = await setup();
    await close();
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], { env: { ...process.env, BB_URL: url, BB_TOKEN_FILE: tokenFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'close'); } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const initial = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };
    child.stdin.write(`${JSON.stringify(initial)}\n`);
    await waitUntil(() => stdout.includes('"id":1'));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'budget_status', arguments: {} } })}\n`);
    await waitUntil(() => stdout.includes('"id":2'));
    const exited = once(child, 'close');
    child.stdin.end();
    await exited;
    const frames = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.jsonrpc)).toEqual(['2.0', '2.0']);
    expect(frames[1]).toMatchObject({ id: 2, result: { isError: true, structuredContent: { error: { code: 'BROKER_UNAVAILABLE' } } } });
    expect(stdout).not.toContain(TOKEN_A);
    expect(stderr).toContain('BROKER_UNAVAILABLE');
    expect(stderr).not.toContain(TOKEN_A);
    expect(child.exitCode).toBe(0);
  });

  it('refuses group/world-readable token files and symlinks before emitting any stdout', async () => {
    const { url, tokenFile, dir } = await setup();
    const link = join(dir, 'link');
    await symlink(tokenFile, link);
    for (const mode of [0o640, 0o604, 0o660, 0o644]) {
      await chmod(tokenFile, mode);
      await refuses(url, tokenFile);
    }
    await chmod(tokenFile, 0o600);
    await refuses(url, link);
    await refuses('http://user:secret@localhost/mcp', tokenFile);
  });
});

async function refuses(url: string, tokenFile: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], { env: { ...process.env, BB_URL: url, BB_TOKEN_FILE: tokenFile }, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'close'); } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code] = await once(child, 'close');
  expect(code).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('protected token file');
  expect(stderr).not.toContain(TOKEN_A);
}
async function waitUntil(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Process response timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
