# B06 broker integration

`BrokerService` implements both frozen agent/owner ports. Construct it with the
Store, NearChain, unlocked CustodySigner, ReceiptLog, ApprovalService,
CheckpointLog, Clock and the account/fee/freshness configuration. Principals must
come from B03's authenticators; a principal-shaped JSON object is not authentication.
B12's ApprovalService must use the same store/audit trust root as the broker.

Await `start()` before serving requests. `requestTransfer`/`approve` drain queued
work by default; set `autoDispatch: false` when the daemon schedules `drain()`.
Schedule repeated `drain()` calls for unresolved outcomes and pending expiry;
`expirePending()` is also available separately. There are no broker-owned timers,
servers, background promises or custody locks to clean up. Stop scheduling, await
in-flight operations, then lock custody and close the Store in the daemon.

The process-wide lane is keyed by testnet/account/public key, shared by multiple
broker instances/connections, and held across final authorization, durable intent,
broadcast and settlement. Freeze/policy/revocation mutations share this boundary.
Admission is always one independent SQLite immediate transaction. An ambiguous
attempt pauses all later nonces; reconciliation queries final evidence even when
frozen. Signed, unsent work pauses on freeze or failed reauthorization, retaining
its hold. Recovery rebroadcasts only identical stored bytes, never a fresh nonce.
Positive non-execution proof is first persisted, then a subsequent drain may
replace that attempt. Cancellation never touches signed work.

A final settlement conservatively debits the cached balance in the same SQL
transaction without extending its observation/freshness timestamp. RPC refresh
is outside SQL and serialized against settlement. This may underestimate capacity
if a chain snapshot already reflected an unresolved transfer, but cannot invent
capacity. Actual fees, including reserve overage and failed transactions, are
accounted at settlement.

## Amendment requests / deployment prerequisites

* **B00/B08:** the Store port has no durable dispatch lease/fencing operation and
  cannot hold its synchronous transaction over custody/RPC awaits. Run exactly
  **one daemon process per custody key** (including freeze/policy administration).
  Multiple BrokerService instances in that process are supported. To support
  active-active *processes*, add a durable fenced per-key lane/leadership port;
  SQLite admission/idempotency alone cannot serialize broadcast versus freeze
  across processes. Never use expiring unfenced locks to permit blind takeover.
* **B00/B04/B13:** the frozen receipt union has no administrative-read,
  reconciliation, export, or checkpoint-created event. All state-changing owner
  operations append existing typed owner events (B12 idempotent standing
  revocation remains a no-op); owner reads/reconcile/export cannot truthfully
  append an event for **every** owner invocation. Add a bounded `owner_operation`
  receipt variant if that literal requirement is mandatory. Export checkpoints
  the current nonempty chain head transactionally, but the frozen return type is
  receipts only: return checkpoint metadata in an amended export result or expose
  B13's paged checkpoint API in the owner transport for external pinning.
* B05's real native adapter currently returns unknown, not positive chain
  non-execution proofs. Consequently real InvalidNonce/expired-block rejection
  remains held/paused until independently obtained final evidence. This is the
  required fail-closed behavior, not an automatic retry facility.
