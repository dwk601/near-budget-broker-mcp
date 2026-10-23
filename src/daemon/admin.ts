import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  AgentPolicyWireSchema, BrokerError, ChainIdSchema, CountSchema, IdSchema,
  PageQuerySchema, TimestampSchema, TransferStateSchema, WalletPolicyWireSchema,
  StandingApprovalGrantSchema, DecimalTextSchema, fromDecimalText,
} from '../contracts/index.js';
import type { Authenticator, CheckpointLog, Config, OwnerBrokerService, OwnerPrincipal } from '../contracts/index.js';
import { ownerRequestFromHeaders } from '../auth/index.js';
import { json, parseJson } from './wire.js';

const empty = z.strictObject({});
const reason = z.string().min(1).max(1024);
const target = z.discriminatedUnion('scope', [z.strictObject({ scope: z.literal('global') }), z.strictObject({ scope: z.literal('agent'), agentId: IdSchema })]);
const seq = { chainId: ChainIdSchema, afterSeq: CountSchema.default(0), limit: CountSchema.min(1).max(1000).default(100) };
const revision = CountSchema.min(1).nullable();
const requestId = z.strictObject({ requestId: IdSchema });
export const adminSchemas = {
  createAgent: z.strictObject({ name: z.string().min(1).max(256) }),
  revokeAgent: z.strictObject({ agentId: IdSchema, reason }),
  listAgents: PageQuerySchema, getPolicy: z.strictObject({ agentId: IdSchema }),
  listStandingApprovals: z.strictObject({ agentId: IdSchema, query: PageQuerySchema }),
  walletStatus: empty, getFreeze: z.strictObject({ target }), getRequest: requestId, auditPublicKey: empty,
  issueToken: z.strictObject({ agentId: IdSchema }), rotateToken: z.strictObject({ credentialId: IdSchema }), revokeToken: z.strictObject({ credentialId: IdSchema }),
  setPolicy: z.strictObject({ policy: AgentPolicyWireSchema, expectedRevision: revision }),
  setWalletPolicy: z.strictObject({ policy: WalletPolicyWireSchema, expectedRevision: revision }),
  approve: z.strictObject({ requestId: IdSchema, expiresAt: TimestampSchema }), reject: z.strictObject({ requestId: IdSchema, reason }),
  grantStandingApproval: z.strictObject({ grant: StandingApprovalGrantSchema.extend({ perTxMax: DecimalTextSchema, totalMax: DecimalTextSchema }) }),
  revokeStandingApproval: z.strictObject({ approvalId: IdSchema }), freeze: z.strictObject({ target, reason }), unfreeze: z.strictObject({ target, reason }),
  reconcile: z.strictObject({ requestId: IdSchema.optional() }),
  resolveAttempt: z.strictObject({ requestId: IdSchema, reason, force: z.boolean().default(false) }),
  exportReceipts: z.strictObject(seq), listCheckpoints: z.strictObject(seq),
  listRequests: z.strictObject({ filter: z.strictObject({ agentId: IdSchema.optional(), states: z.array(TransferStateSchema).optional() }), query: PageQuerySchema }),
} as const;
export type AdminOperation = keyof typeof adminSchemas;
export const adminOperations = Object.keys(adminSchemas) as AdminOperation[];

async function dispatch(op: AdminOperation, value: unknown, b: OwnerBrokerService, p: OwnerPrincipal, checkpoints: CheckpointLog): Promise<unknown> {
  // Each case parses its own strict schema; no unchecked dynamic broker invocation.
  switch (op) {
    case 'createAgent': return b.createAgent(p, adminSchemas[op].parse(value).name);
    case 'revokeAgent': { const a = adminSchemas[op].parse(value); return b.revokeAgent(p, a.agentId, a.reason); }
    case 'listAgents': return b.listAgents(p, adminSchemas[op].parse(value));
    case 'getPolicy': return b.getPolicy(p, adminSchemas[op].parse(value).agentId);
    case 'listStandingApprovals': { const a = adminSchemas[op].parse(value); return b.listStandingApprovals(p, a.agentId, a.query); }
    case 'walletStatus': adminSchemas[op].parse(value); return b.walletStatus(p);
    case 'getFreeze': return b.getFreeze(p, adminSchemas[op].parse(value).target);
    case 'getRequest': return b.getRequest(p, adminSchemas[op].parse(value).requestId);
    case 'auditPublicKey': adminSchemas[op].parse(value); return b.auditPublicKey(p);
    case 'issueToken': return b.issueToken(p, adminSchemas[op].parse(value).agentId);
    case 'rotateToken': return b.rotateToken(p, adminSchemas[op].parse(value).credentialId);
    case 'revokeToken': return b.revokeToken(p, adminSchemas[op].parse(value).credentialId);
    case 'setPolicy': {
      const { policy: a, expectedRevision } = adminSchemas[op].parse(value);
      return b.setPolicy(p, { ...a, perTxMax: fromDecimalText(a.perTxMax), rolling24hMax: fromDecimalText(a.rolling24hMax),
        lifetimeMax: fromDecimalText(a.lifetimeMax), gasBudget24h: fromDecimalText(a.gasBudget24h),
        approvalThreshold: a.approvalThreshold === null ? null : fromDecimalText(a.approvalThreshold) }, expectedRevision);
    }
    case 'setWalletPolicy': { const { policy: a, expectedRevision } = adminSchemas[op].parse(value);
      return b.setWalletPolicy(p, { ...a, rolling24hMax: fromDecimalText(a.rolling24hMax), safetyReserve: fromDecimalText(a.safetyReserve) }, expectedRevision); }
    case 'approve': { const a = adminSchemas[op].parse(value); return b.approve(p, a.requestId, a.expiresAt); }
    case 'reject': { const a = adminSchemas[op].parse(value); return b.reject(p, a.requestId, a.reason); }
    case 'grantStandingApproval': { const { grant: a } = adminSchemas[op].parse(value); return b.grantStandingApproval(p, { ...a, perTxMax: fromDecimalText(a.perTxMax), totalMax: fromDecimalText(a.totalMax) }); }
    case 'revokeStandingApproval': return b.revokeStandingApproval(p, adminSchemas[op].parse(value).approvalId);
    case 'freeze': case 'unfreeze': { const a = adminSchemas[op].parse(value); return b[op](p, a.target, a.reason); }
    case 'reconcile': return b.reconcile(p, adminSchemas[op].parse(value).requestId);
    case 'resolveAttempt': { const a = adminSchemas[op].parse(value); return b.resolveAttempt(p, a.requestId, a.reason, a.force); }
    case 'exportReceipts': { const a = adminSchemas[op].parse(value); return b.exportReceipts(p, a.chainId, a.afterSeq, a.limit); }
    case 'listCheckpoints': { const a = adminSchemas[op].parse(value); return checkpoints.list(a.chainId, a.afterSeq, a.limit); }
    case 'listRequests': { const a = adminSchemas[op].parse(value); return b.listRequests(p, { ...(a.filter.agentId === undefined ? {} : { agentId: a.filter.agentId }), ...(a.filter.states === undefined ? {} : { states: a.filter.states }) }, a.query); }
  }
}
function single(req: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  if (values.length > 1) throw new BrokerError('UNAUTHENTICATED');
  return values[0];
}
export function createAdminHttpServer(config: Config, broker: OwnerBrokerService, auth: Authenticator, checkpoints: CheckpointLog) {
  let closing = false;
  const active = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const work = handle(req, res).catch(() => reply(res, 503, { error: { code: 'BROKER_UNAVAILABLE' } }));
    active.add(work); void work.finally(() => active.delete(work));
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  function reply(res: ServerResponse, status: number, body: unknown) {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(json(body));
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (closing) throw new BrokerError('BROKER_UNAVAILABLE');
      const host = single(req, 'host')?.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/);
      if (!host || !config.allowedHosts.includes(host[1]!) || Number(host[2] ?? 80) !== config.adminPort) throw new BrokerError('FORBIDDEN');
      const origin = single(req, 'origin');
      if (origin !== undefined && !config.allowedOrigins.includes(origin)) throw new BrokerError('FORBIDDEN');
      // Bearer credentials are never an admin capability, even with owner headers.
      if (single(req, 'authorization') !== undefined) throw new BrokerError('UNAUTHENTICATED');
      const headers: Record<string, string | undefined> = {};
      for (const key of ['nonce', 'issued-at', 'body-sha256', 'signature']) headers[`x-bb-owner-${key}`] = single(req, `x-bb-owner-${key}`);
      if (!headers['x-bb-owner-signature']) throw new BrokerError('UNAUTHENTICATED');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
        if (size > 1024 * 1024) throw new BrokerError('FORBIDDEN');
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      const principal = await auth.verifyOwnerRequest(ownerRequestFromHeaders(headers, req.method ?? '', req.url ?? '', bytes));
      if (req.method !== 'POST' || !req.url?.startsWith('/admin/')) throw new BrokerError('NOT_FOUND');
      const op = req.url.slice(7);
      if (!Object.hasOwn(adminSchemas, op)) throw new BrokerError('NOT_FOUND');
      let result: unknown;
      try { result = await dispatch(op as AdminOperation, parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), broker, principal, checkpoints); }
      catch (e) {
        if (e instanceof z.ZodError) {
          const money = new Set(['amount', 'perTxMax', 'rolling24hMax', 'lifetimeMax', 'gasBudget24h', 'approvalThreshold', 'safetyReserve', 'totalMax']);
          throw new BrokerError(e.issues.some((issue) => issue.path.some((key) => money.has(String(key)))) ? 'INVALID_AMOUNT' : 'FORBIDDEN');
        }
        if (e instanceof SyntaxError || e instanceof TypeError) throw new BrokerError('FORBIDDEN');
        throw e;
      }
      reply(res, 200, { result: result ?? null });
    } catch (e) {
      const code = e instanceof BrokerError ? e.code : 'BROKER_UNAVAILABLE';
      reply(res, code === 'UNAUTHENTICATED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'BROKER_UNAVAILABLE' ? 503 : 403, { error: { code, message: code } });
    }
  }
  return { server, async close() {
    closing = true;
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    await Promise.all(active);
  } };
}
