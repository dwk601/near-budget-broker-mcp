# Budget Broker MCP — frozen foundation (B00)

This is the authoritative integration contract. `src/contracts/index.ts` is the
public TypeScript barrel; adjacent Zod schemas validate shared data. These files,
package metadata/lockfile and compiler/test configs are B00-owned. Later tasks
must request a B00 amendment rather than silently change their signatures.
There is deliberately no daemon, storage, policy or chain implementation yet.

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
or SQL REAL for amounts. Chain adapters additionally enforce native u128 limits.

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

### Config

`ConfigSchema` is strict: network literal `testnet`; rpcUrl (HTTP/S, no URL
credentials or obvious mainnet hostname); custody `accountId`; fixed explorer
base `https://testnet.nearblocks.io/txns/`; separate agent/admin ports; dataDir;
ownerPublicKey `ed25519:<base58>`; `feeReservePerTx` defaults to 0.001 NEAR;
`safetyReserve` is required. `parseConfig` rejects mainnet with code
`MAINNET_REFUSED`. A testnet label is not proof of RPC identity: NearChain must
verify the RPC node's `chain_id=testnet` before signing/broadcast and fail closed
on a mismatch/unknown identity. No `.near` suffix heuristic substitutes for this.
Public-key schemas validate shape; crypto adapters must decode exact 32-byte
Ed25519 keys and reject wrong key types/lengths. Config supplies initial wallet
safety reserve, but absence of a persisted wallet policy still denies admission.

### Agents, credentials and owner auth

Agent: `{id,name,status:active|frozen|revoked,createdAt}`. Credentials have their
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

## Transfers, holds, outbox and settlement

TransferInput requires idempotencyKey, receiverId, positive amount, optional memo.
Memo is off-chain metadata, never a contract call. TransferRequest adds id,
agentId, requestDigest, state, reasons, nullable policyRevision/approvalRef and
created/updated/expiry/signed/submitted/completed timestamps. The digest preimage
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

Hold `{requestId,agentId,principal,feeReserve,status}` uses active/committed/released.
AccountingEntry is an immutable positive amount plus explicit kind (principal/
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
B06 must configure/document freshness conservatively. Never trust caller balance.

Exactly one dispatch lane per custody public key. Persist a monotonic nonce:
`max(localNonce, chainNonce)+1`, under serialization, as decimal TEXT. Build and
sign only the native transfer with that explicit nonce and recent block hash.
Persist TxAttempt/outbox (id, requestId, nonce, publicKey, blockHash, **signed bytes**,
txHash, status, receiptIds, nullable gasBurnt/tokensBurnt, timestamps) **before**
network broadcast. Replaying persisted bytes is not re-signing. A restart must
recover outstanding attempts and reconcile them, not allocate replacement nonces
blindly. A new attempt requires positive proof the prior one did not execute;
InvalidNonce alone, RPC timeout, missing transaction/indexer row, or a stale block
hash is insufficient. InvalidNonce re-signing is allowed only when the prior
attempt is proven not executed; retain that attempt/evidence and allocate a new
monotonic nonce without returning the request to queued. No nonce decrement.

Freeze is checked at admission and **immediately before dispatch under the same
serialization as freeze mutations**. Signing and RPC calls are outside synchronous
SQLite callbacks; the per-key dispatcher/freeze serialization remains held across
the final authorization check and broadcast invocation so no freeze commits in
the gap. Re-check even when bytes were already signed. Persist a submission-intent
receipt (`submitted` with payload phase `intent`) atomically before invoking the
network; audit failure blocks the invocation. A freeze pauses unsent signed work;
it cannot undo an already broadcast transfer. Do not release ambiguous holds on
freeze. Owner unfreeze doesn't reactivate revoked agents/credentials.

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
prove history completeness. B13 checkpoints address truncation/rollback evidence.

Types: decision_allowed, decision_denied, approval_required, approved, rejected,
standing_approval_used, queued, submitted, succeeded, failed, outcome_unknown,
cancelled, freeze, unfreeze, policy_updated, credential_issued, credential_revoked.
Agent events belong to their agent chain; owner administrative operations append
an owner event and affected-agent event in the same transaction when applicable.
Payloads contain request IDs, policy revision, reasons and approval references,
not plaintext tokens, unlock secrets or signed owner credentials. `ReceiptLog`
append accepts the caller's StoreTransaction to avoid a second non-atomic DB write.

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
  approval reservations, balance snapshots, receipt heads and durable owner replay.
- PolicyEvaluator: pure decision from explicit snapshot/time.
- Authenticator: token -> AgentPrincipal; owner actual-request verification,
  replay consumption -> OwnerPrincipal.
- ReceiptLog: sync transactional append; list/verify chain and single receipt.
- NearChain: attest testnet; account/access-key views; block hash; explicit-nonce
  native build+sign; encode/decode signed bytes; broadcast exact bytes; txStatus
  and classifyOutcome including final receipt IDs, gasBurnt and tokensBurnt.
- Custody: encrypt/load key, isolated signer and lock. Envelope v1 uses scrypt
  and AES-256-GCM, authenticated ciphertext/salt/IV/tag. B05 must pin safe KDF
  parameters and validate decoded lengths; unlock material isn't in config or DB.
- BrokerService (AgentBrokerService + OwnerBrokerService): agent request/preview,
  request read/cancel, budgetStatus, receipt list/verify, freezeSelf; owner agent
  creation, token issue/rotate/revoke, agent/wallet policy CAS, approve/reject,
  standing grant/revoke, global/agent freeze/unfreeze, reconcile, receipt export,
  request list. Broker, not tools/CLI, orchestrates all atomic invariants.
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

Use **bigint nonce only** in our adapter. `actions.transfer(amount: bigint)`
constructs the sole allowed action. Root exports re-export declarations from
`lib/account-V-f7tl72.d.ts` (generated internal name, not an import path):
`SignedTransaction.encode(): Uint8Array`, static
`SignedTransaction.decode(bytes: Uint8Array): SignedTransaction`, plus
`encodeTransaction(Transaction | SignedTransaction)` and
`decodeSignedTransaction(Uint8Array)`. `Signature` takes `{keyType,data}`.
No `near-api-js/transactions` export is assumed. Do not deep-import generated
internal filenames. KeyPairSigner.signTransaction can sign a prebuilt transaction;
it must not select a nonce implicitly for this broker.

The NEAR skill and references (`api_patterns.md`, `key_management.md`) were read;
the low-level installed declarations, not high-level Account examples, govern
explicit nonce use. Do **not** use Account.transfer/signAndSendTransaction for
dispatch: their convenience nonce/retry behavior bypasses the persisted outbox
contract. The offline contract test creates nonce 123n, signs a native transfer,
and verifies both class and root helper signed codecs without contacting RPC.
