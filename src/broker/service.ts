import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  AgentSchema, AgentPrincipalSchema, AgentPolicySchema, AgentPolicyWireSchema,
  AppendReceiptSchema, BrokerError, BudgetStatusSchema, OwnerPrincipalSchema,
  TransferInputSchema, WalletPolicySchema, WalletPolicyWireSchema, AccountBalanceSchema,
  requestDigest, toDecimalText, transferExplorerUrl,
} from '../contracts/index.js';
import type {
  AccountingEntry, Agent, AgentPrincipal, AgentPolicy, ApprovalService, AppendReceipt,
  BrokerService as BrokerPort, ChainId, CheckpointLog, Clock, Config, CustodySigner,
  Freeze, FreezeTarget, NearChain, OwnerPrincipal, Page, PageQuery, PolicyDecision,
  PolicyEvaluationInput, ReceiptEvent, ReceiptLog, RequestFilter, StandingApprovalGrant,
  Store, StoreReader, StoreTransaction, TransferInput, TransferRequest, TransferView,
  TxAttempt, ChainOutcome,
} from '../contracts/index.js';
import { issueAgentToken, revokeAgentToken, rotateAgentToken } from '../auth/index.js';
import {
  expirePending, listStandingApprovals, reserveStandingApproval,
} from '../approvals/index.js';
import { PurePolicyEvaluator } from '../policy/index.js';
import { custodyLane, custodyPump } from './lane.js';

export interface BrokerOptions {
  store: Store;
  chain: NearChain;
  signer: CustodySigner;
  receipts: ReceiptLog;
  approvals: ApprovalService;
  checkpoints: CheckpointLog;
  clock: Clock;
  config: Pick<Config, 'accountId' | 'balanceMaxAgeMs' | 'feeReservePerTx'>;
  /** Disable for a daemon that schedules drain() itself. No timers are owned here. */
  autoDispatch?: boolean;
  pendingApprovalTtlMs?: number;
  /** Scheduling/crash injection seams. Never passed to network or SQL callbacks. */
  hooks?: {
    beforeDispatch?: () => Promise<void>;
    afterPersistSigned?: (attempt: TxAttempt) => Promise<void>;
    afterBroadcast?: (attempt: TxAttempt) => Promise<void>;
  };
}
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const monetary = new Set(['amount', 'perTxMax', 'rolling24hMax', 'lifetimeMax', 'gasBudget24h', 'approvalThreshold', 'safetyReserve', 'totalMax']);
    throw new BrokerError(result.error.issues.some((i) => i.path.some((part) => monetary.has(String(part)))) ? 'INVALID_AMOUNT' : 'FORBIDDEN');
  }
  return result.data;
}
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new BrokerError('NOT_FOUND');
  return value;
}
function view(request: TransferRequest): TransferView {
  return { ...request, explorerUrl: transferExplorerUrl(request.txHash) };
}
function pages<T>(fetch: (query: PageQuery) => Page<T>): T[] {
  const items: T[] = [];
  let after: string | undefined;
  for (;;) {
    const page = fetch({ limit: 1000, ...(after === undefined ? {} : { after }) });
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (page.nextCursor === after || page.items.length === 0) throw new BrokerError('BROKER_UNAVAILABLE');
    after = page.nextCursor;
  }
}
const preSigning = ['pending_approval', 'approved', 'queued'] as const;

/** Principals are capabilities supplied by B03/transport, NOT JSON authentication.
 * Agent credentials are rechecked on every operation, including idempotent reads.
 */
export class BrokerService implements BrokerPort {
  private readonly evaluator: PurePolicyEvaluator;
  private readonly lane: ReturnType<typeof custodyLane>;
  private readonly pump: ReturnType<typeof custodyPump>;
  private readonly receipts: ReceiptLog;
  private readonly ttl: number;
  constructor(private readonly o: BrokerOptions) {
    this.lane = custodyLane(o.config.accountId, o.signer.publicKey);
    this.pump = custodyPump(o.config.accountId, o.signer.publicKey);
    this.evaluator = new PurePolicyEvaluator({ balanceMaxAgeMs: o.config.balanceMaxAgeMs,
      matchStandingApproval: o.approvals.matchStandingApproval.bind(o.approvals) });
    this.ttl = o.pendingApprovalTtlMs ?? 300_000;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1) throw new BrokerError('FORBIDDEN');
    // Even a custom/fault-injected ReceiptLog must produce the stable failure code.
    this.receipts = {
      auditPublicKey: () => o.receipts.auditPublicKey(),
      append: (tx, event) => {
        try { return o.receipts.append(tx, event); }
        catch { throw new BrokerError('AUDIT_UNAVAILABLE'); }
      },
      list: (...args) => o.receipts.list(...args),
      verify: (...args) => o.receipts.verify(...args),
      verifyReceipt: (...args) => o.receipts.verifyReceipt(...args),
    };
  }
  private agent(r: StoreReader, principal: AgentPrincipal): Agent {
    validate(AgentPrincipalSchema, principal);
    const credential = r.getCredential(principal.credentialId);
    if (!credential || credential.agentId !== principal.agentId || credential.revokedAt !== null) throw new BrokerError('UNAUTHENTICATED');
    const agent = r.getAgent(principal.agentId);
    if (!agent || agent.status !== 'active') throw new BrokerError('FORBIDDEN');
    return agent;
  }
  private owner(principal: OwnerPrincipal): void { validate(OwnerPrincipalSchema, principal); }
  private append(tx: StoreTransaction, event: AppendReceipt, both = false): void {
    const parsed = validate(AppendReceiptSchema, event);
    this.receipts.append(tx, parsed);
    if (both && parsed.chainId !== 'owner') this.receipts.append(tx, { ...parsed, chainId: 'owner' });
  }
  private event(tx: StoreTransaction, event: Omit<AppendReceipt, 'chainId' | 'at'>, agentId: string, both = false): void {
    this.append(tx, { ...event, chainId: `agent:${agentId}`, at: this.o.clock.now() } as AppendReceipt, both);
  }
  private accounting(tx: StoreTransaction, request: TransferRequest, kind: AccountingEntry['kind'], amount: bigint): void {
    tx.appendAccounting({ id: randomUUID(), requestId: request.id, agentId: request.agentId,
      kind, amount, at: this.o.clock.now() });
  }
  private evaluation(r: StoreReader, request: Pick<TransferRequest, 'agentId' | 'receiverId' | 'amount' | 'requestDigest'>,
    requestId: string | null): PolicyEvaluationInput {
    const now = this.o.clock.now();
    return { agent: must(r.getAgent(request.agentId)), agentPolicy: r.getPolicy(request.agentId),
      walletPolicy: r.getWalletPolicy(), usage: r.getUsageSnapshot(request.agentId, now, requestId ?? undefined),
      request: { agentId: request.agentId, receiverId: request.receiverId, amount: request.amount,
        feeReserve: (requestId === null ? null : r.getHold(requestId))?.feeReserve ?? this.o.config.feeReservePerTx },
      requestId, requestDigest: request.requestDigest, standingApprovals: listStandingApprovals(r, request.agentId)
        .filter((a) => {
          const ref = requestId === null ? null : r.getRequest(requestId)?.approvalRef;
          return ref?.kind !== 'standing' || a.id === ref.id;
        }),
      requestApproval: requestId === null ? null : r.getRequestApproval(requestId), now };
  }
  private boundDecision(r: StoreReader, e: PolicyEvaluationInput): PolicyDecision {
    const decision = this.evaluator.evaluate(e);
    if (decision.kind === 'deny' || decision.kind === 'needs_approval' || e.requestId === null) return decision;
    const ref = r.getRequest(e.requestId)?.approvalRef;
    if (ref?.kind === 'standing') {
      const grant = e.standingApprovals.find((a) => a.id === ref.id);
      const reservedTotal = Object.hasOwn(e.usage.standingReserved, ref.id) ? e.usage.standingReserved[ref.id]! : 0n;
      if (!grant || this.o.approvals.matchStandingApproval({ approval: grant, agentId: e.agent.id,
        receiverId: e.request.receiverId, amount: e.request.amount, reservedTotal, now: e.now }).kind !== 'match') {
        return { kind: 'needs_approval', reasons: ['APPROVAL_REQUIRED'] };
      }
    }
    return decision;
  }
  private digest(agentId: string, input: TransferInput): string {
    return requestDigest({ agentId, receiverId: input.receiverId, amount: toDecimalText(input.amount), memo: input.memo ?? null });
  }
  private stale(r: StoreReader): boolean {
    const now = this.o.clock.now(); const s = r.getWalletStatus(now);
    return s.balance === null || s.balanceValidUntil === null || s.balance.observedAt > now
      || now > s.balanceValidUntil || now - s.balance.observedAt > this.o.config.balanceMaxAgeMs;
  }
  private async attest(): Promise<void> {
    try {
      if (await this.o.chain.verifyNetwork() !== 'testnet') throw new Error();
    } catch { throw new BrokerError('MAINNET_REFUSED'); }
  }
  private async chainCall<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (e) { if (e instanceof BrokerError) throw e; throw new BrokerError('BROKER_UNAVAILABLE'); }
  }
  /** RPC outside SQL; serialize refresh against settlement so an in-flight stale
   * view cannot overwrite the conservative post-settlement balance debit. */
  private async refreshLocked(): Promise<void> {
    if (!this.o.store.read((r) => this.stale(r))) return;
    try {
      await this.attest();
      const balance = await this.o.chain.viewAccount(this.o.config.accountId);
      const now = this.o.clock.now();
      if (balance.accountId !== this.o.config.accountId || balance.observedAt > now
        || now - balance.observedAt > this.o.config.balanceMaxAgeMs) return;
      this.o.store.withImmediateTransaction((tx) => tx.putBalance(balance, balance.observedAt + this.o.config.balanceMaxAgeMs));
    } catch (e) {
      if (e instanceof BrokerError && e.code === 'MAINNET_REFUSED') throw e;
      // The stale/unknown snapshot remains stale; evaluator denies WALLET_CAPACITY.
    }
  }
  async requestTransfer(principal: AgentPrincipal, raw: TransferInput): Promise<TransferView> {
    this.o.store.read((r) => this.agent(r, principal));
    const input = validate(TransferInputSchema, raw);
    const digest = this.digest(principal.agentId, input);
    // Resolve replays before RPC, but re-check inside the admission transaction.
    const replay = this.o.store.read((r) => r.findRequestByIdempotency(principal.agentId, input.idempotencyKey));
    if (replay) {
      if (replay.requestDigest !== digest) throw new BrokerError('IDEMPOTENCY_CONFLICT');
      return view(replay);
    }
    if (this.o.store.read((r) => this.stale(r))) await this.lane.run(() => this.refreshLocked());
    const request = this.o.store.withImmediateTransaction((tx) => {
      this.agent(tx, principal);
      const existing = tx.findRequestByIdempotency(principal.agentId, input.idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== digest) throw new BrokerError('IDEMPOTENCY_CONFLICT');
        return existing;
      }
      const evaluation = this.evaluation(tx, { ...input, agentId: principal.agentId, requestDigest: digest }, null);
      const decision = this.evaluator.evaluate(evaluation);
      const now = evaluation.now;
      const request: TransferRequest = { ...input, id: randomUUID(), agentId: principal.agentId,
        requestDigest: digest, state: decision.kind === 'deny' ? 'denied' : decision.kind === 'needs_approval' ? 'pending_approval' : 'queued',
        reasons: decision.reasons, policyRevision: evaluation.agentPolicy?.revision ?? null, approvalRef: null,
        createdAt: now, updatedAt: now, expiresAt: now + this.ttl, signedAt: null, submittedAt: null,
        completedAt: decision.kind === 'deny' ? now : null, txHash: null, gasBurnt: null, tokensBurnt: null };
      if (decision.kind === 'allow_via_standing_approval') request.approvalRef = reserveStandingApproval(tx, request, decision.standingApprovalId, now);
      tx.insertRequest(request);
      if (decision.kind !== 'deny') {
        tx.putHold({ requestId: request.id, agentId: request.agentId, principal: request.amount, feeReserve: this.o.config.feeReservePerTx, status: 'active' });
        this.accounting(tx, request, 'principal_reserved', request.amount);
        this.accounting(tx, request, 'fee_reserved', this.o.config.feeReservePerTx);
      }
      this.decisionReceipt(tx, request, decision);
      if (request.state === 'queued') this.event(tx, { type: 'queued', payload: { requestId: request.id, agentId: request.agentId } }, request.agentId);
      return request;
    });
    if (this.o.autoDispatch !== false && request.state === 'queued') await this.drain();
    return view(this.o.store.read((r) => must(r.getRequest(request.id))));
  }
  async previewTransfer(principal: AgentPrincipal, raw: TransferInput) {
    this.o.store.read((r) => this.agent(r, principal));
    const input = validate(TransferInputSchema, raw);
    // Ephemeral RPC view only: preview must not mutate even the balance row.
    let fresh: PolicyEvaluationInput['usage']['balance'] = null;
    if (this.o.store.read((r) => this.stale(r))) {
      try {
        await this.attest();
        const b = validate(AccountBalanceSchema, await this.o.chain.viewAccount(this.o.config.accountId));
        const now = this.o.clock.now();
        if (b.accountId === this.o.config.accountId && b.observedAt <= now && now - b.observedAt <= this.o.config.balanceMaxAgeMs)
          fresh = { spendable: b.spendable, observedAt: b.observedAt, validUntil: b.observedAt + this.o.config.balanceMaxAgeMs };
      } catch (e) { if (e instanceof BrokerError && e.code === 'MAINNET_REFUSED') throw e; }
    }
    return this.o.store.read((r) => {
      this.agent(r, principal);
      const e = this.evaluation(r, { ...input, agentId: principal.agentId, requestDigest: this.digest(principal.agentId, input) }, null);
      if (fresh) e.usage.balance = fresh;
      return { decision: this.evaluator.evaluate(e), policyRevision: e.agentPolicy?.revision ?? null, at: e.now };
    });
  }
  async getRequest(principal: AgentPrincipal | OwnerPrincipal, requestId: string): Promise<TransferView> {
    return this.o.store.read((r) => {
      if (principal.kind === 'agent') this.agent(r, principal); else this.owner(principal);
      const request = r.getRequest(requestId);
      if (!request || (principal.kind === 'agent' && request.agentId !== principal.agentId)) throw new BrokerError('NOT_FOUND');
      return view(request);
    });
  }
  async cancelRequest(principal: AgentPrincipal, requestId: string): Promise<TransferView> {
    return this.o.store.withImmediateTransaction((tx) => {
      this.agent(tx, principal);
      const request = tx.getRequest(requestId);
      if (!request || request.agentId !== principal.agentId) throw new BrokerError('NOT_FOUND');
      if (!(preSigning as readonly string[]).includes(request.state)) throw new BrokerError('FORBIDDEN');
      const next = this.finishUnsent(tx, request, 'cancelled', 'Cancelled by agent');
      return view(next);
    });
  }
  async budgetStatus(principal: AgentPrincipal) {
    return this.o.store.read((r) => {
      const agent = this.agent(r, principal); const policy = r.getPolicy(agent.id); const at = this.o.clock.now();
      const u = r.getUsageSnapshot(agent.id, at);
      const usage = { agentRolling24h: u.agentRolling24h, agentLifetime: u.agentLifetime,
        agentGas24h: u.agentGas24h, agentRequestsLastMinute: u.agentRequestsLastMinute, agentOutstanding: u.agentOutstanding };
      const effective = policy !== null && !u.agentFrozen && (policy.expiresAt === undefined || at < policy.expiresAt);
      const sub = (a: bigint, b: bigint) => a > b ? a - b : 0n;
      return BudgetStatusSchema.parse({ agent, policy, agentFrozen: u.agentFrozen, usage, at,
        remaining: effective ? { perTx: policy.perTxMax, rolling24h: sub(policy.rolling24hMax, u.agentRolling24h),
          lifetime: sub(policy.lifetimeMax, u.agentLifetime), gas24h: sub(policy.gasBudget24h, u.agentGas24h),
          requestsPerMinute: Math.max(0, policy.ratePerMinute - u.agentRequestsLastMinute), outstandingSlots: Math.max(0, policy.maxOutstanding - u.agentOutstanding) }
          : { perTx: 0n, rolling24h: 0n, lifetime: 0n, gas24h: 0n, requestsPerMinute: 0, outstandingSlots: 0 } });
    });
  }
  async listReceipts(principal: AgentPrincipal, afterSeq: number, limit: number) {
    this.o.store.read((r) => this.agent(r, principal));
    return this.receipts.list(`agent:${principal.agentId}`, afterSeq, limit);
  }
  async verifyReceipt(principal: AgentPrincipal, receipt: ReceiptEvent) {
    this.o.store.read((r) => this.agent(r, principal));
    if (receipt.chainId !== `agent:${principal.agentId}`) throw new BrokerError('FORBIDDEN');
    return this.receipts.verifyReceipt(receipt);
  }
  async freezeSelf(principal: AgentPrincipal, reason: string): Promise<Freeze> {
    return this.lane.run(async () => this.o.store.withImmediateTransaction((tx) => {
      this.agent(tx, principal);
      return this.writeFreeze(tx, { scope: 'agent', agentId: principal.agentId }, true, reason);
    }));
  }
  async createAgent(principal: OwnerPrincipal, name: string) {
    this.owner(principal);
    return this.o.store.withImmediateTransaction((tx) => {
      const agent = validate(AgentSchema, { id: randomUUID(), name, status: 'active', createdAt: this.o.clock.now() });
      tx.putAgent(agent);
      this.event(tx, { type: 'agent_created', payload: { agent } }, agent.id, true);
      return agent;
    });
  }
  async revokeAgent(principal: OwnerPrincipal, agentId: string, reason: string) {
    this.owner(principal);
    return this.lane.run(async () => this.o.store.withImmediateTransaction((tx) => {
      const agent = { ...must(tx.getAgent(agentId)), status: 'revoked' as const };
      tx.putAgent(agent);
      const credentials = pages((q) => tx.listCredentials(agentId, q));
      tx.revokeAgentCredentials(agentId, this.o.clock.now());
      this.event(tx, { type: 'agent_revoked', payload: { agentId, reason } }, agentId, true);
      for (const c of credentials) if (c.revokedAt === null) this.credentialEvent(tx, 'credential_revoked', agentId, c.id);
      return agent;
    }));
  }
  async listAgents(p: OwnerPrincipal, q: PageQuery) { this.owner(p); return this.o.store.read((r) => r.listAgents(q)); }
  async getPolicy(p: OwnerPrincipal, id: string) { this.owner(p); return this.o.store.read((r) => r.getPolicy(id)); }
  async listStandingApprovals(p: OwnerPrincipal, id: string, q: PageQuery) { this.owner(p); return this.o.store.read((r) => r.listStandingApprovals(id, q)); }
  async walletStatus(p: OwnerPrincipal) { this.owner(p); return this.o.store.read((r) => r.getWalletStatus(this.o.clock.now())); }
  async getFreeze(p: OwnerPrincipal, target: FreezeTarget) { this.owner(p); return this.o.store.read((r) => r.getFreeze(target.scope, target.scope === 'agent' ? target.agentId : undefined)); }
  async auditPublicKey(p: OwnerPrincipal) { this.owner(p); return this.receipts.auditPublicKey(); }
  private credentialEvent(tx: StoreTransaction, type: 'credential_issued' | 'credential_revoked', agentId: string, credentialId: string) {
    this.event(tx, { type, payload: { agentId, credentialId } }, agentId, true);
  }
  async issueToken(p: OwnerPrincipal, agentId: string) {
    this.owner(p);
    return this.o.store.withImmediateTransaction((tx) => {
      const issued = issueAgentToken(tx, agentId, this.o.clock.now());
      this.credentialEvent(tx, 'credential_issued', agentId, issued.credential.id);
      return issued;
    });
  }
  async rotateToken(p: OwnerPrincipal, credentialId: string) {
    this.owner(p);
    return this.o.store.withImmediateTransaction((tx) => {
      const issued = rotateAgentToken(tx, credentialId, this.o.clock.now());
      this.credentialEvent(tx, 'credential_revoked', issued.credential.agentId, credentialId);
      this.credentialEvent(tx, 'credential_issued', issued.credential.agentId, issued.credential.id);
      return issued;
    });
  }
  async revokeToken(p: OwnerPrincipal, credentialId: string) {
    this.owner(p);
    this.o.store.withImmediateTransaction((tx) => {
      const c = must(tx.getCredential(credentialId));
      revokeAgentToken(tx, credentialId, this.o.clock.now());
      this.credentialEvent(tx, 'credential_revoked', c.agentId, credentialId);
    });
  }
  async setPolicy(p: OwnerPrincipal, raw: AgentPolicy, revision: number | null) {
    this.owner(p); const policy = validate(AgentPolicySchema, raw);
    return this.lane.run(async () => this.o.store.withImmediateTransaction((tx) => {
      tx.putPolicy(policy, revision);
      const wire = AgentPolicyWireSchema.parse({ ...policy, perTxMax: toDecimalText(policy.perTxMax), rolling24hMax: toDecimalText(policy.rolling24hMax),
        lifetimeMax: toDecimalText(policy.lifetimeMax), gasBudget24h: toDecimalText(policy.gasBudget24h), approvalThreshold: policy.approvalThreshold === null ? null : toDecimalText(policy.approvalThreshold) });
      this.event(tx, { type: 'policy_updated', payload: { scope: 'agent', policy: wire } }, policy.agentId, true);
      return policy;
    }));
  }
  async setWalletPolicy(p: OwnerPrincipal, raw: Parameters<BrokerPort['setWalletPolicy']>[1], revision: number | null) {
    this.owner(p); const policy = validate(WalletPolicySchema, raw);
    return this.lane.run(async () => this.o.store.withImmediateTransaction((tx) => {
      tx.putWalletPolicy(policy, revision);
      this.append(tx, { chainId: 'owner', type: 'policy_updated', at: this.o.clock.now(), payload: { scope: 'wallet', policy: WalletPolicyWireSchema.parse({ ...policy,
        rolling24hMax: toDecimalText(policy.rolling24hMax), safetyReserve: toDecimalText(policy.safetyReserve) }) } });
      return policy;
    }));
  }
  async approve(p: OwnerPrincipal, requestId: string, expiresAt: number) {
    this.owner(p);
    const request = await this.lane.run(async () => {
      await this.refreshLocked();
      return this.o.store.withImmediateTransaction((tx) => {
        const request = must(tx.getRequest(requestId));
        const decision = this.evaluator.evaluate(this.evaluation(tx, request, request.id));
        if (decision.kind === 'deny') throw new BrokerError(decision.reasons[0]!);
        if (tx.getPolicy(request.agentId)?.revision !== request.policyRevision) throw new BrokerError('POLICY_CHANGED');
        const approved = this.auditCall(() => this.o.approvals.approve(tx, { requestId, approvalId: randomUUID(), expiresAt, now: this.o.clock.now() }));
        if (approved.state !== 'approved') return approved;
        const queued: TransferRequest = { ...approved, state: 'queued', updatedAt: this.o.clock.now() };
        tx.updateRequest(queued, 'approved');
        this.event(tx, { type: 'queued', payload: { requestId, agentId: request.agentId } }, request.agentId);
        return queued;
      });
    });
    if (this.o.autoDispatch !== false && request.state === 'queued') await this.drain();
    return this.o.store.read((r) => must(r.getRequest(requestId)));
  }
  /** B12 uses its own injected ReceiptLog. Preserve stable audit failures even
   * when tests inject a raw throwing signer/log into that component. */
  private auditCall<T>(fn: () => T): T {
    try { return fn(); } catch (e) { if (e instanceof BrokerError) throw e; throw new BrokerError('AUDIT_UNAVAILABLE'); }
  }
  async reject(p: OwnerPrincipal, requestId: string, reason: string) {
    this.owner(p);
    return this.o.store.withImmediateTransaction((tx) => this.auditCall(() => this.o.approvals.reject(tx, { requestId, reason, now: this.o.clock.now() })));
  }
  async grantStandingApproval(p: OwnerPrincipal, grant: StandingApprovalGrant) {
    this.owner(p);
    return this.o.store.withImmediateTransaction((tx) => this.auditCall(() => this.o.approvals.grantStandingApproval(tx, { ...grant, id: randomUUID(), now: this.o.clock.now() })));
  }
  async revokeStandingApproval(p: OwnerPrincipal, approvalId: string) {
    this.owner(p);
    return this.lane.run(async () => this.o.store.withImmediateTransaction((tx) => this.auditCall(() => this.o.approvals.revokeStandingApproval(tx, { approvalId, now: this.o.clock.now() }))));
  }
  private writeFreeze(tx: StoreTransaction, target: FreezeTarget, frozen: boolean, reason: string): Freeze {
    const freeze: Freeze = { ...target, frozen, reason, at: this.o.clock.now() };
    tx.putFreeze(freeze);
    this.append(tx, { chainId: target.scope === 'global' ? 'owner' : `agent:${target.agentId}`, type: frozen ? 'freeze' : 'unfreeze', at: freeze.at, payload: freeze }, target.scope === 'agent');
    return freeze;
  }
  async freeze(p: OwnerPrincipal, target: FreezeTarget, reason: string) {
    this.owner(p);
    return this.lane.run(async () => this.o.store.withImmediateTransaction((tx) => this.writeFreeze(tx, target, true, reason)));
  }
  async unfreeze(p: OwnerPrincipal, target: FreezeTarget, reason: string) {
    this.owner(p);
    return this.lane.run(async () => this.o.store.withImmediateTransaction((tx) => this.writeFreeze(tx, target, false, reason)));
  }
  async exportReceipts(p: OwnerPrincipal, chainId: ChainId, afterSeq: number, limit: number) {
    this.owner(p);
    return this.o.store.withImmediateTransaction((tx) => {
      const events = tx.listReceipts(chainId, afterSeq, limit);
      const head = tx.getReceiptHead(chainId);
      if (head && head.seq > (tx.getCheckpointHead(chainId)?.seq ?? 0)) {
        this.auditCall(() => this.o.checkpoints.create(tx, chainId, this.o.clock.now()));
      }
      return events;
    });
  }
  async listRequests(p: OwnerPrincipal, filter: RequestFilter, q: PageQuery) { this.owner(p); return this.o.store.read((r) => r.listRequests(filter, q)); }
  private decisionReceipt(tx: StoreTransaction, request: TransferRequest, decision: PolicyDecision): void {
    this.event(tx, { type: decision.kind === 'deny' ? 'decision_denied' : decision.kind === 'needs_approval' ? 'approval_required' : 'decision_allowed',
      payload: { requestId: request.id, agentId: request.agentId, receiverId: request.receiverId,
        amount: toDecimalText(request.amount), requestDigest: request.requestDigest,
        policyRevision: request.policyRevision, approvalRef: request.approvalRef, reasons: decision.reasons } } as Omit<AppendReceipt, 'chainId' | 'at'>, request.agentId);
  }
  private release(tx: StoreTransaction, request: TransferRequest): void {
    const hold = must(tx.getHold(request.id));
    if (hold.status !== 'active') throw new BrokerError('FORBIDDEN');
    tx.putHold({ ...hold, status: 'released' });
    this.accounting(tx, request, 'principal_released', hold.principal);
    this.accounting(tx, request, 'fee_released', hold.feeReserve);
  }
  private finishUnsent(tx: StoreTransaction, request: TransferRequest, state: 'denied' | 'cancelled' | 'expired', reason: string, decision?: PolicyDecision): TransferRequest {
    const next: TransferRequest = { ...request, state, updatedAt: this.o.clock.now(), completedAt: this.o.clock.now(), reasons: decision?.reasons ?? request.reasons };
    tx.updateRequest(next, request.state);
    this.release(tx, next);
    if (decision) this.decisionReceipt(tx, next, decision);
    else this.event(tx, { type: state as 'cancelled' | 'expired', payload: { requestId: request.id, agentId: request.agentId, reason } }, request.agentId);
    return next;
  }
  /** Call at startup before serving requests; also safe to call after a crash.
   * No background task survives this promise; daemon owns scheduling/shutdown. */
  async start(): Promise<void> { await this.drain(); }
  async expirePending(): Promise<void> {
    this.o.store.withImmediateTransaction((tx) => {
      const requests = pages((q) => tx.listRequests({ states: ['pending_approval'] }, q));
      for (const request of requests) {
        // A backwards wall-clock step cannot expire a newer reservation.
        if (this.o.clock.now() >= request.updatedAt) expirePending(tx, request.id, this.o.clock.now(), this.receipts);
      }
    });
  }
  async reconcile(p: OwnerPrincipal, requestId?: string) {
    this.owner(p);
    if (requestId !== undefined) this.o.store.read((r) => must(r.getRequest(requestId)));
    return { requests: await this.run(false, requestId), at: this.o.clock.now() };
  }
  async resolveAttempt(p: OwnerPrincipal, requestId: string, reason: string): Promise<TransferRequest> {
    this.owner(p);
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 1024 || !reason.isWellFormed()) throw new BrokerError('FORBIDDEN');
    // Pump excludes concurrent reconciliation; lane excludes dispatch and owner
    // policy/freeze writes. Execution/inclusion evidence always vetoes override.
    return this.pump.run(async () => {
      const attempt = this.o.store.read((r) => {
        const request = must(r.getRequest(requestId));
        if (!['signed', 'submitted', 'outcome_unknown'].includes(request.state)) throw new BrokerError('FORBIDDEN');
        return must(r.listAttempts(requestId).find((a) => a.txHash === request.txHash));
      });
      const outcome = await this.status(attempt);
      if (outcome.kind === 'succeeded' || outcome.kind === 'failed' || outcome.kind === 'pending') throw new BrokerError('FORBIDDEN');
      return this.lane.run(async () => this.finishAttempt(attempt, 'owner_attested', reason,
        outcome.kind === 'not_executed' ? outcome.evidence : 'Owner attests no execution; chain evidence unavailable'));
    });
  }
  async drain(): Promise<void> {
    await this.o.hooks?.beforeDispatch?.();
    await this.run(true);
  }
  private outstanding(r: StoreReader) {
    return pages((q) => r.listRequests({ states: ['signed', 'submitted', 'outcome_unknown'] }, q))
      .map((request) => ({ request, attempt: must(r.listAttempts(request.id).find((a) => a.txHash === request.txHash)) }))
      .sort((a, b) => a.attempt.nonce < b.attempt.nonce ? -1 : a.attempt.nonce > b.attempt.nonce ? 1 : 0);
  }
  private async run(dispatchQueued: boolean, requestId?: string): Promise<TransferRequest[]> {
    return this.pump.run(async () => {
      await this.expirePending();
      const touched = new Set<string>(); const skipped = new Set<string>();
      for (;;) {
        // Re-read after EVERY attempt. Owner mutations queued behind the current
        // broadcast acquire the lane before the next item. FINAL polling is never
        // inside that lane, so even a hung status call cannot delay a freeze.
        const existing = this.o.store.read((r) => this.outstanding(r)[0]);
        if (existing) {
          if (requestId !== undefined && existing.request.id !== requestId) break;
          touched.add(existing.request.id);
          if (!await this.recover(existing.request, existing.attempt)) break;
          continue;
        }
        if (!dispatchQueued) break;
        const next = this.o.store.read((r) => pages((q) => r.listRequests({ states: ['queued', 'approved'] }, q)))
          .filter((r) => !skipped.has(r.id))
          .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
        if (!next) break;
        skipped.add(next.id);
        const attempt = await this.lane.run(async () => {
          await this.refreshLocked();
          const current = this.o.store.withImmediateTransaction((tx) => this.authorizeQueued(tx, next.id));
          if (!current) return null;
          const attempt = await this.sign(current);
          if (attempt) {
            await this.o.hooks?.afterPersistSigned?.(attempt);
            await this.send(attempt);
          }
          return attempt;
        });
        if (attempt) {
          touched.add(attempt.requestId);
          // Query/settle before any later nonce; no blind duplicate replacement.
          const current = this.o.store.read((r) => must(r.getRequest(attempt.requestId)));
          const stored = this.o.store.read((r) => must(r.listAttempts(current.id).find((a) => a.txHash === current.txHash)));
          if (!await this.observe(stored, await this.status(stored))) break;
        }
      }
      return this.o.store.read((r) => [...touched].map((id) => must(r.getRequest(id))));
    });
  }
  private authorizeQueued(tx: StoreTransaction, id: string): TransferRequest | null {
    let request = must(tx.getRequest(id));
    if (request.state !== 'queued' && request.state !== 'approved') return null;
    const now = this.o.clock.now();
    if (request.expiresAt !== null && now >= request.expiresAt) { this.finishUnsent(tx, request, 'expired', 'Queue expired'); return null; }
    const e = this.evaluation(tx, request, request.id);
    const decision = this.boundDecision(tx, e);
    if (decision.kind === 'deny') {
      // Freezes pause work, preserving its reservation. Other hard failures
      // deny unsent requests, but can never release an ambiguous payment.
      if (decision.reasons.includes('GLOBAL_FROZEN') || decision.reasons.includes('AGENT_FROZEN')
        || (decision.reasons.length === 1 && decision.reasons.includes('WALLET_CAPACITY') && this.stale(tx))) return null;
      this.finishUnsent(tx, request, 'denied', 'Dispatch denied', decision); return null;
    }
    if (decision.kind === 'needs_approval') {
      const next: TransferRequest = { ...request, state: 'pending_approval', approvalRef: null, reasons: decision.reasons,
        policyRevision: e.agentPolicy?.revision ?? null, updatedAt: now };
      tx.updateRequest(next, request.state); this.decisionReceipt(tx, next, decision); return null;
    }
    if (request.state === 'approved') {
      const next: TransferRequest = { ...request, state: 'queued', updatedAt: now };
      tx.updateRequest(next, 'approved'); request = next;
    }
    // ApprovalRef can only change together with the signed transition. sign()
    // repeats this evaluation after awaits, immediately before persisting bytes.
    return request;
  }
  private async sign(request: TransferRequest, prior?: TxAttempt): Promise<TxAttempt | null> {
    await this.attest();
    const access = await this.chainCall(() => this.o.chain.viewAccessKey(this.o.config.accountId, this.o.signer.publicKey));
    if (!access.fullAccess || access.publicKey !== this.o.signer.publicKey) throw new BrokerError('FORBIDDEN');
    const block = await this.chainCall(() => this.o.chain.recentBlockHash());
    const nonce = this.o.store.withImmediateTransaction((tx) => tx.allocateNonce(this.o.signer.publicKey, access.nonce));
    const signed = await this.chainCall(() => this.o.chain.buildAndSignNativeTransfer({ signerId: this.o.config.accountId,
      receiverId: request.receiverId, amount: request.amount, publicKey: this.o.signer.publicKey, nonce, blockHash: block.hash }, this.o.signer));
    // Validate adapter output and persist exactly the bytes that will be sent.
    if (signed.transfer.nonce !== nonce || signed.transfer.signerId !== this.o.config.accountId
      || signed.transfer.publicKey !== this.o.signer.publicKey || signed.transfer.receiverId !== request.receiverId
      || signed.transfer.amount !== request.amount || signed.transfer.blockHash !== block.hash) throw new BrokerError('FORBIDDEN');
    this.o.chain.encodeSignedTx(signed);
    return this.o.store.withImmediateTransaction((tx) => {
      const current = must(tx.getRequest(request.id));
      if (!prior && current.state !== 'queued') return null; // cancelled during custody await
      if (!prior && current.expiresAt !== null && this.o.clock.now() >= current.expiresAt) {
        this.finishUnsent(tx, current, 'expired', 'Queue expired while signing');
        return null;
      }
      const e = this.evaluation(tx, current, current.id);
      const decision = this.boundDecision(tx, e);
      if (decision.kind !== 'allow' && decision.kind !== 'allow_via_standing_approval') return null;
      const standingId = current.approvalRef?.kind === 'standing' ? current.approvalRef.id
        : decision.kind === 'allow_via_standing_approval' ? decision.standingApprovalId : null;
      const approvalRef = standingId === null ? current.approvalRef
        : reserveStandingApproval(tx, current, standingId, this.o.clock.now());
      if (!prior && approvalRef?.id !== current.approvalRef?.id) {
        this.decisionReceipt(tx, { ...current, approvalRef }, decision);
      }
      const now = this.o.clock.now();
      const attempt: TxAttempt = { id: randomUUID(), requestId: request.id, nonce, publicKey: this.o.signer.publicKey,
        blockHash: block.hash, signedTxBase64: signed.signedTxBase64, txHash: signed.txHash, status: 'signed', receiptIds: [],
        gasBurnt: null, tokensBurnt: null, createdAt: now, updatedAt: now, nonExecutionEvidence: null };
      if (prior) {
        // Replacement retains the exact approval binding. Never silently switch
        // grants using the same-state outbox exception.
        if (approvalRef?.kind !== current.approvalRef?.kind || approvalRef?.id !== current.approvalRef?.id) return null;
        tx.replaceUnexecutedAttempt(current.id, prior.id, attempt);
      } else {
        tx.putAttempt(attempt);
        tx.updateRequest({ ...current, state: 'signed', approvalRef, policyRevision: e.agentPolicy?.revision ?? null,
          signedAt: now, updatedAt: now, txHash: attempt.txHash }, 'queued');
      }
      return attempt;
    });
  }
  private async status(attempt: TxAttempt): Promise<ChainOutcome> {
    try { return await this.o.chain.txStatus(attempt.txHash, this.o.config.accountId, attempt); }
    catch { return { kind: 'outcome_unknown', reason: 'Status unavailable' }; }
  }
  private unknown(attempt: TxAttempt, reason: string): void {
    this.o.store.withImmediateTransaction((tx) => {
      const request = must(tx.getRequest(attempt.requestId));
      const now = this.o.clock.now();
      tx.putAttempt({ ...attempt, status: 'outcome_unknown', updatedAt: now });
      if (request.state !== 'outcome_unknown') {
        tx.updateRequest({ ...request, state: 'outcome_unknown', updatedAt: now }, request.state);
        this.event(tx, { type: 'outcome_unknown', payload: { requestId: request.id, agentId: request.agentId,
          attemptId: attempt.id, txHash: attempt.txHash, reason } }, request.agentId);
      }
    });
  }
  private acknowledged(tx: StoreTransaction, request: TransferRequest, attempt: TxAttempt): TransferRequest {
    if (request.state === 'submitted') return request;
    const now = this.o.clock.now();
    const next: TransferRequest = { ...request, state: 'submitted', submittedAt: now, updatedAt: now };
    tx.updateRequest(next, request.state);
    this.event(tx, { type: 'submitted', payload: { requestId: request.id, agentId: request.agentId, attemptId: attempt.id, txHash: attempt.txHash, phase: 'acknowledged' } }, request.agentId);
    return next;
  }
  /** Caller holds the per-attempt lane, never the whole queue or FINAL polling. */
  private async send(attempt: TxAttempt): Promise<void> {
    const ready = this.o.store.withImmediateTransaction((tx) => {
      const request = must(tx.getRequest(attempt.requestId));
      const decision = this.boundDecision(tx, this.evaluation(tx, request, request.id));
      if (decision.kind !== 'allow' && decision.kind !== 'allow_via_standing_approval') return false;
      if (decision.kind === 'allow_via_standing_approval'
        && (request.approvalRef?.kind !== 'standing' || request.approvalRef.id !== decision.standingApprovalId)) return false;
      this.event(tx, { type: 'submitted', payload: { requestId: request.id, agentId: request.agentId,
        attemptId: attempt.id, txHash: attempt.txHash, phase: 'intent' } }, request.agentId);
      return true;
    });
    if (!ready) return;
    // Network attestation failures before invocation are NOT execution evidence.
    await this.attest();
    let result;
    try { result = await this.o.chain.broadcast(attempt.signedTxBase64); }
    catch { result = { kind: 'outcome_unknown' as const, txHash: attempt.txHash }; }
    await this.o.hooks?.afterBroadcast?.(attempt);
    if (result.kind === 'accepted' && result.txHash === attempt.txHash) {
      this.o.store.withImmediateTransaction((tx) => {
        tx.putAttempt({ ...attempt, status: 'submitted', updatedAt: this.o.clock.now() });
        this.acknowledged(tx, must(tx.getRequest(attempt.requestId)), attempt);
      });
      return;
    }
    // Rejection is not proof. Query status outside the lane before replacement.
    this.unknown(attempt, 'Broadcast acknowledgment unavailable');
  }
  private neverOffered(r: StoreReader, attempt: TxAttempt): boolean {
    let after = 0;
    for (;;) {
      const events = r.listReceipts(`agent:${must(r.getRequest(attempt.requestId)).agentId}`, after, 1000);
      if (!events.length) return true;
      if (events.some((e) => e.type === 'submitted' && e.payload.attemptId === attempt.id)) return false;
      after = events.at(-1)!.seq;
    }
  }
  private finishAttempt(attempt: TxAttempt, basis: 'owner_attested' | 'chain_proof' | 'never_offered', reason: string, evidence: string): TransferRequest {
    return this.o.store.withImmediateTransaction((tx) => {
      const current = must(tx.getRequest(attempt.requestId));
      const stored = must(tx.listAttempts(current.id).find((a) => a.id === attempt.id));
      if (current.txHash !== attempt.txHash || !['signed', 'submitted', 'outcome_unknown'].includes(current.state)) throw new BrokerError('FORBIDDEN');
      if (basis === 'never_offered' && !this.neverOffered(tx, stored)) throw new BrokerError('FORBIDDEN');
      if (basis === 'chain_proof' && stored.status !== 'proven_not_executed') throw new BrokerError('FORBIDDEN');
      if (stored.status !== 'proven_not_executed') tx.putAttempt({ ...stored, status: 'failed', gasBurnt: 0n, tokensBurnt: 0n, updatedAt: this.o.clock.now() });
      const next: TransferRequest = { ...current, state: 'failed', gasBurnt: 0n, tokensBurnt: 0n,
        updatedAt: this.o.clock.now(), completedAt: this.o.clock.now() };
      tx.updateRequest(next, current.state);
      this.release(tx, next);
      this.accounting(tx, next, 'gas_charged', 0n);
      this.event(tx, { type: 'failed', payload: { requestId: current.id, agentId: current.agentId, txHash: attempt.txHash,
        receiptIds: [], gasBurnt: '0', tokensBurnt: '0', reason, resolution: { attemptId: attempt.id, basis, evidence } } }, current.agentId, true);
      return next;
    });
  }
  private async observe(attempt: TxAttempt, outcome: ChainOutcome): Promise<boolean> {
    return this.lane.run(async () => {
      if (outcome.kind === 'succeeded' || outcome.kind === 'failed') { this.settle(attempt, outcome); return true; }
      if (outcome.kind === 'pending') {
        this.o.store.withImmediateTransaction((tx) => {
          tx.putAttempt({ ...attempt, status: 'submitted', updatedAt: this.o.clock.now() });
          this.acknowledged(tx, must(tx.getRequest(attempt.requestId)), attempt);
        });
        return false;
      }
      if (outcome.kind === 'not_executed') {
        this.o.store.withImmediateTransaction((tx) => {
          const current = must(tx.getRequest(attempt.requestId));
          if (current.state !== 'outcome_unknown') tx.updateRequest({ ...current, state: 'outcome_unknown', updatedAt: this.o.clock.now() }, current.state);
          tx.putAttempt({ ...attempt, status: 'proven_not_executed', nonExecutionEvidence: outcome.evidence, updatedAt: this.o.clock.now() });
          this.event(tx, { type: 'outcome_unknown', payload: { requestId: current.id, agentId: current.agentId,
            attemptId: attempt.id, txHash: attempt.txHash, reason: 'Positive non-execution evidence; replacement pending' } }, current.agentId);
        });
        return false; // durable proof boundary; at most one replacement per drain
      }
      this.unknown(attempt, 'Final execution evidence unavailable');
      return false;
    });
  }
  private async recover(request: TransferRequest, attempt: TxAttempt): Promise<boolean> {
    if (attempt.status !== 'proven_not_executed') {
      const outcome = await this.status(attempt);
      if (outcome.kind !== 'outcome_unknown') return this.observe(attempt, outcome);
    }
    const next = await this.lane.run(async () => {
      const unoffered = this.o.store.read((r) => this.neverOffered(r, attempt));
      let decision = this.o.store.read((r) => this.boundDecision(r, this.evaluation(r, request, request.id)));
      // Positive exclusion (or never-offered evidence) needs no live wallet RPC
      // to release work already prohibited by revocation/freeze/policy. A stale
      // balance alone, however, is retryable and must not terminally deny work.
      const certain = attempt.status === 'proven_not_executed' || unoffered;
      const hardDenied = decision.kind === 'needs_approval' || (decision.kind === 'deny'
        && !decision.reasons.includes('GLOBAL_FROZEN') && decision.reasons.some((reason) => reason !== 'WALLET_CAPACITY'));
      if (certain && hardDenied) {
        this.finishAttempt(attempt, unoffered ? 'never_offered' : 'chain_proof', 'Authorization no longer permits transfer',
          unoffered ? 'Broker evidence: no submission intent or acknowledgment exists' : must(attempt.nonExecutionEvidence));
        return true;
      }
      await this.refreshLocked();
      decision = this.o.store.read((r) => this.boundDecision(r, this.evaluation(r, request, request.id)));
      if (decision.kind === 'deny' || decision.kind === 'needs_approval') {
        const reasons: readonly string[] = decision.reasons;
        if (reasons.includes('GLOBAL_FROZEN') || (reasons.length === 1 && reasons.includes('WALLET_CAPACITY') && this.o.store.read((r) => this.stale(r)))) return null;
        if (attempt.status === 'proven_not_executed' || unoffered) {
          this.finishAttempt(attempt, unoffered ? 'never_offered' : 'chain_proof', 'Authorization no longer permits transfer',
            unoffered ? 'Broker evidence: no submission intent or acknowledgment exists' : must(attempt.nonExecutionEvidence));
          return true;
        }
        return null; // already offered: a per-agent freeze cannot undo ambiguity
      }
      let send = attempt;
      if (attempt.status === 'proven_not_executed') {
        const replacement = await this.sign(request, attempt);
        if (!replacement) return null;
        send = replacement;
        await this.o.hooks?.afterPersistSigned?.(send);
      }
      // Safe even for outcome_unknown: rebroadcast the EXACT durable bytes.
      await this.send(send);
      return send;
    });
    if (next === true) return true;
    if (next === null) return false;
    const stored = this.o.store.read((r) => must(r.listAttempts(next.requestId).find((a) => a.id === next.id)));
    return this.observe(stored, await this.status(stored));
  }
  private settle(attempt: TxAttempt, outcome: Extract<ChainOutcome, { kind: 'succeeded' | 'failed' }>): void {
    this.o.store.withImmediateTransaction((tx) => {
      let request = must(tx.getRequest(attempt.requestId));
      if (request.state === 'succeeded' || request.state === 'failed') return;
      if (request.txHash !== attempt.txHash) throw new BrokerError('FORBIDDEN');
      const now = this.o.clock.now();
      tx.putAttempt({ ...attempt, status: outcome.kind, receiptIds: outcome.receiptIds,
        gasBurnt: outcome.gasBurnt, tokensBurnt: outcome.tokensBurnt, updatedAt: now });
      request = this.acknowledged(tx, request, attempt);
      const next: TransferRequest = { ...request, state: outcome.kind, gasBurnt: outcome.gasBurnt,
        tokensBurnt: outcome.tokensBurnt, updatedAt: now, completedAt: now };
      tx.updateRequest(next, request.state);
      const hold = must(tx.getHold(request.id));
      if (hold.status !== 'active') throw new BrokerError('FORBIDDEN');
      if (outcome.kind === 'succeeded') {
        this.accounting(tx, next, 'principal_committed', hold.principal);
        if (request.approvalRef?.kind === 'standing') {
          const approval = must(tx.getStandingApproval(request.approvalRef.id));
          tx.putStandingApproval(this.o.approvals.consumeStandingApproval({ approval, amount: hold.principal, reservedAmount: hold.principal }));
          this.event(tx, { type: 'standing_approval_used', payload: { requestId: request.id, agentId: request.agentId,
            approvalId: approval.id, amount: toDecimalText(hold.principal) } }, request.agentId, true);
        }
      } else this.accounting(tx, next, 'principal_released', hold.principal);
      this.accounting(tx, next, 'gas_charged', outcome.tokensBurnt);
      this.accounting(tx, next, 'fee_released', hold.feeReserve > outcome.tokensBurnt ? hold.feeReserve - outcome.tokensBurnt : 0n);
      tx.putHold({ ...hold, status: 'committed' });
      this.event(tx, { type: outcome.kind, payload: { requestId: request.id, agentId: request.agentId,
        txHash: attempt.txHash, receiptIds: outcome.receiptIds, gasBurnt: outcome.gasBurnt.toString(), tokensBurnt: toDecimalText(outcome.tokensBurnt),
        ...(outcome.kind === 'failed' ? { reason: 'Transaction execution failed' } : {}) } } as Omit<AppendReceipt, 'chainId' | 'at'>, request.agentId);
      // Conservative debit without extending freshness. RPC refresh is serialized
      // with settlement; no admission can spend a cached pre-payment balance.
      const status = tx.getWalletStatus(now);
      if (status.balance && status.balanceValidUntil !== null) {
        const debit = (outcome.kind === 'succeeded' ? hold.principal : 0n) + outcome.tokensBurnt;
        const sub = (n: bigint) => n > debit ? n - debit : 0n;
        tx.putBalance({ ...status.balance, total: sub(status.balance.total), spendable: sub(status.balance.spendable) }, status.balanceValidUntil);
      }
    });
  }
}
