import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AgentSchema, AgentStatusSchema, AppendReceiptSchema, BroadcastResultSchema,
  BudgetStatusSchema, CheckpointSchema, ConfigSchema, DecimalTextSchema, MAX_U128,
  MCP_AGENT_TOOL_INPUT_SCHEMAS, NearAmountSchema, OUTBOX_STATUSES, RECEIPT_EVENT_TYPES,
  RECEIPT_PAYLOAD_SCHEMAS, ReceiptEventSchema, StandingApprovalWireSchema,
  TransferInputSchema, TransferRequestSchema, TransferViewSchema, TxAttemptSchema, UsageSnapshotSchema,
  YoctoNearSchema, fromDecimalText, formatNear, isAllowedTransition, parseConfig,
  parseNear, toDecimalText, transferExplorerUrl,
} from '../../src/contracts/index.js';
import type {
  AccountingEntry, AgentPrincipal, ApprovalService, ApproveRequestCommand,
  AuditSigner, BroadcastResult, BudgetStatus, Checkpoint, CheckpointLog, Clock,
  NearChain, OwnerBrokerService, OwnerPrincipal, ReceiptLog, StandingApproval,
  StandingApprovalConsumeInput, StandingApprovalMatchInput, StoreReader,
  StoreTransaction, TransferRequest, TransferView, WalletStatus,
} from '../../src/contracts/index.js';

const publicKey = `ed25519:${'1'.repeat(32)}`;
const hash = '1'.repeat(32);
const agent = { id: 'a', name: 'A', status: 'active' as const, createdAt: 1 };
const config = { network: 'testnet', rpcUrl: 'https://rpc.testnet.near.org', accountId: 'broker.testnet',
  dataDir: '/data', auditKeyPath: '/data/audit.key', ownerPublicKey: publicKey, safetyReserve: 0n };
const usage = { agentRolling24h: 0n, agentLifetime: 0n, agentGas24h: 0n,
  agentRequestsLastMinute: 0, agentOutstanding: 0 };
const budget = { agent, policy: null, agentFrozen: false, usage,
  remaining: { perTx: 0n, rolling24h: 0n, lifetime: 0n, gas24h: 0n, requestsPerMinute: 0, outstandingSlots: 0 }, at: 1 };
const request = { id: 'r', agentId: 'a', idempotencyKey: 'once', requestDigest: 'a'.repeat(64),
  receiverId: 'bob.testnet', amount: 1n, state: 'queued' as const, reasons: [], policyRevision: 1,
  approvalRef: null, createdAt: 1, updatedAt: 1, expiresAt: null, signedAt: null, submittedAt: null,
  completedAt: null, txHash: null, gasBurnt: null, tokensBurnt: null };

describe('u128 enforcement at every shared monetary boundary', () => {
  it('accepts maximum u128 and rejects the next yocto everywhere', () => {
    const nearMax = '340282366920938.463463374607431768211455';
    expect(parseNear(nearMax)).toBe(MAX_U128);
    expect(formatNear(MAX_U128)).toBe(nearMax);
    expect(toDecimalText(MAX_U128)).toBe('340282366920938463463374607431768211455');
    expect(fromDecimalText(MAX_U128.toString())).toBe(MAX_U128);
    expect(YoctoNearSchema.parse(MAX_U128)).toBe(MAX_U128);
    expect(DecimalTextSchema.parse(MAX_U128.toString())).toBe(MAX_U128.toString());
    expect(NearAmountSchema.safeParse('340282366920938.463463374607431768211456').success).toBe(false);
    expect(() => parseNear('340282366920938.463463374607431768211456')).toThrow('INVALID_AMOUNT');
    expect(YoctoNearSchema.safeParse(MAX_U128 + 1n).success).toBe(false);
    expect(DecimalTextSchema.safeParse((MAX_U128 + 1n).toString()).success).toBe(false);
    expect(() => fromDecimalText((MAX_U128 + 1n).toString())).toThrow('INVALID_AMOUNT');
    expect(() => toDecimalText(MAX_U128 + 1n)).toThrow('INVALID_AMOUNT');
    expect(() => formatNear(MAX_U128 + 1n)).toThrow('INVALID_AMOUNT');
    const tool = MCP_AGENT_TOOL_INPUT_SCHEMAS.request_transfer;
    expect(tool.safeParse({ idempotencyKey: 'x', receiverId: 'bob.testnet', amount: MAX_U128.toString() }).success).toBe(true);
    expect(tool.safeParse({ idempotencyKey: 'x', receiverId: 'bob.testnet', amount: (MAX_U128 + 1n).toString() }).success).toBe(false);
    expect(TransferInputSchema.safeParse({ idempotencyKey: 'x', receiverId: 'bob.testnet', amount: MAX_U128 + 1n }).success).toBe(false);
  });
  it('bounds attacker input length before BigInt conversion, including million-digit amounts', () => {
    const hostile = '9'.repeat(1_000_000);
    expect(DecimalTextSchema.safeParse(hostile).success).toBe(false);
    expect(NearAmountSchema.safeParse(hostile).success).toBe(false);
    expect(() => fromDecimalText(hostile)).toThrow('INVALID_AMOUNT');
    expect(() => parseNear(hostile)).toThrow('INVALID_AMOUNT');
    expect(MCP_AGENT_TOOL_INPUT_SCHEMAS.request_transfer.safeParse({
      receiverId: 'bob.testnet', idempotencyKey: 'hostile', amount: hostile,
    }).success).toBe(false);
  });
});

describe('exact-testnet config and deployment controls', () => {
  it.each(['mainnet', 'MAINNET', 'Mainnet', 'TESTNET', 'Testnet', ' testnet', 'testnet ', 'localnet', '', null, 1])(
    'rejects any network other than the exact literal: %s', (network) => {
      expect(ConfigSchema.safeParse({ ...config, network }).success).toBe(false);
      try { parseConfig({ ...config, network }); expect.unreachable(); }
      catch (error) { expect(error).toHaveProperty('code', 'MAINNET_REFUSED'); }
    },
  );
  it.each(['https://rpc.mainnet.near.org', 'https://free.rpc.fastnear.com',
    'https://rpc.example.com/mainnet', 'https://rpc.example.com/MAINNET',
    'https://rpc.example.com/%6dainnet', 'https://rpc.example.com/?network=mainnet',
    'ftp://testnet.example', 'not-a-url', 'https://rpc.example.com/%xx'])('wraps RPC refusal in a stable code: %s', (rpcUrl) => {
    expect(ConfigSchema.safeParse({ ...config, rpcUrl }).success).toBe(false);
    expect(() => parseConfig({ ...config, rpcUrl })).toThrow('MAINNET_REFUSED');
    try { parseConfig({ ...config, rpcUrl }); }
    catch (error) { expect(error).toHaveProperty('code', 'MAINNET_REFUSED'); }
  });
  it('accepts unknown RPC aliases only with the runtime chain_id attestation contract', () => {
    expect(parseConfig({ ...config, rpcUrl: 'https://rpc.example.com/test' }).network).toBe('testnet');
    expectTypeOf<ReturnType<NearChain['verifyNetwork']>>().toEqualTypeOf<Promise<'testnet'>>();
  });
  it('freezes secure defaults and supports container-only bind configuration', () => {
    const defaults = parseConfig(config);
    expect(defaults.bindHost).toBe('127.0.0.1');
    expect(defaults.allowedHosts).toEqual(['127.0.0.1', 'localhost']);
    expect(defaults.allowedOrigins).toEqual([]);
    expect(defaults.balanceMaxAgeMs).toBe(10_000);
    expect(defaults.auditKeyPath).toBe('/data/audit.key');
    expect(parseConfig({ ...config, bindHost: '0.0.0.0', allowedOrigins: ['http://localhost:3210'] }).bindHost).toBe('0.0.0.0');
  });
  it.each([
    { bindHost: 'broker.example' }, { allowedHosts: [] }, { allowedHosts: ['*'] },
    { allowedHosts: ['localhost:3210'] }, { allowedHosts: ['localhost.evil/'] },
    { allowedOrigins: ['*'] }, { allowedOrigins: ['null'] }, { allowedOrigins: ['http://localhost/'] },
    { allowedOrigins: ['http://user:pass@localhost'] }, { balanceMaxAgeMs: 0 },
    { balanceMaxAgeMs: 60_001 }, { balanceMaxAgeMs: 1.5 }, { auditKeyPath: '' },
  ])('rejects unsafe/ambiguous controls %#', (override) => {
    expect(ConfigSchema.safeParse({ ...config, ...override }).success).toBe(false);
  });
});

describe('agent-scoped status, freeze and transfer observability', () => {
  it('has only active/revoked agent lifecycle; both freeze flags are required separately', () => {
    expect(AgentStatusSchema.options).toEqual(['active', 'revoked']);
    expect(AgentSchema.safeParse({ ...agent, status: 'frozen' }).success).toBe(false);
    const internal = { ...usage, walletRolling24h: 0n, outstandingHolds: 0n, balance: null,
      standingReserved: {}, agentFrozen: true, globalFrozen: false };
    expect(UsageSnapshotSchema.parse(internal).agentFrozen).toBe(true);
    expect(UsageSnapshotSchema.safeParse({ ...internal, agentFrozen: undefined }).success).toBe(false);
    expect(UsageSnapshotSchema.safeParse({ ...internal, globalFrozen: undefined }).success).toBe(false);
  });
  it('rejects wallet data leakage at BOTH status and own-usage boundaries', () => {
    expect(BudgetStatusSchema.parse(budget)).toEqual(budget);
    for (const [key, value] of Object.entries({ walletPolicy: null, balance: null,
      walletRolling24h: 1n, outstandingHolds: 1n, globalFrozen: true, standingReserved: {} })) {
      expect(BudgetStatusSchema.safeParse({ ...budget, [key]: value }).success).toBe(false);
      expect(BudgetStatusSchema.safeParse({ ...budget, usage: { ...usage, [key]: value } }).success).toBe(false);
    }
    expectTypeOf<ReturnType<OwnerBrokerService['walletStatus']>>().toEqualTypeOf<Promise<WalletStatus>>();
    expectTypeOf<BudgetStatus>().not.toHaveProperty('walletPolicy');
  });
  it('exposes nullable transaction hash, actual gas charges and exact testnet explorer link', () => {
    expect(TransferRequestSchema.parse(request).txHash).toBeNull();
    expect(TransferViewSchema.parse({ ...request, explorerUrl: null }).explorerUrl).toBeNull();
    const submitted = { ...request, txHash: hash, gasBurnt: 10n, tokensBurnt: 20n };
    const explorerUrl = `https://testnet.nearblocks.io/txns/${hash}`;
    expect(transferExplorerUrl(hash)).toBe(explorerUrl);
    expect(TransferViewSchema.parse({ ...submitted, explorerUrl }).tokensBurnt).toBe(20n);
    expect(TransferViewSchema.safeParse({ ...submitted, explorerUrl: null }).success).toBe(false);
    expect(TransferViewSchema.safeParse({ ...request, explorerUrl }).success).toBe(false);
    expect(TransferViewSchema.safeParse({ ...submitted, explorerUrl: `https://nearblocks.io/txns/${hash}` }).success).toBe(false);
    expect(() => transferExplorerUrl('not-a-hash')).toThrow();
  });
  it('pins important cancellation/expiry/ambiguity edges and forbids same-state mutation', () => {
    expect(isAllowedTransition('queued', 'cancelled')).toBe(true);
    expect(isAllowedTransition('pending_approval', 'expired')).toBe(true);
    expect(isAllowedTransition('signed', 'outcome_unknown')).toBe(true);
    expect(isAllowedTransition('signed', 'signed')).toBe(false);
    expect(isAllowedTransition('outcome_unknown', 'queued')).toBe(false);
  });
});

describe('approval/checkpoint/owner integration seams (type-level regression)', () => {
  it('exposes transaction-bound B12 operations and pure match/consume methods', () => {
    expectTypeOf<Parameters<ApprovalService['approve']>>().toEqualTypeOf<[StoreTransaction, ApproveRequestCommand]>();
    expectTypeOf<ReturnType<ApprovalService['approve']>>().toEqualTypeOf<TransferRequest>();
    expectTypeOf<Parameters<ApprovalService['reject']>[0]>().toEqualTypeOf<StoreTransaction>();
    expectTypeOf<Parameters<ApprovalService['grantStandingApproval']>[0]>().toEqualTypeOf<StoreTransaction>();
    expectTypeOf<Parameters<ApprovalService['revokeStandingApproval']>[0]>().toEqualTypeOf<StoreTransaction>();
    expectTypeOf<Parameters<ApprovalService['matchStandingApproval']>>().toEqualTypeOf<[StandingApprovalMatchInput]>();
    expectTypeOf<Parameters<ApprovalService['consumeStandingApproval']>>().toEqualTypeOf<[StandingApprovalConsumeInput]>();
    expectTypeOf<ReturnType<ApprovalService['consumeStandingApproval']>>().toEqualTypeOf<StandingApproval>();
  });
  it('supports B13 creation in the same transaction, durable heads, and trusted verification', () => {
    expectTypeOf<Parameters<CheckpointLog['create']>>().toEqualTypeOf<[StoreTransaction, string, number]>();
    expectTypeOf<ReturnType<CheckpointLog['create']>>().toEqualTypeOf<Checkpoint>();
    expectTypeOf<Parameters<StoreTransaction['insertCheckpoint']>>().toEqualTypeOf<[Checkpoint]>();
    expectTypeOf<ReturnType<StoreReader['getCheckpointHead']>>().toEqualTypeOf<Checkpoint | null>();
    expectTypeOf<ReturnType<AuditSigner['signHash']>>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<ReturnType<ReceiptLog['auditPublicKey']>>().toEqualTypeOf<string>();
    expectTypeOf<ReturnType<StoreReader['getWalletStatus']>>().toEqualTypeOf<WalletStatus>();
    expectTypeOf<ReturnType<Clock['now']>>().toEqualTypeOf<number>();
  });
  it('provides owner reads, permanent revokeAgent and accounting access without trusting agent args', () => {
    for (const operation of ['listAgents', 'getPolicy', 'listStandingApprovals', 'walletStatus',
      'getFreeze', 'getRequest', 'auditPublicKey', 'revokeAgent', 'resolveAttempt'] as const) {
      expectTypeOf<Parameters<OwnerBrokerService[typeof operation]>[0]>().toEqualTypeOf<OwnerPrincipal>();
    }
    expectTypeOf<ReturnType<OwnerBrokerService['getRequest']>>().toEqualTypeOf<Promise<TransferView>>();
    expectTypeOf<OwnerPrincipal>().not.toEqualTypeOf<AgentPrincipal>();
    expectTypeOf<ReturnType<StoreReader['listAccounting']>['items']>().toEqualTypeOf<AccountingEntry[]>();
    expectTypeOf<ReturnType<NearChain['broadcast']>>().toEqualTypeOf<Promise<BroadcastResult>>();
    expect(OUTBOX_STATUSES).toEqual(['signed', 'submitted', 'outcome_unknown']);
  });
});

describe('broadcast and checkpoint validation', () => {
  it('distinguishes acceptance, rejection and ambiguous transport failure, without claiming non-execution', () => {
    for (const result of [
      { kind: 'accepted', txHash: hash },
      { kind: 'rejected', txHash: hash, code: 'INVALID_NONCE', reason: 'nonce rejection' },
      { kind: 'rejected', txHash: hash, code: 'EXPIRED_BLOCK_HASH', reason: 'old block' },
      { kind: 'outcome_unknown', txHash: hash, reason: 'timeout' },
    ]) expect(BroadcastResultSchema.safeParse(result).success).toBe(true);
    expect(BroadcastResultSchema.safeParse({ txHash: hash }).success).toBe(false);
    expect(BroadcastResultSchema.safeParse({ kind: 'not_executed', txHash: hash, evidence: 'timeout' }).success).toBe(false);
    expect(BroadcastResultSchema.safeParse({ kind: 'rejected', txHash: hash, code: 'INVALID_NONCE', reason: 'nonce', retryable: true }).success).toBe(false);
  });
  it('requires persisted positive non-execution evidence before an attempt becomes replaceable', () => {
    const attempt = { id: 't', requestId: 'r', nonce: 1n, publicKey, blockHash: hash,
      signedTxBase64: 'AA==', txHash: hash, status: 'proven_not_executed', receiptIds: [],
      gasBurnt: null, tokensBurnt: null, createdAt: 1, updatedAt: 2, nonExecutionEvidence: null };
    expect(TxAttemptSchema.safeParse(attempt).success).toBe(false);
    expect(TxAttemptSchema.safeParse({ ...attempt, nonExecutionEvidence: '' }).success).toBe(false);
    expect(TxAttemptSchema.safeParse({ ...attempt, nonExecutionEvidence: 'positive adapter evidence' }).success).toBe(true);
    expect(TxAttemptSchema.safeParse({ ...attempt, status: 'signed' }).success).toBe(true);
  });
  it('requires complete signed checkpoint heads (embedded key is not a trust root)', () => {
    const checkpoint = { version: 1, chainId: 'agent:a', seq: 1, headHash: 'a'.repeat(64),
      previousCheckpointHash: null, at: 1, auditPublicKey: publicKey, hash: 'b'.repeat(64), signature: Buffer.alloc(64).toString('base64') };
    expect(CheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(CheckpointSchema.safeParse({ ...checkpoint, seq: 0 }).success).toBe(false);
    expect(CheckpointSchema.safeParse({ ...checkpoint, previousCheckpointHash: undefined }).success).toBe(false);
    expect(CheckpointSchema.safeParse({ ...checkpoint, signature: 'invalid' }).success).toBe(false);
  });
});

const decision = { requestId: 'r', agentId: 'a', receiverId: 'bob.testnet', amount: '1',
  requestDigest: 'a'.repeat(64), policyRevision: 1, approvalRef: null };
const settlement = { requestId: 'r', agentId: 'a', txHash: hash, receiptIds: [hash], gasBurnt: '1', tokensBurnt: '1' };
const approval = { id: 's', agentId: 'a', perTxMax: '1', totalMax: '10', usedTotal: '2', expiresAt: 10 };
const payloads = {
  decision_allowed: { ...decision, reasons: [] }, decision_denied: { ...decision, reasons: ['NO_POLICY'] },
  approval_required: { ...decision, reasons: ['APPROVAL_REQUIRED'] },
  approved: { requestId: 'r', agentId: 'a', approvalId: 'p', requestDigest: 'a'.repeat(64), policyRevision: 1, expiresAt: 10 },
  rejected: { requestId: 'r', agentId: 'a', reason: 'owner denied' },
  expired: { requestId: 'r', agentId: 'a', reason: 'approval expired' },
  cancelled: { requestId: 'r', agentId: 'a', reason: 'agent cancelled' },
  standing_approval_granted: { agentId: 'a', approval },
  standing_approval_revoked: { agentId: 'a', approvalId: 's', revokedAt: 3 },
  standing_approval_used: { requestId: 'r', agentId: 'a', approvalId: 's', amount: '1' },
  queued: { requestId: 'r', agentId: 'a' },
  submitted: { requestId: 'r', agentId: 'a', attemptId: 't', txHash: hash, phase: 'intent' },
  succeeded: settlement, failed: { ...settlement, reason: 'execution failed' },
  outcome_unknown: { requestId: 'r', agentId: 'a', attemptId: 't', txHash: hash, reason: 'timeout' },
  freeze: { scope: 'agent', agentId: 'a', frozen: true, at: 1, reason: 'stop' },
  unfreeze: { scope: 'agent', agentId: 'a', frozen: false, at: 2, reason: 'resume' },
  policy_updated: { scope: 'wallet', policy: { revision: 1, rolling24hMax: '0', safetyReserve: '0' } },
  agent_created: { agent }, agent_revoked: { agentId: 'a', reason: 'owner revoked' },
  credential_issued: { agentId: 'a', credentialId: 'c' }, credential_revoked: { agentId: 'a', credentialId: 'c' },
} satisfies Record<typeof RECEIPT_EVENT_TYPES[number], unknown>;

describe('complete correlated receipt vocabulary', () => {
  it.each(RECEIPT_EVENT_TYPES)('validates exact payload for %s, rejects missing/arbitrary/secret fields', (type) => {
    const base = { chainId: 'owner', type, at: 1, payload: payloads[type] };
    expect(AppendReceiptSchema.safeParse(base).success).toBe(true);
    expect(AppendReceiptSchema.safeParse({ ...base, payload: {} }).success).toBe(false);
    expect(AppendReceiptSchema.safeParse({ ...base, payload: { ...payloads[type], token: 'secret' } }).success).toBe(false);
    expect(ReceiptEventSchema.safeParse({ ...base, seq: 1, prevHash: '0'.repeat(64), hash: 'a'.repeat(64),
      signature: Buffer.alloc(64).toString('base64') }).success).toBe(true);
  });
  it('rejects wallet/global and mismatched identity events on agent chains', () => {
    const scoped = { chainId: 'agent:a', at: 1 };
    expect(AppendReceiptSchema.safeParse({ ...scoped, type: 'policy_updated', payload: payloads.policy_updated }).success).toBe(false);
    expect(AppendReceiptSchema.safeParse({ ...scoped, type: 'freeze', payload: { scope: 'global', frozen: true, at: 1, reason: 'stop' } }).success).toBe(false);
    expect(AppendReceiptSchema.safeParse({ ...scoped, type: 'queued', payload: { requestId: 'r', agentId: 'other' } }).success).toBe(false);
    expect(AppendReceiptSchema.safeParse({ ...scoped, type: 'agent_created', payload: { agent: { ...agent, id: 'other' } } }).success).toBe(false);
    expect(AppendReceiptSchema.safeParse({ ...scoped, type: 'standing_approval_granted', payload: { agentId: 'a', approval: { ...approval, agentId: 'other' } } }).success).toBe(false);
  });
  it('supports explicit, backward-compatible zero-execution resolution receipts', () => {
    const base = { chainId: 'agent:a', at: 1, type: 'failed', payload: { ...settlement, receiptIds: [], gasBurnt: '0', tokensBurnt: '0', reason: 'Owner investigated',
      resolution: { attemptId: 't', basis: 'owner_attested', evidence: 'Owner attests no execution' } } };
    expect(AppendReceiptSchema.safeParse(base).success).toBe(true);
    expect(AppendReceiptSchema.safeParse({ ...base, chainId: 'owner' }).success).toBe(true);
    for (const resolution of [{}, { ...base.payload.resolution, basis: 'timeout' }, { ...base.payload.resolution, evidence: '' }]) {
      expect(AppendReceiptSchema.safeParse({ ...base, payload: { ...base.payload, resolution } }).success).toBe(false);
    }
    expect(AppendReceiptSchema.safeParse({ ...base, payload: { ...base.payload, reason: '' } }).success).toBe(false);
    expect(AppendReceiptSchema.safeParse({ ...base, payload: { ...base.payload, tokensBurnt: '1' } }).success).toBe(false);
    expectTypeOf<Parameters<OwnerBrokerService['resolveAttempt']>>().toEqualTypeOf<[OwnerPrincipal, string, string]>();
    expectTypeOf<ReturnType<OwnerBrokerService['resolveAttempt']>>().toEqualTypeOf<Promise<TransferRequest>>();
  });
  it('has schemas for exactly every event and pins submitted phase and approval amounts', () => {
    expect(Object.keys(RECEIPT_PAYLOAD_SCHEMAS)).toEqual([...RECEIPT_EVENT_TYPES]);
    expect(RECEIPT_PAYLOAD_SCHEMAS.submitted.safeParse({ ...payloads.submitted, phase: undefined }).success).toBe(false);
    expect(RECEIPT_PAYLOAD_SCHEMAS.submitted.safeParse({ ...payloads.submitted, phase: 'acknowledged' }).success).toBe(true);
    expect(StandingApprovalWireSchema.safeParse({ ...approval, usedTotal: '11' }).success).toBe(false);
    expect(StandingApprovalWireSchema.safeParse({ ...approval, usedTotal: 2n }).success).toBe(false);
    expect(StandingApprovalWireSchema.safeParse({ ...approval, usedTotal: 'bad' }).success).toBe(false);
    const event = ReceiptEventSchema.parse({ chainId: 'agent:a', seq: 1, prevHash: '0'.repeat(64), type: 'submitted',
      at: 1, payload: payloads.submitted, hash: 'a'.repeat(64), signature: Buffer.alloc(64).toString('base64') });
    if (event.type === 'submitted') expectTypeOf(event.payload.phase).toEqualTypeOf<'intent' | 'acknowledged'>();
  });
});
