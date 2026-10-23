# Agent MCP reference

Exactly eight tools. Identity comes from the bearer token, never an `agentId` argument. Inputs are strict JSON objects: extra fields are rejected. No owner tools, keys, direct signing, arbitrary actions, FT or contract calls. Native NEAR testnet only.

Success is an MCP `content` array containing a text item whose `text` is canonical JSON of the result below; parse that JSON, not a prose summary. Domain bigints serialize as decimal strings. Errors set `isError:true`, text JSON `{"code":"CODE","message":"CODE"}`, and `structuredContent:{"error":{"code":"CODE","message":"CODE"}}`. Tool discovery/transport failures may instead be protocol or HTTP errors. A **policy denial or pending approval can be a successful tool response containing a decision/request with reasons**, not `isError`.

## Shared transfer input

Both preview and request require:

```json
{
  "idempotencyKey": "invoice-0042-attempt-1",
  "receiverId": "receiver.testnet",
  "amount": "1000000000000000000000",
  "memo": "optional off-chain note"
}
```

`amount` is positive **integer yoctoNEAR text** (example: 0.001 NEAR), never a JSON number or human decimal. Canonical `0|[1-9][0-9]*`, but transfer zero is rejected; max 2^128−1 (39 digits). `idempotencyKey`: 1..256 characters; `memo`: optional, at most 1024 characters, off-chain only. Receiver must be a valid NEAR account ID. Omitted memo normalizes to null in the request digest; empty string differs. Reuse the same key and identical payload after timeout/reconnect; changing payload gives `IDEMPOTENCY_CONFLICT`. A different agent's key namespace is independent. Preview requires a key but neither consumes nor records it. Every persisted request permanently consumes its key, including terminal unsent `denied`, `expired`, `rejected` and `cancelled` requests. Replaying it returns that request, not a new admission attempt, even after rate/capacity recovers. A new key and new request require owner authorization; never retry after `rejected`.

## Tools and outputs

| Tool | Input | Result |
| --- | --- | --- |
| `budget_status` | `{}` | `{agent,policy,agentFrozen,usage,remaining,at}`; own scope only |
| `preview_transfer` | Shared transfer input | `{decision,policyRevision,at}`; no hold, request, receipt or idempotency write |
| `request_transfer` | Shared transfer input | `TransferView`; saves one request and decision, reserves if admitted |
| `get_request` | `{"requestId":"ID"}` | Own `TransferView`; other-agent/unknown ID gives `NOT_FOUND` |
| `cancel_request` | `{"requestId":"ID"}` | Own `TransferView` changed to cancelled before signing; signed/ambiguous/terminal work is refused |
| `list_receipts` | `{"afterSeq":0,"limit":100}` (both optional) | Own `ReceiptEvent[]`, ascending sequence; exclusive `afterSeq`, limit 1..1000 |
| `verify_receipt` | `{"receipt":FULL_RECEIPT_EVENT}` | `{valid,chainId,checked,firstInvalidSeq,reason}`; scope is own agent chain |
| `freeze_self` | `{"reason":"nonempty explanation"}` | `{scope:"agent",agentId,frozen:true,reason,at}`; reason 1..1024 characters |

### Budget and decisions

`agent`: `{id,name,status,createdAt}`; status active or revoked (revoked tokens cannot authenticate). Policy includes own agentId/revision, monetary caps, ratePerMinute/maxOutstanding, recipients, approvalThreshold and optional expiresAt. `usage` has `agentRolling24h`, `agentLifetime`, `agentGas24h` (yocto strings), `agentRequestsLastMinute` and `agentOutstanding` (integer counts). `remaining` has `perTx`, `rolling24h`, `lifetime`, `gas24h` (yocto strings), `requestsPerMinute`, `outstandingSlots` (counts). Missing/expired policy or own freeze yields zero remaining. No custody balance, wallet policy, global freeze flag, other-agent usage or standing totals are exposed. Remaining own quota is **not** a capacity/approval promise.

Preview decision is `{kind:"allow",reasons:[]}`, `{kind:"deny",reasons:[CODE,...]}`, `{kind:"needs_approval",reasons:["APPROVAL_REQUIRED"]}`, or `{kind:"allow_via_standing_approval",reasons:[],standingApprovalId}`. It is advisory and may change before admission/dispatch.

### TransferView and lifecycle

Fields: `id,agentId,idempotencyKey,requestDigest,receiverId,amount,memo?`, `state,reasons,policyRevision,approvalRef`, `createdAt,updatedAt,expiresAt,signedAt,submittedAt,completedAt`, `txHash,gasBurnt,tokensBurnt,explorerUrl`. Timestamps are integer epoch **ms**, nullable where not yet known; nullable revision/approvalRef; `approvalRef` is `{kind:"request"|"standing",id}`. Amount/tokensBurnt are yocto strings, gasBurnt is a gas-unit decimal string; null fees mean unknown, not zero. Explorer URL is null with no hash, otherwise `https://testnet.nearblocks.io/txns/` plus hash. A hash/signature/submission is **not final success**.

States: `denied`, `pending_approval`, `approved`, `rejected`, `expired`, `cancelled`, `queued`, `signed`, `submitted`, `succeeded`, `failed`, `outcome_unknown`. Pending approval reserves principal+fees; ask the owner to review the existing ID, do not create many new requests. The daemon uses a fixed **300 s (5 minute)** request TTL: `expiresAt = createdAt + 300000`. The deadline covers **`pending_approval`, `queued` and `approved`** before signing. At or after it, pending approval expires when processed by the sweeper or owner action; queued/approved work expires when the dispatch gate next processes it, releasing both principal and fee holds. Freeze does not pause or extend the TTL: queued/approved work can expire while globally frozen. Unfreeze does not revive expired work or its consumed key. This TTL does not release signed/offered uncertainty. Approval cannot extend the original deadline; its effective expiry is the earlier of the owner's supplied expiry and the request deadline. Rejection/cancellation also release unsent holds; a denied admission has no hold. These terminal unsent states do not free their idempotency keys. Approved work is re-evaluated before dispatch. Poll `get_request` with bounded backoff. On uncertain outcomes preserve the key/ID and wait for reconciliation; do not pay again with a fresh key. Failed executed transfers still charge actual gas. Explicit owner force-resolution of **offered uncertain bytes** may mark failed **while retaining the hold**; fresh exclusion can release it. Force on **never-offered signed bytes** instead abandons the request and releases principal+fees without a resolution watch. Positive pending/final execution evidence vetoes either force path. Failed alone is not proof funds were released. Automatic post-resolution watches for offered work stop after more than **60 h from the later of signing and last recorded offer**, without releasing uncertain holds; afterwards the owner must use explicit `owner reconcile REQUEST_ID` to check that request. Late execution found during a watch or explicit reconciliation corrects accounting once on both chains and globally freezes for review.

### Receipts and freeze

Receipt fields: `{chainId,seq,prevHash,type,at,payload,hash,signature}`. Sequence starts 1, genesis prevHash is 64 zeros. SHA-256 covers canonical preimage fields (excluding hash/signature); audit Ed25519 signature covers decoded hash bytes. Type-specific payloads record decisions, approvals, queue/submission intent/acknowledgment, settlement/actual fees, unknown outcomes, policy/credential/freeze events. No token or key plaintext. `verify_receipt` checks one event against the daemon's audit key; it does **not** independently pin history/completeness. Page until empty or shorter than limit, continuing from last sequence; export/pin/offline verification is an owner operation. Across pages, history can grow.

`freeze_self` blocks new own spending and final dispatch; owner alone can unfreeze. Own reads/receipts remain available with a valid token. It cannot undo broadcasts. Never-offered signed work may be permanently abandoned and needs a genuinely new request if later authorized; offered uncertainty retains its hold. Use freeze immediately on suspected misuse, then notify the operator.

## Stable error/reason codes

| Codes | Meaning / safe response |
| --- | --- |
| `UNAUTHENTICATED` | Missing/invalid/revoked token; ask owner for a protected replacement, never seek keys |
| `FORBIDDEN` | Invalid arguments, forbidden origin/host, cross-chain verification, uncancellable state or authorization; correct usage/review |
| `AGENT_FROZEN`, `GLOBAL_FROZEN` | Stop spending; owner review, no bypass |
| `NO_POLICY` | Missing/expired effective policy; ask owner |
| `PER_TX_EXCEEDED`, `ROLLING_24H_EXCEEDED`, `LIFETIME_EXCEEDED` | Own hard principal caps; do not split requests to evade them |
| `GLOBAL_CAP_EXCEEDED` | Wallet rolling cap; owner review |
| `GAS_BUDGET_EXCEEDED` | Own monetary gas cap, including reservations/failed fees |
| `RATE_LIMITED`, `MAX_OUTSTANDING` | Back off and inspect existing requests. A persisted `denied` request stays denied on same-key replay; capacity recovery does not revive it. Only owner authorization permits a new key/request |
| `RECIPIENT_NOT_ALLOWED` | Recipient policy refusal; no alternate signing path |
| `WALLET_CAPACITY` | Insufficient/stale/unknown spendable capacity; preview is not a guarantee |
| `APPROVAL_REQUIRED` | Owner or valid standing approval needed within the original 300 s TTL; preserve existing pending request and check for expiry |
| `IDEMPOTENCY_CONFLICT` | Key reused for different immutable payload; inspect original request, do not blindly retry |
| `NOT_FOUND` | Unknown or not-owned request; do not probe others' IDs |
| `BROKER_UNAVAILABLE` | Dependency/transport unavailable; outcome may be ambiguous, inspect/retry same key only |
| `INVALID_AMOUNT` | Incorrect monetary representation/range/zero transfer; use exact positive yocto text |
| `MAINNET_REFUSED` | Network attestation/config refused; no mainnet or alternate RPC bypass |
| `AUDIT_UNAVAILABLE` | Audit failure blocks mutation/dispatch; notify owner |
| `NONCE_CONFLICT` | Custody lane/nonce conflict; owner reconciliation, no direct retry-signing |
| `POLICY_CHANGED` | Approval policy revision changed; owner rereads/reviews |

Validation authenticates first. Codes are stable; raw RPC/SQL/stack/secret details are intentionally suppressed.
