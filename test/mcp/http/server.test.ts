import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createAgentHttpServer, startAgentHttpServer } from '../../../src/mcp/http/index.js';
import { parseRequestJson } from '../../../src/mcp/http/json.js';
import { BrokerError, MCP_AGENT_TOOL_NAMES } from '../../../src/contracts/index.js';
import { fakes, principalA, receipt, TOKEN_A, TOKEN_B, transferArgs } from '../local/fakes.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };
async function setup(options: { allowedOrigins?: string[]; maxBodyBytes?: number; maxSessions?: number; maxSessionsPerCredential?: number; maxSessionsPerAgent?: number; sessionIdleTtlMs?: number; clock?: { now(): number } } = {}) {
  const deps = fakes();
  const listener = await startAgentHttpServer({
    ...deps, config: { bindHost: '127.0.0.1', agentPort: 0, allowedHosts: ['127.0.0.1', 'localhost'], allowedOrigins: options.allowedOrigins ?? [] },
    ...options,
  });
  cleanup.push(listener.close);
  const port = (listener.server.address() as AddressInfo).port;
  async function client(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const sdk = new Client({ name: 'real-http-client', version: '1' });
    cleanup.push(() => sdk.close());
    await sdk.connect(transport as Transport);
    return { sdk, transport };
  }
  function raw(options: { headers?: string[]; body?: string | Buffer; method?: string; chunked?: boolean; path?: string; accept?: string } = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = options.body ?? JSON.stringify(initialize);
      const headers = options.headers ?? ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${TOKEN_A}`];
      const req = request({ hostname: '127.0.0.1', port, path: options.path ?? '/mcp', method: options.method ?? 'POST', headers: [
        ...headers, 'Content-Type', 'application/json', 'Accept', options.accept ?? 'application/json, text/event-stream',
        ...(options.chunked ? ['Transfer-Encoding', 'chunked'] : ['Content-Length', String(Buffer.byteLength(body))]),
      ] }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (data: string) => { text += data; });
        res.on('end', () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }
  return { ...deps, ...listener, port, client, raw };
}
function decoded(result: Awaited<ReturnType<Client['callTool']>>) {
  const blocks = result.content as Array<{ text: string }>;
  return JSON.parse(blocks[0]!.text) as Record<string, unknown>;
}

describe('guarded Streamable HTTP', () => {
  it('uses a real SDK initialize/list/call flow for all eight tools', async () => {
    const { client, broker } = await setup();
    const { sdk } = await client(TOKEN_A);
    expect((await sdk.listTools()).tools.map((t) => t.name)).toEqual([...MCP_AGENT_TOOL_NAMES]);
    const args = [
      {}, transferArgs, transferArgs, { requestId: 'request-A' }, { requestId: 'request-A' },
      { afterSeq: 3, limit: 5 }, { receipt: receipt() }, { reason: 'kill switch' },
    ];
    for (const [i, name] of MCP_AGENT_TOOL_NAMES.entries()) {
      const result = await sdk.callTool({ name, arguments: args[i]! });
      expect(result.isError).not.toBe(true);
      if (name === 'request_transfer') expect(decoded(result).amount).toBe(transferArgs.amount);
    }
    expect(broker.freezeSelf).toHaveBeenCalledWith(principalA, 'kill switch');
    expect(broker.listReceipts).toHaveBeenCalledWith(principalA, 3, 5);
    for (const [i, name] of MCP_AGENT_TOOL_NAMES.entries()) {
      const denied = await sdk.callTool({ name, arguments: { ...args[i], agentId: 'B' } });
      expect(denied.structuredContent).toEqual({ error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } });
    }
  });

  it('requires a valid bearer on every HTTP method including known sessions, prevents session hijack, and notices revocation', async () => {
    const { raw, port, client, revoked, broker } = await setup();
    for (const auth of [[], ['Authorization', 'Bearer invalid']]) {
      expect((await raw({ headers: ['Host', `127.0.0.1:${port}`, ...auth] })).status).toBe(401);
    }
    const { sdk: a, transport } = await client(TOKEN_A);
    const { sdk: b } = await client(TOKEN_B);
    await b.callTool({ name: 'request_transfer', arguments: transferArgs });
    expect(decoded(await a.callTool({ name: 'get_request', arguments: { requestId: 'request-B' } }))).toEqual({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
    const session = transport.sessionId!;
    expect(session).toBeTruthy();
    for (const method of ['POST', 'GET', 'DELETE']) {
      for (const auth of [[], ['Authorization', 'Bearer invalid'], ['Authorization', `Bearer ${TOKEN_A}`, 'Authorization', `Bearer ${TOKEN_B}`]]) {
        const response = await raw({ method, headers: ['Host', `127.0.0.1:${port}`, 'Mcp-Session-Id', session, ...auth] });
        expect(response.status).toBe(401);
        expect(response.body).not.toContain('secret');
      }
      expect((await raw({ method, headers: ['Host', `127.0.0.1:${port}`, 'Mcp-Session-Id', session, 'Authorization', `Bearer ${TOKEN_B}`] })).status).toBe(403);
    }
    revoked.add(TOKEN_A);
    expect((await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Mcp-Session-Id', session, 'Authorization', `Bearer ${TOKEN_A}`] })).status).toBe(401);
    await expect(a.callTool({ name: 'budget_status', arguments: {} })).rejects.toThrow();
    expect(broker.budgetStatus).not.toHaveBeenCalled();
  });

  it('validates one exact Host authority and exact Origin; ignores forwarded headers', async () => {
    const { raw, port } = await setup({ allowedOrigins: ['https://trusted.example'] });
    const auth = ['Authorization', `Bearer ${TOKEN_A}`];
    for (const host of ['evil.example', `evillocalhost:${port}`, `localhost.evil:${port}`, `localhost.:${port}`, `LOCALHOST:${port}`, 'localhost:1', `localhost:${port},evil`, `user@localhost:${port}`, `localhost:${port}/`, 'localhost:99999', `127.0.0.1:${port + 1}`]) {
      expect((await raw({ headers: ['Host', host, ...auth, 'X-Forwarded-Host', `localhost:${port}`] })).status, host).toBe(403);
    }
    // Node itself rejects an HTTP/1.1 request lacking Host before our handler.
    expect((await raw({ headers: auth })).status).toBe(400);
    expect((await raw({ headers: ['Host', `localhost:${port}`, 'Host', `localhost:${port}`, ...auth] })).status).toBe(403);
    for (const origin of ['null', 'https://evil.example', 'https://trusted.example/', 'https://trusted.example.evil', 'https://trusted.example, https://evil.example', 'https://user@trusted.example']) {
      expect((await raw({ headers: ['Host', `localhost:${port}`, ...auth, 'Origin', origin] })).status, origin).toBe(403);
    }
    expect((await raw({ headers: ['Host', `localhost:${port}`, ...auth, 'Origin', 'https://trusted.example', 'Origin', 'https://trusted.example'] })).status).toBe(403);
    expect((await raw({ headers: ['Host', `localhost:${port}`, ...auth, 'Origin', 'https://trusted.example'] })).status).toBe(200);
    expect((await raw()).status).toBe(200); // absent Origin
    const other = await setup();
    expect((await other.raw({ headers: ['Host', `localhost:${other.port}`, ...auth, 'Origin', 'https://trusted.example'] })).status).toBe(403);
  });

  it('bounds declared and chunked body sizes; rejects duplicate/escaped keys and malformed restricted JSON', async () => {
    const { raw } = await setup({ maxBodyBytes: 512 });
    expect((await raw({ body: 'x'.repeat(513) })).status).toBe(413);
    expect((await raw({ body: 'x'.repeat(513), chunked: true })).status).toBe(413);
    for (const method of ['GET', 'DELETE']) {
      expect((await raw({ method, body: 'x'.repeat(513) })).status).toBe(413);
      expect((await raw({ method, body: '{}' })).status).toBe(400);
    }
    for (const body of [
      '{"method":"initialize","method":"initialize"}', '{"method":"initialize","m\\u0065thod":"initialize"}',
      '{"params":{"x":1,"x":2}}', '{"value":1.5}', '{"value":9007199254740992}', '{"value":"\\ud800"}', 'not json', '{"x":}',
    ]) expect((await raw({ body })).status, body).toBe(400);
    expect((await raw()).status).toBe(200);
  });

  it('bounds sessions per credential and agent so A cannot lock B out; revocation reclaims slots', async () => {
    const { raw, port, client, revoked } = await setup({ maxSessions: 3 });
    await client(TOKEN_A);
    expect((await raw()).status).toBe(429);
    const b = await client(TOKEN_B);
    expect((await b.sdk.callTool({ name: 'freeze_self', arguments: { reason: 'stop' } })).isError).not.toBe(true);
    revoked.add(TOKEN_A);
    // B triggers a revocation sweep without relying on A's forbidden DELETE.
    await b.sdk.listTools();
    revoked.clear();
    expect((await raw()).status).toBe(200);
    expect((await raw()).status).toBe(429);
    // An unauthenticated attacker cannot evict B using B's session id.
    expect((await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Mcp-Session-Id', b.transport.sessionId!, 'Authorization', 'Bearer invalid'] })).status).toBe(401);
    expect((await b.sdk.listTools()).tools).toHaveLength(8);
  });

  it('enforces credential and agent caps independently, including multiple credentials for one hostile agent', async () => {
    const credential = await setup({ maxSessions: 3, maxSessionsPerCredential: 1, maxSessionsPerAgent: 10 });
    expect((await credential.raw()).status).toBe(200);
    expect((await credential.raw()).status).toBe(429);
    const agent = await setup({ maxSessions: 3, maxSessionsPerCredential: 10, maxSessionsPerAgent: 1 });
    const original = agent.authenticator.authenticateAgent;
    vi.mocked(agent.authenticator.authenticateAgent).mockImplementation(async (token) => token === TOKEN_B
      ? { ...principalA, credentialId: 'second-credential' } : { ...principalA });
    expect((await agent.raw()).status).toBe(200);
    expect((await agent.raw({ headers: ['Host', `127.0.0.1:${agent.port}`, 'Authorization', `Bearer ${TOKEN_B}`] })).status).toBe(429);
    expect(original).toHaveBeenCalled();
  });

  it('enforces the global cap, cleans failed initialization, and reaps idle sessions', async () => {
    let time = 100;
    const { raw } = await setup({ maxSessions: 2, maxSessionsPerCredential: 10, maxSessionsPerAgent: 10, sessionIdleTtlMs: 50, clock: { now: () => time } });
    // SDK rejects Accept before assigning a session. No failed-init slot may remain.
    for (let i = 0; i < 3; i++) expect((await raw({ accept: 'application/json' })).status).toBe(406);
    expect((await raw()).status).toBe(200);
    expect((await raw()).status).toBe(200);
    expect((await raw()).status).toBe(429);
    time += 50;
    expect((await raw()).status).toBe(200);
  });

  it('reaps credentials on failed authentication, classifies dependency outages, and accepts case-insensitive Bearer', async () => {
    const { raw, port, authenticator, revoked } = await setup({ maxSessions: 1 });
    const headers = ['Host', `127.0.0.1:${port}`, 'Authorization', `bEaReR ${TOKEN_A}`];
    expect((await raw({ headers })).status).toBe(200);
    revoked.add(TOKEN_A);
    expect((await raw({ headers })).status).toBe(401);
    revoked.clear();
    expect((await raw({ headers })).status).toBe(200);
    vi.mocked(authenticator.authenticateAgent).mockRejectedValueOnce(new Error('sqlite secret busy'));
    const outage = await raw({ headers });
    expect(outage.status).toBe(503);
    expect(JSON.parse(outage.body)).toEqual({ error: { code: 'BROKER_UNAVAILABLE', message: 'BROKER_UNAVAILABLE' } });
    expect((await raw({ headers })).status).toBe(200);
    vi.mocked(authenticator.authenticateAgent).mockRejectedValueOnce(new BrokerError('AUDIT_UNAVAILABLE', 'secret'));
    expect((await raw({ headers })).status).toBe(503);
  });

  it('checks path/method, UTF-8 and canonical JSON on otherwise valid initialization and established sessions', async () => {
    const { raw, client, port } = await setup();
    expect((await raw({ path: '/not-mcp' })).status).toBe(404);
    expect((await raw({ path: '/mcp?x=1' })).status).toBe(404);
    expect((await raw({ method: 'PUT' })).status).toBe(405);
    const invalidUtf8 = Buffer.concat([Buffer.from(JSON.stringify(initialize).replace('test', 'MARK')), Buffer.alloc(0)]);
    const marker = invalidUtf8.indexOf('MARK');
    invalidUtf8[marker] = 0xff;
    expect((await raw({ body: invalidUtf8 })).status).toBe(400);
    for (const value of [1.5, 1e30, '\ud800']) {
      const body = JSON.stringify({ ...initialize, params: { ...initialize.params, extra: value } });
      expect((await raw({ body })).status).toBe(400);
    }
    const { transport } = await client(TOKEN_A);
    const headers = ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${TOKEN_A}`, 'Mcp-Session-Id', transport.sessionId!];
    for (const method of ['DELETE', 'GET']) {
      for (const chunked of [false, true]) expect((await raw({ method, headers, body: '{}', chunked })).status).toBe(400);
    }
    for (const amount of [1, 1.5, 1e30]) {
      const response = await raw({ headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_transfer', arguments: { ...transferArgs, amount } } }) });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: { code: 'INVALID_AMOUNT', message: 'INVALID_AMOUNT' } });
    }
  });

  it('keeps the listener closed to work after shutdown, including when rebound by an embedding caller', async () => {
    const deps = fakes();
    const listener = createAgentHttpServer({ ...deps, config: { bindHost: '127.0.0.1', agentPort: 3210, allowedHosts: ['127.0.0.1'], allowedOrigins: [] } });
    await listener.close();
    await new Promise<void>((resolve) => listener.server.listen(0, '127.0.0.1', resolve));
    cleanup.push(listener.close);
    const port = (listener.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(initialize) });
    expect(response.status).toBe(503);
    expect(deps.authenticator.authenticateAgent).not.toHaveBeenCalled();
  });

  it('accepts valid escaped/nested JSON and rejects duplicates at any array/object nesting level', () => {
    const value = { nested: [{ 'quoted"': 'slash\\ braces{}[]', amount: '123' }, true, null, -10], empty: [] };
    expect(parseRequestJson(JSON.stringify(value))).toEqual(value);
    for (const invalid of ['[{"x":1,"\\u0078":2}]', '[1,]', '{"x":1,}', 'true false', '[', '"unterminated', '['.repeat(130) + ']'.repeat(130)]) {
      expect(() => parseRequestJson(invalid)).toThrow();
    }
  });

  it('allows explicit session deletion but never treats an invented ID as authorization', async () => {
    const { client, raw, port } = await setup();
    const { transport } = await client(TOKEN_A);
    const sessionId = transport.sessionId!;
    await transport.terminateSession();
    for (const id of [sessionId, 'invented']) {
      expect((await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${TOKEN_A}`, 'Mcp-Session-Id', id] })).status).toBe(404);
    }
  });
});
