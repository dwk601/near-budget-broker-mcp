# B06 broker integration

`BrokerService` implements the agent and owner ports. Inject Store, NearChain,
unlocked CustodySigner, ReceiptLog, ApprovalService, CheckpointLog, Clock and
account/fee/freshness configuration. Principals come from B03 authenticators,
not principal-shaped JSON. All components must share the store/audit trust root.

Await `start()` before serving requests. `requestTransfer`/`approve` drain by
default; set `autoDispatch: false` when the daemon schedules `drain()`. Repeated
drains drive unresolved outcomes and approval expiry. `expirePending()` is also
available separately. The broker owns no timers, servers or background promises.
Stop scheduling, await in-flight work, then lock custody and close Store.

## Dispatch and recovery

A process-wide pump serializes drain/recovery for the custody key. A separate
per-attempt lane serializes owner freeze/policy/revocation/approval mutations with
final authorization, signing, durable submission intent and broadcast. Each
attempt releases this lane; FINAL-status polling is outside it. Waiting owner
mutations therefore commit before the next queue item. Every iteration re-reads
live state and refreshes stale balance outside SQL. Stale-only capacity failure
pauses admitted work, never denies it. Pending execution remains submitted.

Only persisted bytes are offered. Both signed and outcome_unknown attempts may
rebroadcast those exact bytes after a status lookup. A new signature requires
persisted positive non-execution proof. The native adapter derives proof from
validated attempt bytes, structured negative lookups, final nonce/expiry evidence
and a second negative lookup after that observation; it works after restart.
Timeout, InvalidNonce rejection alone, missing fields or indexer absence alone
never unlock a replacement. A proven non-executed attempt whose replacement is
no longer authorized is failed with zero burn and its reservation released.

A signed **never-offered** attempt has no durable intent/acknowledgment receipt
(and thus could not have reached broadcast in this broker). Under the lane it may
be abandoned when its agent is frozen/revoked or authorization otherwise fails.
This releases its reservation and permits other agents to proceed at higher
nonces. Already-offered ambiguity cannot use that exception. Global freeze pauses
the lane, but final evidence can still settle work while frozen.

`resolveAttempt(owner, requestId, reason)` is an explicit zero-execution owner
attestation, never a blind automated retry. Pending/final execution evidence vetoes
it. When chain evidence is unknown the owner accepts responsibility for asserting
no execution; the broker terminally fails the request, releases its hold and writes
failed receipts on both owner and agent chains. The optional `resolution` payload
records attemptId, evidence and basis (`owner_attested`, `chain_proof`, or
`never_offered`), distinguishing these from measured chain failures. Receipt
failure rolls back the entire resolution. This operation creates no replacement.

`reconcile` examines existing attempts only and returns examined requests, not the
request table; it never starts unrelated queued payments. Preview refreshes an
ephemeral balance without writing any rows or receipts. A backwards clock step
skips pending expirations newer than the clock. Standing approvals stay bound to
the decision's grant and are re-reserved at signing. Benign policy revision drift
at owner approval returns `POLICY_CHANGED` instead of an opaque error.

Settlement charges actual tokensBurnt (including failures/overage) exactly once,
and conservatively debits cached balance without extending observation freshness.
RPC refresh is serialized against settlement. This may underestimate capacity
when a chain snapshot already reflected an unresolved transfer, but cannot invent
capacity.

## Deployment prerequisites and compatible amendments

* B08 must enforce **one daemon process per custody key**, e.g. an exclusive
  process lock. Multiple BrokerService connections/instances in that process are
  supported. Active-active processes need a durable fenced leadership port, not
  an expiring unfenced lock. SQLite admission/idempotency alone is insufficient
  for cross-process freeze-versus-broadcast serialization.
* State-changing owner operations have typed owner receipts. Reads have no
  `owner_operation` variant and do not manufacture mutation receipts. Idempotent
  B12 standing revocation remains a no-op. These exceptions were accepted by the
  independent review.
* Receipt-array export is unchanged/backward-compatible and checkpoints a new
  nonempty head transactionally. B08 can expose B13's existing checkpoint list
  API for metadata and external pinning; embedded keys are not trust roots.
* Coordinator-authorized shared changes are limited to optional txStatus attempt
  context, resolveAttempt, POLICY_CHANGED, optional failed-resolution metadata,
  and the corresponding architecture/tests. No storage/approval schema migration.

## Regression evidence

`test/broker/review.test.ts` covers F1–F12, nonzero RPC/broadcast latency, all
owner serialization boundaries and the reported non-equivalent mutation gaps.
`native-integration.test.ts` composes real NativeNearChain and encrypted custody
with a fake RPC for Expired, InvalidNonce and a transient pre-send attestation
failure. `test/near/non-execution.test.ts` exercises proof boundaries and vetoes.

`npx tsx test/broker/mutations.ts` temporarily applies semantic reconstructions
of the review's identified mutations, runs the focused suite for each and always
restores source. IDs were supplied without patch files, so these are explicitly
reconstructions rather than a claim to have executed undisclosed original patches.
The review's equivalent/defense-only survivors are not counted as semantic gaps.
