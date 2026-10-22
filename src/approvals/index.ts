import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  ApproveRequestCommandSchema, BrokerError, GrantStandingApprovalCommandSchema, IdSchema,
  OwnerPrincipalSchema, RejectRequestCommandSchema, RevokeStandingApprovalCommandSchema,
  StandingApprovalConsumeInputSchema, StandingApprovalMatchInputSchema, TimestampSchema, TransferRequestSchema,
  requestDigest, toDecimalText,
} from '../contracts/index.js';
import type {
  ApprovalRef, ApprovalService, AppendReceipt, ApproveRequestCommand,
  GrantStandingApprovalCommand, OwnerPrincipal, ReceiptLog, RejectRequestCommand,
  RevokeStandingApprovalCommand, StandingApproval, StandingApprovalConsumeInput,
  StandingApprovalMatch, StandingApprovalMatchInput, StoreReader, StoreTransaction,
  TransferRequest,
} from '../contracts/index.js';

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) {
    // Zod strings allow lone surrogates, but signed canonical JSON does not.
    // Check schema-parsed values before any storage or receipt side effects.
    validateStrings(result.data);
    return result.data;
  }
  const monetary = new Set(['amount', 'perTxMax', 'totalMax', 'usedTotal', 'reservedTotal', 'reservedAmount']);
  throw new BrokerError(result.error.issues.some((issue) => issue.path.some((key) => monetary.has(String(key))))
    ? 'INVALID_AMOUNT' : 'FORBIDDEN');
}
function requireThat(value: unknown): asserts value {
  if (!value) throw new BrokerError('FORBIDDEN');
}

function validateStrings(value: unknown): void {
  if (typeof value === 'string') requireThat(value.isWellFormed());
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(validateStrings);
}

const ReservationRequestSchema = TransferRequestSchema.pick({ id: true, agentId: true, receiverId: true, amount: true }).strip();

/** Pure grant bounds only, NEVER a policy/freeze/wallet authorization. */
export function matchStandingApproval(input: StandingApprovalMatchInput): StandingApprovalMatch {
  const { approval, agentId, receiverId, amount, reservedTotal, now } = validate(StandingApprovalMatchInputSchema, input);
  if (approval.agentId !== agentId || approval.revokedAt !== undefined || now >= approval.expiresAt
    || (approval.recipients !== undefined && !approval.recipients.includes(receiverId))
    || amount > approval.perTxMax
    // Subtraction avoids an overflowing intermediate u128 sum.
    || reservedTotal > approval.totalMax - approval.usedTotal
    || amount > approval.totalMax - approval.usedTotal - reservedTotal) {
    return { kind: 'no_match', reasons: ['APPROVAL_REQUIRED'] };
  }
  return { kind: 'match', approvalId: approval.id };
}

/** Successful principal only. Revocation/expiry cannot erase executed spending.
 * The broker must persist this result and release the reservation atomically. */
export function consumeStandingApproval(input: StandingApprovalConsumeInput): StandingApproval {
  const { approval, amount, reservedAmount } = validate(StandingApprovalConsumeInputSchema, input);
  requireThat(amount <= reservedAmount && amount <= approval.totalMax - approval.usedTotal);
  return { ...approval, usedTotal: approval.usedTotal + amount };
}

export interface StandingApprovalSelectionInput extends Omit<StandingApprovalMatchInput, 'approval' | 'reservedTotal'> {
  approvals: readonly StandingApproval[];
  standingReserved: Readonly<Record<string, bigint>>;
}
/** Same deterministic UTF-16 ID ordering as the policy evaluator, not locale or
 * input order. Own-key lookup supports hostile IDs such as "__proto__". */
export function selectStandingApproval(input: StandingApprovalSelectionInput): StandingApprovalMatch {
  let selected: string | null = null;
  for (const approval of input.approvals) {
    const reservedTotal = Object.hasOwn(input.standingReserved, approval.id) ? input.standingReserved[approval.id]! : 0n;
    const match = matchStandingApproval({ approval, agentId: input.agentId, receiverId: input.receiverId,
      amount: input.amount, reservedTotal, now: input.now });
    if (match.kind === 'match' && (selected === null || match.approvalId < selected)) selected = match.approvalId;
  }
  return selected === null ? { kind: 'no_match', reasons: ['APPROVAL_REQUIRED'] } : { kind: 'match', approvalId: selected };
}

/** Call only inside ONE Store read/transaction snapshot; no first-page shortcut. */
export function listStandingApprovals(view: StoreReader, agentId: string): StandingApproval[] {
  const approvals: StandingApproval[] = [];
  let after: string | undefined;
  do {
    const page = view.listStandingApprovals(agentId, { ...(after === undefined ? {} : { after }), limit: 1000 });
    approvals.push(...page.items);
    if (page.nextCursor === null) return approvals;
    requireThat(page.items.length > 0 && page.nextCursor === page.items.at(-1)?.id && page.nextCursor !== after);
    after = page.nextCursor;
  } while (true);
}

/** No independent reservation counter: broker attaches the returned ref to its
 * request and writes the active hold in THIS transaction. Also usable at dispatch
 * (own hold excluded). Always re-check hard caps separately before dispatch. */
export function reserveStandingApproval(
  tx: StoreTransaction,
  request: Pick<TransferRequest, 'id' | 'agentId' | 'receiverId' | 'amount'>,
  approvalId: string,
  now: number,
): ApprovalRef {
  request = validate(ReservationRequestSchema, request);
  validate(IdSchema, approvalId);
  validate(TimestampSchema, now);
  const approval = tx.getStandingApproval(approvalId);
  if (approval === null) throw new BrokerError('NOT_FOUND');
  const usage = tx.getUsageSnapshot(request.agentId, now, request.id);
  const reservedTotal = Object.hasOwn(usage.standingReserved, approvalId) ? usage.standingReserved[approvalId]! : 0n;
  requireThat(matchStandingApproval({ approval, agentId: request.agentId, receiverId: request.receiverId,
    amount: request.amount, reservedTotal, now }).kind === 'match');
  return { kind: 'standing', id: approvalId };
}

/** Owner-independent sweeper seam. Uses the caller's transaction and ReceiptLog;
 * no nested transaction, owner impersonation or separate reservation counter.
 * Not-yet-due/non-pending requests are unchanged, so repeated sweeps are safe.
 */
export function expirePending(tx: StoreTransaction, requestId: string, now: number, receipts: ReceiptLog): TransferRequest {
  validate(IdSchema, requestId);
  validate(TimestampSchema, now);
  const request = tx.getRequest(requestId);
  if (request === null) throw new BrokerError('NOT_FOUND');
  if (request.state !== 'pending_approval') return request;
  requireThat(now >= request.updatedAt);
  if (request.expiresAt === null || now < request.expiresAt) return request;
  const hold = tx.getHold(requestId);
  requireThat(hold?.status === 'active' && hold.agentId === request.agentId && hold.principal === request.amount);
  return finishPending(tx, request, now, 'expired', 'Pending approval expired', receipts);
}

function finishPending(tx: StoreTransaction, request: TransferRequest, now: number,
  state: 'rejected' | 'expired', reason: string, receipts: ReceiptLog): TransferRequest {
  const hold = tx.getHold(request.id);
  requireThat(hold?.status === 'active');
  const finished: TransferRequest = { ...request, state, updatedAt: now, completedAt: now, approvalRef: null };
  tx.updateRequest(finished, 'pending_approval');
  tx.putHold({ ...hold, status: 'released' });
  for (const [kind, amount] of [['principal_released', hold.principal], ['fee_released', hold.feeReserve]] as const) {
    tx.appendAccounting({ id: randomUUID(), requestId: request.id, agentId: request.agentId, kind, amount, at: now });
  }
  appendBoth(tx, { chainId: 'owner', type: state, at: now,
    payload: { requestId: request.id, agentId: request.agentId, reason } }, request.agentId, receipts);
  return finished;
}

function appendBoth(tx: StoreTransaction, event: AppendReceipt, agentId: string, receipts: ReceiptLog): void {
  receipts.append(tx, event);
  receipts.append(tx, { ...event, chainId: `agent:${agentId}` });
}

/** Owner-scoped, synchronous implementation of the frozen port. Its signatures
 * intentionally have no principal parameter: construction requires a VERIFIED
 * OwnerPrincipal from the broker. Schema checking rejects agents, but is not an
 * HTTP authentication mechanism. Do not expose this capability through MCP.
 * Broker checks current hard caps in this same transaction and again at dispatch.
 */
export class TransactionalApprovalService implements ApprovalService {
  constructor(principal: OwnerPrincipal, private readonly receipts: ReceiptLog) {
    validate(OwnerPrincipalSchema, principal);
  }

  readonly matchStandingApproval = matchStandingApproval;
  readonly consumeStandingApproval = consumeStandingApproval;

  approve(tx: StoreTransaction, input: ApproveRequestCommand): TransferRequest {
    const command = validate(ApproveRequestCommandSchema, input);
    const request = this.pending(tx, command.requestId, command.now);
    if (request.expiresAt !== null && command.now >= request.expiresAt) {
      return finishPending(tx, request, command.now, 'expired', 'Pending approval expired', this.receipts);
    }
    requireThat(command.expiresAt > command.now);
    const policy = tx.getPolicy(request.agentId);
    if (policy === null || (policy.expiresAt !== undefined && command.now >= policy.expiresAt)) {
      throw new BrokerError('NO_POLICY');
    }
    requireThat(tx.getAgent(request.agentId)?.status === 'active');
    requireThat(policy.revision === request.policyRevision);
    requireThat(request.requestDigest === requestDigest({ agentId: request.agentId,
      receiverId: request.receiverId, amount: toDecimalText(request.amount), memo: request.memo ?? null }));
    // Never extend the lifetime reserved by the pending request.
    const expiresAt = Math.min(command.expiresAt, request.expiresAt ?? command.expiresAt);
    const approval = { id: command.approvalId, requestId: request.id, agentId: request.agentId,
      requestDigest: request.requestDigest, policyRevision: policy.revision, approvedAt: command.now, expiresAt };
    tx.putRequestApproval(approval);
    const approved: TransferRequest = { ...request, state: 'approved', reasons: [],
      approvalRef: { kind: 'request', id: approval.id }, updatedAt: command.now };
    tx.updateRequest(approved, 'pending_approval');
    this.appendBoth(tx, { chainId: 'owner', type: 'approved', at: command.now, payload: {
      requestId: request.id, agentId: request.agentId, approvalId: approval.id,
      requestDigest: approval.requestDigest, policyRevision: approval.policyRevision, expiresAt,
    } }, request.agentId);
    return approved;
  }

  reject(tx: StoreTransaction, input: RejectRequestCommand): TransferRequest {
    const command = validate(RejectRequestCommandSchema, input);
    const request = this.pending(tx, command.requestId, command.now);
    return request.expiresAt !== null && command.now >= request.expiresAt
      ? finishPending(tx, request, command.now, 'expired', 'Pending approval expired', this.receipts)
      : finishPending(tx, request, command.now, 'rejected', command.reason, this.receipts);
  }

  grantStandingApproval(tx: StoreTransaction, input: GrantStandingApprovalCommand): StandingApproval {
    const { now, recipients, ...grant } = validate(GrantStandingApprovalCommandSchema, input);
    requireThat(grant.expiresAt > now && tx.getStandingApproval(grant.id) === null);
    const agent = tx.getAgent(grant.agentId);
    if (agent === null) throw new BrokerError('NOT_FOUND');
    requireThat(agent.status === 'active');
    const approval: StandingApproval = { ...grant, ...(recipients === undefined ? {} : { recipients }), usedTotal: 0n };
    tx.putStandingApproval(approval);
    this.appendBoth(tx, { chainId: 'owner', type: 'standing_approval_granted', at: now, payload: {
      agentId: approval.agentId, approval: { ...approval, perTxMax: toDecimalText(approval.perTxMax),
        totalMax: toDecimalText(approval.totalMax), usedTotal: toDecimalText(approval.usedTotal) },
    } }, approval.agentId);
    return approval;
  }

  revokeStandingApproval(tx: StoreTransaction, input: RevokeStandingApprovalCommand): StandingApproval {
    const { approvalId, now } = validate(RevokeStandingApprovalCommandSchema, input);
    const approval = tx.getStandingApproval(approvalId);
    if (approval === null) throw new BrokerError('NOT_FOUND');
    if (approval.revokedAt !== undefined) return approval; // idempotent; never reset usage/time
    const revoked: StandingApproval = { ...approval, revokedAt: now };
    tx.putStandingApproval(revoked);
    this.appendBoth(tx, { chainId: 'owner', type: 'standing_approval_revoked', at: now,
      payload: { agentId: approval.agentId, approvalId, revokedAt: now } }, approval.agentId);
    return revoked;
  }

  /** Optional broker settlement helper beyond the pure port. Call after recording
   * success, BEFORE committing the active hold. Commits the hold to remove its
   * reservation; broker writes final principal/fee accounting in the same tx.
   * Repeated calls fail closed rather than debit twice. No debit on failure.
   */
  settleStandingApproval(tx: StoreTransaction, requestId: string, now: number): StandingApproval {
    validate(IdSchema, requestId);
    validate(TimestampSchema, now);
    const request = tx.getRequest(requestId);
    if (request === null) throw new BrokerError('NOT_FOUND');
    requireThat(request.state === 'succeeded' && request.approvalRef?.kind === 'standing' && now >= request.updatedAt);
    const hold = tx.getHold(requestId);
    requireThat(hold?.status === 'active' && hold.agentId === request.agentId && hold.principal === request.amount);
    const approval = tx.getStandingApproval(request.approvalRef.id);
    requireThat(approval !== null && approval.agentId === request.agentId);
    const consumed = consumeStandingApproval({ approval, amount: request.amount, reservedAmount: hold.principal });
    tx.putStandingApproval(consumed);
    tx.putHold({ ...hold, status: 'committed' });
    this.appendBoth(tx, { chainId: 'owner', type: 'standing_approval_used', at: now, payload: {
      requestId, agentId: request.agentId, approvalId: approval.id, amount: toDecimalText(request.amount),
    } }, request.agentId);
    return consumed;
  }

  private pending(tx: StoreTransaction, requestId: string, now: number): TransferRequest {
    const request = tx.getRequest(requestId);
    if (request === null) throw new BrokerError('NOT_FOUND');
    requireThat(request.state === 'pending_approval' && now >= request.updatedAt);
    const hold = tx.getHold(requestId);
    requireThat(hold?.status === 'active' && hold.agentId === request.agentId && hold.principal === request.amount);
    return request;
  }

  private appendBoth(tx: StoreTransaction, event: AppendReceipt, agentId: string): void {
    appendBoth(tx, event, agentId, this.receipts);
  }
}
