import { z } from 'zod';
import { IdSchema, CountSchema } from './primitives.js';
import { TransferInputWireSchema } from './transfers.js';
import { ReceiptEventSchema } from './audit.js';

export const MCP_AGENT_TOOL_NAMES = [
  'budget_status', 'preview_transfer', 'request_transfer', 'get_request',
  'cancel_request', 'list_receipts', 'verify_receipt', 'freeze_self',
] as const;
export type McpAgentToolName = typeof MCP_AGENT_TOOL_NAMES[number];
export const MCP_AGENT_TOOL_INPUT_SCHEMAS = {
  budget_status: z.strictObject({}),
  preview_transfer: TransferInputWireSchema,
  request_transfer: TransferInputWireSchema,
  get_request: z.strictObject({ requestId: IdSchema }),
  cancel_request: z.strictObject({ requestId: IdSchema }),
  list_receipts: z.strictObject({ afterSeq: CountSchema.default(0), limit: CountSchema.min(1).max(1000).default(100) }),
  verify_receipt: z.strictObject({ receipt: ReceiptEventSchema }),
  freeze_self: z.strictObject({ reason: z.string().min(1).max(1024) }),
} as const satisfies Record<McpAgentToolName, z.ZodType>;
export type McpAgentToolInputs = {
  [K in McpAgentToolName]: z.infer<typeof MCP_AGENT_TOOL_INPUT_SCHEMAS[K]>
};
/** Host-published address; inside Docker the server may bind the container interface. */
export const LOOPBACK_HOST = '127.0.0.1' as const;
export const MCP_HTTP_PATH = '/mcp' as const;
export const ADMIN_HTTP_PREFIX = '/admin' as const;
