# B06 broker integration and safety boundaries

Construct `BrokerService` with Store, NearChain, unlocked CustodySigner,
ReceiptLog, ApprovalService, CheckpointLog, Clock and account/fee/freshness config.
Principals come from B03 authentication, never principal-shaped JSON. Components
share the same database and audit trust root. Await `start()` before serving.

`requestTransfer`/`approve` drain by default; set `autoDispatch: false` for daemon
scheduling. Schedule repeated `drain()` calls for reconciliation/expiry and durable
resolution watches. `expirePending()` is also available separately. No broker-owned
timers, servers or background promises survive a call. Stop scheduling and await
work before locking custody/closing Store.

## Dispatch and balance

The per-key pump serializes drain/recovery/resolution. A separate per-attempt lane
serializes owner freeze/policy/revocation/approval mutations with authorization,
signing, durable intent and broadcast. FINAL polling is outside that lane; owner
mutations do not wait behind the entire queue. Queue state is reread every attempt.

Balance refresh is single-flight per custody key across connections, with one
admission lane entry and a 250 ms failure cache. Preview shares an ephemeral RPC
cache but writes no rows. Settlement invalidates that cache and in-flight older
preview generations, so an old RPC cannot overwrite the conservative debit.
Observation timestamps never gain freshness from caching. Stale-only capacity
failure pauses admitted work (including never-offered work), never abandons it.

## Proof and replay

Only persisted bytes are offered. Every offer first durably updates
`lastOfferedAt` and increments `offerCount`; byte-identical retries reuse the first
signed intent receipt. Both broker and real adapter pre-send attestations run
BEFORE intent through the optional `BroadcastPreparation` capability. Its one-shot
closure submits only already validated bytes, after the broker records intent.
A failure at either pre-offer boundary retries the same stored bytes promptly;
there is no offer count/timestamp or 60-second replay delay to undo.
New attempts explicitly store null before intent, avoiding receipt-chain scans.
Legacy rows recover intent/offer time once per changed chain head. An early send
return leaves signed/never-offered state, not a false outcome_unknown receipt.

Status is checked every drain. After an offer, identical-byte retries/exclusion
wait at least 60,000 ms. Both proof paths bind signed identity and require a
retrievable anchor/history; missing/GC history never proves absence.

* NONCE proof still requires sole-first-offer InvalidNonce/Expired rejection
  provenance plus a pinned FINAL consumed nonce. InvalidNonce provenance requires
  payload tx_nonce equal to this signed nonce and ak_nonce STRICTLY GREATER than
  tx_nonce; equality can be a hidden acceptance followed by a gateway retry. The
  adapter preserves bounded nonce details in its canonical rejection reason;
  strict first-validation evidence is retained in nonExecutionEvidence and full
  later proof facts in signed receipts. Bare legacy flags do not qualify.
  Rejected replays never acquire first provenance, which cannot be erased.
* EXPIRY proof applies to any offer count, including ambiguous 504/timeouts and
  other definitive first-offer InvalidTxError kinds (e.g. NotEnoughBalance). Require
  a FINAL-head-pinned access-key nonce STRICTLY LESS than the attempt nonce,
  FINAL head >= anchor height + protocol validity + 1,000 safety blocks, signing
  age >= validity * 1,000 ms (nominal one-second testnet block), and two definitive
  UNKNOWN_TRANSACTION lookups spaced >=1,000 ms. Keep the 60s last-offer age too.
  Signing age is immutable and is not reset by replay. Positive visibility,
  missing anchor/key, unpinned key, consumed nonce, RPC failure or insufficient
  margin/age/spacing vetoes proof. Expiry alone cannot disprove prior execution.

Expiry observations trust complete, consistent retained FINAL history from the
configured RPC, not a cryptographic absence proof from arbitrary indexer silence.
This bounded expiry path prevents a dropped first offer from locking funds forever.
Known rejected bytes wait for proof rather than destroying their provenance.

Persisted proof is not permanent authority. Replacement signing and full spaced
proofs run OUTSIDE the custody mutation lane while the per-key pump remains held.
A freeze/revoke can acknowledge during the proof sleep. Only the no-sleep final
visibility/FINAL-head/pinned-key recheck, authority check, persistence and offer
remain inside the lane. The native adapter requires a matching full observation
<=5s old for that capability and always re-reads mutable chain facts; it does not
return cached absence as authority. Adapters lacking the final-recheck capability
fail closed without replacement signing. Final RPC/broadcast latency still bounds
acknowledgment during that final critical section. Fresh evidence is receipted
atomically with replacement. Newly visible execution of the unreplaced
current proof corrects its status and is charged, never re-signed/broadcast anew.
Prior evidence and signed identity are retained. Proven work whose replacement is
no longer authorized may fail with zero burn/release only against fresh proof.

A NEVER-OFFERED attempt can be permanently abandoned on agent freeze/revocation
or hard policy failure. **Unfreeze does not restore that failed request.** A fresh
request/idempotency key is needed if later permitted. Global freeze pauses work;
already-offered ambiguity cannot use broker abandonment.

## Owner resolution and late execution

`resolveAttempt(owner,id,reason,force=false)` requires fresh, aged exclusion:
definitive UNKNOWN_TRANSACTION, retained history and either first-rejected nonce
proof or expiry with an unconsumed pinned nonce. It cannot normally resolve an
unreachable chain. Positive pending/final execution always vetoes resolution.

Explicit `force=true` may retire an uncertain lane item, but **retains the entire
principal+fee hold** until fresh exclusion or final execution. It cannot free the
same budget for another payment. Both chains receive failed-resolution receipts
with force/holdRetained flags, basis and required reason. Audit failure rolls back
the operation. Force never creates a replacement. Exception: a forced NEVER-OFFERED
attempt uses broker abandonment, releases its hold, and creates no watch. Visible
success/failure/pending always vetoes even that force path.

Conservative consequence: if A is force-retired while ambiguous and a later B
payment consumes a higher nonce, A's hold may remain ACTIVE PERMANENTLY. Even if
A's first send was really dropped, current nonce >= A's nonce cannot distinguish
that from an indexed-late execution of A. Expiry/time/horizon or negative archival
lookups do not refund that budget. Positive final visibility can settle it; this
API deliberately adds no owner write-off or blind release action.

Resolved offered attempts are automatically watched for 60 hours from signing or
the latest offer, covering nominal testnet validity + margin up to the approximate
five-epoch GC horizon. A receipt-tail index (replayed once on restart, then consumed
incrementally) avoids scanning all failed requests every drain. Automatic watches
stop at the horizon; uncertain holds are NOT released just because time elapsed.
Explicit reconcile(id) remains available beyond the horizon, e.g. with an archival
RPC. Once the hold is released, watches make only the cheap visibility RPC;
they do not repeatedly fetch anchor/key/protocol or sleep to re-prove exclusion.
Watches never broadcast. Actual late
success/failure corrects the resolved request/attempt/hold through the narrow
`Store.correctResolvedExecution` seam, charges actual principal/tokensBurnt once,
appends signed lateResolution receipts to both chains, and globally freezes for
owner review. Other terminal requests/holds remain immutable. Legacy zero gas
charges are corrected with positive append-only `gas_correction` entries, not
history rewrites. Old signed resolution receipts enroll legacy watches on restart.
An exhausted standing grant cannot block recording a real late loss: principal/gas
accounting remains authoritative; revoke the overrun grant so owner unfreeze cannot
reuse stale remaining standing capacity. The freeze requires overrun reconciliation.

`reconcile` examines only existing attempts/watches, respects request IDs, returns
only examined requests and never dispatches unrelated queued payments. Standing
grants remain bound to the original decision; benign approval revision drift is
`POLICY_CHANGED`. Backwards clocks skip newer pending expirations.

## Deployment and compatible amendments

* B08 must enforce **one daemon process per custody key**, e.g. an exclusive lock.
  Multiple broker connections in that process are supported. Active-active needs
  durable fenced leadership; SQLite alone cannot serialize cross-process freeze
  versus broadcast. One database/trust root backs that custody key.
* Reads do not manufacture mutation receipts (`owner_operation` is not in the
  schema); idempotent B12 standing revocation stays a no-op, as review accepted.
* Receipt-array export remains compatible; B08 can list B13 checkpoints for
  external pinning. Embedded verification keys are not independent trust roots.
* Authorized N2 storage changes are scoped positive-proof/late-resolution
  corrections, monotonic offer metadata and append-only gas corrections. Optional
  attempt JSON fields require no database migration. Generic terminal transitions,
  released-hold resurrection and immutable signed bytes are still protected.

## Regression and mutation verification

F1–F12 tests remain. `safety.test.ts` covers N1–N10, stale/offline pause, coalescing,
force budgets, restart/legacy/late accounting and all new concurrency survivors.
Real NativeNearChain plus encrypted custody/fake RPC tests cover GC, lag and
execution becoming visible during replacement signing, besides Expired,
InvalidNonce, dropped 504, other InvalidTxError and transient pre-send failures.
`followup.test.ts` covers Q11/Q02/Q36/Q19/Q39/Q43 plus watch indexing/horizon,
pre-offer retries and forced never-offered release. `correction-guards.test.ts`
independently pins every request/attempt immutable, fee equality, requestId and
hold-status guard. Redundant ID lookups are fault-injected with corrupt JSON row
identity to test fail-closed behavior independently, not counted as healthy-row
attack paths. Storage tests use real SqliteStore; no storage/schema amendment.

`npx tsx test/broker/mutations.ts` operates ONLY on an isolated temporary copy of
source/tests, never worktree src (even if killed). Review IDs lack patch files,
so mutations are explicitly semantic reconstructions. The runner verifies real
assertion failures, cleans the temporary copy and checks worktree source bytes.
The real fake-RPC send_tx handler checks durable offerCount/lastOfferedAt BEFORE
accepting any bytes, with an out-of-band assertion to prevent RPC error sanitizing
from hiding that ordering violation. Prepared-submit one-shot/account binding,
strict nonce provenance, and freeze acknowledgment during the replacement proof
sleep are explicitly mutation-tested.
MCP/HTTP suites are included as integration regressions. B08 deployment/CLI paths
remain outside B06F's ownership.
