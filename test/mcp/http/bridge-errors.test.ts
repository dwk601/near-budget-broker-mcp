import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runStdioBridge } from '../../../src/bridge/index.js';
import { TOKEN_A } from '../local/fakes.js';

it('cancels an oversized upstream reader before delivering the structured error, without waiting for an abort deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-reader-'));
  const token = join(dir, 'token');
  await writeFile(token, TOKEN_A, { mode: 0o600 });
  const cancelled = vi.fn();
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
    }, { headers: { 'Mcp-Session-Id': 'reader-session' } });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.alloc(5000, 32)); },
      cancel: cancelled,
    }), { status: 400 });
  });
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const client = new Client({ name: 'real-sdk-reader-test', version: '1' });
  const bridge = await runStdioBridge({ env: { BB_URL: 'http://127.0.0.1/mcp', BB_TOKEN_FILE: token }, stdin, stdout, stderr: new PassThrough() });
  try {
    await client.connect(new StdioServerTransport(stdout, stdin));
    expect((await client.callTool({ name: 'budget_status', arguments: {} })).structuredContent).toEqual({ error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } });
    expect(cancelled).toHaveBeenCalledTimes(1);
  } finally {
    await client.close(); await bridge.close(); fetch.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
