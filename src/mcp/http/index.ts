import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { BrokerError, MCP_HTTP_PATH } from '../../contracts/index.js';
import type { AgentBrokerService, AgentPrincipal, Authenticator, Clock, Config, ErrorCode } from '../../contracts/index.js';
import { authenticatePrincipal, createAgentMcpServer, samePrincipal } from '../local/index.js';
import { parseRequestJson } from './json.js';

export type AgentHttpConfig = Pick<Config, 'bindHost' | 'agentPort' | 'allowedHosts' | 'allowedOrigins'>;
export interface AgentHttpOptions {
  config: AgentHttpConfig;
  broker: AgentBrokerService;
  authenticator: Authenticator;
  maxBodyBytes?: number;
  maxSessions?: number;
  maxSessionsPerCredential?: number;
  maxSessionsPerAgent?: number;
  sessionIdleTtlMs?: number;
  clock?: Clock;
  /** Explicit externally published Docker port, if different from listener. */
  publishedPort?: number;
}
interface Session {
  server: Server; transport: StreamableHTTPServerTransport; principal: AgentPrincipal;
  token: string; lastUsed: number;
}

/** Reject duplicate raw headers before Node's header coalescing can hide them. */
function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  }
  if (values.length > 1) throw new Error('Repeated header');
  return values[0];
}
function deny(res: ServerResponse, status: number, code: ErrorCode): void {
  if (res.headersSent) { res.end(); return; }
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: { code, message: code } }));
}

/** Creates an unstarted node:http server. B08 owns process lifecycle/listen. */
export function createAgentHttpServer(options: AgentHttpOptions) {
  const { config, broker, authenticator } = options;
  const now = () => (options.clock?.now() ?? Date.now());
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const maxSessions = options.maxSessions ?? 1000;
  const perCredential = options.maxSessionsPerCredential ?? Math.max(1, Math.min(4, Math.floor(maxSessions / 2)));
  const perAgent = options.maxSessionsPerAgent ?? Math.max(1, Math.min(8, Math.floor(maxSessions / 2)));
  const ttl = options.sessionIdleTtlMs ?? 300_000;
  if ([maxBody, maxSessions, perCredential, perAgent, ttl].some((bound) => !Number.isSafeInteger(bound) || bound < 1)) {
    throw new RangeError('Invalid transport bounds');
  }
  const sessions = new Map<string, Session>();
  const allSessions = new Set<Session>();
  const pending = new Map<string, AgentPrincipal>();
  let closing = false;
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => deny(res, 500, 'BROKER_UNAVAILABLE'));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  async function evictToken(token: string): Promise<void> {
    await Promise.all([...allSessions].filter((s) => s.token === token).map((s) => s.server.close()));
  }
  // Reclaim revoked credentials even when clients cannot send an authenticated DELETE.
  // A session id from a failed request alone is never grounds to evict somebody else.
  let sweeping: Promise<void> | undefined;
  function sweep(): Promise<void> {
    sweeping ??= (async () => {
      await Promise.all([...allSessions].filter((s) => now() - s.lastUsed >= ttl).map((s) => s.server.close()));
      await Promise.all([...new Set([...allSessions].map((s) => s.token))].map(async (token) => {
        try {
          const live = await authenticatePrincipal(authenticator, token);
          if ([...allSessions].some((s) => s.token === token && !samePrincipal(live, s.principal))) await evictToken(token);
        } catch { await evictToken(token); }
      }));
    })().finally(() => { sweeping = undefined; });
    return sweeping;
  }
  const reaper = setInterval(() => { if (!closing) void sweep(); }, Math.min(ttl, 30_000));
  reaper.unref();
  async function authenticationFailure(res: ServerResponse, error: unknown, token?: string) {
    if (token) await evictToken(token);
    const unauthenticated = error instanceof BrokerError && error.code === 'UNAUTHENTICATED';
    deny(res, unauthenticated ? 401 : 503, unauthenticated ? 'UNAUTHENTICATED' : 'BROKER_UNAVAILABLE');
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) { deny(res, 503, 'BROKER_UNAVAILABLE'); return; }
    // Never use X-Forwarded-* as an authority.
    try {
      const host = singleHeader(req, 'host');
      const authority = host?.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/);
      const address = server.address() as AddressInfo | null;
      const listenerPort = address?.port ?? config.agentPort;
      const port = authority?.[2] === undefined ? 80 : Number(authority[2]);
      if (!authority || !config.allowedHosts.includes(authority[1]!)
        || (port !== listenerPort && port !== options.publishedPort)) throw new Error('Host');
      const origin = singleHeader(req, 'origin');
      if (origin !== undefined) {
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin
          || !config.allowedOrigins.includes(origin)) throw new Error('Origin');
      }
    } catch { deny(res, 403, 'FORBIDDEN'); return; }
    let token: string | undefined;
    let principal: AgentPrincipal;
    try {
      let header: string | undefined;
      try { header = singleHeader(req, 'authorization'); }
      catch { throw new BrokerError('UNAUTHENTICATED'); }
      const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/i);
      if (!match) throw new BrokerError('UNAUTHENTICATED');
      token = match[1]!;
      principal = await authenticatePrincipal(authenticator, token);
    } catch (error) { await authenticationFailure(res, error, token); return; }
    if (closing) { deny(res, 503, 'BROKER_UNAVAILABLE'); return; }
    if (req.url !== MCP_HTTP_PATH) { deny(res, 404, 'NOT_FOUND'); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { deny(res, 405, 'FORBIDDEN'); return; }
    await sweep();
    let sessionId: string | undefined;
    try { sessionId = singleHeader(req, 'mcp-session-id'); }
    catch { deny(res, 400, 'FORBIDDEN'); return; }
    let session = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (sessionId !== undefined) {
      if (!session) { deny(res, 404, 'NOT_FOUND'); return; }
      if (!samePrincipal(principal, session.principal)) { deny(res, 403, 'FORBIDDEN'); return; }
      session.lastUsed = now();
    }
    const length = req.headers['content-length'];
    if (length !== undefined && Number(length) > maxBody) { deny(res, 413, 'FORBIDDEN'); return; }
    if (req.method !== 'POST' && ((length !== undefined && Number(length) !== 0) || req.headers['transfer-encoding'])) {
      deny(res, 400, 'FORBIDDEN'); return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of req) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          size += bytes.length;
          if (size > maxBody) { deny(res, 413, 'FORBIDDEN'); return; }
          chunks.push(bytes);
        }
        body = parseRequestJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (error) { deny(res, 400, error instanceof BrokerError && error.code === 'INVALID_AMOUNT' ? 'INVALID_AMOUNT' : 'FORBIDDEN'); return; }
    }
    if (!session) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) { deny(res, 400, 'FORBIDDEN'); return; }
      const principals = [...allSessions].map((s) => s.principal).concat([...pending.values()]);
      if (principals.length >= maxSessions
        || principals.filter((p) => p.credentialId === principal.credentialId).length >= perCredential
        || principals.filter((p) => p.agentId === principal.agentId).length >= perAgent) {
        deny(res, 429, 'RATE_LIMITED'); return;
      }
      const reservation = randomUUID();
      pending.set(reservation, principal);
      try {
        const mcp = await createAgentMcpServer({ broker, authenticator, token,
          onAuthenticationFailure: () => { void evictToken(token); },
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: (id) => { sessions.set(id, created); },
          onsessionclosed: (id) => { sessions.delete(id); void mcp.close(); },
        });
        const created: Session = { server: mcp, transport, principal: Object.freeze({ ...principal }), token, lastUsed: now() };
        if (!samePrincipal(principal, await authenticatePrincipal(authenticator, token))) {
          await mcp.close(); throw new BrokerError('UNAUTHENTICATED');
        }
        // SDK 1.32.1 accessor declarations are not exactOptionalPropertyTypes-compatible.
        if (closing) { await mcp.close(); deny(res, 503, 'BROKER_UNAVAILABLE'); return; }
        await mcp.connect(transport as Transport);
        allSessions.add(created);
        mcp.onclose = () => {
          allSessions.delete(created);
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        session = created;
      } catch (error) { await authenticationFailure(res, error, token); return; }
      finally { pending.delete(reservation); }
    }
    try { await session.transport.handleRequest(req, res, body); }
    finally { if (!session.transport.sessionId) await session.server.close(); }
  }
  async function close(): Promise<void> {
    closing = true;
    clearInterval(reaper);
    await sweeping;
    await Promise.all([...allSessions].map((session) => session.server.close()));
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  }
  return { server, close };
}

export async function startAgentHttpServer(options: AgentHttpOptions) {
  const listener = createAgentHttpServer(options);
  try {
    await new Promise<void>((resolve, reject) => {
      listener.server.once('error', reject);
      listener.server.listen(options.config.agentPort, options.config.bindHost, () => {
        listener.server.off('error', reject); resolve();
      });
    });
    return listener;
  } catch (error) { await listener.close(); throw error; }
}
