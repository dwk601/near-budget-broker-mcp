import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AgentPrincipalSchema, BrokerError, MCP_AGENT_TOOL_INPUT_SCHEMAS, MCP_AGENT_TOOL_NAMES,
  canonicalJson, fromDecimalText,
} from '../../contracts/index.js';
import type { AgentBrokerService, AgentPrincipal, Authenticator, ErrorCode, TransferInput } from '../../contracts/index.js';

export function toolError(code: ErrorCode): CallToolResult {
  const error = { code, message: code };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }], structuredContent: { error } };
}

const descriptions = {
  budget_status: 'Inspect your own policy, usage and remaining budget; not a capacity promise.',
  preview_transfer: 'Preview a native NEAR transfer without reserving funds. amount is unsigned decimal yoctoNEAR text (1 NEAR = 10^24 yoctoNEAR).',
  request_transfer: 'Request a native NEAR transfer using an idempotency key. amount is positive decimal yoctoNEAR text, never a JSON number or human NEAR decimal.',
  get_request: 'Read one of your own transfer requests.',
  cancel_request: 'Cancel your own request before signing; ambiguous or signed transfers cannot be cancelled.',
  list_receipts: 'List your signed receipts after an exclusive sequence cursor; defaults: afterSeq=0, limit=100.',
  verify_receipt: 'Verify a receipt scoped to your own agent chain.',
  freeze_self: 'Activate your agent kill switch to block new transfers and dispatch.',
} as const;

/** Distinguish invalid credentials from failures of the authentication dependency. */
export async function authenticatePrincipal(authenticator: Authenticator, token: string): Promise<AgentPrincipal> {
  try { return AgentPrincipalSchema.parse(await authenticator.authenticateAgent(token)); }
  catch (error) {
    throw new BrokerError(error instanceof BrokerError && error.code === 'UNAUTHENTICATED'
      ? 'UNAUTHENTICATED' : 'BROKER_UNAVAILABLE');
  }
}

/** Only shared strict input schemas are advertised, including additionalProperties:false. */
export function agentTools(): Tool[] {
  return MCP_AGENT_TOOL_NAMES.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(MCP_AGENT_TOOL_INPUT_SCHEMAS[name], { io: 'input' }) as Tool['inputSchema'],
  }));
}

export function samePrincipal(a: AgentPrincipal, b: AgentPrincipal): boolean {
  return a.kind === b.kind && a.agentId === b.agentId && a.credentialId === b.credentialId;
}

/** A session captures a credential, never a mutable current-user slot. */
export async function createAgentMcpServer(options: {
  broker: AgentBrokerService; authenticator: Authenticator; token: string;
  onAuthenticationFailure?: () => void;
}): Promise<Server> {
  const { broker, authenticator, token } = options;
  const principal = Object.freeze(await authenticatePrincipal(authenticator, token));
  const server = new Server({ name: 'budget-broker', version: '0.1.0' }, { capabilities: { tools: {} } });
  async function authenticate(): Promise<AgentPrincipal> {
    try {
      const live = await authenticatePrincipal(authenticator, token);
      if (!samePrincipal(principal, live)) throw new BrokerError('UNAUTHENTICATED');
      return principal;
    } catch (error) {
      // A transient dependency failure is not evidence of revocation. Let the MCP
      // response be sent before notifying a session owner about definitive failure.
      if (error instanceof BrokerError && error.code === 'UNAUTHENTICATED') {
        setImmediate(() => options.onAuthenticationFailure?.());
      }
      throw error;
    }
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await authenticate();
    return { tools: agentTools() };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const p = await authenticate(); // Before validation, lookups, or idempotency probes.
      const args = params.arguments ?? {};
      function parse<K extends keyof typeof MCP_AGENT_TOOL_INPUT_SCHEMAS>(name: K) {
        const parsed = MCP_AGENT_TOOL_INPUT_SCHEMAS[name].safeParse(args);
        if (!parsed.success) {
          const monetary = parsed.error.issues.some((issue) => issue.path[0] === 'amount');
          throw new BrokerError(monetary ? 'INVALID_AMOUNT' : 'FORBIDDEN');
        }
        return parsed.data as z.output<(typeof MCP_AGENT_TOOL_INPUT_SCHEMAS)[K]>;
      }
      function transfer(name: 'preview_transfer' | 'request_transfer'): TransferInput {
        const input = parse(name);
        return { ...input, amount: fromDecimalText(input.amount) };
      }
      let result: unknown;
      switch (params.name) {
        case 'budget_status': parse('budget_status'); result = await broker.budgetStatus(p); break;
        case 'preview_transfer': result = await broker.previewTransfer(p, transfer('preview_transfer')); break;
        case 'request_transfer': result = await broker.requestTransfer(p, transfer('request_transfer')); break;
        case 'get_request': result = await broker.getRequest(p, parse('get_request').requestId); break;
        case 'cancel_request': result = await broker.cancelRequest(p, parse('cancel_request').requestId); break;
        case 'list_receipts': {
          const input = parse('list_receipts');
          result = await broker.listReceipts(p, input.afterSeq, input.limit); break;
        }
        case 'verify_receipt': result = await broker.verifyReceipt(p, parse('verify_receipt').receipt); break;
        case 'freeze_self': result = await broker.freezeSelf(p, parse('freeze_self').reason); break;
        default: throw new BrokerError('FORBIDDEN');
      }
      // No global BigInt mutation. Domain values are unsigned decimal wire text.
      const wire: unknown = JSON.parse(JSON.stringify(result, (_key, value: unknown) => {
        if (typeof value !== 'bigint') return value;
        if (value < 0n) throw new BrokerError('BROKER_UNAVAILABLE');
        return value.toString(10);
      }));
      return { content: [{ type: 'text', text: canonicalJson(wire) }] };
    } catch (error) {
      return toolError(error instanceof BrokerError ? error.code : 'BROKER_UNAVAILABLE');
    }
  });
  return server;
}
