# Operator guide

Budget Broker handles native NEAR on testnet only. Read the [security model](security-model.md) first. Run owner and provisioning commands in a protected operator environment, never in an agent shell. You need Node 24 or later, npm, and Docker Compose v2. The CLI has no command that transfers or signs outside the broker's checks.

## Provisioning

1. Build from source with `npm ci && npm run build`. `npm run fixtures:native -- --apply` creates a random funded testnet custody account, a broker full-access key, a recovery full-access key, and two receiver subaccounts, A and B. `npm run fixtures:native -- --check` checks permissions, keys, network, and positive balances, and provisions nothing. Both commands need the public RPC and faucet. If apply fails during an outage, run it again with the same external directory rather than creating a new identity. A passing check does not tell you how much the broker can dispatch. Only `broker-key.json`, the custody envelope, is encrypted. `recovery.json` holds a plaintext ed25519 full-access private key and `receivers.json` holds plaintext ed25519 receiver private keys, all with mode 0600. `master.secret` holds the binary unlock secret. Treat the whole external fixtures directory as secret and keep agents out of it.
2. `budget-broker owner init-owner-key --out /protected/owner.json` creates a new encrypted Ed25519 owner key file with mode 0600. It refuses to overwrite an existing file and prints the path and public key. Use a long random passphrase of 12 to 4096 characters. On a TTY the unlock prompt does not echo. `BB_OWNER_PASSPHRASE` exists only for protected automation, because environment inspection and CI logs can expose it. Never pass secrets as command-line arguments. The daemon receives only the public key.
3. The fixture `broker-key.json` is already encrypted with the exact binary `master.secret`. Install it in the volume as `custody.json`, and do not pass it to `init-custody`. To encrypt a raw broker key that you provisioned separately, run:

   ```sh
   budget-broker init-custody --key-file /protected/native-key --master-file /protected/master --out /protected/custody.json
   ```

   The raw input file holds only an `ed25519:…` secret string, not a credentials JSON record. It must have mode 0600 and belong to the user running the command. The master file holds 32 to 4096 bytes, read verbatim, so a trailing newline changes the secret. The command creates a new encrypted envelope and refuses to overwrite. Never use the fixture recovery key as the daemon key.
4. Copy `examples/daemon-config.json` to a protected 0700 directory outside the repository, edit it there, and set the file mode to 0600. Set the custody account from the fixture manifest and the owner public key from step 2. Config amounts are yoctoNEAR strings. The data and audit paths are paths inside the container. Config never contains a private key or the master secret.
5. Compose passes secrets as files, which works with its read-only service. Set these variables to absolute protected paths. They are paths, not secret values:

   ```sh
   export BB_MASTER_FILE=/protected/testnet-fixtures/master.secret
   export BB_CONFIG_FILE=/protected/budget-broker/config.json
   export BB_IMAGE=budget-broker:local
   export BB_DATA_VOLUME=budget-broker-data
   ```

   Both files must be outside the repository, have mode 0600, and be unreadable by agents. The master file must be a regular file, not a symlink, with mode 0600 or 0400. The daemon uid must own it, and read access alone is not enough. Inside the container that uid is 1000. If these checks fail, startup reports `BAD_MASTER_SECRET`. The daemon uid must also be able to read the config.

   On Linux, create these files as the correct protected uid, because Compose cannot remap file-secret uid or mode portably. On Docker Desktop, check the file-sharing ownership mapping. Do not loosen permissions to get startup working. A secret manager may write these files for you. The fixtures generate the master as binary bytes, so keep them verbatim in a file and never put them in an environment variable. Compose secrets sourced from the environment or from inline content do not work with this read-only service.

   `BB_MASTER_FILE` is the host path. Compose mounts it at `/run/secrets/bb_master` and sets the daemon's `BB_MASTER_SECRET_FILE` to that container path. The config mounts at `/run/secrets/bb_config`. The daemon refuses a direct `BB_MASTER_SECRET` value, even when a file is also set.
6. Use the same `BB_IMAGE` and `BB_DATA_VOLUME` values for every command. From the checkout root, build and create the service through Compose before you provision the volume:

   ```sh
   docker compose -f docker/docker-compose.yml config --quiet
   docker compose -f docker/docker-compose.yml build
   docker compose -f docker/docker-compose.yml create
   ```

   Docker copies the image's uid/gid 1000 ownership into a fresh volume only when the volume is first mounted at the image's `/var/lib/budget-broker`. If you mount it at `/data` first, the volume can end up owned by root. Do not delete or overwrite an existing installation to fix permissions.
7. Copy the encrypted envelope into the volume over stdin from a protected operator container. Mount the volume at the same target, and do not bind-mount the raw key or the fixtures directory:

   ```sh
   docker run --rm -i --read-only --network none --user 1000:1000 \
     --mount "type=volume,src=$BB_DATA_VOLUME,dst=/var/lib/budget-broker" \
     --entrypoint node "$BB_IMAGE" -e \
     'require("node:fs").writeFileSync("/var/lib/budget-broker/custody.json",require("node:fs").readFileSync(0),{flag:"wx",mode:0o600})' \
     < /protected/testnet-fixtures/broker-key.json
   docker compose -f docker/docker-compose.yml up -d --no-build
   ```

   If you used `init-custody` on a raw key, redirect its envelope instead. The `wx` flag refuses to overwrite an existing file. Only the operator runs this step. It does not grant agents any Docker access. Keep deliberate protected backups of the envelope, the master secret, and the whole fixtures directory, including the plaintext recovery and receiver key files. File permissions are not encryption. Never mount owner keys, raw custody keys, host credential directories, or the Docker socket into the daemon or an agent.

The source Dockerfile builds from `src`, the lockfile, and `tsconfig`, not from the npm tarball. To use a prebuilt image that you trust, set `BB_IMAGE`, merge `examples/compose.prebuilt.yaml` (which removes the build section), and skip the build step. The optional `compose.resources.yaml` adds memory and process limits. Both overrides keep the loopback port publications and the isolation settings. Validate the exact merged configuration before `create` and `up`. The `!reset` tag needs Compose 2.24.4 or later.

Keep the host ports at 127.0.0.1:3210 and 127.0.0.1:3211, and keep the container port numbers and config numbers unchanged. Only the listener inside the container binds 0.0.0.0. The image runs as uid 1000 with a read-only root filesystem and dropped capabilities. State lives on the named volume, and a size-limited tmpfs is the only other writable path. None of this stops a user who controls Docker. Run one volume, one daemon, and one trust root per custody key. Do not run two daemons for the same key, and do not run independent replicas on separate volumes or hosts. See [Docker provisioning details](../docker/README.md), which also covers repairing ownership on an existing volume.

## Owner CLI reference

Prefix each form with `budget-broker`, or with `node dist/main.js` in a built checkout. [cli-help.txt](cli-help.txt) is captured from the real `--help` output, and the packaging tests compare it byte for byte with the help from the installed bin. The packaging tests also ran every command form and flag in the table below through the installed bin against an offline admin stub that records requests. That confirms CLI and wire behavior, not live payments.

`budget-broker --help`, `budget-broker help`, `budget-broker help owner` and `budget-broker owner --help` exit 0 and print the general help on stdout. They read no keys and use no network. `budget-broker mcp --help` and `budget-broker help mcp` also exit 0, but print help on stderr so that MCP stdout stays empty. The help text is one general page, not a separate page per command.

| Form | Purpose |
| --- | --- |
| `owner init-owner-key --out FILE` | Create a new encrypted owner key and print its path and public key |
| `init-custody --key-file FILE --master-file FILE --out FILE` | Encrypt a raw custody secret with the exact master bytes |
| `daemon --config FILE` | Start the daemon. Without the flag it reads `BB_CONFIG_FILE` |
| `mcp` | Start the keyless stdio bridge using `BB_URL` and `BB_TOKEN_FILE` |
| `owner agent create NAME` | Create an agent and print its generated UUID |
| `owner agent list` | List agents, one page at a time |
| `owner agent revoke AGENT_ID REASON` | Revoke an agent and its credentials permanently |
| `owner token issue AGENT_ID --out NEW_FILE` | Write a new token to a new 0600 file and print the path and credentialId |
| `owner token rotate CREDENTIAL_ID --out NEW_FILE` | Revoke the old credential, issue a replacement, and print the path and credentialId |
| `owner token revoke CREDENTIAL_ID` | Revoke a credential immediately |
| `owner policy set --file FILE` | Update an agent policy with a revision check |
| `owner policy get AGENT_ID` | Show an agent policy |
| `owner wallet-policy set --file FILE` | Update the wallet policy with a revision check. Required before any spending |
| `owner approvals list` | List requests waiting for approval, one page at a time |
| `owner approvals approve REQUEST_ID EXPIRES_AT_EPOCH_MS` | Approve the exact stored request. The expiry must be in the future |
| `owner approvals reject REQUEST_ID REASON` | Reject a request and release its unsigned hold |
| `owner standing grant --file FILE` | Grant a bounded standing approval with a future expiry |
| `owner standing revoke APPROVAL_ID` | Revoke a standing grant |
| `owner standing list AGENT_ID` | List an agent's standing grants, one page at a time |
| `owner freeze global REASON` | Stop all admission and dispatch |
| `owner freeze agent AGENT_ID REASON` | Stop one agent |
| `owner unfreeze global REASON` | Clear the global freeze after review |
| `owner unfreeze agent AGENT_ID REASON` | Clear an agent freeze. This does not undo revocation |
| `owner status` | Show wallet policy, balance, freshness, holds, and global freeze state |
| `owner audit-key` | Print the public audit verification key. Pin it in separate storage |
| `owner requests list [AGENT_ID]` | List requests, optionally for one agent |
| `owner requests get REQUEST_ID` | Show a request and its testnet explorer URL |
| `owner reconcile [REQUEST_ID]` | Check existing attempts and watches. Does not dispatch queued payments |
| `owner resolve-attempt REQUEST_ID REASON [--force]` | Resolve a stuck attempt in exceptional cases. See below |
| `owner receipts export CHAIN_ID [--out NEW_FILE]` | Export a full chain and create a checkpoint at the latest head |
| `owner checkpoints list CHAIN_ID [--out NEW_FILE]` | Export the checkpoint array |
| `owner receipts verify --file FILE --checkpoint FILE --audit-key KEY` | Verify offline against a trusted key and retained checkpoint |

Agent, request, credential, and approval IDs must be real UUIDs issued by the broker, including IDs inside policy and grant files. The UUIDs in the examples are placeholders and do not exist. Reasons must not be blank, and multiword reasons need quotes. The CLI validates local arguments and files before it authenticates the owner.

`--key FILE` overrides `BB_OWNER_KEY_FILE`. `--url URL` overrides `BB_ADMIN_URL`, which defaults to `http://127.0.0.1:3211`. `--json` makes errors and path output machine-readable. Structured results are JSON either way. Every remote owner read or write is an Ed25519-signed POST with a nonce that blocks replay. Bearer tokens are never used. Creating keys and verifying receipts offline do not contact the admin port. `--force` is valid only with `resolve-attempt`. `--audit-key` takes a public `ed25519:…` key, not private material.

`agent list`, `approvals list`, `standing list` and `requests list` accept `--limit` from 1 to 1000 (default 1000) and `--after CURSOR`, where the cursor is the returned `nextCursor`. IDs sort by byte order, not by time. Receipt and checkpoint exports fetch every page and return arrays. `--out` creates a new protected file and refuses to overwrite a file or follow a symlink.

`token issue` and `token rotate` print the absolute path on one line and `credentialId: UUID` on the next. With `--json` they print `{path,credentialId}`. The token itself appears only in its new 0600 file, never on stdout, in the database, or in logs. Rotate or revoke with the credential ID, not the agent ID. Pick a new output path, give the file to the isolated agent user with mode 0600, and reconnect the clients. The old credential stops working immediately, including in open sessions.

Diagnostics go to stderr. Verification results go to stdout, including `valid:false`.

| Status | Meaning |
| --- | --- |
| 0 | Success, help, or clean shutdown |
| 1 | Operation, dependency, or daemon failure, or failed receipt verification |
| 2 | Usage error, local argument error, policy or grant file validation error, or a stale policy revision (`POLICY_CHANGED` mapped to `USAGE`) |
| 3 | Authentication or authorization failure, including a Host or Origin rejection on a policy write |

`receipts verify` exits 1, not 2 or 3, on malformed JSON, schema errors, tampering, bad signatures, and checkpoint errors. A missing or unreadable file and a JSON or schema parsing failure also exit 1, with `Budget Broker: AUDIT_UNAVAILABLE` (in `--json` mode, `{error:{code:"AUDIT_UNAVAILABLE"}}`). In this offline command the code means a problem with the local input files, not a failure of the daemon's audit volume. Check the paths, the file contents, and the public key you pinned. If the files parse but the audit key is wrong, the command prints `valid:false` JSON on stdout, writes nothing to stderr, and exits 1, with or without `--json`. Never swap in a different key just to make verification pass. A missing required flag exits 2.

The `--json` error shape is `{error:{code}}`. Daemon failures may add a separate redacted `reason`, described in the troubleshooting guide. Wrong UUIDs, an approval or grant expiry in the past, invalid amounts in files, an invalid URL, and blank reasons are local usage errors. A policy authorization failure exits 3, not the stale revision code.

## Policies and gas

Start from the JSON examples and replace their UUIDs and recipients. In owner CLI files, the amount fields (`perTxMax`, `rolling24hMax`, `lifetimeMax`, `gasBudget24h`, `approvalThreshold`, `safetyReserve`, and the standing `totalMax`) are unsigned decimal NEAR strings. They may not be JSON numbers, and they may not use exponents, leading zeros in the integer part, whitespace, or more than 24 decimal places. The CLI converts them once. The daemon config, the admin wire format, receipts, and MCP already use integer yoctoNEAR strings. Every amount must fit in a u128. `gasBudget24h` is an amount of NEAR, not a count of gas units.

Revision 1 creates a policy that does not exist yet, sent with `expectedRevision=null`. Revision N succeeds only if the stored revision is N-1. Read the policy before you update it. A stale write exits 2. A missing or expired policy denies everything, a zero limit means zero, and an empty allowlist allows no recipients. `approvalThreshold:null` removes the approval gate and nothing else. The optional `expiresAt` and approval expiries are epoch milliseconds, and a policy counts as expired at the exact expiry time. An agent's own caps combine with the wallet rolling cap, the safety reserve, and a fresh spendable balance. `budget_status` does not promise wallet capacity.

Admission reserves the principal plus `feeReservePerTx`, and pending approvals hold the same reservation. Outstanding holds count until the transfer settles safely, even after 24 hours. Settled spending leaves the rolling window after 24 hours. The rate limit counts distinct admitted requests in the last 60 seconds, not retries. A successful transfer spends its principal. A failed transfer releases its principal, but the requesting agent pays the summed actual `tokensBurnt` exactly once. The broker releases unused fee reserve, and charges any fee above the reserve. Set reserves conservatively. A stale or unknown balance denies spending. `gasBurnt` reports gas units separately.

## Approvals

A transfer strictly above the threshold enters `pending_approval` with `APPROVAL_REQUIRED`. The MCP tool call can still succeed in that case. Run `owner approvals list` and inspect the exact request. Then approve it with a short expiry in epoch milliseconds, or reject it with a reason. An approval binds the request digest and the current policy revision. If you get `POLICY_CHANGED`, reread the request and policy and review them again. An approval never bypasses a freeze, a hard cap, or a stale capacity check.

The daemon gives every request a fixed time to live of 300 seconds, so `expiresAt = createdAt + 300000`. No daemon config setting changes it. The deadline applies to requests in `pending_approval`, `queued`, and `approved`, which are the states before signing. Once the deadline passes, a pending request expires the next time the sweeper or an owner action processes it. A queued or approved request expires the next time the dispatch gate processes it. Expiry releases both the principal hold and the fee hold.

A freeze does not pause or extend the deadline. An existing queue can expire during a global freeze, and unfreezing does not revive expired work or free its idempotency key. The deadline never makes it safe to release an attempt that was already signed or offered. An approval expires at the expiry you give or at the original request deadline, whichever comes first, so an approval cannot extend the five minutes. Rejecting or cancelling a request also releases its unsent holds. A denied request never had a hold.

Every stored request keeps its idempotency key forever, including requests that ended without being sent: `expired`, `rejected`, `cancelled`, and `denied`. Replaying the key returns the original request in its current state, even after `RATE_LIMITED` or `MAX_OUTSTANDING` conditions clear. A new key and a new request need your explicit authorization. Agents must never retry after `rejected`.

To grant a standing approval, copy `examples/standing-approval.json`. Replace its sample agent UUID, recipients, per-transfer maximum, total maximum, and sample expiry, and choose a short future lifetime. Run `owner standing grant --file FILE` and keep the returned ID. Inspect grants with `owner standing list AGENT_ID` and revoke one with `owner standing revoke APPROVAL_ID`. If the file omits `recipients`, the grant covers any recipient. An empty list covers none. A standing approval skips only the approval prompt. Each reservation takes from the grant's total atomically, and a successful transfer records its principal as used. If the grant expires or is revoked before dispatch, the broker stops using it. Executed payments cannot be undone.

A queued or approved request can find that the current policy selects a standing grant it was never bound to. The broker then moves it to `pending_approval` for your approval instead of switching grants. Signed attempts cannot switch grants either. If such an attempt was never offered, or fresh evidence shows it did not execute, the broker marks it failed and releases its holds. If it was offered and the outcome is unclear, the broker keeps the holds and waits for evidence or for your resolution. It does not ask for a new approval or broadcast again.

If an executed payment exceeds the grant's remaining standing capacity, the broker still records the actual principal and gas. In the same transaction it revokes the grant and sets the global kill switch so you can review. The broker records the overrun in the ledger and receipts instead of forcing it into the bounded `usedTotal`, which leaves other active standing reservations intact.

## Receipts, checkpoints and recovery

`CHAIN_ID` is `owner` or `agent:AGENT_UUID`. Export to a new protected path. Get the audit key with `owner audit-key` through a separate channel, not from an export you do not trust. Exporting a chain with a new nonempty head creates a checkpoint. List the checkpoints, pick one object from the array, and store it outside the broker. Then run `owner receipts verify --file receipts.json --checkpoint retained-object.json --audit-key ed25519:TRUSTED_KEY`. It runs offline and needs no owner key. It checks signatures, canonical hashes, the genesis entry, the links between entries, and that the chain includes the pinned head. `valid:false` exits 1, and so do malformed inputs. A checkpoint array is not a valid checkpoint input. A pin protects only the history up to it, so retain newer pins often.

On SIGTERM or SIGINT the daemon stops new dispatch at once. It then stops scheduling, closes listeners, and waits for work already in progress before it locks custody and closes SQLite. Set the 90-second grace period longer than your RPC workload. Shutdown does not drain the backlog. Queued work stays in the database and resumes after restart, subject to its original deadline and the current authorization. The daemon does not cancel RPC calls already in flight. On restart it reconciles the stored signed bytes, nonces, and holds, and never re-signs blindly. A freeze uses the same final dispatch lock but cannot recall work already offered. An agent freeze may permanently fail signed work that was never offered, and unfreezing does not revive that request. Work with an unknown outcome may keep its holds indefinitely.

`broker.sqlite` and its WAL and SHM sidecar files have mode 0600. The daemon enforces that when it creates them under a loose umask and when it reopens existing files. It refuses symlinks for the database and the sidecars.

The daemon holds two SQLite EXCLUSIVE locks for its whole lifetime. One is at `dataDir/daemon.lock`. The other is at `<OS-account-home>/.budget-broker-locks/<sha256(custodyPublicKey)>.sqlite`, and it stops a second daemon from using the same key with a different data directory or port, as long as both run as the same OS user in the same namespace. The directory comes from the OS account database, not from `HOME` or `TMPDIR`, and no production config or environment setting overrides it. The daemon refuses existing files or directories with unsafe ownership, modes, or symlinks and does not repair them. The directory has mode 0700 and the lock files have mode 0600. The image puts the OS account home on the same named volume.

Keep the lock files and never unlink them. The kernel releases the locks after SIGKILL or a crash, so a restart needs no PID guessing and no manual deletion. These locks do not coordinate across different users, hosts, or independent container volumes. If you are upgrading from the old text O_EXCL lock format, stop the old daemon and remove its old text `daemon.lock` once before you start this version. Never delete SQLite-format locks.

`resolve-attempt` is for exceptional cases. Normally it needs fresh, aged evidence that the attempt did not execute: either the [first-rejection nonce proof or the independent expiry proof](security-model.md#accounting-authorization-and-audit). A timeout or a missing indexer entry is not enough. Positive evidence that the transfer is pending or executed blocks resolution, even with `--force`.

- For signed bytes that were offered and have an uncertain outcome, `--force` marks the attempt failed and removes it from the lane, but keeps the principal and fee holds. It creates no replacement and frees no capacity. Fresh exclusion evidence lets the broker release the holds instead.
- For signed bytes that were never offered, `--force` abandons the request and releases both holds, and no resolution watch follows. The broker's records must show no submission intent and no acknowledgment. Forcing does not revive the failed request or its key.

For offered work, automatic watches after resolution stop once more than 60 hours have passed since signing or the last recorded offer, whichever is later. The clock does not start at your resolution. Reaching that limit never releases uncertain holds. After the limit, run `owner reconcile REQUEST_ID` to check that specific request. An unscoped `reconcile` does not keep those watches running. If the RPC history is unavailable or garbage-collected, it cannot prove the transfer did not execute. Watches never broadcast. When a watch or an explicit reconcile finds a late execution, the broker corrects accounting once on both chains and sets a global freeze for review. Reconcile principal, fees, and any standing overrun before you unfreeze. Never delete database rows or holds to unblock agents.
