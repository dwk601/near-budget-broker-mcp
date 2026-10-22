import { vi } from 'vitest';
import { BrokerError, requestDigest, TransferViewSchema } from '../../../src/contracts/index.js';
import type { AgentBrokerService, AgentPrincipal, Authenticator, BudgetStatus, ReceiptEvent, TransferInput, TransferView } from '../../../src/contracts/index.js';

export const TOKEN_A = `bb_agent_${Buffer.alloc(32, 1).toString('base64url')}`;
export const TOKEN_B = `bb_agent_${Buffer.alloc(32, 2).toString('base64url')}`;
export const principalA: AgentPrincipal = { kind: 'agent', agentId: 'A', credentialId: 'cred-A' };
export const principalB: AgentPrincipal = { kind: 'agent', agentId: 'B', credentialId: 'cred-B' };
export const transferArgs = { idempotencyKey: 'key', receiverId: 'receiver.testnet', amount: '1000000000000000000000001', memo: 'memo' };
export function receipt(agentId = 'A'): ReceiptEvent {
  return {
    chainId: `agent:${agentId}`, seq: 1, prevHash: '0'.repeat(64), hash: '1'.repeat(64),
    signature: Buffer.alloc(64).toString('base64'), type: 'queued', at: 100,
    payload: { requestId: `request-${agentId}`, agentId },
  };
}
export function status(agentId: string): BudgetStatus {
  return {
    agent: { id: agentId, name: agentId, status: 'active', createdAt: 100 }, policy: null, agentFrozen: false,
    usage: { agentRolling24h: 1n, agentLifetime: 2n, agentGas24h: 3n, agentRequestsLastMinute: 4, agentOutstanding: 5 },
    remaining: { perTx: 1000000000000000000000001n, rolling24h: 7n, lifetime: 8n, gas24h: 9n, requestsPerMinute: 10, outstandingSlots: 11 }, at: 100,
  };
}
export function fakes() {
  const revoked = new Set<string>();
  const authenticator: Authenticator = {
    authenticateAgent: vi.fn(async (token: string) => {
      if (revoked.has(token)) throw new BrokerError('UNAUTHENTICATED', 'secret auth detail');
      if (token === TOKEN_A) return { ...principalA };
      if (token === TOKEN_B) return { ...principalB };
      throw new BrokerError('UNAUTHENTICATED', 'secret token');
    }),
    verifyOwnerRequest: vi.fn(async () => { throw new Error('Owner not exposed'); }),
  };
  const requests = new Map<string, TransferView>();
  function create(p: AgentPrincipal, input: TransferInput) {
    const view = TransferViewSchema.parse({
      ...input, id: `request-${p.agentId}`, agentId: p.agentId, requestDigest: requestDigest({ receiverId: input.receiverId, amount: input.amount.toString(), agentId: p.agentId, memo: input.memo ?? null }),
      state: 'queued', reasons: [], policyRevision: 1, approvalRef: null, createdAt: 100, updatedAt: 100,
      expiresAt: null, signedAt: null, submittedAt: null, completedAt: null, txHash: null, gasBurnt: null, tokensBurnt: null, explorerUrl: null,
    });
    requests.set(view.id, view); return view;
  }
  function get(p: AgentPrincipal, id: string) {
    const request = requests.get(id);
    if (!request || request.agentId !== p.agentId) throw new BrokerError('NOT_FOUND', 'secret B request exists');
    return request;
  }
  const broker = {
    requestTransfer: vi.fn(async (p: AgentPrincipal, input: TransferInput) => create(p, input)),
    previewTransfer: vi.fn(async (_p: AgentPrincipal, _input: TransferInput) => ({ decision: { kind: 'allow' as const, reasons: [] as [] }, policyRevision: 1, at: 100 })),
    getRequest: vi.fn(async (p: AgentPrincipal, id: string) => get(p, id)),
    cancelRequest: vi.fn(async (p: AgentPrincipal, id: string) => ({ ...get(p, id), state: 'cancelled' as const })),
    budgetStatus: vi.fn(async (p: AgentPrincipal) => status(p.agentId)),
    listReceipts: vi.fn(async (p: AgentPrincipal, _after: number, _limit: number) => [receipt(p.agentId)]),
    verifyReceipt: vi.fn(async (p: AgentPrincipal, r: ReceiptEvent) => {
      if (r.chainId !== `agent:${p.agentId}`) throw new BrokerError('NOT_FOUND');
      return { valid: true, chainId: r.chainId, checked: 1, firstInvalidSeq: null, reason: null };
    }),
    freezeSelf: vi.fn(async (p: AgentPrincipal, reason: string) => ({ scope: 'agent' as const, agentId: p.agentId, frozen: true, reason, at: 100 })),
  } satisfies AgentBrokerService;
  return { broker, authenticator, revoked, requests };
}
