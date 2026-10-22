import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentMcpServer } from '../../../src/mcp/local/index.js';
import { BrokerError, MCP_AGENT_TOOL_NAMES } from '../../../src/contracts/index.js';
import { fakes, principalA, principalB, receipt, TOKEN_A, TOKEN_B, transferArgs } from './fakes.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });
async function setup(token = TOKEN_A, deps = fakes()) {
  const server = await createAgentMcpServer({ ...deps, token });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'real-test-client', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(() => client.close(), () => server.close());
  return { ...deps, client };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}
function text(result: Awaited<ReturnType<typeof call>>) {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text) as unknown;
}

describe('session-bound agent MCP factory', () => {
  it('initializes, lists exactly eight strict tools and calls every broker method with the verified principal', async () => {
    const { client, broker } = await setup();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([...MCP_AGENT_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).not.toHaveProperty('agentId');
    }
    expect(text(await call(client, 'budget_status'))).toMatchObject({ agent: { id: 'A' }, remaining: { perTx: transferArgs.amount }, usage: { agentLifetime: '2' } });
    expect(broker.budgetStatus).toHaveBeenCalledWith(principalA);
    expect(text(await call(client, 'preview_transfer', transferArgs))).toMatchObject({ decision: { kind: 'allow' } });
    expect(broker.previewTransfer).toHaveBeenCalledWith(principalA, { ...transferArgs, amount: BigInt(transferArgs.amount) });
    expect(text(await call(client, 'request_transfer', transferArgs))).toMatchObject({ id: 'request-A', amount: transferArgs.amount });
    expect(broker.requestTransfer).toHaveBeenCalledWith(principalA, { ...transferArgs, amount: BigInt(transferArgs.amount) });
    expect(text(await call(client, 'get_request', { requestId: 'request-A' }))).toMatchObject({ id: 'request-A' });
    expect(broker.getRequest).toHaveBeenCalledWith(principalA, 'request-A');
    expect(text(await call(client, 'cancel_request', { requestId: 'request-A' }))).toMatchObject({ state: 'cancelled' });
    expect(broker.cancelRequest).toHaveBeenCalledWith(principalA, 'request-A');
    expect(text(await call(client, 'list_receipts'))).toEqual([receipt()]);
    expect(broker.listReceipts).toHaveBeenCalledWith(principalA, 0, 100);
    await call(client, 'list_receipts', { afterSeq: 7, limit: 11 });
    expect(broker.listReceipts).toHaveBeenLastCalledWith(principalA, 7, 11);
    expect(text(await call(client, 'verify_receipt', { receipt: receipt() }))).toMatchObject({ valid: true, chainId: 'agent:A' });
    expect(broker.verifyReceipt).toHaveBeenCalledWith(principalA, receipt());
    expect(text(await call(client, 'freeze_self', { reason: 'stop' }))).toMatchObject({ frozen: true, agentId: 'A', reason: 'stop' });
    expect(broker.freezeSelf).toHaveBeenCalledWith(principalA, 'stop');
  });

  it('rejects agentId injection on all eight tools and invalid amounts before service invocation', async () => {
    const { client, broker } = await setup();
    const args: Record<string, Record<string, unknown>> = {
      budget_status: {}, preview_transfer: transferArgs, request_transfer: transferArgs,
      get_request: { requestId: 'request-A' }, cancel_request: { requestId: 'request-A' },
      list_receipts: {}, verify_receipt: { receipt: receipt() }, freeze_self: { reason: 'stop' },
    };
    for (const name of MCP_AGENT_TOOL_NAMES) {
      const result = await call(client, name, { ...args[name], agentId: 'B' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: { code: 'FORBIDDEN', message: 'FORBIDDEN' } });
    }
    for (const amount of ['0', '-1', '01', '1.2', '9'.repeat(100), 1]) {
      expect(text(await call(client, 'request_transfer', { ...transferArgs, amount }))).toEqual({ code: 'INVALID_AMOUNT', message: 'INVALID_AMOUNT' });
    }
    expect(text(await call(client, 'owner_tool'))).toEqual({ code: 'FORBIDDEN', message: 'FORBIDDEN' });
    for (const method of Object.values(broker)) expect(method).not.toHaveBeenCalled();
  });

  it('keeps two concurrent principals separate and does not leak cross-agent lookup/receipt details', async () => {
    const deps = fakes();
    const a = await setup(TOKEN_A, deps);
    const b = await setup(TOKEN_B, deps);
    await Promise.all([call(a.client, 'request_transfer', transferArgs), call(b.client, 'request_transfer', transferArgs)]);
    expect(deps.broker.requestTransfer).toHaveBeenCalledWith(principalB, expect.anything());
    for (const name of ['get_request', 'cancel_request']) {
      const result = await call(a.client, name, { requestId: 'request-B' });
      expect(result.isError).toBe(true);
      expect(text(result)).toEqual({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
      expect(JSON.stringify(result)).not.toContain('secret');
    }
    expect(text(await call(a.client, 'verify_receipt', { receipt: receipt('B') }))).toEqual({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
  });

  it('re-checks revocation before every call, before validation, and refuses principal changes', async () => {
    const { client, broker, revoked, authenticator } = await setup();
    revoked.add(TOKEN_A);
    expect(text(await call(client, 'get_request', { agentId: 'B' }))).toEqual({ code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED' });
    expect(broker.getRequest).not.toHaveBeenCalled();
    await expect(client.listTools()).rejects.toThrow('UNAUTHENTICATED');
    revoked.clear();
    vi.mocked(authenticator.authenticateAgent).mockResolvedValue(principalB);
    expect(text(await call(client, 'budget_status'))).toEqual({ code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED' });
    expect(broker.budgetStatus).not.toHaveBeenCalled();
    vi.mocked(authenticator.authenticateAgent).mockResolvedValue({ ...principalA, credentialId: 'rotated' });
    expect(text(await call(client, 'budget_status'))).toEqual({ code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED' });
    expect(broker.budgetStatus).not.toHaveBeenCalled();
  });

  it('sanitizes both BrokerErrors and unexpected exceptions', async () => {
    const { client, broker } = await setup();
    broker.budgetStatus.mockRejectedValueOnce(new BrokerError('AGENT_FROZEN', 'secret SQL key'));
    expect(text(await call(client, 'budget_status'))).toEqual({ code: 'AGENT_FROZEN', message: 'AGENT_FROZEN' });
    broker.budgetStatus.mockRejectedValueOnce(new Error('secret private key stack'));
    expect(text(await call(client, 'budget_status'))).toEqual({ code: 'BROKER_UNAVAILABLE', message: 'BROKER_UNAVAILABLE' });
  });
});
