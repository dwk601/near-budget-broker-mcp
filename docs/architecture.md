# Budget Broker MCP — frozen foundation (B00)

This is the authoritative integration contract. `src/contracts/index.ts` is the
public TypeScript barrel; adjacent Zod schemas validate shared data. These files,
package metadata/lockfile and compiler/test configs are B00-owned. Later tasks
must request a B00 amendment rather than silently change their signatures.
There is deliberately no daemon, storage, policy or chain implementation yet.
The post-review B00 amendment below is authoritative over the initial commit:
shared canonical byte helpers, scoped status, explicit approval/checkpoint seams,
per-type receipts, single-source freeze state and bounded u128 monetary inputs.

## Product and trust boundary

One **NEAR testnet** custody account backs many mutually hostile agents. Only
native NEAR transfers are supported: no FT, arbitrary actions, contract calls,
agent-selected signer, access-key management or mainnet fallback. A long-running
Docker daemon holds custody and audit secrets. Its SQLite database and encrypted
custody key live in a named volume, not an agent-accessible bind mount.

The npm bin is `budget-broker` -> `dist/main.js`. `budget-broker mcp` is an npx-
installable stdio bridge, not an in-process broker. It proxies MCP stdio to the
daemon's Streamable HTTP `/mcp` endpoint using the agent bearer token. Never log
tokens or protocol messages on stdout. The owner CLI uses a separate admin port
and Ed25519-signed HTTP requests; it has no agent-budget bypass endpoint. The
daemon knows only the owner's public key, never the owner's private key.

Host-published ports bind **127.0.0.1 only** (default agent 3210, admin 3211).
A container listener may bind its container interface to permit Docker forwarding;
never publish either port on `0.0.0.0` on the host. Validate Host/Origin against
DNS rebinding, authenticate every HTTP request including existing MCP sessions,
and never interpret an MCP session ID as an authorization credential. Do not
expose owner tools through MCP. Containers receive no Docker socket or host
credentials. Agents get neither named-volume paths nor decryption secrets.

**Threat-model limit:** Docker alone is not a security boundary against a host
user who can control Docker, read owner private keys/unlock secrets, inspect
container memory, or become root. Same-user agent shells must be denied those
capabilities by the deployment sandbox; the owner signing environment must be
separate/protected. Encryption at rest protects locked data, not a compromised
unlocked daemon. No guarantee here claims otherwise. The isolation task must
exercise this boundary; never solve it by moving custody back into the bridge.

## Build, package and test conventions

- Node >=24, ESM, strict TypeScript, NodeNext resolution; use `.js` import paths
  in TypeScript. Runtime uses built-in `node:sqlite`, **no SQLite npm dependency**.
- `tsconfig.json`: `rootDir=src`, `outDir=dist`, declarations/source maps.
  `tsconfig.test.json` additionally typechecks tests, scripts and Vitest config
  without emitting. Tests/scripts never enter the distributable `dist` tree.
- Exact pins: near-api-js 7.3.1, @modelcontextprotocol/sdk 1.32.1, Zod 4.6.7
  (SDK peer range `^3.25 || ^4.0`), TypeScript 5.9.3, Vitest 4.1.12,
  tsx 4.23.15, @types/node 24.19.2. Commit `package-lock.json`; use `npm ci`.
- Package stays `near-budget-broker-mcp`, private, MIT. Allowlist: `dist`,
  `README.md`, `LICENSE`, `skills`, `examples`, `docker`. No secrets, databases,
  tests or fixture artifacts in the package. No auto-launch daemon in postinstall.
- `build` compiles; `typecheck` emits nothing; `check:all` runs typecheck, build,
  then offline tests. `test` runs all `test/**/*.test.ts` except `test/live/**`.
  Offline includes local protocol/e2e/performance tests: use injected Clock,
  in-memory/temp storage and mock chain/network boundaries, not public RPCs.
- All area scripts exist now. Each non-contract suite intentionally throws
  `not implemented: <area>`; replacing the placeholder with genuine assertions
  is the owning task's responsibility. Do not skip/todo it or set passWithNoTests.
  Consequently `test` and `check:all` **must fail at B00**. `test:contracts` passes.
- Areas map to `test/<area>` except `mcp` -> `test/mcp/local`, `http` ->
  `test/mcp/http`, `audit` -> `test/audit/core`, `checkpoints` ->
  `test/audit/checkpoints`, `live:native` -> `test/live/native`.
- `fixtures:native`: `tsx scripts/fixtures/native/index.ts`; `demo:testnet`:
  `tsx scripts/demo/index.ts`. Both stubs print `not implemented` and exit 1.
  Live tests are opt-in, testnet-only, explicitly funded and never run by `test`.

## Module ownership (disjoint writer paths)

| Task | Owned implementation paths | Test paths / other responsibility |
| --- | --- | --- |
| B00 | `src/contracts/**` | `test/contracts/**`, package/lock/configs, LICENSE, this document; initial main stub |
| B01 | `src/storage/**` | `test/storage/**` |
| B02 | `src/policy/**` | `test/policy/**` |
| B03 | `src/auth/**` | `test/auth/**` |
| B04 | `src/audit/core/**` | `test/audit/core/**` |
| B05 | `src/near/**`, `src/custody/**` | `test/near/**`, `test/custody/**` |
| B06 | `src/broker/**` | `test/broker/**` |
| B07 | `src/mcp/local/**`, `src/mcp/http/**`, `src/bridge/**` | `test/mcp/local/**`, `test/mcp/http/**` |
| B08 | `src/daemon/**`, `src/cli/**`, `src/main.ts`, `docker/**` | `test/cli/**`, `test/isolation/**`, `test/package/**` |
| B12 | `src/approvals/**` | `test/approvals/**` |
| B13 | `src/audit/checkpoints/**` | `test/audit/checkpoints/**` |
| F00 | `scripts/fixtures/**` | native fixture tooling |
| B09 | README, `docs/**` except this file, `examples/**`, `skills/**` | operator/product documentation |
| B10 | `test/e2e/**`, `test/live/**`, `scripts/demo/**` | demo and live/e2e integration |
| B14 | `test/perf/**`, `.github/**` | performance and CI |

B08 replaces the B00 `src/main.ts` stub. Stub files in later-owned test/script
paths are handoffs, not permission to edit B00 contracts. Implementation-specific
helpers/types stay in the owning module; exported cross-module changes require
amendment. No implementation imports from another task's internals: inject ports.

## Representation and validation

### Amounts, time, canonical JSON

`YoctoNear` is a **bigint**; 1 NEAR = 10^24 yoctoNEAR. `parseNear` accepts only
unsigned ordinary decimal **strings**, at most 24 fractional digits, no signs,
whitespace, exponents, grouping, leading integer zeros or coercion. Zero is a
valid amount value but not a transfer. `formatNear` emits canonical decimals
without insignificant fractional zeros. One yocto is exactly
`0.000000000000000000000001`. Never use floats, `parseFloat`, `Number(bigint)`
or SQL REAL for amounts. ALL monetary domain/wire schemas and conversion helpers
enforce **0..2^128-1** (positive for transfers). Decimal TEXT is at most 39 digits;
human NEAR input is at most 40 characters/15 integer digits. Validation bounds
length before BigInt conversion, so million-digit hostile inputs never reach
BigInt parsing. Intermediate accounting arithmetic must also fail closed on
u128 overflow, never truncate/wrap. Chain adapters revalidate before encoding.

All amounts, nonces and gas-unit bigints persist as canonical unsigned decimal
**SQLite TEXT** (`0` or `[1-9][0-9]*`) and cross HTTP/MCP/JSON as the same text.
Schemas for domain records accept bigints; wire adapters must explicitly map
TEXT via `fromDecimalText`/`toDecimalText`. `TransferInputWireSchema` defines the
agent transfer boundary: `amount` is **yoctoNEAR text**, not NEAR decimals.
The CLI may accept human NEAR strings and convert exactly once. No global
BigInt.prototype.toJSON mutation. INTEGER columns may hold safe counters/time,
but not amounts/nonces. Do not sum or lexicographically compare amount TEXT in
SQL; read and perform exact bigint arithmetic under the admission transaction.

All `*At` and Clock values are safe integer Unix epoch **milliseconds**. Counts
and revisions are safe integers; agent/wallet policy revisions begin at 1.
Canonical JSON follows RFC 8785 key ordering/string escaping recursively, array
order preserved, with the restricted JSON domain in `JsonValueSchema` (safe
integer numbers only). Convert bigint monetary values to decimal TEXT first.
Reject undefined, non-finite/unsafe/fractional numbers, duplicate JSON keys and
non-JSON objects at boundaries. Hash UTF-8 canonical bytes with SHA-256, lowercase
64-character hex. No platform-specific serialization or implicit string coercion.

`src/contracts/canonical.ts` is the ONLY shared byte-format authority; import its
pure helpers rather than reimplementing signing/digests in each task:

| Helper | Exact result |
| --- | --- |
| `canonicalJson(value)` | canonical JSON string; UTF-16 code-unit key ordering, not UTF-8/codepoint order; arrays ordered; -0 -> 0 |
| `sha256Hex(textOrBytes)` | lowercase SHA-256 hex of UTF-8 string or exact bytes; no JSON quoting/hex decoding |
| `requestDigest(preimage)` | SHA-256 of canonical agentId/receiverId/yocto-TEXT amount/memo; missing or null memo -> null |
| `hashAgentToken(token)` | validate syntax then hash exact full UTF-8 token, including bb_agent_ prefix |
| `ownerSigningBytes(payload)` | validated canonical signing payload as UTF-8 Uint8Array, NOT a hash |
| `receiptHashInput(preimage)` | validated canonical receipt preimage bytes, excludes hash/signature |
| `checkpointHashInput(preimage)` | validated canonical checkpoint preimage bytes, excludes hash/signature |

No Unicode normalization; lone surrogates, sparse/extended arrays, cycles,
accessors, non-enumerable properties, symbols, toJSON/classes and depths >128
are rejected. Objects must be plain or null-prototype. Numeric-looking object
keys are sorted lexically (not JS enumeration order). A parsed object has already
lost duplicate keys: HTTP parsers MUST reject duplicate raw JSON keys before
these helpers; canonicalJson cannot recover them. Fixed cross-module golden byte,
hash and Ed25519 signature vectors live in `test/contracts/canonical.test.ts`.

### Config

`ConfigSchema` is strict: ONLY exact network literal `testnet` (no normalization:
MAINNET/Mainnet/TESTNET/localnet all rejected); rpcUrl (HTTP/S, no credentials,
mainnet URL marker or known mainnet alias `free.rpc.fastnear.com`); custody
`accountId`; fixed explorer base `https://testnet.nearblocks.io/txns/`; separate
agent/admin ports; required dataDir and auditKeyPath; ownerPublicKey
`ed25519:<base58>`; `feeReservePerTx` defaults to 0.001 NEAR; required safetyReserve.
`parseConfig` wraps ALL network/RPC validation failures as
`BrokerError('MAINNET_REFUSED')`; other config failures remain ZodErrors. A schema
safeParse failure is still a Zod validation result, not a BrokerError.

bindHost defaults to `127.0.0.1`; `0.0.0.0` is allowed ONLY inside the isolated
container with host ports published on 127.0.0.1. allowedHosts defaults to
`['127.0.0.1','localhost']`: exact lowercase hostnames, no ports/wildcards or
trailing dot. B07/B08 must parse exactly one valid Host authority, validate its
port against the listener/published port, and compare the hostname exactly, not
by suffix or trusted forwarded headers. allowedOrigins defaults to `[]`: reject
all present browser Origins unless exactly allowlisted; absent Origin is allowed
for authenticated CLI/bridge. Entries must be serialized HTTP(S) origins, no
userinfo/path/query/fragment/opaque `null`. Reject malformed/multiple Origin/Host
headers before matching. `balanceMaxAgeMs` defaults to 10,000 (allowed 1..60,000);
B06 derives snapshot validUntil = observedAt + balanceMaxAgeMs. auditKeyPath is
container-internal audit key material, never an owner private key or agent file.

URL heuristics are only an early rejection: arbitrary RPC aliases cannot be
classified by a static hostname list. A testnet label is not proof: NearChain must
verify the RPC node's `chain_id=testnet` before signing/broadcast and fail closed
on a mismatch/unknown identity. No `.near` suffix heuristic substitutes for this.
Public-key schemas validate shape; crypto adapters must decode exact 32-byte
Ed25519 keys and reject wrong key types/lengths. Config supplies initial wallet
safety reserve, but absence of a persisted wallet policy still denies admission.

### Agents, credentials and owner auth

Agent: `{id,name,status:active|revoked,createdAt}`. **No frozen lifecycle state.**
Freeze lives ONLY in Freeze records. Store snapshots derive mandatory
`agentFrozen` and `globalFrozen` from those records; evaluator checks both before
caps/approvals. Missing freeze records mean false, not missing policy. Unfreeze
changes a Freeze record, never Agent.status.
`revokeAgent` permanently sets revoked, atomically revokes all its credentials
and writes agent_revoked plus credential_revoked events; token issuance for a
revoked agent is forbidden. Revocation stops new admission/dispatch, never
releases already-ambiguous holds. `putAgent` cannot reactivate a revoked agent.
Credentials have their
own ID, agentId, createdAt, nullable revokedAt and **tokenHash only** (SHA-256 of
the exact UTF-8 token). Tokens are `bb_agent_` + 32 cryptographically random bytes
in canonical unpadded base64url (43 chars). Never persist, audit or log plaintext
tokens; return them only once on issue/rotation. Rotation revokes the old token
atomically with issuing the new one. Authentication checks current revocation;
an agent token is not a custody key. Revoked agents cannot regain access via a
new session, and frozen agents cannot dispatch. A frozen agent may still inspect
its own status/receipts; token authentication alone does not mean spend allowed.

**Authenticate first**, before request lookups, idempotency probes or detailed
validation errors. Identity comes exclusively from the verified token, never
from tool args. Every agent operation filters request/receipt ownership, including
verification/export-like tools; do not leak existence of another agent's IDs.
Owner operations require OwnerPrincipal produced by the signed-request verifier,
not an unchecked JSON `{kind:'owner'}`. Ports are trusted in-process interfaces,
not authentication mechanisms by themselves.

`budget_status` returns strict `BudgetStatusSchema`: own agent/policy,
agentFrozen, own usage, own remaining quotas, at. No walletPolicy, custody
balance, walletRolling24h, outstandingHolds, globalFreeze/globalFrozen or other
agent/standing usage. Remaining is max(0, own cap - own reserved+settled usage);
perTx is own perTxMax, all zero if policy missing/expired or agent revoked/frozen.
This is not a wallet-capacity/approval promise. The internal `UsageSnapshot` is
NEVER serialized as an agent response. `WalletStatus` is owner-only. Global
freeze and wallet-policy receipt events also stay exclusively on the owner chain.

Owner signs canonical `{method,path,bodySha256,nonce,issuedAt}` using Ed25519:
uppercase HTTP method, exact encoded request path including query (no origin or
fragment), hash of actual HTTP body bytes (empty body = SHA-256(empty bytes)),
random unpadded base64url nonce (22..128 chars), issuedAt epoch ms. CLI emits
canonical JSON body bytes; the verifier hashes transport-provided raw bytes,
never trusts a body hash copied from the envelope. Signature is canonical base64
of 64 raw signature bytes over canonical payload UTF-8 bytes. Only configured
ownerPublicKey verifies it. Enforce `abs(now-issuedAt) <= 60_000`; implicit expiry
is issuedAt+60_000. Durably consume each nonce once before executing any admin
mutation (UNIQUE nonce, including concurrent requests/restarts). Keep nonce rows
through expiry inclusive; future-issued requests remain replay-protected through
their full window. Never accept a signature valid for a different method/path/body.

### Policies and decisions

AgentPolicy: agentId, monotonic revision, perTxMax, rolling24hMax, lifetimeMax,
gasBudget24h, ratePerMinute, maxOutstanding, recipients `{mode,accounts[]}`,
approvalThreshold (null = never needs approval), optional expiresAt. WalletPolicy:
revision, rolling24hMax, safetyReserve. **Missing policy = deny; zero = zero,
never unlimited.** `gasBudget24h` is a monetary yoctoNEAR limit, not gas units.
Expiry is effective at `now >= expiresAt`. Recipient allowlist `[]` allows none;
allow_all ignores its accounts list. Hard caps are checked before approvals.

`PolicyEvaluator.evaluate` is pure: agent + nullable policies + UsageSnapshot +
PolicyRequest + standing approvals + nullable digest-bound request approval +
now -> `allow | deny | needs_approval | allow_via_standing_approval`, reasons,
and standingApprovalId when applicable. No SQL, RPC, clock reads or mutation.
A valid per-request approval returns `allow` only for its exact request ID,
agent, requestDigest, current agent policy revision and unexpired grant. A changed
policy requires a fresh decision; approvals never bypass current wallet limits.

Snapshot principal totals include successful principal plus all active holds
(including pending approvals), counted once, even if a hold is older than 24h.
Settled 24h entries use `[now-24h, now]` with the lower boundary exclusive.
Gas usage includes actual tokens burnt in that window (even failed transfers)
plus outstanding fee reservations. Rate usage counts newly admitted distinct
requests in `(now-60s, now]`, including pending approvals, not idempotent retries.
Outstanding counts all nonterminal requests with active holds. Denials don't
reserve budget; HTTP abuse throttling is separate. Re-evaluation excludes the
request's own hold from ALL applicable totals to avoid double counting.

StandingApproval: owner-granted id, agentId, optional recipients (absent = any,
empty = none), perTxMax, totalMax, usedTotal, mandatory expiresAt, optional
revokedAt. Only bypasses the above-threshold approval gate, **never** hard caps,
freeze, revocation or wallet capacity. A request needs approval only when amount
is strictly greater than approvalThreshold. Check agent, recipients, perTx,
`usedTotal + standingReserved[id] + amount <= totalMax`, expiry and revocation
at admission AND dispatch. `usedTotal` is finalized successful principal;
`standingReserved` accounts active uses until final settlement. Reserve/release
approval consumption atomically with holds. Receipts name the exact approval;
revocation before dispatch blocks use. No mutation in preview/evaluator.

B12 implements `ApprovalService`, not duplicate BrokerService endpoints. B06
owns owner authentication, dispatch and hard-cap orchestration and calls B12
inside its existing StoreTransaction. B12 synchronously approve/rejects requests
and grants/revokes standing approvals, including state/hold/receipt writes; never
starts a nested transaction. Per-request approval IDs/digest/revision/expiry bind
the persisted immutable request. `matchStandingApproval` is a pure bounded grant
matcher, injected into policy/broker (never a hard-cap bypass). `consumeStandingApproval`
is a pure successful-settlement debit, requires amount <= reservedAmount and
usedTotal+amount <= totalMax, returns a new approval without input mutation. It
must debit already-executed transfers even if the grant has since expired or been
revoked. The broker persists it and releases the standing reservation atomically
with final accounting; failed/cancelled work releases reservations without a debit.
Reservations derive from active holds plus request.approvalRef, avoiding a second
unsynchronized usage counter. List all relevant standing grants inside the same
read/transaction snapshot when evaluating (not just the first page).

## Transfers, holds, outbox and settlement

TransferInput requires idempotencyKey, receiverId, positive amount, optional memo.
Memo is off-chain metadata, never a contract call. TransferRequest adds id,
agentId, requestDigest, state, reasons, nullable policyRevision/approvalRef and
created/updated/expiry/signed/submitted/completed timestamps, nullable txHash,
gasBurnt and tokensBurnt. Hash is the current persisted signed attempt's hash;
fees are actual aggregate burnt values when known, never estimates (null is
unknown, 0 is known zero). The agent requestTransfer/getRequest/cancelRequest
return `TransferView`, which also guarantees explorerUrl is null iff txHash is
null, otherwise exactly EXPLORER_BASE+txHash. Never link mainnet. The digest preimage
is canonical `{agentId,receiverId,amount,memo}` with amount yocto TEXT and absent
memo normalized to **null** (empty string stays distinct). Scope idempotency by
`UNIQUE(agentId,idempotencyKey)`. Same key+digest returns the original request;
same key+different digest -> `IDEMPOTENCY_CONFLICT`. A replay never reserves,
authorizes, broadcasts or appends another decision. ID generation is internal.

States: denied, pending_approval, approved, rejected, expired, cancelled, queued,
signed, submitted, succeeded, failed, outcome_unknown. `ALLOWED_TRANSITIONS` is
the exhaustive source of truth; no self transitions. Initial state is denied,
pending_approval or queued following admission. Terminal denied/rejected/expired/
cancelled/succeeded/failed never change. Pending approval can be approved,
rejected, expired, cancelled or denied by re-evaluation; approved queues only
after re-evaluation. Queued work can be cancelled/expired/denied or sent back to
approval before signing. Once signed, never cancel or return to a fresh queue.
`outcome_unknown` may become submitted/succeeded/failed on evidence, not cancelled.
A signing event does not prove execution; a timeout does not prove failure.
`StoreTransaction.updateRequest` enforces ALLOWED_TRANSITIONS and CAS on
expectedState; immutable request/digest/idempotency fields cannot change and
same-state updates are rejected. Re-signing a positively proven-unexecuted
attempt uses ONLY `replaceUnexecutedAttempt`: the prior attempt must match
request.txHash and status proven_not_executed, request state signed or
outcome_unknown, and replacement nonce strictly higher. It atomically persists
replacement signed bytes+current txHash without changing request state or
releasing holds; retains old evidence. `putAttempt` alone cannot switch request
identity. `proven_not_executed` attempt status requires persisted nonempty
nonExecutionEvidence from positive chain-adapter observations, never a timeout
or InvalidNonce alone. No generic same-state metadata write bypasses these requirements.

Hold `{requestId,agentId,principal,feeReserve,status}` uses active/committed/released.
AccountingEntry is an immutable **nonnegative u128** amount plus explicit kind (principal/
fee reserved/released, principal committed, gas charged), never floating deltas.
Hold active means fully reserved; committed means final chain settlement, with
unused principal/fees released in accounting; released means no possible execution
and no remaining reservation. Failed execution charges gas but releases principal.
Finalization is idempotent; never charge duplicate RPC receipts twice.

Admission is one SQLite **BEGIN IMMEDIATE** transaction: re-check live auth/
freeze/policy state, resolve idempotency, evaluate, reserve hold/standing budget,
create request and append signed decision receipt, then commit. Any audit write
or signature failure rolls back all changes and blocks dispatch. Pending approvals
also reserve principal+fee; rejection/cancellation/expiry before signing releases
these atomically with the state+receipt. Owner approval re-evaluates current caps
excluding its own reservation; it is not a detached permission to spend later.

Wallet admission equation (all exact bigint):

`principal + feeReserve <= spendable balance - outstanding holds - safetyReserve`

Spendable excludes locked funds and storage staking reserve. Negative RHS denies.
Stale/unknown balance (null, invalid/future observation or now>validUntil) fails
closed with WALLET_CAPACITY. Obtain/refresh RPC balance outside SQLite callbacks;
Reject also when now-observedAt > config.balanceMaxAgeMs regardless of a stored
validUntil; B06 must not extend freshness by re-reading cached data. Never trust
caller balance. Owner `walletStatus` has balanceValidUntil; agent status has no balance.

Exactly one dispatch lane per custody public key. Persist a monotonic nonce:
`max(localNonce, chainNonce)+1`, under serialization, as decimal TEXT. Build and
sign only the native transfer with that explicit nonce and recent block hash.
Persist TxAttempt/outbox (id, requestId, nonce, publicKey, blockHash, **signed bytes**,
txHash, status, receiptIds, nullable gasBurnt/tokensBurnt, timestamps and nullable
nonExecutionEvidence) **before**
network broadcast. Replaying persisted bytes is not re-signing. A restart must
recover outstanding attempts and reconcile them, not allocate replacement nonces
blindly. A new attempt requires positive proof the prior one did not execute;
InvalidNonce alone, RPC timeout, missing transaction/indexer row, or a stale block
hash is insufficient. InvalidNonce re-signing is allowed only when the prior
attempt is proven not executed; retain that attempt/evidence and allocate a new
monotonic nonce without returning the request to queued. No nonce decrement.

`listOutbox` returns ONLY unresolved signed/submitted/outcome_unknown attempts
(`OUTBOX_STATUSES`); terminal succeeded/failed/proven_not_executed history is
available via listAttempts(requestId). Recovery paging is ID order, NOT dispatch
nonce order; the single lane still dispatches/reconciles in nonce-safe order.
All PageQuery lists (agents, credentials, requests, standing grants, accounting,
outbox) use ascending immutable ID with SQLite COLLATE BINARY (UTF-8 byte order).
`after` is an exclusive last ID, not an offset/authorization token; nextCursor
is last returned ID only when more matching rows exist, otherwise null. Apply
scope/filters on EVERY page, including invented/cross-agent cursors. Separate
pages have no shared-snapshot guarantee; invariant-sensitive scans stay inside
one Store read/transaction. Receipts/checkpoints page by ascending seq with
exclusive afterSeq=0 for start; limit 1..1000. `listAccounting` supports agentId
and/or requestId filters for auditable owner reconciliation, not agent-wide leaks.

Freeze is checked at admission and **immediately before dispatch under the same
serialization as freeze mutations**. Signing and RPC calls are outside synchronous
SQLite callbacks; the per-key dispatcher/freeze serialization remains held across
the final authorization check and broadcast invocation so no freeze commits in
the gap. Re-check even when bytes were already signed. Persist a submission-intent
receipt (`submitted` with payload phase `intent`) atomically before invoking the
network; audit failure blocks the invocation. A freeze pauses unsent signed work;
it cannot undo an already broadcast transfer. Do not release ambiguous holds on
freeze. Owner unfreeze doesn't reactivate revoked agents/credentials.

`broadcast` returns typed BroadcastResult: accepted{txHash},
rejected{txHash,code:INVALID_NONCE|EXPIRED_BLOCK_HASH|RPC_REJECTED,reason}, or
outcome_unknown{txHash,reason}. These are adapter results, NOT new broker error
codes. Expected network/RPC failures do not use untyped exception semantics;
unexpected exceptions must conservatively become outcome_unknown in the broker.
A rejected send is NOT proof that an earlier broadcast didn't execute. Only
positive ChainOutcome.not_executed evidence unlocks a replacement attempt.

Broadcast acknowledgment -> submitted; final chain execution evidence -> succeeded
or failed. Timeout/unclassified response -> **outcome_unknown**, keeps the hold,
nonce and signed bytes until final evidence. Actual transaction + receipt gas and
tokens burnt (not gas-price estimates) are aggregated once and charged to the
requesting agent's gasBudget24h **even on failure**. Principals count as spent
only on final success. If actual fees exceed reserve, charge actual fees, record
the overage and fail closed on subsequent capacity/gas checks; never hide a loss
or refund nonexistent money. Reserve sufficiency is an operational prerequisite.

## Receipts and errors

Independent chains: `agent:<agentId>` for each agent, plus separate `owner` chain.
ReceiptEvent: chainId, seq (starts 1), prevHash (64 zeros at genesis), type, at,
payload, hash, signature. Hash canonical `{chainId,seq,prevHash,type,at,payload}`
only, not hash/signature; sign the 32 decoded SHA-256 bytes with the daemon's
**Ed25519 audit key**, distinct from owner and custody keys. Verification checks
sequence, genesis/previous hash, canonical payload hash and signature with a
trusted audit public key. Hash/signature fields alone do not establish trust or
prove history completeness. Use shared receiptHashInput/sha256Hex. B04 provides
synchronous `AuditSigner` to ReceiptLog and B13 CheckpointLog; signHash rejects
anything but exactly 32 hash bytes. ReceiptLog.auditPublicKey and the owner
BrokerService.auditPublicKey expose the trusted public verification key for
independent exports; never derive trust from an arbitrary event's supplied key.

`RECEIPT_PAYLOAD_SCHEMAS` defines strict, per-type payloads, correlated with type
in ReceiptPreimage/ReceiptEvent/AppendReceipt; no arbitrary payload object:

| Types | Required payload content (exact fields in schemas) |
| --- | --- |
| decision_allowed, decision_denied, approval_required | request/agent/receiver, amount TEXT, requestDigest, nullable policyRevision/approvalRef, reasons (empty/nonempty/APPROVAL_REQUIRED respectively) |
| approved | requestId, agentId, approvalId, digest, revision, expiresAt |
| rejected, expired, cancelled | requestId, agentId, reason |
| standing_approval_granted | agentId, full bounded approval with TEXT amounts |
| standing_approval_revoked | agentId, approvalId, revokedAt |
| standing_approval_used | requestId, agentId, approvalId, amount TEXT |
| queued | requestId, agentId |
| submitted | requestId, agentId, attemptId, txHash, phase **intent or acknowledged** (mandatory) |
| succeeded, failed | requestId, agentId, txHash, receiptIds, actual gasBurnt/tokensBurnt TEXT; failed also reason |
| outcome_unknown | requestId, agentId, attemptId, txHash, reason |
| freeze, unfreeze | exact Freeze record with frozen true/false respectively |
| policy_updated | scope agent or wallet, full corresponding policy with TEXT amounts |
| agent_created | full Agent record |
| agent_revoked | agentId, reason |
| credential_issued, credential_revoked | agentId, credentialId (never token/secret) |

Agent events bind payload identity to chainId. Owner administrative operations
append owner and affected-agent events in the same transaction where applicable;
wallet policy/global freeze stay owner-only. ReceiptLog append uses the caller's
StoreTransaction: signature or write failure rolls back state/holds/approval.
Schema checks prevent mismatched agent payloads and cross-scope receipt leakage.

### B13 checkpoints

CheckpointPreimage is `{version:1,chainId,seq,headHash,previousCheckpointHash,at,
auditPublicKey}`. seq/headHash pin an existing nonempty receipt chain head;
previousCheckpointHash is null for first checkpoint, otherwise the previous
checkpoint hash for that chain. Checkpoint adds hash (sha256Hex of
checkpointHashInput(preimage)) and signature (audit Ed25519 signature on decoded
32-byte hash). Store.insertCheckpoint atomically CAS-checks the prior checkpoint,
requires strictly increasing seq and the stored receipt hash at seq, UNIQUE
(chainId,seq). No empty-chain or duplicate-head checkpoint. CheckpointLog.create
accepts the existing StoreTransaction and Clock-supplied at; signing/storage
failures roll back. list uses seq paging; verify requires an explicitly trusted
audit public key, verifies hash/signature/linkage/monotonicity, returns structured
CheckpointVerification. Embedded keys are metadata, not trust roots. External
pinning/export of checkpoints is required to detect rollback/truncation; a local
DB alone cannot prove absence of a removed suffix. B13 owns implementations,
not duplicate canonical or audit signer logic.

Frozen error/reason vocabulary (`ErrorCodeSchema`): UNAUTHENTICATED, FORBIDDEN,
AGENT_FROZEN, GLOBAL_FROZEN, NO_POLICY, PER_TX_EXCEEDED, ROLLING_24H_EXCEEDED,
LIFETIME_EXCEEDED, GLOBAL_CAP_EXCEEDED, GAS_BUDGET_EXCEEDED, RATE_LIMITED,
MAX_OUTSTANDING, RECIPIENT_NOT_ALLOWED, WALLET_CAPACITY, APPROVAL_REQUIRED,
IDEMPOTENCY_CONFLICT, NOT_FOUND, BROKER_UNAVAILABLE, INVALID_AMOUNT,
MAINNET_REFUSED, AUDIT_UNAVAILABLE, NONCE_CONFLICT. Expired policies are NO_POLICY;
expired approvals cannot satisfy the gate. Generic validation/authorization uses
FORBIDDEN except malformed monetary values INVALID_AMOUNT. Do not invent a
parallel code vocabulary. Return stable codes, not raw RPC/SQL/stack/secret data.

## Ports (implemented by owning tasks)

`src/contracts/ports.ts` freezes:

- Store + StoreReader/StoreTransaction: synchronous read snapshots and atomic
  immediate transactions; no awaited callbacks/thenables, no network within SQL.
  Explicit CAS policies/states, idempotency, holds/accounting, nonce, outbox,
  approval reservations, balance snapshots, receipt/checkpoint heads and durable
  owner replay. Accounting has a paged read. getWalletStatus is owner/internal;
  no arbitrary asynchronous transactions or generic request-state patch.
- PolicyEvaluator: pure decision from explicit snapshot/time.
- Authenticator: token -> AgentPrincipal; owner actual-request verification,
  replay consumption -> OwnerPrincipal.
- AuditSigner (B04): sync hash signer shared by ReceiptLog and CheckpointLog.
- ReceiptLog: sync transactional append; list/verify chain and single receipt;
  expose auditPublicKey for independently verified exports.
- CheckpointLog (B13): transaction-bound create, seq list and trusted-key verify.
- ApprovalService (B12): transaction-bound approve/reject/standing grant/revoke;
  pure match/consume helpers, injected into broker/policy as above.
- NearChain: attest testnet; account/access-key views; block hash; explicit-nonce
  native build+sign; encode/decode signed bytes; broadcast exact bytes; txStatus
  and classifyOutcome including final receipt IDs, gasBurnt and tokensBurnt.
- Custody: encrypt/load key, isolated signer and lock. Envelope v1 uses scrypt
  and AES-256-GCM, authenticated ciphertext/salt/IV/tag. B05 must pin safe KDF
  parameters and validate decoded lengths; unlock material isn't in config or DB.
- BrokerService (AgentBrokerService + OwnerBrokerService): agent request/preview,
  request read/cancel, budgetStatus, receipt list/verify, freezeSelf; owner agent
  creation/permanent revocation, token issue/rotate/revoke, agent/wallet policy
  CAS, approve/reject delegated to ApprovalService, standing grant/revoke,
  global/agent freeze/unfreeze, reconcile, receipt export and request list. Owner
  reads listAgents/getPolicy/listStandingApprovals/walletStatus/getFreeze/
  getRequest/auditPublicKey permit restart/discovery/offline verification without
  internal-module imports. BrokerService.getRequest accepts a trusted agent OR
  owner principal; agent ownership filtering is mandatory. Broker, not tools/CLI,
  orchestrates all atomic invariants and invokes injected B12/B13 ports.
- Clock: injected `now()` epoch milliseconds.

Exact agent tool names: budget_status, preview_transfer, request_transfer,
get_request, cancel_request, list_receipts, verify_receipt, freeze_self. Their
strict argument schemas are `MCP_AGENT_TOOL_INPUT_SCHEMAS`; none accept agentId.
Preview is advisory/read-only: no hold, idempotency row or receipt. All eventual
responses serialize monetary bigints as decimal yoctoNEAR text.

## Verified near-api-js 7.3.1 imports (not legacy @near-js packages)

Verified in the installed package declarations and exercised offline by
`test/contracts/contracts.test.ts`:

```ts
import {
  createTransaction, actions, SignedTransaction, Signature,
  encodeTransaction, decodeSignedTransaction,
  KeyPair, KeyPairSigner, PublicKey, JsonRpcProvider,
} from 'near-api-js';
```

`node_modules/near-api-js/package.json` exports `.` import types from
`./lib/index.d.ts`. That file declares:

```ts
createTransaction(signerId: string, publicKey: PublicKey, receiverId: string,
  nonce: bigint | string | number, actions: Action[], blockHash: Uint8Array): Transaction
```

Use **bigint nonce only** in our adapter. The installed signature is
`actions.transfer(deposit?: bigint)`; this broker MUST pass an explicit validated
positive u128 yoctoNEAR deposit (never rely on the optional default). It
constructs the sole allowed action. Root exports re-export declarations from
`lib/account-V-f7tl72.d.ts` (generated internal name, not an import path):
`SignedTransaction.encode(): Uint8Array`, static
`SignedTransaction.decode(bytes: Uint8Array): SignedTransaction`, plus
`encodeTransaction(Transaction | SignedTransaction)` and
`decodeSignedTransaction(Uint8Array)`. `Signature` takes `{keyType,data}`.
No `near-api-js/transactions` export is assumed. Do not deep-import generated
internal filenames. KeyPairSigner.signTransaction can sign a prebuilt transaction;
it must not select a nonce implicitly for this broker. The package also exports
`near-api-js/rpc-errors` (public `./rpc-errors` export); B05 may import typed RPC
errors there to map them into BroadcastResult/ChainOutcome. It is not a license
to blindly retry InvalidNonce or leak provider errors through the broker API.

The NEAR skill and references (`api_patterns.md`, `key_management.md`) were read;
the low-level installed declarations, not high-level Account examples, govern
explicit nonce use. Do **not** use Account.transfer/signAndSendTransaction for
dispatch: their convenience nonce/retry behavior bypasses the persisted outbox
contract. The offline contract test creates nonce 123n, signs a native transfer,
and verifies both class and root helper signed codecs without contacting RPC.

## B06 review amendment: liveness and explicit resolution

This coordinator-authorized amendment takes precedence over earlier statements
about indefinitely paused signed work. One daemon process per custody key remains
a deployment prerequisite (B08 must enforce exclusive process ownership).

The dispatch pump is serialized separately from the per-attempt authorization
lane. Acquire/release that lane for each attempt, re-reading live queue state and
refreshing stale balance before the next attempt. Freeze/policy/revocation writes
share the final authorization/broadcast boundary, not the entire queue or FINAL
status polling. Stale-only WALLET_CAPACITY pauses admitted work; it never
terminally denies it. Pending execution remains submitted with its hold active.
Rebroadcast identical persisted bytes for signed AND outcome_unknown attempts;
never re-sign without positive exclusion evidence. Reconciliation examines only
existing attempts (and returns only examined requests), never queued payments.
Preview may fetch an ephemeral balance but writes no balance/request/hold/receipt.
A backwards clock step skips pending expirations newer than the clock.

NearChain.txStatus accepts an optional persisted TxAttempt (the two-argument
form remains compatible). The native adapter validates its signed bytes and binds
hash/signer/key/nonce/block before proving exclusion. A structured
UNKNOWN_TRANSACTION lookup plus a pinned final access-key nonce >= attempt nonce
proves that nonce cannot execute anew. Alternatively a final head strictly past
the signed block height + protocol transaction_validity_period establishes
expiry. Both paths require a second UNKNOWN_TRANSACTION lookup AFTER the final
observation. Timeouts, arbitrary error strings, missing fields, an unpinned key
view or a head merely at the validity boundary never prove exclusion. Any positive
transaction/inclusion evidence vetoes exclusion even if final fee data is missing.
Proof is retained in nonExecutionEvidence and through restart. When replacement
is no longer authorized, positively proven-unexecuted work may fail with zero
burn and release its hold rather than wedge unrelated agents.

Broker-evidenced abandonment is permitted ONLY for a never-offered attempt:
there is no durable submission-intent or acknowledged receipt for that attempt,
and the broker has never invoked broadcast (intent MUST commit before invocation).
Under the shared lane, a revoked/frozen agent or other failed authorization may
abandon such an attempt, mark it failed with zero burn, release its hold and let
other agents proceed with strictly higher nonces. It can never be revived or
rebroadcast. Global freeze still pauses the lane. Already-offered ambiguous work
cannot use this exception. A standing grant remains bound to the exact grant in
the decision receipt; signing must re-reserve that same grant. A benign revision
mismatch at owner approval returns the stable POLICY_CHANGED code.

OwnerBrokerService.resolveAttempt(owner, requestId, reason) is an explicit
owner-attested **zero-execution** resolution for a stuck current attempt. Reason
must be nonempty, well-formed and <=1024 characters. Authenticate the owner as
usual; serialize against dispatch/reconciliation, query current chain evidence,
and REFUSE resolution if pending, successful or failed execution is observed.
With unknown evidence the owner explicitly accepts responsibility for the
attestation; this is not an automatic proof or a gas estimate. Resolution fails
that request with zero burn, releases its hold, never creates a replacement, and
atomically appends a failed receipt on BOTH owner and affected-agent chains.
The backward-compatible optional failed.payload.resolution is
{attemptId,basis:owner_attested|chain_proof|never_offered,evidence}; failed.reason
records the mandatory explanation. Automatic proof/never-offered abandonment uses
the same explicit resolution metadata. These receipts distinguish attestation
from measured chain failure. Receipt failure rolls back the entire resolution.
Externally pin exported checkpoints using the existing B13 list API; the legacy
receipt-array export remains unchanged.

## B06 safety amendment N1–N10 (supersedes weaker resolution/proof rules above)

Negative RPC visibility is not an everlasting proof. BOTH nonce and expiry
exclusion paths must retrieve and validate the signed transaction's anchor block
from retained history. A GC/history error, wrong anchor, final head older than the
anchor, malformed fields or a transport error means outcome_unknown, never
not_executed. A final consumed nonce alone is insufficient: the transaction itself
could have consumed that nonce before RPC history was garbage-collected. Require
at least NON_EXECUTION_MIN_AGE_MS (60,000 ms) since the most recent durable offer.
The age is measured from lastOfferedAt, not creation/signing time; unknown legacy
offer metadata is recovered from receipts or fails closed. The final observations
and repeated definitive UNKNOWN_TRANSACTION lookups rely on the configured trusted
RPC's retained, consistent final history, not arbitrary indexer absence.

### B06F M1/L4: separate nonce and generous-expiry exclusion rules

For the NONCE path, minimum age/retained history alone are insufficient: prolonged
lookup lag can hide an accepted transaction. A nonce-based exclusion additionally
requires durable offerCount=1 and definitive firstRejection (INVALID_NONCE or
EXPIRED_BLOCK_HASH) from that sole offer. Missing legacy counters never establish
this provenance; rejected rebroadcasts cannot become first rejections. Those
provenance records remain immutable.

The independent EXPIRY path applies to ANY offerCount and needs no first-rejection
metadata. It covers an ambiguous first 504 whose bytes never reached the chain,
replayed bytes, and other definitive first-offer InvalidTxError kinds such as
NotEnoughBalance (represented by RPC_REJECTED, not forged nonce provenance).
All of these conditions are required:

* Retrieve and validate the exact signed anchor block from retained history.
* Pin FINAL head/protocol configuration; require head height >= anchor height +
  transaction_validity_period + 1,000 safety blocks.
* Signing age (immutable attempt.createdAt) >= validity period * 1,000 ms, using
  testnet's nominal one-second validity block as an additional wall-clock gate.
  Keep the separate minimum 60-second age since lastOfferedAt. Replays cannot
  reset signing age or extend the signed transaction's block-hash validity.
* Obtain two definitive UNKNOWN_TRANSACTION lookups spaced at least 1,000 ms,
  with the second after the retained/final observations. Positive visibility,
  timeout, malformed data, GC/missing anchor or insufficient spacing vetoes proof.

The 1,000-block margin and spaced negative lookups rely on the configured trusted
RPC's complete, consistent retained FINAL history; they are not a cryptographic
absence proof from an arbitrary indexer. Nonce consumption by itself still cannot
resolve accepted/ambiguous work. Proven expiry can release a hold or authorize a
replacement only with the existing policy/freeze re-evaluations and fresh exclusion
recheck immediately before atomic replacement persistence. New offer counts are
persisted before invocation and cannot decrease. Known first-rejected invalid
bytes wait for proof rather than being pointlessly rebroadcast.

Persist lastOfferedAt BEFORE every invocation (including byte-identical retries).
Reuse the first signed submission-intent receipt for those same bytes rather than
manufacturing another intent receipt per retry. New-format attempts have explicit
lastOfferedAt=null before intent, so never-offered checks do not scan receipt
history. Legacy rows recover offer metadata once per changed chain head. Status
queries may run every drain, but identical-byte retries are spaced by the same
minimum age so frequent retries cannot perpetually reset the proof-age clock.
A send-gate early return leaves the attempt signed/never-offered, not unknown.

A persisted exclusion observation must be queried again on recovery, and again
AFTER asynchronous construction/signing immediately before replacement persistence.
Fresh exclusion evidence is receipted atomically with the replacement. Newly
visible pending/final execution of the current, unreplaced proof corrects its
attempt status while retaining earlier evidence; it must never authorize another
payment. Store.putAttempt permits only this narrow positive correction out of
proven_not_executed. Signed identity and monotonic offer time remain immutable.

resolveAttempt(owner,id,reason,force=false) now REQUIRES fresh definitive exclusion:
retained history, minimum offer age, UNKNOWN_TRANSACTION and final consumed nonce
or expired validity. It cannot default-resolve a still-valid transaction or an
unreachable RPC. Explicit force=true is separately receipted and may retire an
uncertain lane item, but RETAINS its entire principal+fee hold until fresh exclusion
or actual final execution is observed. Thus force cannot free the same agent's
budget for a second payment. Positive pending/final execution always vetoes even
force. Failed resolution receipts record force and holdRetained explicitly.

All offered, artificially resolved attempts have durable resolutionWatch metadata.
Drains/start/reconcile continue watching through their validity window AND beyond
it for late historical visibility; watches never rebroadcast. A forced hold is
released only on fresh mature exclusion. Actual late success/failure is charged
exactly once, with actual principal and tokensBurnt, a signed lateResolution
receipt on both owner/agent chains, and a global freeze requiring owner review.
A narrow Store.correctResolvedExecution seam atomically corrects only an explicit
watched failed request/attempt/hold, not generic terminal states. Old zero-burn
resolution accounting is never rewritten: positive gas_correction entries charge
any legacy zero-charge difference and participate in gas usage. If a released
standing grant is now exhausted, actual principal/gas accounting still wins over
the grant's limits; revoke that grant so owner unfreeze cannot re-spend stale
remaining standing capacity. The freeze requires reconciliation of the late overrun.
Legacy signed resolution receipts enroll old resolved rows into the watch after
restart. No SQLite migration is needed for these optional JSON metadata fields.

Balance refresh is single-flight per custody key across broker connections, with
one admission lane entry, a 250 ms negative cache, and shared ephemeral preview
cache. Cache timestamps never extend observation freshness. A settlement generation
invalidates in-flight pre-payment preview results before they can overwrite a
conservative balance debit. Owner mutations wait for at most the current refresh,
not a hostile queue of repeated failed RPCs. Preview still writes no rows.

An agent-scope freeze may permanently abandon NEVER-OFFERED signed work, as already
authorized. **Unfreeze does not restore that failed request**; the agent must submit
a new idempotency key if the owner permits a fresh payment. Already-offered work
cannot use abandonment. Stale-only capacity failure must pause a never-offered
attempt and preserve its hold, not abandon it. Global freeze pauses signed work.

The mutation runner operates exclusively on an isolated temporary source/test
copy. It never rewrites worktree src, even on interruption. Required MCP/HTTP
placeholder suites remain owned by their downstream tasks; B06 does not skip or
silence them.
