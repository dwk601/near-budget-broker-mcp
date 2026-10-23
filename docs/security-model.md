# Security model and explicit limits

## Trusted and untrusted components

Untrusted: mutually hostile agents, their prompts/tool inputs, MCP sessions and request IDs. Trusted: operator signing environment, host/kernel/container runtime, daemon code/dependencies, storage/audit root, and configured RPC's truthful retained final history. This is **testnet-only experimental native NEAR custody**, not production custody, multi-party consensus, or a defense against a malicious host/RPC.

Only the daemon has the encrypted custody key, unlock secret, DB and private audit key. The stdio bridge receives a protected scoped bearer token, URL and MCP bytes, not a wallet key. Agent identity is authenticated on every HTTP/tool operation, including existing sessions; session IDs are not credentials. Request/receipt lookups are ownership-filtered. Tokens are random bearer secrets stored as hashes server-side; stealing one compromises that agent's allowed capabilities until revoked. An agent can spend its entire allowed budget and freeze itself; policy is not intent validation.

The owner CLI signs method/path/body-hash/nonce/time with a separate encrypted Ed25519 owner key. The daemon holds only the public owner key. Owner requests have a 60s time window and durable replay protection. The admin port exposes bounded broker operations, not arbitrary SQL/signing or an owner transfer bypass. Owner policy/approval authority is highly privileged: protect it.

## Isolation is a deployment requirement

**Agents must not have Docker socket/control, root, owner key/passphrase, custody/recovery keys, master material, daemon named-volume or provisioning-environment access.** A same-user shell can often inspect files, environment, processes or Docker: run it under a **separate OS user or properly isolated container/sandbox** without those capabilities. A second terminal, hidden filename, chmod under the same uid, or encrypted-at-rest file beside an available unlock secret is not a boundary. Host administrators/Docker users can inspect an unlocked daemon. Encryption protects locked data, not a compromised process.

No Docker socket or host credential-directory mounts. Named-volume custody/DB, separate Compose secrets, read-only rootfs, uid 1000, no-new-privileges and dropped capabilities reduce accidental exposure but do not defeat host control. Raw custody/owner keys never enter the daemon image/build context; only the encrypted custody envelope is provisioned. Fixture recovery keys are a separate full-access escape hatch and must be protected from agents too. Binary master files must not be coerced into environment text.

Agent/admin host publications bind 127.0.0.1, not 0.0.0.0; validate Host/Origin against DNS rebinding. Do not trust forwarded headers or disable authentication for loopback clients. Default browser Origins are denied; bearer tokens are not owner capabilities. An agent container needs an explicit restricted route to the daemon, not a public admin publication.

## Accounting, authorization and audit

Fail closed: missing/expired policies, zero caps, freeze/revocation, stale/unknown balance, invalid monetary values and audit failure deny spending. Native transfer only, fixed signer, explicit persisted nonce/signed bytes, testnet RPC identity check, no arbitrary action or mainnet fallback. Bigint/u128 arithmetic and integer yocto text avoid floating-point money.

Atomic admission combines current authorization, scoped idempotency, reservations and signed decision. Pending approvals reserve principal+gas. Standing approvals bypass only the approval gate, not hard caps. Final authorization shares serialization with freeze/policy/revocation writes before broadcast invocation. Freeze cannot recall offered payments, and ambiguous outcomes retain holds. Actual transaction plus receipt fees belong to the requesting agent, even on failed execution; real fees above reserve still count. Preview/remaining quota never guarantees shared-wallet capacity.

One daemon process, database and volume/trust root per custody key. In-volume and uid-local per-key locks are fail-closed, but **independent containers/hosts with different volumes are not fenced**. No active-active deployment. Preserve locks after crashes until the operator establishes the old process is dead. SQLite alone cannot serialize cross-process network broadcast against freeze.

Persist before broadcast; reuse exact signed bytes after ambiguity. Missing indexer/transaction visibility, timeouts and InvalidNonce alone do not prove non-execution. Automated replacement uses restrictive sole-first-rejection provenance plus mature retained-history exclusion evidence. A lying/stale RPC is not independently disproved by these rules. Uncertainty may retain funds indefinitely. Force resolution retires a lane item without releasing uncertain holds; durable watches charge late actual outcomes and globally freeze for review. Never manually erase holds to restore capacity.

Independent per-agent and owner receipt chains use SHA-256 canonical preimages and a distinct audit Ed25519 key. Audit/signature failure rolls back mutations. Signatures prove possession of a trusted key, not truth of a compromised daemon/RPC, full historical availability, or absence of truncation. Independently pin the public audit key and external checkpoints. A local DB/checkpoint cannot detect its own rollback; a retained external pin protects only through its sequence. Newer deleted suffixes remain undetectable without newer pins. Audit key compromise permits forged history; backup/monitor the trust root.

## Not provided

Mainnet, FT, contract calls, arbitrary signing/key management, active-active fencing, guaranteed payment liveness, fee estimates as final accounting, automated release on timeouts, unprivileged defense against host/Docker/root access, or production-grade custody guarantees. Independent RPC/chain auditing, external checkpoint retention, OS isolation and secret lifecycle remain operator duties.
