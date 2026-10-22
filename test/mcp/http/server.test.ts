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
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    const onGet = (req: import('node:http').IncomingMessage) => {
      if (req.method === 'GET' && req.headers['mcp-session-id'] === transport.sessionId) { listener.server.off('request', onGet); received(); }
    };
    listener.server.on('request', onGet);
    try { await sdk.connect(transport as Transport); await started; await new Promise((resolve) => setImmediate(resolve)); }
    finally { listener.server.off('request', onGet); }
    return { sdk, transport };
  }
  function raw(options: { headers?: string[]; body?: string | Buffer; method?: string; chunked?: boolean; path?: string; accept?: string } = {}) {
    return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const body = options.body ?? JSON.stringify(initialize);
      const headers = options.headers ?? ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${TOKEN_A}`];
      const req = request({ hostname: '127.0.0.1', port, path: options.path ?? '/mcp', method: options.method ?? 'POST', headers: [
        ...headers, 'Content-Type', 'application/json', 'Accept', options.accept ?? 'application/json, text/event-stream',
        ...(options.chunked ? ['Transfer-Encoding', 'chunked'] : ['Content-Length', String(Buffer.byteLength(body))]),
      ] }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (data: string) => { text += data; });
        res.on('end', () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
      });
      req.on('error', reject);
      req.setTimeout(1500, () => req.destroy(new Error('HTTP response timed out')));
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
    const first = await client(TOKEN_A);
    expect((await raw()).status).toBe(200);
    await expect(first.sdk.listTools()).rejects.toMatchObject({ code: 404 });
    const b = await client(TOKEN_B);
    expect((await b.sdk.callTool({ name: 'freeze_self', arguments: { reason: 'stop' } })).isError).not.toBe(true);
    revoked.add(TOKEN_A);
    // A's definitive failure reclaims A only; unauthenticated DELETE is unnecessary.
    expect((await raw()).status).toBe(401);
    revoked.clear();
    expect((await raw()).status).toBe(200);
    expect((await raw()).status).toBe(200);
    // An unauthenticated attacker cannot evict B using B's session id.
    expect((await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Mcp-Session-Id', b.transport.sessionId!, 'Authorization', 'Bearer invalid'] })).status).toBe(401);
    expect((await b.sdk.listTools()).tools).toHaveLength(8);
  });

  it('enforces credential and agent caps independently, including multiple credentials for one hostile agent', async () => {
    const credential = await setup({ maxSessions: 3, maxSessionsPerCredential: 1, maxSessionsPerAgent: 10 });
    const first = await credential.client(TOKEN_A);
    expect((await credential.raw()).status).toBe(200);
    await expect(first.sdk.listTools()).rejects.toMatchObject({ code: 404 });
    const agent = await setup({ maxSessions: 3, maxSessionsPerCredential: 10, maxSessionsPerAgent: 1 });
    const original = agent.authenticator.authenticateAgent;
    vi.mocked(agent.authenticator.authenticateAgent).mockImplementation(async (token) => token === TOKEN_B
      ? { ...principalA, credentialId: 'second-credential' } : { ...principalA });
    expect((await agent.raw()).status).toBe(200);
    expect((await agent.raw({ headers: ['Host', `127.0.0.1:${agent.port}`, 'Authorization', `Bearer ${TOKEN_B}`] })).status).toBe(429);
    expect(original).toHaveBeenCalled();
  });

  it('evicts only the oldest own idle session, never an active response or another credential', async () => {
    let time = 100;
    const deps = await setup({ maxSessions: 3, maxSessionsPerCredential: 2, maxSessionsPerAgent: 10, clock: { now: () => time } });
    const first = await deps.client(TOKEN_A);
    time = 200;
    const second = await deps.client(TOKEN_A);
    time = 300;
    await first.sdk.listTools();
    time = 400;
    expect((await deps.raw()).status).toBe(200);
    await expect(second.sdk.listTools()).rejects.toMatchObject({ code: 404 });
    expect((await first.sdk.listTools()).tools).toHaveLength(8);
    const active = await setup({ maxSessions: 1, maxSessionsPerCredential: 1 });
    const { sdk } = await active.client(TOKEN_A);
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = active.broker.budgetStatus.getMockImplementation()!;
    active.broker.budgetStatus.mockImplementationOnce(async (p) => { enter(); await gate; return original(p); });
    const call = sdk.callTool({ name: 'budget_status', arguments: {} }, undefined, { timeout: 1500 });
    try {
      await entered;
      expect((await active.raw()).status).toBe(429);
    } finally { release(); }
    expect((await call).isError).not.toBe(true);
    expect((await active.raw()).status).toBe(200);
  });

  it('enforces the global cap, cleans failed initialization, and reaps idle sessions', async () => {
    let time = 100;
    const { raw, port, authenticator } = await setup({ maxSessions: 2, maxSessionsPerCredential: 10, maxSessionsPerAgent: 10, sessionIdleTtlMs: 50, clock: { now: () => time } });
    const authenticate = vi.mocked(authenticator.authenticateAgent).getMockImplementation()!;
    const third = `bb_agent_${Buffer.alloc(32, 3).toString('base64url')}`;
    vi.mocked(authenticator.authenticateAgent).mockImplementation(async (token) => token === third
      ? { kind: 'agent', agentId: 'C', credentialId: 'cred-C' } : authenticate(token));
    const headers = (token: string) => ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${token}`];
    // SDK rejects Accept before assigning a session. No failed-init slot may remain.
    for (let i = 0; i < 3; i++) expect((await raw({ accept: 'application/json' })).status).toBe(406);
    expect((await raw()).status).toBe(200);
    expect((await raw({ headers: headers(TOKEN_B) })).status).toBe(200);
    expect((await raw({ headers: headers(third) })).status).toBe(429);
    time += 50;
    expect((await raw({ headers: headers(third) })).status).toBe(200);
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

  it('returns an authentication challenge and cleans timers when listen fails', async () => {
    const { raw, port } = await setup();
    const denied = await raw({ headers: ['Host', `127.0.0.1:${port}`] });
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer');
    const timers = vi.spyOn(globalThis, 'setInterval');
    const clears = vi.spyOn(globalThis, 'clearInterval');
    try {
      await expect(startAgentHttpServer({ ...fakes(), config: { bindHost: '127.0.0.1', agentPort: port, allowedHosts: ['127.0.0.1'], allowedOrigins: [] } })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(clears).toHaveBeenCalledWith(timers.mock.results[0]!.value);
    } finally {
      for (const result of timers.mock.results) if (result.type === 'return') clearInterval(result.value as NodeJS.Timeout);
      timers.mockRestore(); clears.mockRestore();
    }
  });

  it('counts pending concurrent initializations against every cap before awaiting authentication', async () => {
    for (const scope of ['global', 'credential', 'agent']) {
      const deps = await setup({ maxSessions: scope === 'global' ? 1 : 3, maxSessionsPerCredential: scope === 'credential' ? 1 : 10, maxSessionsPerAgent: scope === 'agent' ? 1 : 10 });
      const authenticate = vi.mocked(deps.authenticator.authenticateAgent).getMockImplementation()!;
      let enter!: () => void; let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      vi.mocked(deps.authenticator.authenticateAgent).mockImplementation(async (token) => {
        if (++calls === 2) { enter(); await gate; }
        if (scope === 'agent' && token === TOKEN_B) return { ...principalA, credentialId: 'second' };
        return authenticate(token);
      });
      const first = deps.raw();
      try {
        await entered;
        const second = await deps.raw({ headers: ['Host', `127.0.0.1:${deps.port}`, 'Authorization', `Bearer ${scope === 'credential' ? TOKEN_A : TOKEN_B}`] });
        expect(second.status, scope).toBe(429);
      } finally { release(); await first; }
    }
  });

  it('delivers second-layer auth errors before eviction and preserves sessions on transient errors', async () => {
    for (const code of ['UNAUTHENTICATED', 'BROKER_UNAVAILABLE'] as const) {
      const { client, raw, port, authenticator, broker } = await setup();
      const { sdk, transport } = await client(TOKEN_A);
      const live = vi.mocked(authenticator.authenticateAgent).getMockImplementation()!;
      let calls = 0;
      vi.mocked(authenticator.authenticateAgent).mockImplementation(async (token) => {
        if (++calls === 2) throw code === 'UNAUTHENTICATED' ? new BrokerError(code) : new Error('SQLITE_BUSY secret');
        return live(token);
      });
      const response = await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${TOKEN_A}`, 'Mcp-Session-Id', transport.sessionId!],
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'budget_status', arguments: {} } }) });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ id: 9, result: { isError: true, structuredContent: { error: { code, message: code } } } });
      expect(broker.budgetStatus).not.toHaveBeenCalled();
      await new Promise((resolve) => setImmediate(resolve));
      if (code === 'UNAUTHENTICATED') await expect(sdk.listTools()).rejects.toMatchObject({ code: 404 });
      else expect((await sdk.listTools()).tools).toHaveLength(8);
    }
  });

  it('does not evict the caller on an outer authenticator outage', async () => {
    const { client, raw, port, authenticator } = await setup();
    const { sdk, transport } = await client(TOKEN_A);
    vi.mocked(authenticator.authenticateAgent).mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    expect((await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${TOKEN_A}`, 'Mcp-Session-Id', transport.sessionId!] })).status).toBe(503);
    expect((await sdk.listTools()).tools).toHaveLength(8);
  });

  it('keeps per-request authentication cost constant with 100 credentials', async () => {
    const { raw, port, authenticator } = await setup({ maxSessions: 150 });
    const tokens = new Map(Array.from({ length: 100 }, (_, i) => [`bb_agent_${Buffer.alloc(32, i + 3).toString('base64url')}`, { kind: 'agent' as const, agentId: `agent-${i}`, credentialId: `credential-${i}` }]));
    vi.mocked(authenticator.authenticateAgent).mockImplementation(async (token) => tokens.get(token)!);
    let first: string | undefined;
    for (const [token] of tokens) {
      const response = await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${token}`] });
      expect(response.status).toBe(200);
      first ??= String(response.headers['mcp-session-id']);
    }
    vi.mocked(authenticator.authenticateAgent).mockClear();
    const token = tokens.keys().next().value!;
    const response = await raw({ headers: ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${token}`, 'Mcp-Session-Id', first!],
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'budget_status', arguments: {} } }) });
    expect(response.status).toBe(200);
    expect(authenticator.authenticateAgent).toHaveBeenCalledTimes(2);
  });

  it('background reaping revokes A without evicting B on a transient authenticator hiccup', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { client, authenticator, revoked } = await setup({ sessionIdleTtlMs: 1000, clock: { now: () => 100 } });
      const a = await client(TOKEN_A); const b = await client(TOKEN_B);
      const live = vi.mocked(authenticator.authenticateAgent).getMockImplementation()!;
      let hiccup = true;
      vi.mocked(authenticator.authenticateAgent).mockImplementation(async (token) => {
        if (token === TOKEN_B && hiccup) { hiccup = false; throw new Error('SQLITE_BUSY'); }
        return live(token);
      });
      revoked.add(TOKEN_A);
      await vi.advanceTimersByTimeAsync(1000);
      expect(hiccup).toBe(false);
      revoked.clear();
      await expect(a.sdk.listTools()).rejects.toMatchObject({ code: 404 });
      expect((await b.sdk.listTools()).tools).toHaveLength(8);
    } finally { vi.useRealTimers(); }
  });

  it('refreshes activity on GET and protects long-running POST responses from the idle reaper', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let release = () => {};
    try {
      let time = 100;
      const { raw, port, client, broker } = await setup({ sessionIdleTtlMs: 1000, clock: { now: () => time } });
      const initialized = await raw();
      const id = String(initialized.headers['mcp-session-id']);
      time = 850;
      const abort = new AbortController();
      const stream = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { Authorization: `Bearer ${TOKEN_A}`, 'Mcp-Session-Id': id, Accept: 'text/event-stream' }, signal: abort.signal });
      expect(stream.status).toBe(200); abort.abort();
      time = 1150;
      await vi.advanceTimersByTimeAsync(1000);
      const headers = ['Host', `127.0.0.1:${port}`, 'Authorization', `Bearer ${TOKEN_A}`, 'Mcp-Session-Id', id];
      expect((await raw({ headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).status).toBe(200);
      const { sdk } = await client(TOKEN_B);
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const original = broker.budgetStatus.getMockImplementation()!;
      broker.budgetStatus.mockImplementationOnce(async (principal) => { enter(); await gate; return original(principal); });
      const slow = sdk.callTool({ name: 'budget_status', arguments: {} }, undefined, { timeout: 1500 });
      await entered;
      time += 2000;
      await vi.advanceTimersByTimeAsync(1000);
      release();
      expect((await slow).isError).not.toBe(true);
      time += 500;
      await vi.advanceTimersByTimeAsync(1000);
      expect((await sdk.listTools()).tools).toHaveLength(8);
    } finally { release(); vi.useRealTimers(); }
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
