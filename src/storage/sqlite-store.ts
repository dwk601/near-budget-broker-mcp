import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fchmodSync, openSync, chmodSync } from 'node:fs';
import type { SQLInputValue } from 'node:sqlite';
import type { z } from 'zod';
import {
  AccountBalanceSchema, AccountIdSchema, AccountingEntrySchema, AgentCredentialSchema,
  AgentPolicySchema, AgentSchema, BrokerError, CheckpointSchema, CountSchema,
  Ed25519PublicKeySchema, FreezeSchema, GENESIS_PREV_HASH, HoldSchema, MAX_U128,
  OUTBOX_STATUSES, PageQuerySchema, ReceiptEventSchema,
  RequestApprovalSchema, StandingApprovalSchema, TimestampSchema, TransferRequestSchema,
  TxAttemptSchema, WalletPolicySchema, fromDecimalText, isAllowedTransition, requestDigest, toDecimalText,
} from '../contracts/index.js';
import type {
  AccountBalance, AccountingEntry, AccountingFilter, Agent, AgentCredential, AgentPolicy,
  ChainId, Checkpoint, Freeze, Hold, Page, PageQuery, ReceiptEvent, RequestApproval,
  RequestFilter, StandingApproval, Store, StoreReader, StoreTransaction, TransferRequest,
  TransferState, TxAttempt, UsageSnapshot, WalletPolicy, WalletStatus,
} from '../contracts/index.js';
import { migrate } from './migrations.js';
import { rollbackQuietly, storageError } from './sqlite-errors.js';

export interface SqliteStoreOptions {
  /** Nonces are namespaced by (testnet, custody account, public key). */
  accountId: string;
  network?: 'testnet';
  busyTimeoutMs?: number;
}

type Row = Record<string, unknown>;
const fields = {
  policy: ['perTxMax', 'rolling24hMax', 'lifetimeMax', 'gasBudget24h', 'approvalThreshold'],
  wallet: ['rolling24hMax', 'safetyReserve'],
  request: ['amount', 'gasBurnt', 'tokensBurnt'],
  standing: ['perTxMax', 'totalMax', 'usedTotal'],
  attempt: ['nonce', 'gasBurnt', 'tokensBurnt'],
  balance: ['total', 'locked', 'storageReserve', 'spendable'],
};
function encode(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => typeof item === 'bigint'
    ? (key === 'nonce' || key === 'gasBurnt' ? item.toString() : toDecimalText(item)) : item);
}
function unsignedFromText(text: unknown): bigint {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text)) throw new BrokerError('BROKER_UNAVAILABLE');
  return BigInt(text);
}
function decode<T>(row: Row, schema: z.ZodType<T>, bigints: readonly string[] = []): T {
  const value = JSON.parse(String(row['data'])) as Record<string, unknown>;
  for (const key of bigints) {
    const text = value[key];
    if (text !== null && text !== undefined) {
      value[key] = key === 'nonce' || key === 'gasBurnt' ? unsignedFromText(text) : fromDecimalText(text);
    }
  }
  return schema.parse(value);
}
function requireThat(condition: unknown, code: 'FORBIDDEN' | 'NONCE_CONFLICT' | 'AUDIT_UNAVAILABLE' | 'NOT_FOUND' = 'FORBIDDEN'): asserts condition {
  if (!condition) throw new BrokerError(code);
}
function add(a: bigint, b: bigint): bigint {
  const result = a + b;
  if (result < 0n || result > MAX_U128) throw new BrokerError('INVALID_AMOUNT');
  return result;
}
function same(a: unknown, b: unknown): boolean { return encode(a) === encode(b); }
const MAX_NONCE = (1n << 64n) - 1n;
const terminal = new Set<TransferState>(['denied', 'rejected', 'expired', 'cancelled', 'succeeded', 'failed']);

/** One connection per Store. Handles cannot escape their synchronous callback. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly options: SqliteStoreOptions;
  private inCallback = false;
  private closed = false;

  constructor(filename: string, options: SqliteStoreOptions) {
    AccountIdSchema.parse(options.accountId);
    if (options.network !== undefined && options.network !== 'testnet') throw new BrokerError('MAINNET_REFUSED');
    const timeout = options.busyTimeoutMs ?? 5_000;
    requireThat(Number.isSafeInteger(timeout) && timeout >= 0 && timeout <= 2_147_483_647);
    this.options = { ...options, network: 'testnet' };
    try {
      if (filename !== ':memory:' && filename !== '') {
        // Pre-create before SQLite can write anything. SQLite derives new WAL/SHM
        // permissions from the main DB, not the process's (possibly loose) umask.
        const fd = openSync(filename, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
        // Also tighten sidecars left by an older deployment/crash before opening.
        for (const suffix of ['-wal', '-shm']) {
          try { chmodSync(`${filename}${suffix}`, 0o600); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
      }
      this.db = new DatabaseSync(filename);
    } catch (error) { throw storageError(error); }
    try {
      this.db.exec(`PRAGMA busy_timeout = ${timeout}; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
      migrate(this.db, options.accountId);
    } catch (error) {
      try { this.db.close(); } catch { /* preserve initialization failure */ }
      throw storageError(error);
    }
  }

  read<T>(operation: (view: StoreReader) => T): T {
    return this.run(false, operation);
  }
  withImmediateTransaction<T>(operation: (tx: StoreTransaction) => T): T {
    return this.run(true, operation);
  }
  /** Convenience alias; the public port name is withImmediateTransaction. */
  transaction<T>(operation: (tx: StoreTransaction) => T): T {
    return this.withImmediateTransaction(operation);
  }
  private run<T>(write: boolean, operation: (view: Transaction) => T): T {
    requireThat(!this.closed && !this.inCallback);
    // Reject native async callbacks before their first side effect. Thenables
    // returned by ordinary callbacks are also rejected and rolled back below.
    requireThat(operation.constructor.name !== 'AsyncFunction');
    try { this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); } catch (error) { throw storageError(error); }
    this.inCallback = true;
    const view = new Transaction(this.db, this.options, write);
    try {
      const result = operation(view);
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
        // Avoid unhandled rejections from an accidentally returned Promise.
        if (result instanceof Promise) void result.catch(() => {});
        throw new BrokerError('FORBIDDEN', 'Storage callbacks must be synchronous');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      rollbackQuietly(this.db);
      throw storageError(error);
    } finally { view.finish(); this.inCallback = false; }
  }
  close(): void {
    requireThat(!this.inCallback);
    if (!this.closed) { this.db.close(); this.closed = true; }
  }
}

class Transaction implements StoreTransaction {
  private active = true;
  constructor(private readonly db: DatabaseSync, private readonly options: SqliteStoreOptions, private readonly writable: boolean) {}
  finish(): void { this.active = false; }
  private check(write = false): void { requireThat(this.active && (!write || this.writable)); }
  private rows(sql: string, ...args: SQLInputValue[]): Row[] {
    this.check();
    try { return this.db.prepare(sql).all(...args); } catch (error) { throw storageError(error); }
  }
  private row(sql: string, ...args: SQLInputValue[]): Row | undefined {
    this.check();
    try { return this.db.prepare(sql).get(...args); } catch (error) { throw storageError(error); }
  }
  private exec(sql: string, ...args: SQLInputValue[]): void {
    this.check(true);
    try { this.db.prepare(sql).run(...args); }
    catch (error) { throw storageError(error); }
  }
  private one<T>(sql: string, args: SQLInputValue[], schema: z.ZodType<T>, bigints: readonly string[] = []): T | null {
    const row = this.row(sql, ...args);
    return row ? decode(row, schema, bigints) : null;
  }
  private page<T>(table: string, where: string[], args: SQLInputValue[], query: PageQuery, schema: z.ZodType<T>, bigints: readonly string[] = []): Page<T> {
    const q = PageQuerySchema.parse(query);
    if (q.after !== undefined) { where.push('id COLLATE BINARY > ?'); args.push(q.after); }
    const rows = this.rows(`SELECT id, data FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id COLLATE BINARY LIMIT ?`, ...args, q.limit + 1);
    const more = rows.length > q.limit;
    const selected = rows.slice(0, q.limit);
    return { items: selected.map((r) => decode(r, schema, bigints)), nextCursor: more ? String(selected.at(-1)?.['id']) : null };
  }
  getAgent(id: string): Agent | null { return this.one('SELECT data FROM agents WHERE id = ?', [id], AgentSchema); }
  listAgents(q: PageQuery): Page<Agent> { return this.page('agents', [], [], q, AgentSchema); }
  getCredential(id: string): AgentCredential | null { return this.one('SELECT data FROM credentials WHERE id = ?', [id], AgentCredentialSchema); }
  listCredentials(agentId: string, q: PageQuery): Page<AgentCredential> { return this.page('credentials', ['agent_id = ?'], [agentId], q, AgentCredentialSchema); }
  findCredentialByHash(hash: string): AgentCredential | null { return this.one('SELECT data FROM credentials WHERE token_hash = ?', [hash], AgentCredentialSchema); }
  getPolicy(agentId: string): AgentPolicy | null { return this.one('SELECT data FROM policies WHERE agent_id = ? ORDER BY revision DESC LIMIT 1', [agentId], AgentPolicySchema, fields.policy); }
  getWalletPolicy(): WalletPolicy | null { return this.one('SELECT data FROM wallet_policies ORDER BY revision DESC LIMIT 1', [], WalletPolicySchema, fields.wallet); }
  getRequest(id: string): TransferRequest | null { return this.one('SELECT data FROM requests WHERE id = ?', [id], TransferRequestSchema, fields.request); }
  findRequestByIdempotency(agentId: string, key: string): TransferRequest | null { return this.one('SELECT data FROM requests WHERE agent_id = ? AND idempotency_key = ?', [agentId, key], TransferRequestSchema, fields.request); }
  listRequests(filter: RequestFilter, q: PageQuery): Page<TransferRequest> {
    const where: string[] = []; const args: SQLInputValue[] = [];
    if (filter.agentId !== undefined) { where.push('agent_id = ?'); args.push(filter.agentId); }
    if (filter.states !== undefined) {
      if (filter.states.length === 0) where.push('0');
      else { where.push(`state IN (${filter.states.map(() => '?').join(',')})`); args.push(...filter.states); }
    }
    return this.page('requests', where, args, q, TransferRequestSchema, fields.request);
  }
  getHold(id: string): Hold | null {
    const row = this.row('SELECT * FROM holds WHERE request_id = ?', id);
    return row ? HoldSchema.parse({ requestId: row['request_id'], agentId: row['agent_id'], principal: fromDecimalText(row['principal']), feeReserve: fromDecimalText(row['fee_reserve']), status: row['status'] }) : null;
  }
  listAccounting(filter: AccountingFilter, q: PageQuery): Page<AccountingEntry> {
    const where: string[] = []; const args: SQLInputValue[] = [];
    if (filter.agentId !== undefined) { where.push('agent_id = ?'); args.push(filter.agentId); }
    if (filter.requestId !== undefined) { where.push('request_id = ?'); args.push(filter.requestId); }
    return this.page('accounting', where, args, q, AccountingEntrySchema, ['amount']);
  }
  listStandingApprovals(agentId: string, q: PageQuery): Page<StandingApproval> { return this.page('standing_approvals', ['agent_id = ?'], [agentId], q, StandingApprovalSchema, fields.standing); }
  getStandingApproval(id: string): StandingApproval | null { return this.one('SELECT data FROM standing_approvals WHERE id = ?', [id], StandingApprovalSchema, fields.standing); }
  getRequestApproval(id: string): RequestApproval | null { return this.one('SELECT data FROM request_approvals WHERE request_id = ?', [id], RequestApprovalSchema); }
  getFreeze(scope: 'global' | 'agent', agentId?: string): Freeze | null {
    requireThat(scope === 'global' || (scope === 'agent' && typeof agentId === 'string'));
    return this.one('SELECT data FROM freezes WHERE id = ?', [scope === 'global' ? 'global' : `agent:${agentId}`], FreezeSchema);
  }
  listAttempts(id: string): TxAttempt[] { return this.rows('SELECT data FROM attempts WHERE network = ? AND account_id = ? AND request_id = ? ORDER BY id COLLATE BINARY', 'testnet', this.options.accountId, id).map((r) => decode(r, TxAttemptSchema, fields.attempt)); }
  listOutbox(q: PageQuery): Page<TxAttempt> { return this.page('attempts', ['network = ?', 'account_id = ?', `status IN (${OUTBOX_STATUSES.map(() => '?').join(',')})`], ['testnet', this.options.accountId, ...OUTBOX_STATUSES], q, TxAttemptSchema, fields.attempt); }
  getLocalNonce(publicKey: string): bigint {
    const row = this.row('SELECT nonce FROM nonces WHERE network = ? AND account_id = ? AND public_key = ?', 'testnet', this.options.accountId, publicKey);
    const nonce = row ? unsignedFromText(row['nonce']) : 0n;
    requireThat(nonce <= MAX_NONCE, 'NONCE_CONFLICT');
    return nonce;
  }
  getReceiptHead(chainId: ChainId): ReceiptEvent | null { return this.one('SELECT data FROM receipts WHERE chain_id = ? ORDER BY seq DESC LIMIT 1', [chainId], ReceiptEventSchema); }
  listReceipts(chainId: ChainId, afterSeq: number, limit: number): ReceiptEvent[] {
    this.seqQuery(afterSeq, limit);
    return this.rows('SELECT data FROM receipts WHERE chain_id = ? AND seq > ? ORDER BY seq LIMIT ?', chainId, afterSeq, limit).map((r) => decode(r, ReceiptEventSchema));
  }
  getCheckpointHead(chainId: ChainId): Checkpoint | null { return this.one('SELECT data FROM checkpoints WHERE chain_id = ? ORDER BY seq DESC LIMIT 1', [chainId], CheckpointSchema); }
  listCheckpoints(chainId: ChainId, afterSeq: number, limit: number): Checkpoint[] {
    this.seqQuery(afterSeq, limit);
    return this.rows('SELECT data FROM checkpoints WHERE chain_id = ? AND seq > ? ORDER BY seq LIMIT ?', chainId, afterSeq, limit).map((r) => decode(r, CheckpointSchema));
  }
  private seqQuery(afterSeq: number, limit: number): void { CountSchema.parse(afterSeq); requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000); }
  private balance(): { balance: AccountBalance; validUntil: number } | null {
    const row = this.row('SELECT data, valid_until FROM balance WHERE id = 1');
    return row ? { balance: decode(row, AccountBalanceSchema, fields.balance), validUntil: Number(row['valid_until']) } : null;
  }
  getWalletStatus(now: number): WalletStatus {
    const usage = this.getUsageSnapshot('', now);
    const balance = this.balance();
    return { policy: this.getWalletPolicy(), balance: balance?.balance ?? null, balanceValidUntil: balance?.validUntil ?? null,
      walletRolling24h: usage.walletRolling24h, outstandingHolds: usage.outstandingHolds, globalFreeze: this.getFreeze('global'), at: now };
  }
  getUsageSnapshot(agentId: string, now: number, excludeRequestId?: string): UsageSnapshot {
    TimestampSchema.parse(now);
    const balance = this.balance();
    const usage: UsageSnapshot = {
      agentRolling24h: 0n, agentLifetime: 0n, agentGas24h: 0n, agentRequestsLastMinute: 0,
      agentOutstanding: 0, walletRolling24h: 0n, outstandingHolds: 0n, standingReserved: Object.create(null) as Record<string, bigint>,
      balance: balance ? { spendable: balance.balance.spendable, observedAt: balance.balance.observedAt, validUntil: balance.validUntil } : null,
      agentFrozen: this.getFreeze('agent', agentId)?.frozen ?? false, globalFrozen: this.getFreeze('global')?.frozen ?? false,
    };
    const exclude = excludeRequestId === undefined ? '' : ' AND request_id != ?';
    const args: SQLInputValue[] = excludeRequestId === undefined ? [] : [excludeRequestId];
    for (const row of this.rows(`SELECT data FROM accounting WHERE
      ((kind = 'principal_committed' AND (agent_id = ? OR at > ?))
       OR (kind IN ('gas_charged','gas_correction') AND agent_id = ? AND at > ?)) AND at <= ?${exclude}`,
      agentId, now - 86_400_000, agentId, now - 86_400_000, now, ...args)) {
      const entry = decode(row, AccountingEntrySchema, ['amount']);
      // Future entries never contribute to a snapshot at an earlier clock time.
      if (entry.at > now) continue;
      const recent = entry.at > now - 86_400_000;
      if (entry.kind === 'principal_committed') {
        if (recent) usage.walletRolling24h = add(usage.walletRolling24h, entry.amount);
        if (entry.agentId === agentId) {
          usage.agentLifetime = add(usage.agentLifetime, entry.amount);
          if (recent) usage.agentRolling24h = add(usage.agentRolling24h, entry.amount);
        }
      } else if (entry.agentId === agentId && recent) usage.agentGas24h = add(usage.agentGas24h, entry.amount);
    }
    for (const row of this.rows(`SELECT h.*, r.data FROM holds h JOIN requests r ON r.id = h.request_id WHERE h.status = 'active'${excludeRequestId === undefined ? '' : ' AND h.request_id != ?'}`, ...args)) {
      const request = decode(row, TransferRequestSchema, fields.request);
      const principal = fromDecimalText(row['principal']); const fee = fromDecimalText(row['fee_reserve']);
      usage.outstandingHolds = add(usage.outstandingHolds, add(principal, fee));
      usage.walletRolling24h = add(usage.walletRolling24h, principal);
      if (request.agentId === agentId) {
        usage.agentRolling24h = add(usage.agentRolling24h, principal);
        usage.agentLifetime = add(usage.agentLifetime, principal);
        usage.agentGas24h = add(usage.agentGas24h, fee);
        if (!terminal.has(request.state)) usage.agentOutstanding++;
        if (request.approvalRef?.kind === 'standing') {
          const id = request.approvalRef.id;
          usage.standingReserved[id] = add(usage.standingReserved[id] ?? 0n, principal);
        }
      }
    }
    // Admissions are immutable and survive cancellation/denial after admission.
    const count = this.row(`SELECT COUNT(*) AS count FROM requests r JOIN admissions a ON a.request_id = r.id
      WHERE r.agent_id = ? AND r.created_at > ? AND r.created_at <= ?${excludeRequestId === undefined ? '' : ' AND r.id != ?'}`,
      agentId, now - 60_000, now, ...args);
    usage.agentRequestsLastMinute = Number(count?.['count'] ?? 0);
    return usage;
  }

  putAgent(input: Agent): void {
    const agent = AgentSchema.parse(input); const old = this.getAgent(agent.id);
    requireThat(!old || old.status !== 'revoked' || agent.status === 'revoked');
    requireThat(!old || old.createdAt === agent.createdAt);
    this.exec('INSERT INTO agents(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', agent.id, encode(agent));
  }
  putCredential(input: AgentCredential): void {
    const credential = AgentCredentialSchema.parse(input); const old = this.getCredential(credential.id);
    const agent = this.getAgent(credential.agentId);
    requireThat(agent && (agent.status === 'active' || (old && credential.revokedAt !== null)));
    requireThat(!old || (old.agentId === credential.agentId && old.tokenHash === credential.tokenHash && old.createdAt === credential.createdAt && (old.revokedAt === null || old.revokedAt === credential.revokedAt)));
    this.exec('INSERT INTO credentials(id, agent_id, token_hash, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', credential.id, credential.agentId, credential.tokenHash, encode(credential));
  }
  revokeAgentCredentials(agentId: string, at: number): void {
    TimestampSchema.parse(at);
    for (const row of this.rows('SELECT data FROM credentials WHERE agent_id = ?', agentId)) {
      const credential = decode(row, AgentCredentialSchema);
      if (credential.revokedAt === null) this.putCredential({ ...credential, revokedAt: at });
    }
  }
  putPolicy(input: AgentPolicy, expectedRevision: number | null): void {
    const policy = AgentPolicySchema.parse(input); const old = this.getPolicy(policy.agentId);
    requireThat((old?.revision ?? null) === expectedRevision && policy.revision === (expectedRevision ?? 0) + 1);
    this.exec('INSERT INTO policies(agent_id, revision, data) VALUES (?, ?, ?)', policy.agentId, policy.revision, encode(policy));
  }
  putWalletPolicy(input: WalletPolicy, expectedRevision: number | null): void {
    const policy = WalletPolicySchema.parse(input); const old = this.getWalletPolicy();
    requireThat((old?.revision ?? null) === expectedRevision && policy.revision === (expectedRevision ?? 0) + 1);
    this.exec('INSERT INTO wallet_policies(revision, data) VALUES (?, ?)', policy.revision, encode(policy));
  }
  insertRequest(input: TransferRequest): void {
    const request = TransferRequestSchema.parse(input);
    const existing = this.findRequestByIdempotency(request.agentId, request.idempotencyKey);
    if (existing && existing.requestDigest !== request.requestDigest) throw new BrokerError('IDEMPOTENCY_CONFLICT');
    requireThat(request.requestDigest === requestDigest({ agentId: request.agentId, receiverId: request.receiverId, amount: toDecimalText(request.amount), memo: request.memo ?? null }));
    if (existing) return; // Valid replay: no new admission or metadata writes.
    requireThat(this.getAgent(request.agentId)?.status === 'active');
    requireThat(['denied', 'pending_approval', 'queued'].includes(request.state));
    this.exec('INSERT INTO requests(id, agent_id, idempotency_key, digest, state, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)', request.id, request.agentId, request.idempotencyKey, request.requestDigest, request.state, request.createdAt, encode(request));
    if (request.state !== 'denied') this.exec('INSERT INTO admissions(request_id) VALUES (?)', request.id);
  }
  updateRequest(input: TransferRequest, expectedState: TransferState): void {
    const request = TransferRequestSchema.parse(input); const old = this.getRequest(request.id);
    requireThat(old, 'NOT_FOUND');
    requireThat(old.state === expectedState && isAllowedTransition(old.state, request.state));
    const immutable = ['id', 'agentId', 'idempotencyKey', 'requestDigest', 'receiverId', 'amount', 'memo', 'createdAt'] as const;
    requireThat(immutable.every((key) => old[key] === request[key]));
    // Once a signed hash exists only the proven-unexecuted seam may change it.
    requireThat(old.txHash === null || old.txHash === request.txHash);
    const attempts = this.listAttempts(request.id);
    if (['signed', 'submitted', 'outcome_unknown'].includes(request.state)) requireThat(request.txHash !== null);
    if (request.txHash !== null) requireThat(attempts.some((a) => a.txHash === request.txHash));
    // Recoverable signed bytes may only remain in the post-signing lane.
    // Never return them to approval/queueing or finalize around an unresolved send.
    if (terminal.has(request.state) || ['pending_approval', 'approved', 'queued'].includes(request.state)) {
      requireThat(!attempts.some((a) => (OUTBOX_STATUSES as readonly string[]).includes(a.status)));
    }
    this.exec('UPDATE requests SET state = ?, data = ? WHERE id = ? AND state = ?', request.state, encode(request), request.id, expectedState);
  }
  putHold(input: Hold): void {
    const hold = HoldSchema.parse(input); const old = this.getHold(hold.requestId);
    const request = this.getRequest(hold.requestId);
    requireThat(request && request.agentId === hold.agentId && request.amount === hold.principal);
    // Revocation blocks reservations, not settlement/release of ambiguous work.
    if (hold.status === 'active') requireThat(this.getAgent(hold.agentId)?.status === 'active');
    requireThat(!old || (old.agentId === hold.agentId && old.principal === hold.principal && old.feeReserve === hold.feeReserve && (old.status === 'active' || old.status === hold.status)));
    this.exec('INSERT INTO holds(request_id, agent_id, principal, fee_reserve, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET status = excluded.status', hold.requestId, hold.agentId, toDecimalText(hold.principal), toDecimalText(hold.feeReserve), hold.status);
  }
  appendAccounting(input: AccountingEntry): void {
    const entry = AccountingEntrySchema.parse(input);
    this.exec('INSERT INTO accounting(id, request_id, agent_id, kind, amount, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)', entry.id, entry.requestId, entry.agentId, entry.kind, toDecimalText(entry.amount), entry.at, encode(entry));
  }
  putStandingApproval(input: StandingApproval): void {
    const approval = StandingApprovalSchema.parse(input); const old = this.getStandingApproval(approval.id);
    // Grants are immutable except monotonic settlement usage and revocation.
    requireThat(!old || (same({ ...old, usedTotal: approval.usedTotal, revokedAt: approval.revokedAt }, { ...approval, revokedAt: approval.revokedAt }) && approval.usedTotal >= old.usedTotal && (old.revokedAt === undefined || old.revokedAt === approval.revokedAt)));
    this.exec('INSERT INTO standing_approvals(id, agent_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', approval.id, approval.agentId, encode(approval));
  }
  putRequestApproval(input: RequestApproval): void {
    const approval = RequestApprovalSchema.parse(input); const request = this.getRequest(approval.requestId);
    requireThat(request && request.agentId === approval.agentId && request.requestDigest === approval.requestDigest);
    // The caller may update the decision's policyRevision later in this same
    // transaction; the evaluator, not persistence order, validates grant freshness.
    this.exec('INSERT INTO request_approvals(request_id, id, data) VALUES (?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET id = excluded.id, data = excluded.data', approval.requestId, approval.id, encode(approval));
  }
  putFreeze(input: Freeze): void {
    const freeze = FreezeSchema.parse(input);
    if (freeze.scope === 'agent') requireThat(this.getAgent(freeze.agentId));
    this.exec('INSERT INTO freezes(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', freeze.scope === 'global' ? 'global' : `agent:${freeze.agentId}`, encode(freeze));
  }
  private getAttempt(id: string): TxAttempt | null {
    return this.one('SELECT data FROM attempts WHERE network = ? AND account_id = ? AND id = ?', ['testnet', this.options.accountId, id], TxAttemptSchema, fields.attempt);
  }
  putAttempt(input: TxAttempt): void { this.saveAttempt(TxAttemptSchema.parse(input), false); }
  private saveAttempt(attempt: TxAttempt, replacement: boolean): void {
    const request = this.getRequest(attempt.requestId); requireThat(request, 'NOT_FOUND');
    requireThat(attempt.nonce <= MAX_NONCE, 'NONCE_CONFLICT');
    const old = this.getAttempt(attempt.id);
    if (old) {
      const immutable = ['id', 'requestId', 'nonce', 'publicKey', 'blockHash', 'signedTxBase64', 'txHash', 'createdAt'] as const;
      requireThat(immutable.every((key) => old[key] === attempt[key]));
      const watchEnrollment = ['failed', 'proven_not_executed'].includes(old.status) && request.state === 'failed'
        && old.resolutionWatch === undefined && attempt.resolutionWatch === true
        && same({ ...old, resolutionWatch: true }, attempt)
        && this.rows('SELECT data FROM receipts WHERE chain_id = ?', `agent:${request.agentId}`).some((row) => {
          const receipt = decode(row, ReceiptEventSchema);
          return receipt.type === 'failed' && receipt.payload.resolution?.attemptId === old.id
            && receipt.payload.resolution.basis !== 'never_offered';
        });
      const proofCorrection = old.status === 'proven_not_executed' && request.txHash === old.txHash
        && ['signed', 'submitted', 'outcome_unknown'].includes(request.state)
        && ['submitted', 'succeeded', 'failed'].includes(attempt.status)
        && (attempt.status === 'submitted' || (attempt.gasBurnt !== null && attempt.tokensBurnt !== null));
      requireThat(!['succeeded', 'failed', 'proven_not_executed'].includes(old.status) || same(old, attempt) || proofCorrection || watchEnrollment);
      requireThat(attempt.status !== 'signed' || old.status === 'signed');
      requireThat(old.nonExecutionEvidence === null || old.nonExecutionEvidence === attempt.nonExecutionEvidence);
      requireThat(old.offerCount === undefined
        ? attempt.offerCount === undefined || attempt.offerCount >= 2
        : attempt.offerCount !== undefined && attempt.offerCount >= old.offerCount);
      requireThat(old.firstRejection === undefined || old.firstRejection === attempt.firstRejection);
      requireThat(attempt.firstRejection === undefined || (old.firstRejection === attempt.firstRejection
        || (attempt.offerCount === 1 && old.offerCount === 1)));
      // Offer timestamps are monotonic durable intent; never erase a past offer.
      requireThat(old.lastOfferedAt === undefined || old.lastOfferedAt === null
        || (attempt.lastOfferedAt !== undefined && attempt.lastOfferedAt !== null && attempt.lastOfferedAt >= old.lastOfferedAt));
    } else {
      requireThat(attempt.status === 'signed' && attempt.nonce > 0n && attempt.nonce <= this.getLocalNonce(attempt.publicKey), 'NONCE_CONFLICT');
      requireThat(replacement || (request.state === 'queued' && request.txHash === null && this.listAttempts(request.id).length === 0));
    }
    this.exec('INSERT INTO attempts(id, request_id, network, account_id, status, public_key, nonce, tx_hash, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data', attempt.id, attempt.requestId, 'testnet', this.options.accountId, attempt.status, attempt.publicKey, attempt.nonce.toString(), attempt.txHash, encode(attempt));
  }
  correctResolvedExecution(input: TransferRequest, inputAttempt: TxAttempt): void {
    const request = TransferRequestSchema.parse(input); const attempt = TxAttemptSchema.parse(inputAttempt);
    const old = this.getRequest(request.id); const prior = this.getAttempt(attempt.id); const hold = this.getHold(request.id);
    requireThat(old && prior && hold && old.state === 'failed' && prior.resolutionWatch === true
      && attempt.resolutionWatch === false && ['failed', 'proven_not_executed'].includes(prior.status)
      && old.txHash === prior.txHash && request.txHash === prior.txHash && attempt.requestId === old.id
      && (request.state === 'succeeded' || request.state === 'failed') && attempt.status === request.state
      && attempt.gasBurnt !== null && attempt.tokensBurnt !== null
      && request.gasBurnt === attempt.gasBurnt && request.tokensBurnt === attempt.tokensBurnt
      && (hold.status === 'active' || hold.status === 'released'));
    const immutableRequest = ['id', 'agentId', 'idempotencyKey', 'requestDigest', 'receiverId', 'amount', 'memo', 'createdAt',
      'approvalRef', 'policyRevision', 'reasons', 'expiresAt', 'signedAt', 'submittedAt'] as const;
    const immutableAttempt = ['id', 'requestId', 'nonce', 'publicKey', 'blockHash', 'signedTxBase64', 'txHash', 'createdAt', 'lastOfferedAt', 'offerCount', 'firstRejection', 'nonExecutionEvidence'] as const;
    requireThat(immutableRequest.every((key) => same(old[key], request[key]))
      && immutableAttempt.every((key) => prior[key] === attempt[key]));
    // The sole terminal-resolution correction seam; generic state/hold updates
    // still cannot reopen failed work or resurrect released reservations.
    this.exec('UPDATE attempts SET status = ?, data = ? WHERE id = ?', attempt.status, encode(attempt), attempt.id);
    this.exec('UPDATE requests SET state = ?, data = ? WHERE id = ?', request.state, encode(request), request.id);
    this.exec("UPDATE holds SET status = 'committed' WHERE request_id = ?", request.id);
  }
  replaceUnexecutedAttempt(requestId: string, previousAttemptId: string, input: TxAttempt): void {
    const replacement = TxAttemptSchema.parse(input); const request = this.getRequest(requestId);
    const prior = this.getAttempt(previousAttemptId);
    requireThat(request && prior && prior.requestId === requestId && prior.txHash === request.txHash && prior.status === 'proven_not_executed' && prior.nonExecutionEvidence !== null);
    requireThat(request.state === 'signed' || request.state === 'outcome_unknown');
    requireThat(replacement.requestId === requestId && replacement.id !== prior.id && replacement.publicKey === prior.publicKey && replacement.nonce > prior.nonce && replacement.nonce === this.getLocalNonce(replacement.publicKey), 'NONCE_CONFLICT');
    requireThat(!this.row('SELECT 1 FROM attempts WHERE id = ?', replacement.id));
    this.saveAttempt(replacement, true);
    this.exec('UPDATE requests SET data = ? WHERE id = ?', encode({ ...request, txHash: replacement.txHash, updatedAt: replacement.updatedAt }), requestId);
  }
  allocateNonce(publicKey: string, chainNonce: bigint): bigint {
    Ed25519PublicKeySchema.parse(publicKey);
    requireThat(typeof chainNonce === 'bigint' && chainNonce >= 0n && chainNonce <= MAX_NONCE, 'NONCE_CONFLICT');
    const local = this.getLocalNonce(publicKey); const next = (local > chainNonce ? local : chainNonce) + 1n;
    requireThat(next <= MAX_NONCE, 'NONCE_CONFLICT');
    this.exec('INSERT INTO nonces(network, account_id, public_key, nonce) VALUES (?, ?, ?, ?) ON CONFLICT(network, account_id, public_key) DO UPDATE SET nonce = excluded.nonce', 'testnet', this.options.accountId, publicKey, next.toString());
    return next;
  }
  putBalance(input: AccountBalance, validUntil: number): void {
    const balance = AccountBalanceSchema.parse(input); TimestampSchema.parse(validUntil);
    requireThat(balance.accountId === this.options.accountId && validUntil >= balance.observedAt);
    const old = this.balance();
    requireThat(!old || balance.observedAt >= old.balance.observedAt);
    this.exec('INSERT INTO balance(id, valid_until, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET valid_until = excluded.valid_until, data = excluded.data', validUntil, encode(balance));
  }
  insertReceipt(input: ReceiptEvent): void {
    const receipt = ReceiptEventSchema.parse(input); const head = this.getReceiptHead(receipt.chainId);
    requireThat(receipt.seq === (head?.seq ?? 0) + 1 && receipt.prevHash === (head?.hash ?? GENESIS_PREV_HASH), 'AUDIT_UNAVAILABLE');
    this.exec('INSERT INTO receipts(chain_id, seq, hash, data) VALUES (?, ?, ?, ?)', receipt.chainId, receipt.seq, receipt.hash, encode(receipt));
  }
  insertCheckpoint(input: Checkpoint): void {
    const checkpoint = CheckpointSchema.parse(input); const head = this.getCheckpointHead(checkpoint.chainId);
    const receipt = this.row('SELECT hash FROM receipts WHERE chain_id = ? AND seq = ?', checkpoint.chainId, checkpoint.seq);
    requireThat(checkpoint.previousCheckpointHash === (head?.hash ?? null) && checkpoint.seq > (head?.seq ?? 0) && receipt?.['hash'] === checkpoint.headHash, 'AUDIT_UNAVAILABLE');
    this.exec('INSERT INTO checkpoints(chain_id, seq, data) VALUES (?, ?, ?)', checkpoint.chainId, checkpoint.seq, encode(checkpoint));
  }
  consumeOwnerNonce(nonce: string, expiresAt: number, now: number): boolean {
    requireThat(/^[A-Za-z0-9_-]{22,128}$/.test(nonce)); TimestampSchema.parse(expiresAt); TimestampSchema.parse(now);
    requireThat(expiresAt >= now);
    // Strict < keeps the boundary millisecond replay-protected. No cleanup that
    // can commit independently of the authenticated mutation.
    this.exec('DELETE FROM owner_nonces WHERE expires_at < ?', now);
    if (this.row('SELECT 1 FROM owner_nonces WHERE nonce = ?', nonce)) return false;
    this.exec('INSERT INTO owner_nonces(nonce, expires_at) VALUES (?, ?)', nonce, expiresAt);
    return true;
  }
}
