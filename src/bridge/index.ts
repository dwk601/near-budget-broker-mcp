import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode as McpErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AgentTokenSchema, BrokerError } from '../contracts/index.js';
import type { ErrorCode } from '../contracts/index.js';
import { toolError } from '../mcp/local/index.js';

async function readToken(path: string): Promise<string> {
  // Inspect the opened inode, not a racy stat(path)+readFile(path) pair. No symlinks.
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
  let token: string;
  let url: URL;
  try {
    if (!env['BB_URL'] || !env['BB_TOKEN_FILE']) throw new BrokerError('FORBIDDEN');
    url = new URL(env['BB_URL']);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new BrokerError('FORBIDDEN');
    }
    // BB_URL may denote the daemon origin or its explicit /mcp endpoint.
    if (url.pathname === '/') url.pathname = '/mcp';
    if (url.pathname !== '/mcp') throw new BrokerError('FORBIDDEN');
    token = await readToken(env['BB_TOKEN_FILE']);
  } catch {
    stderr.write('Budget Broker bridge: invalid URL or protected token file\n');
    throw new BrokerError('FORBIDDEN');
  }
  const timeout = options.timeoutMs ?? 5000;
  let upstream: Client | undefined;
  let upstreamTransport: StreamableHTTPClientTransport | undefined;
  let connecting: Promise<Client> | undefined;
  let stopped = false;
  const requestOptions = { timeout };
  async function connect(): Promise<Client> {
    if (upstream) return upstream;
    if (connecting) return connecting;
    connecting = (async () => {
      const client = new Client({ name: 'budget-broker-bridge', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeout),
        ]) }),
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
      try {
        // SDK 1.32.1 sessionId accessor conflicts with exact optional typing only.
        await client.connect(transport as Transport, requestOptions);
        if (stopped) throw new BrokerError('BROKER_UNAVAILABLE');
        upstream = client;
        upstreamTransport = transport;
        return client;
      } catch (error) { await client.close(); throw error; }
      finally { connecting = undefined; }
    })();
    return connecting;
  }
  function codeFor(error: unknown): ErrorCode {
    if (error instanceof StreamableHTTPError && error.code === 401) return 'UNAUTHENTICATED';
    return 'BROKER_UNAVAILABLE';
  }
  function diagnose(code: ErrorCode) { stderr.write(`Budget Broker bridge: ${code}\n`); }
  const server = new Server({ name: 'budget-broker-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return await (await connect()).listTools(undefined, requestOptions); }
    catch (error) {
      const code = codeFor(error); diagnose(code);
      throw new McpError(McpErrorCode.InternalError, code, { code });
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try { return await (await connect()).callTool(params, undefined, requestOptions); }
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
      // Explicit DELETE releases the daemon's stateful session; disconnect alone does not.
      await upstreamTransport?.terminateSession().catch(() => undefined);
      await upstream?.close();
    })();
    return closePromise;
  }
  function onEnd() { void close(); }
  stdin.once('end', onEnd);
  await server.connect(transport);
  return { close };
}
