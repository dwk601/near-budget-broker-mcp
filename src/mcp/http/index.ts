import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AgentPrincipalSchema, MCP_HTTP_PATH } from '../../contracts/index.js';
import type { AgentBrokerService, AgentPrincipal, Authenticator, Config, ErrorCode } from '../../contracts/index.js';
import { createAgentMcpServer, samePrincipal } from '../local/index.js';
import { parseRequestJson } from './json.js';

export type AgentHttpConfig = Pick<Config, 'bindHost' | 'agentPort' | 'allowedHosts' | 'allowedOrigins'>;
export interface AgentHttpOptions {
  config: AgentHttpConfig;
  broker: AgentBrokerService;
  authenticator: Authenticator;
  maxBodyBytes?: number;
  maxSessions?: number;
  /** Explicit externally published Docker port, if different from listener. */
  publishedPort?: number;
}
interface Session { server: Server; transport: StreamableHTTPServerTransport; principal: AgentPrincipal }

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
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const maxSessions = options.maxSessions ?? 1000;
  if (!Number.isSafeInteger(maxBody) || maxBody < 1 || !Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new RangeError('Invalid transport bounds');
  }
  const sessions = new Map<string, Session>();
  const allSessions = new Set<Session>();
  let closing = false;
  let pendingInitializations = 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => deny(res, 500, 'BROKER_UNAVAILABLE'));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
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
    let token: string;
    let principal: AgentPrincipal;
    try {
      const header = singleHeader(req, 'authorization');
      const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/);
      if (!match) throw new Error('Bearer required');
      token = match[1]!;
      principal = AgentPrincipalSchema.parse(await authenticator.authenticateAgent(token));
    } catch { deny(res, 401, 'UNAUTHENTICATED'); return; }
    if (closing) { deny(res, 503, 'BROKER_UNAVAILABLE'); return; }
    if (req.url !== MCP_HTTP_PATH) { deny(res, 404, 'NOT_FOUND'); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) { deny(res, 405, 'FORBIDDEN'); return; }
    let sessionId: string | undefined;
    try { sessionId = singleHeader(req, 'mcp-session-id'); }
    catch { deny(res, 400, 'FORBIDDEN'); return; }
    let session = sessionId === undefined ? undefined : sessions.get(sessionId);
    if (sessionId !== undefined) {
      if (!session) { deny(res, 404, 'NOT_FOUND'); return; }
      if (!samePrincipal(principal, session.principal)) { deny(res, 403, 'FORBIDDEN'); return; }
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
      } catch { deny(res, 400, 'FORBIDDEN'); return; }
    }
    if (!session) {
      if (req.method !== 'POST' || !isInitializeRequest(body)) { deny(res, 400, 'FORBIDDEN'); return; }
      if (allSessions.size + pendingInitializations >= maxSessions) { deny(res, 429, 'RATE_LIMITED'); return; }
      pendingInitializations++;
      try {
        const mcp = await createAgentMcpServer({ broker, authenticator, token });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: (id) => { sessions.set(id, created); },
          onsessionclosed: (id) => { sessions.delete(id); void mcp.close(); },
        });
        const created: Session = { server: mcp, transport, principal: Object.freeze({ ...principal }) };
        // Authenticate again inside the factory; prevent identity changes during initialization.
        if (!samePrincipal(principal, await authenticator.authenticateAgent(token))) {
          await mcp.close(); deny(res, 401, 'UNAUTHENTICATED'); return;
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
      } catch { deny(res, 401, 'UNAUTHENTICATED'); return; }
      finally { pendingInitializations--; }
    }
    await session.transport.handleRequest(req, res, body);
    if (!session.transport.sessionId) await session.server.close();
  }
  async function close(): Promise<void> {
    closing = true;
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
  await new Promise<void>((resolve, reject) => {
    listener.server.once('error', reject);
    listener.server.listen(options.config.agentPort, options.config.bindHost, () => {
      listener.server.off('error', reject); resolve();
    });
  });
  return listener;
}
