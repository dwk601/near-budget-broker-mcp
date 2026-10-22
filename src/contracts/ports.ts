import type { Agent, AgentCredential, AgentPrincipal, Freeze, IssuedCredential, OwnerPrincipal } from './agents.js';
import type { AppendReceipt, ChainId, ReceiptEvent, ReceiptVerification } from './audit.js';
import type { OwnerVerificationInput } from './auth.js';
import type { AccountBalance, AccessKeyView, BroadcastResult, ChainOutcome, EncryptedCustodyKey, NativeTransferToSign, RecentBlock, SignedNativeTransfer, TxAttempt } from './chain.js';
import type { Checkpoint, CheckpointVerification } from './checkpoints.js';
import type { ApproveRequestCommand, GrantStandingApprovalCommand, RejectRequestCommand, RevokeStandingApprovalCommand, StandingApprovalConsumeInput, StandingApprovalGrant, StandingApprovalMatch, StandingApprovalMatchInput } from './approvals.js';
import type { BudgetStatus, WalletStatus } from './status.js';
import type { AgentPolicy, PolicyDecision, PolicyEvaluationInput, RequestApproval, StandingApproval, UsageSnapshot, WalletPolicy } from './policy.js';
import type { Ed25519PublicKey, JsonValue, Page, PageQuery, Timestamp } from './primitives.js';
import type { AccountingEntry, Hold, TransferInput, TransferRequest, TransferState, TransferView } from './transfers.js';

export interface Clock { now(): Timestamp }

/** Sync methods: never await network/IO in a node:sqlite transaction. */
export interface StoreReader {
  getAgent(agentId: string): Agent | null;
  listAgents(query: PageQuery): Page<Agent>;
  getCredential(credentialId: string): AgentCredential | null;
  listCredentials(agentId: string, query: PageQuery): Page<AgentCredential>;
  findCredentialByHash(tokenHash: string): AgentCredential | null;
  getPolicy(agentId: string): AgentPolicy | null;
  getWalletPolicy(): WalletPolicy | null;
  /** Owner/internal only; works even when the wallet has no agents. */
  getWalletStatus(now: Timestamp): WalletStatus;
  getRequest(requestId: string): TransferRequest | null;
  findRequestByIdempotency(agentId: string, idempotencyKey: string): TransferRequest | null;
  listRequests(filter: RequestFilter, query: PageQuery): Page<TransferRequest>;
  getHold(requestId: string): Hold | null;
  listAccounting(filter: AccountingFilter, query: PageQuery): Page<AccountingEntry>;
  getUsageSnapshot(agentId: string, now: Timestamp, excludeRequestId?: string): UsageSnapshot;
  listStandingApprovals(agentId: string, query: PageQuery): Page<StandingApproval>;
  getStandingApproval(id: string): StandingApproval | null;
  getRequestApproval(requestId: string): RequestApproval | null;
  getFreeze(scope: 'global' | 'agent', agentId?: string): Freeze | null;
  listAttempts(requestId: string): TxAttempt[];
  /** ONLY unresolved attempts (OUTBOX_STATUSES), including ambiguity; no final or
   * proven_not_executed history. ID paging order is NOT dispatch/nonce order. */
  listOutbox(query: PageQuery): Page<TxAttempt>;
  getLocalNonce(publicKey: string): bigint;
  getReceiptHead(chainId: ChainId): ReceiptEvent | null;
  /** Ascending seq, strictly after afterSeq (0 starts); limit 1..1000. */
  listReceipts(chainId: ChainId, afterSeq: number, limit: number): ReceiptEvent[];
  getCheckpointHead(chainId: ChainId): Checkpoint | null;
  /** Ascending checkpoint seq, exclusive cursor; limit 1..1000. */
  listCheckpoints(chainId: ChainId, afterSeq: number, limit: number): Checkpoint[];
}
export interface StoreTransaction extends StoreReader {
  /** Never reactivate a revoked agent; freeze state is not stored here. */
  putAgent(agent: Agent): void;
  putCredential(credential: AgentCredential): void;
  revokeAgentCredentials(agentId: string, at: Timestamp): void;
  /** CAS revisions; null means insert only. */
  putPolicy(policy: AgentPolicy, expectedRevision: number | null): void;
  putWalletPolicy(policy: WalletPolicy, expectedRevision: number | null): void;
  /** UNIQUE(agentId, idempotencyKey), immutable digest and transfer fields. */
  insertRequest(request: TransferRequest): void;
  /** CAS current state and enforce ALLOWED_TRANSITIONS, rejecting same-state or
   * immutable-field changes. Atomically update txHash/fees with a valid transition. */
  updateRequest(request: TransferRequest, expectedState: TransferState): void;
  /** The sole same-state exception: prior attempt MUST be proven_not_executed,
   * match request.txHash, and request state signed|outcome_unknown. Atomically
   * persist replacement signed bytes and switch txHash; retain old evidence and
   * holds, require strictly higher allocated nonce. Never a blind retry. */
  replaceUnexecutedAttempt(requestId: string, previousAttemptId: string, replacement: TxAttempt): void;
  putHold(hold: Hold): void;
  appendAccounting(entry: AccountingEntry): void;
  putStandingApproval(approval: StandingApproval): void;
  putRequestApproval(approval: RequestApproval): void;
  putFreeze(freeze: Freeze): void;
  /** Positive execution may correct a current proven_not_executed observation;
   * its exclusion evidence and signed identity must be retained. */
  putAttempt(attempt: TxAttempt): void;
  /** Narrow correction for a failed, explicitly resolved current attempt with a
   * resolutionWatch marker. Requires actual final execution; atomically corrects
   * request/attempt/hold without reopening any generic terminal transition.
   * Caller appends actual accounting and signed correction receipts in this tx. */
  correctResolvedExecution(request: TransferRequest, attempt: TxAttempt): void;
  /** Persist max(local, chain)+1, strictly increasing for the custody key. */
  allocateNonce(publicKey: string, chainNonce: bigint): bigint;
  putBalance(balance: AccountBalance, validUntil: Timestamp): void;
  /** UNIQUE(chainId, seq); compare current head to prevHash, reject forks. */
  insertReceipt(receipt: ReceiptEvent): void;
  /** UNIQUE(chainId,seq), monotonic seq and CAS previousCheckpointHash; headHash
   * must match the stored receipt at seq. First previousCheckpointHash is null. */
  insertCheckpoint(checkpoint: Checkpoint): void;
  /** Atomic insert-if-unused; survives restarts. Retain through expiresAt inclusive. */
  consumeOwnerNonce(nonce: string, expiresAt: Timestamp, now: Timestamp): boolean;
}
export interface RequestFilter { agentId?: string; states?: TransferState[] }
export interface AccountingFilter { agentId?: string; requestId?: string }
export interface Store {
  read<T>(operation: (view: StoreReader) => T): T;
  /** BEGIN IMMEDIATE, sync callback, COMMIT; any throw rolls back everything.
   * Implementations must reject thenables returned by a callback at runtime. */
  withImmediateTransaction<T>(operation: (tx: StoreTransaction) => T): T;
  close(): void;
}

export interface PolicyEvaluator { evaluate(input: PolicyEvaluationInput): PolicyDecision }
export interface Authenticator {
  /** Validate syntax/hash/revocation. Identity is never accepted from tool args. */
  authenticateAgent(token: string): Promise<AgentPrincipal>;
  /** Verify actual method/path/body, key, skew <=60s; durably consume nonce before return. */
  verifyOwnerRequest(input: OwnerVerificationInput): Promise<OwnerPrincipal>;
}
/** B04-provided synchronous audit signer, injected into ReceiptLog and B13
 * CheckpointLog. Separate from async custody signing and owner private keys. */
export interface AuditSigner {
  readonly publicKey: Ed25519PublicKey;
  /** Reject any input other than exactly 32 decoded SHA-256 bytes. */
  signHash(hashBytes: Uint8Array): Uint8Array;
}
export interface ReceiptLog {
  auditPublicKey(): Ed25519PublicKey;
  /** Signing and insertion in the caller's atomic transaction; no async side effects. */
  append(tx: StoreTransaction, event: AppendReceipt): ReceiptEvent;
  list(chainId: ChainId, afterSeq: number, limit: number): ReceiptEvent[];
  verify(chainId: ChainId): ReceiptVerification;
  verifyReceipt(receipt: ReceiptEvent): ReceiptVerification;
}
/** B13 implementation; creation/signing/insertion uses the caller's transaction.
 * One checkpoint per increasing nonempty chain head. Signing hashes canonical
 * checkpointHashInput bytes; sign the 32 decoded hash bytes, not hash text.
 * Local verification cannot detect rollback without an externally pinned head. */
export interface CheckpointLog {
  create(tx: StoreTransaction, chainId: ChainId, at: Timestamp): Checkpoint;
  list(chainId: ChainId, afterSeq: number, limit: number): Checkpoint[];
  verify(checkpoints: readonly Checkpoint[], trustedAuditPublicKey: Ed25519PublicKey): CheckpointVerification;
}
/** B12 implementation. Mutations are synchronous inside the broker's existing
 * BEGIN IMMEDIATE, including approval/hold/state/receipt changes. Never open a
 * nested transaction. Broker authenticates owner and checks fresh hard caps;
 * B12 validates request state, digest/revision, expiry and grant bounds. */
export interface ApprovalService {
  approve(tx: StoreTransaction, command: ApproveRequestCommand): TransferRequest;
  reject(tx: StoreTransaction, command: RejectRequestCommand): TransferRequest;
  grantStandingApproval(tx: StoreTransaction, command: GrantStandingApprovalCommand): StandingApproval;
  revokeStandingApproval(tx: StoreTransaction, command: RevokeStandingApprovalCommand): StandingApproval;
  /** Pure: no storage, receipts, clock reads or mutation of input objects. */
  matchStandingApproval(input: StandingApprovalMatchInput): StandingApprovalMatch;
  consumeStandingApproval(input: StandingApprovalConsumeInput): StandingApproval;
}
export interface CustodySigner {
  readonly publicKey: string;
  /** Sign bytes, not arbitrary JSON. Secrets never leave the daemon. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}
export interface Custody {
  encryptKey(secretKey: string, passphrase: Uint8Array): Promise<EncryptedCustodyKey>;
  loadKey(encrypted: EncryptedCustodyKey, passphrase: Uint8Array): Promise<CustodySigner>;
  lock(): Promise<void>;
}
export interface NearChain {
  /** Must attest RPC chain_id=testnet before any signing/broadcast. */
  verifyNetwork(): Promise<'testnet'>;
  viewAccount(accountId: string): Promise<AccountBalance>;
  viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView>;
  recentBlockHash(): Promise<RecentBlock>;
  buildAndSignNativeTransfer(transfer: NativeTransferToSign, signer: CustodySigner): Promise<SignedNativeTransfer>;
  encodeSignedTx(transaction: SignedNativeTransfer): Uint8Array;
  decodeSignedTx(bytes: Uint8Array): SignedNativeTransfer;
  /** Broadcast exact persisted signed bytes, no implicit nonce selection/retry-signing. */
  broadcast(signedTxBase64: string): Promise<BroadcastResult>;
  /** Optional persisted attempt supplies exact bytes/nonce/block for positive
   * non-execution evidence; legacy two-argument readers remain supported. */
  txStatus(txHash: string, signerId: string, attempt?: TxAttempt): Promise<ChainOutcome>;
  classifyOutcome(rpcResponse: unknown): ChainOutcome;
}

export interface TransferPreview { decision: PolicyDecision; policyRevision: number | null; at: Timestamp }
export interface ReconcileResult { requests: TransferRequest[]; at: Timestamp }
export interface AgentBrokerService {
  requestTransfer(principal: AgentPrincipal, input: TransferInput): Promise<TransferView>;
  /** Read-only, no hold, idempotency row, or receipt; not an authorization to dispatch. */
  previewTransfer(principal: AgentPrincipal, input: TransferInput): Promise<TransferPreview>;
  getRequest(principal: AgentPrincipal, requestId: string): Promise<TransferView>;
  cancelRequest(principal: AgentPrincipal, requestId: string): Promise<TransferView>;
  budgetStatus(principal: AgentPrincipal): Promise<BudgetStatus>;
  listReceipts(principal: AgentPrincipal, afterSeq: number, limit: number): Promise<ReceiptEvent[]>;
  verifyReceipt(principal: AgentPrincipal, receipt: ReceiptEvent): Promise<ReceiptVerification>;
  freezeSelf(principal: AgentPrincipal, reason: string): Promise<Freeze>;
}
export interface OwnerBrokerService {
  createAgent(principal: OwnerPrincipal, name: string): Promise<Agent>;
  revokeAgent(principal: OwnerPrincipal, agentId: string, reason: string): Promise<Agent>;
  listAgents(principal: OwnerPrincipal, query: PageQuery): Promise<Page<Agent>>;
  getPolicy(principal: OwnerPrincipal, agentId: string): Promise<AgentPolicy | null>;
  listStandingApprovals(principal: OwnerPrincipal, agentId: string, query: PageQuery): Promise<Page<StandingApproval>>;
  walletStatus(principal: OwnerPrincipal): Promise<WalletStatus>;
  getFreeze(principal: OwnerPrincipal, target: FreezeTarget): Promise<Freeze | null>;
  getRequest(principal: OwnerPrincipal, requestId: string): Promise<TransferView>;
  auditPublicKey(principal: OwnerPrincipal): Promise<Ed25519PublicKey>;
  issueToken(principal: OwnerPrincipal, agentId: string): Promise<IssuedCredential>;
  rotateToken(principal: OwnerPrincipal, credentialId: string): Promise<IssuedCredential>;
  revokeToken(principal: OwnerPrincipal, credentialId: string): Promise<void>;
  setPolicy(principal: OwnerPrincipal, policy: AgentPolicy, expectedRevision: number | null): Promise<AgentPolicy>;
  setWalletPolicy(principal: OwnerPrincipal, policy: WalletPolicy, expectedRevision: number | null): Promise<WalletPolicy>;
  approve(principal: OwnerPrincipal, requestId: string, expiresAt: Timestamp): Promise<TransferRequest>;
  reject(principal: OwnerPrincipal, requestId: string, reason: string): Promise<TransferRequest>;
  grantStandingApproval(principal: OwnerPrincipal, grant: StandingApprovalGrant): Promise<StandingApproval>;
  revokeStandingApproval(principal: OwnerPrincipal, approvalId: string): Promise<StandingApproval>;
  freeze(principal: OwnerPrincipal, target: FreezeTarget, reason: string): Promise<Freeze>;
  unfreeze(principal: OwnerPrincipal, target: FreezeTarget, reason: string): Promise<Freeze>;
  /** Reconcile existing attempts only; never admit/dispatch unrelated queued work.
   * Result contains only requests examined by this call, not the request table. */
  reconcile(principal: OwnerPrincipal, requestId?: string): Promise<ReconcileResult>;
  /** Default requires fresh, aged exclusion with retained history (definitive
   * UNKNOWN_TRANSACTION and final nonce consumed/validity expired). Explicit
   * force may retire a still-uncertain lane item, but retains its full hold.
   * Pending/final execution always vetoes resolution. Requires a reason and
   * receipts on owner + agent chains. Resolved work is durably watched; late
   * execution corrects actual accounting. Never creates a replacement payment. */
  resolveAttempt(principal: OwnerPrincipal, requestId: string, reason: string, force?: boolean): Promise<TransferRequest>;
  exportReceipts(principal: OwnerPrincipal, chainId: ChainId, afterSeq: number, limit: number): Promise<ReceiptEvent[]>;
  listRequests(principal: OwnerPrincipal, filter: RequestFilter, query: PageQuery): Promise<Page<TransferRequest>>;
}
export type FreezeTarget = { scope: 'global' } | { scope: 'agent'; agentId: string };
export interface BrokerService extends Omit<AgentBrokerService, 'getRequest'>, Omit<OwnerBrokerService, 'getRequest'> {
  /** Agent ownership filter is mandatory; owner may read any request. */
  getRequest(principal: AgentPrincipal | OwnerPrincipal, requestId: string): Promise<TransferView>;
}

/** Shared JSON contract: bigint -> unsigned decimal TEXT, never Number(bigint).
 * Object keys sorted recursively per RFC 8785; arrays retain order; undefined,
 * unsafe/fractional numbers, non-JSON values and duplicate JSON keys rejected.
 * Canonical hashes/signatures use UTF-8 and lowercase SHA-256 hex. */
export type CanonicalJson = JsonValue;
