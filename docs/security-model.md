# Security model and explicit limits

## Trusted and untrusted components

The broker does not trust agents. It assumes they are hostile to each other, and it also distrusts their prompts, tool inputs, MCP sessions, and request IDs. It trusts the operator's signing environment, the host kernel and container runtime, the daemon code and its dependencies, the storage and audit root, and the configured RPC to report retained final history truthfully. This is experimental custody of native NEAR on testnet. It is not production custody or multi-party consensus, and it does not defend against a malicious host or RPC.

Only the daemon holds the encrypted custody key, the unlock secret, the database, and the private audit key. The stdio bridge receives a protected bearer token, a URL, and MCP bytes, and never a wallet key. The daemon authenticates the agent on every HTTP request and tool call, including calls on existing sessions. Session IDs are not credentials. Request and receipt lookups return only the calling agent's records. Tokens are random bearer secrets, and the server stores only their hashes. A stolen token gives the thief that agent's allowed capabilities until the owner revokes it. An agent can spend its whole allowed budget and can freeze itself. A policy limits amounts and recipients. It does not check what the agent intends.

The owner CLI signs the method, path, body hash, nonce, and time with a separate encrypted Ed25519 owner key. The daemon holds only the owner public key. Owner requests must arrive within a 60-second window, and the daemon stores nonces to block replay. The admin port offers a fixed set of broker operations. It has no endpoint for arbitrary SQL, raw signing, or an owner transfer that skips the checks. The owner key can change policy and approve spending, so protect it.

## Isolation is a deployment requirement

Agents must not have Docker socket access or Docker control, root, the owner key or passphrase, the custody or recovery keys, the master secret, the daemon's named volume, or the provisioning environment. A shell running as the same user can often read files, environment variables, processes, and Docker. Run agents as a separate OS user or in an isolated container or sandbox that lacks those capabilities. None of these is a boundary: a second terminal, a hidden filename, chmod under the same uid, or an encrypted file next to a readable unlock secret. Host administrators and Docker users can inspect an unlocked daemon. Encryption protects locked data, not a compromised process.

The deployment mounts no Docker socket and no host credential directories. Several settings reduce accidental exposure but do not defeat someone who controls the host:

- custody and the database on a named volume
- separate file-backed Compose secrets
- a read-only root filesystem
- uid 1000
- `no-new-privileges`
- dropped capabilities

`BB_MASTER_FILE` and `BB_CONFIG_FILE` are absolute protected host paths outside the repository, with 0600 files in 0700 directories that agents cannot read. The master file must be a regular file, not a symlink, with mode 0600 or 0400. The daemon uid must own it, and read access alone is not enough. Inside the container that uid is 1000. Otherwise startup reports `BAD_MASTER_SECRET`. The daemon uid must also be able to read the config. These two secret file mounts are a deliberate operator exception. They are not bind mounts of state directories. The binary master bytes stay verbatim in the file. The daemon reads `BB_MASTER_SECRET_FILE` and refuses a direct `BB_MASTER_SECRET`, even when a file is also set.

Raw custody keys and owner keys never enter the daemon image or its build context. Only the encrypted envelope crosses into the volume, over stdin. `compose create` initializes a fresh volume at `/var/lib/budget-broker` before provisioning, which keeps uid 1000 as the owner. Of the fixture files, only `broker-key.json` is encrypted. `recovery.json` (a full-access key) and `receivers.json` contain plaintext ed25519 private keys with mode 0600. The binary `master.secret` is also secret, so keep agents out of the whole fixtures directory. `broker.sqlite` and its WAL and SHM sidecar files have mode 0600, and the daemon refuses symlinks for any of them.

The agent and admin ports publish on 127.0.0.1, not 0.0.0.0. The daemon validates Host and Origin to block DNS rebinding. Do not trust forwarded headers, and do not turn off authentication for loopback clients. The daemon denies browser Origins by default. A bearer token never grants owner capabilities. An agent in a container needs an explicit restricted route to the daemon, never a public admin port.

## Accounting, authorization and audit

The broker denies spending when anything is missing or uncertain: a missing or expired policy, a zero cap, a freeze or revocation, a stale or unknown balance, an invalid amount, or an audit failure. It sends only native transfers from a fixed signer. It stores the nonce and signed bytes explicitly, checks the RPC's testnet identity, and never falls back to arbitrary actions or mainnet. Amounts use bigint and u128 arithmetic over integer yoctoNEAR strings, never floating point.

Admission is one atomic step that checks current authorization, applies the agent-scoped idempotency key, takes reservations, and writes a signed decision. Pending approvals reserve principal and gas. Standing approvals bypass only the approval gate, not hard caps. A queued or approved request cannot start using a standing grant it was never bound to. It returns to `pending_approval` for the owner. Signed attempts cannot switch grants either. For an authorization mismatch the broker releases their holds only when the attempt was never offered or when fresh exclusion evidence exists. Otherwise the holds stay. If an executed payment exceeds the remaining standing capacity, the broker still records it, revokes the grant, and sets the global kill switch, which leaves other active standing reservations intact.

The final authorization check takes the same lock as freeze, policy, and revocation writes, before the broadcast call. A freeze cannot recall an offered payment, and an ambiguous outcome keeps its holds. The requesting agent pays the actual transaction and receipt fees, even when execution fails, and fees above the reserve still count. Neither a preview nor the remaining quota guarantees capacity in the shared wallet.

Run one daemon process, one database, and one volume or trust root per custody key. The daemon holds two SQLite EXCLUSIVE locks for its lifetime. One protects `dataDir/daemon.lock`. The other is a database named after the custody public key, in the `.budget-broker-locks` directory under the OS account home. That second lock stops the same key from running with a different data directory or port under one OS user and namespace, whatever `HOME` and `TMPDIR` say. The daemon refuses existing lock files with unsafe permissions. The kernel releases both locks on SIGKILL or a crash, but the lock files must stay in place and must never be unlinked or replaced. The image keeps the OS account home, and therefore the key lock, on the same private named volume.

These locks do not coordinate independent users, containers, or hosts with different volumes. The broker has no active-active mode and no distributed leader election. Keep `BB_IMAGE` and `BB_DATA_VOLUME` consistent and keep one trust root per key. An old text O_EXCL lock needs a one-time migration, and only after the old daemon has stopped. Never use that deletion step on current SQLite locks.

The broker persists signed bytes before it broadcasts them, and after an ambiguous result it resends the exact same bytes. A missing indexer entry, a timeout, or an `InvalidNonce` error does not by itself prove that a transaction did not execute. Automatic replacement needs one of two independent proofs that it did not execute:

- **First-rejection nonce proof.** The attempt has exactly one offer, and that first offer received either a definitive `EXPIRED_BLOCK_HASH` rejection or an `INVALID_NONCE` rejection. The `INVALID_NONCE` record must carry the rejected transaction's nonce and an access-key nonce at rejection time that is strictly greater. A fresh access-key view pinned to the final head must show a nonce greater than or equal to the attempt nonce.
- **Expiry proof.** This works for any number of offers and needs no first-rejection record. The access-key nonce pinned to the final head must be strictly below the attempt nonce. The final height must be at least the anchor height plus the protocol transaction validity period plus 1000 blocks. The time since signing must be at least the validity period times 1000 ms. Two definitive `UNKNOWN_TRANSACTION` lookups must be at least 1 second apart. A consumed nonce rules out this path, however much margin has passed.

Both paths verify the stored signed bytes. Both require the last recorded offer to be at least 60 seconds old, require matching anchor history to be retrievable, and require a second negative lookup after the key observation pinned to the final head. Both lead to the same `proven_not_executed` replacement flow, which checks exclusion and current authorization again before it commits and sends a replacement. Both depend on the trusted RPC reporting its retained final history truthfully. Missing or garbage-collected history counts as no proof, and the broker cannot detect an RPC that lies or lags. See [proof and replacement details](architecture.md#b06f-m1l4-separate-nonce-and-generous-expiry-exclusion-rules).

Owner `resolve-attempt` normally requires fresh exclusion evidence. Evidence that the transfer is pending or executed blocks it, even with `--force`. For signed bytes that were offered and have an uncertain outcome, forcing marks the lane item failed but keeps the principal and fee holds, and fresh exclusion evidence can release them later. For signed bytes that were never offered, forcing abandons the request and releases both holds, with no resolution watch. "Never offered" means the broker's durable records show no submission intent and no acknowledgment. A transaction missing from the chain does not qualify.

For offered work, automatic watches after resolution stop once more than 60 hours have passed since signing or the last recorded offer, whichever is later, and they free no uncertain holds when they stop. After that, run `owner reconcile REQUEST_ID`. An unscoped `reconcile` does not extend the automatic watches. When a watch finds a late outcome, the broker charges it once on both receipt chains and sets a global freeze for review. Uncertain work may hold funds indefinitely, and reaching the watch limit does not prove the transfer did not execute. Never erase holds by hand to restore capacity.

Each agent has its own receipt chain, and the owner has a separate one. Chains use SHA-256 over canonical preimages and a dedicated Ed25519 audit key. If the audit write or signature fails, the broker rolls back the change. A valid signature shows that the trusted key signed the entry. It does not show that a compromised daemon or RPC told the truth, that all history is still available, or that nobody truncated the chain. Pin the public audit key and external checkpoints in separate storage. A local database or checkpoint cannot detect its own rollback. An external pin protects history only through its sequence number, and entries deleted after the newest pin stay undetectable. Anyone with the audit key can forge history, so back up and monitor the trust root.

## Not provided

The broker does not provide:

- mainnet, fungible tokens, or contract calls
- arbitrary signing or key management
- active-active fencing
- guaranteed payment liveness
- fee estimates as final accounting
- defense against anyone with host, Docker, or root access
- production-grade custody guarantees

Holds on offered bytes with an uncertain outcome are never released just because time passed. Releasing them needs final evidence, an exclusion proof, or owner resolution under the rules above, and forcing alone keeps uncertain holds. This does not affect the 300-second expiry of unsent requests or the evidence-based expiry proof. The operator remains responsible for independent RPC and chain auditing, keeping external checkpoints, OS isolation, and the secret lifecycle.
