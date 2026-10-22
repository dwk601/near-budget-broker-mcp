import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AgentTokenSchema, BrokerError, ErrorCodeSchema } from '../contracts/index.js';
import type { ErrorCode } from '../contracts/index.js';
import { toolError } from '../mcp/local/index.js';

async function readToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096
      || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new BrokerError('FORBIDDEN');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new BrokerError('FORBIDDEN');
    return AgentTokenSchema.parse(buffer.subarray(0, bytesRead).toString('utf8').trim());
  } finally { await file.close(); }
}
class UpstreamError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode) { super(code); }
}
function statusCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'BROKER_UNAVAILABLE';
  if (status === 404) return 'NOT_FOUND';
  return 'FORBIDDEN';
}
async function errorResponse(response: Response): Promise<UpstreamError> {
  let code = statusCode(response.status);
  // Bound untrusted diagnostics and propagate only the frozen code, never messages.
  const reader = response.body?.getReader();
  try {
    let bytes = 0; const chunks: Uint8Array[] = [];
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 4096) break;
      chunks.push(chunk.value);
    }
    if (bytes <= 4096) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: unknown } };
      const parsed = ErrorCodeSchema.safeParse(body.error?.code);
      if (parsed.success && response.status < 500) code = parsed.data;
    }
  } catch { /* fall back to HTTP status */ }
  finally { await reader?.cancel().catch(() => undefined); }
  return new UpstreamError(response.status, code);
}

export interface StdioBridgeOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  timeoutMs?: number;
}

/** Used by `budget-broker mcp`. No custody, broker implementation or local successes. */
export async function runStdioBridge(options: StdioBridgeOptions = {}) {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  let url: URL;
  const tokenPath = env['BB_TOKEN_FILE'];
  try {
    if (!env['BB_URL'] || !tokenPath) throw new BrokerError('FORBIDDEN');
    url = new URL(env['BB_URL']);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BrokerError('FORBIDDEN');
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(url.hostname);
    if (url.protocol === 'http:' && !loopback) throw new BrokerError('FORBIDDEN');
    if (url.pathname === '/') url.pathname = '/mcp';
    if (url.pathname !== '/mcp') throw new BrokerError('FORBIDDEN');
    await readToken(tokenPath);
  } catch {
    stderr.write('Budget Broker bridge: invalid URL or protected token file\n');
    throw new BrokerError('FORBIDDEN');
  }
  const timeout = options.timeoutMs ?? 5000;
  interface Upstream { client: Client; transport: StreamableHTTPClientTransport }
  let upstream: Upstream | undefined;
  let connecting: Promise<Upstream> | undefined;
  let stopped = false;
  const requestOptions = { timeout };
  async function connect(): Promise<Upstream> {
    if (upstream) return upstream;
    if (connecting) return connecting;
    connecting = (async () => {
      let token: string;
      try { token = await readToken(tokenPath!); }
      catch { throw new BrokerError('FORBIDDEN'); }
      const client = new Client({ name: 'budget-broker-bridge', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
        fetch: async (input, init) => {
          const response = await fetch(input, { ...init, signal: AbortSignal.any([
            ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeout),
          ]) });
          if (response.status >= 400) throw await errorResponse(response);
          return response;
        },
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
      try {
        // SDK 1.32.1 sessionId accessor conflicts with exact optional typing only.
        await client.connect(transport as Transport, requestOptions);
        if (stopped) throw new BrokerError('BROKER_UNAVAILABLE');
        return upstream = { client, transport };
      } catch (error) { await client.close(); throw error; }
    })().finally(() => { connecting = undefined; });
    return connecting;
  }
  function codeFor(error: unknown): ErrorCode {
    if (error instanceof UpstreamError) return error.code;
    if (error instanceof BrokerError) return error.code;
    if (error instanceof StreamableHTTPError && error.code !== undefined) return statusCode(error.code);
    return 'BROKER_UNAVAILABLE';
  }
  async function discard(failed: Upstream): Promise<void> {
    if (upstream === failed) upstream = undefined;
    await failed.client.close();
  }
  async function proxy<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const connection = await connect();
    try { return await operation(connection.client); }
    catch (error) {
      const status = error instanceof UpstreamError ? error.status : error instanceof StreamableHTTPError ? error.code : undefined;
      if (status === 404) {
        await discard(connection);
        // A missing session was not dispatched. Retry exactly once with a new session
        // and freshly read credentials. Never replay an ambiguous network failure.
        const fresh = await connect();
        try { return await operation(fresh.client); }
        catch (retryError) { await discard(fresh); throw retryError; }
      }
      if (status === undefined || status === 401 || status >= 500) await discard(connection);
      throw error;
    }
  }
  function diagnose(code: ErrorCode) { stderr.write(`Budget Broker bridge: ${code}\n`); }
  const server = new Server({ name: 'budget-broker-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return await proxy((client) => client.listTools(undefined, requestOptions)); }
    catch (error) {
      const code = codeFor(error); diagnose(code);
      throw new McpError(McpErrorCode.InternalError, code, { code });
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try { return await proxy((client) => client.callTool(params, undefined, requestOptions)); }
    catch (error) { const code = codeFor(error); diagnose(code); return toolError(code); }
  });
  const stdin = options.stdin ?? process.stdin;
  const transport = new StdioServerTransport(stdin, options.stdout ?? process.stdout);
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closePromise ??= (async () => {
      stopped = true;
      stdin.off('end', onEnd);
      await server.close();
      if (connecting) await connecting.catch(() => undefined);
      await upstream?.transport.terminateSession().catch(() => undefined);
      await upstream?.client.close();
    })();
    return closePromise;
  }
  function onEnd() { void close(); }
  stdin.once('end', onEnd);
  await server.connect(transport);
  return { close };
}
