# Agent MCP reference

The broker exposes exactly eight tools. The bearer token identifies the agent, and no tool takes an `agentId` argument. Inputs are strict JSON objects, and the broker rejects extra fields. Agents get no owner tools, no keys, no direct signing, no arbitrary actions, and no fungible token or contract calls. Only native NEAR on testnet is supported.

A successful call returns an MCP `content` array with one text item. Its `text` is canonical JSON of the result described below. Parse that JSON rather than any prose. Bigint values serialize as decimal strings. On error the result sets `isError:true`, the text is JSON `{"code":"CODE","message":"CODE"}`, and `structuredContent` is `{"error":{"code":"CODE","message":"CODE"}}`. Failures during tool discovery or in the transport may instead arrive as protocol or HTTP errors. A policy denial or a pending approval can be a successful tool response that contains a decision or request with reasons, not an `isError` result.

## Shared transfer input

`preview_transfer` and `request_transfer` both take:

```json
{
  "idempotencyKey": "invoice-0042-attempt-1",
  "receiverId": "receiver.testnet",
  "amount": "1000000000000000000000",
  "memo": "optional off-chain note"
}
```

`amount` is a positive integer number of yoctoNEAR written as a string. The example is 0.001 NEAR. It is never a JSON number or a decimal NEAR value. The canonical form is `0|[1-9][0-9]*`, but a transfer of zero is rejected. The maximum is 2^128−1, which has 39 digits. `idempotencyKey` is 1 to 256 characters. `memo` is optional, at most 1024 characters, and never goes on chain. `receiverId` must be a valid NEAR account ID. An omitted memo becomes null in the request digest, which differs from an empty string.

After a timeout or reconnect, send the same key with the identical payload. A changed payload returns `IDEMPOTENCY_CONFLICT`. Each agent has its own key namespace. A preview needs a key but does not use it up or record it. Every stored request keeps its key forever, including requests that ended without being sent: `denied`, `expired`, `rejected`, and `cancelled`. Replaying the key returns that request and does not try admission again, even after rate limits or capacity recover. A new key and a new request need owner authorization. Never retry after `rejected`.

## Tools and outputs

| Tool | Input | Result |
| --- | --- | --- |
| `budget_status` | `{}` | `{agent,policy,agentFrozen,usage,remaining,at}` for the calling agent only |
| `preview_transfer` | Shared transfer input | `{decision,policyRevision,at}`. Creates no hold, request, or receipt, and records no idempotency key |
| `request_transfer` | Shared transfer input | `TransferView`. Stores one request and its decision, and reserves funds if admitted |
| `get_request` | `{"requestId":"ID"}` | The agent's own `TransferView`. Another agent's ID or an unknown ID returns `NOT_FOUND` |
| `cancel_request` | `{"requestId":"ID"}` | The agent's own `TransferView`, now cancelled. Works only before signing. Signed, ambiguous, or finished work is refused |
| `list_receipts` | `{"afterSeq":0,"limit":100}`, both optional | The agent's own `ReceiptEvent[]` in ascending sequence. `afterSeq` is exclusive. `limit` is 1 to 1000 |
| `verify_receipt` | `{"receipt":FULL_RECEIPT_EVENT}` | `{valid,chainId,checked,firstInvalidSeq,reason}`. Checks only the agent's own chain |
| `freeze_self` | `{"reason":"nonempty explanation"}` | `{scope:"agent",agentId,frozen:true,reason,at}`. The reason is 1 to 1024 characters |

### Budget and decisions

`agent` is `{id,name,status,createdAt}`, and `status` is `active` or `revoked`. A revoked agent's token cannot authenticate. `policy` holds the agent's own `agentId` and revision, its amount caps, `ratePerMinute`, `maxOutstanding`, recipients, `approvalThreshold`, and an optional `expiresAt`.

`usage` has `agentRolling24h`, `agentLifetime`, and `agentGas24h` as yoctoNEAR strings, and `agentRequestsLastMinute` and `agentOutstanding` as integer counts. `remaining` has `perTx`, `rolling24h`, `lifetime`, and `gas24h` as yoctoNEAR strings, and `requestsPerMinute` and `outstandingSlots` as counts. If the policy is missing or expired, or the agent is frozen, every remaining value is zero. The tool does not show the custody balance, the wallet policy, the global freeze flag, other agents' usage, or standing grant totals. Remaining quota does not promise wallet capacity or approval.

A preview decision is one of:

- `{kind:"allow",reasons:[]}`
- `{kind:"deny",reasons:[CODE,...]}`
- `{kind:"needs_approval",reasons:["APPROVAL_REQUIRED"]}`
- `{kind:"allow_via_standing_approval",reasons:[],standingApprovalId}`

A preview is advisory, and the result may change before admission or dispatch.

A queued or approved request cannot start using a standing grant it was never bound to. It returns to `pending_approval` for the owner. Signed attempts never switch grants either. If the attempt was never offered, or fresh evidence shows it did not execute, the broker can mark it failed. If it was offered and the outcome is unclear, the broker keeps its holds until evidence arrives or the owner resolves it. If an executed payment exceeds the remaining standing capacity, the broker still records it, revokes the grant, and sets the global kill switch. Ask the owner to review, and never create a replacement payment.

### TransferView and lifecycle

A `TransferView` has these fields:

- `id`, `agentId`, `idempotencyKey`, `requestDigest`, `receiverId`, `amount`, `memo` (optional)
- `state`, `reasons`, `policyRevision`, `approvalRef`
- `createdAt`, `updatedAt`, `expiresAt`, `signedAt`, `submittedAt`, `completedAt`
- `txHash`, `gasBurnt`, `tokensBurnt`, `explorerUrl`

Timestamps are integer epoch milliseconds and are null until known. `policyRevision` and `approvalRef` can be null. `approvalRef` is `{kind:"request"|"standing",id}`. `amount` and `tokensBurnt` are yoctoNEAR strings, and `gasBurnt` is a decimal string of gas units. A null fee means unknown, not zero. `explorerUrl` is null when there is no hash, and otherwise is `https://testnet.nearblocks.io/txns/` followed by the hash. A hash, a signature, or a submission does not mean the transfer succeeded.

The states are `denied`, `pending_approval`, `approved`, `rejected`, `expired`, `cancelled`, `queued`, `signed`, `submitted`, `succeeded`, `failed`, and `outcome_unknown`.

A pending approval reserves principal and fees. Ask the owner to review the existing request ID, and do not create more requests. The daemon gives every request a fixed time to live of 300 seconds, so `expiresAt = createdAt + 300000`. The deadline applies to `pending_approval`, `queued`, and `approved`, which are the states before signing. Once it passes, a pending request expires the next time the sweeper or an owner action processes it. A queued or approved request expires the next time the dispatch gate processes it. Expiry releases both the principal hold and the fee hold. A freeze does not pause or extend the deadline, so queued or approved work can expire during a global freeze. Unfreezing does not revive expired work or free its key. The deadline never releases signed or offered work with an uncertain outcome. An approval cannot extend the original deadline. It expires at the owner's chosen time or at the request deadline, whichever comes first. Rejection and cancellation also release unsent holds, and a denied request never had a hold. These final states keep their idempotency keys. The broker checks approved work again before dispatch.

Poll `get_request` with bounded backoff. If the outcome is uncertain, keep the key and ID and wait for reconciliation. Do not pay again with a new key. A failed transfer that executed still pays its actual gas.

The owner can force-resolve an attempt in two cases:

- For signed bytes that were offered and have an uncertain outcome, forcing may mark the request failed while the hold stays in place. Fresh evidence that it did not execute can release the hold.
- For signed bytes that were never offered, forcing abandons the request and releases the principal and fees, with no resolution watch.

Positive evidence that the transfer is pending or executed blocks both. A `failed` state alone does not prove the funds were released.

For offered work, automatic watches after resolution stop once more than 60 hours have passed since signing or the last recorded offer, whichever is later. They do not release uncertain holds when they stop. After that, the owner must run `owner reconcile REQUEST_ID` to check the request. If a watch or an explicit reconcile finds a late execution, the broker corrects accounting once on both chains and sets a global freeze for review.

### Receipts and freeze

A receipt has the fields `{chainId,seq,prevHash,type,at,payload,hash,signature}`. Sequence numbers start at 1, and the genesis `prevHash` is 64 zeros. The SHA-256 hash covers the canonical preimage fields, which exclude `hash` and `signature`. The audit Ed25519 signature covers the decoded hash bytes. Each receipt type has its own payload. Payloads record decisions, approvals, queueing, submission intent and acknowledgment, settlement and actual fees, unknown outcomes, and policy, credential, and freeze events. No receipt contains a token or key in plaintext.

`verify_receipt` checks one event against the daemon's audit key. It does not pin history or prove that the chain is complete. To read the whole chain, page until a page comes back empty or shorter than the limit, continuing from the last sequence number. The chain can grow between pages. Export, pinning, and offline verification are owner operations.

`freeze_self` blocks the agent's new spending and its final dispatch, and only the owner can unfreeze. The agent can still read its own state and receipts with a valid token. A freeze cannot undo a broadcast. Signed work that was never offered may be abandoned permanently and then needs a new request if the owner later allows it. Offered work with an uncertain outcome keeps its hold. Freeze at once if you suspect misuse, then tell the operator.

## Error and reason codes

| Codes | Meaning and safe response |
| --- | --- |
| `UNAUTHENTICATED` | The token is missing, invalid, or revoked. Ask the owner for a protected replacement. Never look for keys |
| `FORBIDDEN` | Invalid arguments, a forbidden Origin or Host, verification of another agent's chain, a state that cannot be cancelled, or an authorization failure. Fix the call or ask for review |
| `AGENT_FROZEN`, `GLOBAL_FROZEN` | Stop spending and wait for owner review. There is no bypass |
| `NO_POLICY` | The effective policy is missing or expired. Ask the owner |
| `PER_TX_EXCEEDED`, `ROLLING_24H_EXCEEDED`, `LIFETIME_EXCEEDED` | The agent's hard principal caps. Do not split requests to get around them |
| `GLOBAL_CAP_EXCEEDED` | The wallet rolling cap. Ask the owner to review |
| `GAS_BUDGET_EXCEEDED` | The agent's gas budget, counting reservations and fees from failed transfers |
| `RATE_LIMITED`, `MAX_OUTSTANDING` | Back off and inspect existing requests. A stored `denied` request stays denied when you replay its key, even after capacity recovers. Only the owner can authorize a new key or request |
| `RECIPIENT_NOT_ALLOWED` | The policy does not allow this recipient. There is no other signing path |
| `WALLET_CAPACITY` | Spendable capacity is too low, stale, or unknown. A preview does not guarantee capacity |
| `APPROVAL_REQUIRED` | The owner or a valid standing approval must approve within the original 300-second deadline. Keep the existing pending request and check whether it expired |
| `IDEMPOTENCY_CONFLICT` | The key was already used with a different payload. Inspect the original request and do not retry blindly |
| `NOT_FOUND` | The request is unknown or belongs to another agent. Do not probe other agents' IDs |
| `BROKER_UNAVAILABLE` | A dependency or the transport is down, and the outcome may be unclear. Inspect the request, and retry only with the same key |
| `INVALID_AMOUNT` | The amount has the wrong format, is out of range, or is zero. Send an exact positive yoctoNEAR string |
| `MAINNET_REFUSED` | The broker refused the network attestation or config. There is no mainnet path and no RPC bypass |
| `AUDIT_UNAVAILABLE` | An audit failure blocks changes and dispatch. Tell the owner |
| `NONCE_CONFLICT` | A nonce conflict in the custody lane. The owner must reconcile. Do not retry by signing directly |
| `POLICY_CHANGED` | The policy revision changed under an approval. The owner rereads and reviews |

The broker authenticates before it validates input. Codes are stable. The broker never returns raw RPC, SQL, stack, or secret details.
