import type { Agent, AgentCredential, AgentPrincipal, Freeze, IssuedCredential, OwnerPrincipal } from './agents.js';
import type { AppendReceipt, ChainId, ReceiptEvent, ReceiptVerification } from './audit.js';
import type { OwnerVerificationInput } from './auth.js';
import type { AccountBalance, AccessKeyView, ChainOutcome, EncryptedCustodyKey, NativeTransferToSign, RecentBlock, SignedNativeTransfer, TxAttempt } from './chain.js';
import type { AgentPolicy, PolicyDecision, PolicyEvaluationInput, RequestApproval, StandingApproval, UsageSnapshot, WalletPolicy } from './policy.js';
import type { JsonValue, Page, PageQuery, Timestamp } from './primitives.js';
import type { AccountingEntry, Hold, TransferInput, TransferRequest, TransferState } from './transfers.js';

export interface Clock { now(): Timestamp }

/** Sync methods: never await network/IO in a node:sqlite transaction. */
export interface StoreReader {
  getAgent(agentId: string): Agent | null;
  listAgents(query: PageQuery): Page<Agent>;
  getCredential(credentialId: string): AgentCredential | null;
  findCredentialByHash(tokenHash: string): AgentCredential | null;
  getPolicy(agentId: string): AgentPolicy | null;
  getWalletPolicy(): WalletPolicy | null;
  getRequest(requestId: string): TransferRequest | null;
  findRequestByIdempotency(agentId: string, idempotencyKey: string): TransferRequest | null;
  listRequests(filter: RequestFilter, query: PageQuery): Page<TransferRequest>;
  getHold(requestId: string): Hold | null;
  getUsageSnapshot(agentId: string, now: Timestamp, excludeRequestId?: string): UsageSnapshot;
  listStandingApprovals(agentId: string): StandingApproval[];
  getStandingApproval(id: string): StandingApproval | null;
  getRequestApproval(requestId: string): RequestApproval | null;
  getFreeze(scope: 'global' | 'agent', agentId?: string): Freeze | null;
  listAttempts(requestId: string): TxAttempt[];
  listOutbox(query: PageQuery): Page<TxAttempt>;
  getLocalNonce(publicKey: string): bigint;
  getReceiptHead(chainId: ChainId): ReceiptEvent | null;
  listReceipts(chainId: ChainId, afterSeq: number, limit: number): ReceiptEvent[];
}
export interface StoreTransaction extends StoreReader {
  putAgent(agent: Agent): void;
  putCredential(credential: AgentCredential): void;
  /** CAS revisions; null means insert only. */
  putPolicy(policy: AgentPolicy, expectedRevision: number | null): void;
  putWalletPolicy(policy: WalletPolicy, expectedRevision: number | null): void;
  /** UNIQUE(agentId, idempotencyKey), immutable digest and transfer fields. */
  insertRequest(request: TransferRequest): void;
  updateRequest(request: TransferRequest, expectedState: TransferState): void;
  putHold(hold: Hold): void;
  appendAccounting(entry: AccountingEntry): void;
  putStandingApproval(approval: StandingApproval): void;
  putRequestApproval(approval: RequestApproval): void;
  putFreeze(freeze: Freeze): void;
  putAttempt(attempt: TxAttempt): void;
  /** Persist max(local, chain)+1, strictly increasing for the custody key. */
  allocateNonce(publicKey: string, chainNonce: bigint): bigint;
  putBalance(balance: AccountBalance, validUntil: Timestamp): void;
  /** UNIQUE(chainId, seq); compare current head to prevHash, reject forks. */
  insertReceipt(receipt: ReceiptEvent): void;
  /** Atomic insert-if-unused; survives restarts. Retain through expiresAt inclusive. */
  consumeOwnerNonce(nonce: string, expiresAt: Timestamp, now: Timestamp): boolean;
}
export interface RequestFilter { agentId?: string; states?: TransferState[] }
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
export interface ReceiptLog {
  /** Signing and insertion in the caller's atomic transaction; no async side effects. */
  append(tx: StoreTransaction, event: AppendReceipt): ReceiptEvent;
  list(chainId: ChainId, afterSeq: number, limit: number): ReceiptEvent[];
  verify(chainId: ChainId): ReceiptVerification;
  verifyReceipt(receipt: ReceiptEvent): ReceiptVerification;
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
  broadcast(signedTxBase64: string): Promise<{ txHash: string }>;
  txStatus(txHash: string, signerId: string): Promise<ChainOutcome>;
  classifyOutcome(rpcResponse: unknown): ChainOutcome;
}

export interface BudgetStatus {
  agent: Agent;
  policy: AgentPolicy | null;
  walletPolicy: WalletPolicy | null;
  usage: UsageSnapshot;
  at: Timestamp;
}
export interface TransferPreview { decision: PolicyDecision; policyRevision: number | null; at: Timestamp }
export interface ReconcileResult { requests: TransferRequest[]; at: Timestamp }
export interface AgentBrokerService {
  requestTransfer(principal: AgentPrincipal, input: TransferInput): Promise<TransferRequest>;
  /** Read-only, no hold, idempotency row, or receipt; not an authorization to dispatch. */
  previewTransfer(principal: AgentPrincipal, input: TransferInput): Promise<TransferPreview>;
  getRequest(principal: AgentPrincipal, requestId: string): Promise<TransferRequest>;
  cancelRequest(principal: AgentPrincipal, requestId: string): Promise<TransferRequest>;
  budgetStatus(principal: AgentPrincipal): Promise<BudgetStatus>;
  listReceipts(principal: AgentPrincipal, afterSeq: number, limit: number): Promise<ReceiptEvent[]>;
  verifyReceipt(principal: AgentPrincipal, receipt: ReceiptEvent): Promise<ReceiptVerification>;
  freezeSelf(principal: AgentPrincipal, reason: string): Promise<Freeze>;
}
export interface OwnerBrokerService {
  createAgent(principal: OwnerPrincipal, name: string): Promise<Agent>;
  issueToken(principal: OwnerPrincipal, agentId: string): Promise<IssuedCredential>;
  rotateToken(principal: OwnerPrincipal, credentialId: string): Promise<IssuedCredential>;
  revokeToken(principal: OwnerPrincipal, credentialId: string): Promise<void>;
  setPolicy(principal: OwnerPrincipal, policy: AgentPolicy, expectedRevision: number | null): Promise<AgentPolicy>;
  setWalletPolicy(principal: OwnerPrincipal, policy: WalletPolicy, expectedRevision: number | null): Promise<WalletPolicy>;
  approve(principal: OwnerPrincipal, requestId: string, expiresAt: Timestamp): Promise<TransferRequest>;
  reject(principal: OwnerPrincipal, requestId: string, reason: string): Promise<TransferRequest>;
  grantStandingApproval(principal: OwnerPrincipal, grant: Omit<StandingApproval, 'id' | 'usedTotal' | 'revokedAt'>): Promise<StandingApproval>;
  revokeStandingApproval(principal: OwnerPrincipal, approvalId: string): Promise<StandingApproval>;
  freeze(principal: OwnerPrincipal, target: FreezeTarget, reason: string): Promise<Freeze>;
  unfreeze(principal: OwnerPrincipal, target: FreezeTarget, reason: string): Promise<Freeze>;
  reconcile(principal: OwnerPrincipal, requestId?: string): Promise<ReconcileResult>;
  exportReceipts(principal: OwnerPrincipal, chainId: ChainId, afterSeq: number, limit: number): Promise<ReceiptEvent[]>;
  listRequests(principal: OwnerPrincipal, filter: RequestFilter, query: PageQuery): Promise<Page<TransferRequest>>;
}
export type FreezeTarget = { scope: 'global' } | { scope: 'agent'; agentId: string };
export interface BrokerService extends AgentBrokerService, OwnerBrokerService {}

/** Shared JSON contract: bigint -> unsigned decimal TEXT, never Number(bigint).
 * Object keys sorted recursively per RFC 8785; arrays retain order; undefined,
 * unsafe/fractional numbers, non-JSON values and duplicate JSON keys rejected.
 * Canonical hashes/signatures use UTF-8 and lowercase SHA-256 hex. */
export type CanonicalJson = JsonValue;
