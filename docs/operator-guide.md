# Operator guide

Native NEAR, testnet only. Read the [security boundary](security-model.md) first. Run owner/provisioning commands in a protected operator environment, never an agent shell. Node 24+, npm and Docker Compose v2 are prerequisites. The CLI provides no transfer/signing bypass.

## Provisioning

1. From source: `npm ci && npm run build`. `npm run fixtures:native -- --apply` creates a random funded testnet custody account, broker and recovery full-access keys, and receiver A/B subaccounts. `npm run fixtures:native -- --check` checks permissions, keys, network and positive balances without provisioning. Requires public RPC/faucet; retry apply with the same external directory after an outage, not a new identity. Do not infer dispatch capacity from the fixture check.
2. `budget-broker owner init-owner-key --out /protected/owner.json` exclusively creates a 0600 encrypted Ed25519 owner key and returns its path/public key. Use a long random passphrase (12..4096 characters). Unlock prompts on a TTY without echo. `BB_OWNER_PASSPHRASE` is only for protected automation: environment inspection/CI logs can expose it. Never pass secrets as argv. The daemon receives only the public key.
3. Fixture `broker-key.json` is **already encrypted** using the exact binary `master.secret`. Install it as volume `custody.json`; do not pass that envelope to `init-custody`. For a separately provisioned raw broker key, use:

   ```sh
   budget-broker init-custody --key-file /protected/native-key --master-file /protected/master --out /protected/custody.json
   ```

   Raw input is only an `ed25519:…` secret string, not credentials JSON; 0600 and caller-owned. Master file: 32..4096 verbatim bytes, newline-sensitive. Output is an exclusive encrypted envelope. Never use the fixture recovery key as the daemon key.
4. Copy/edit `examples/daemon-config.json` **outside the repo**, in a protected 0700 directory, with file mode **0600**. Set the custody account from fixture manifest and returned owner public key. Config amounts are **yoctoNEAR strings**; data/audit paths are container-internal. No private key or master secret value belongs in config.
5. Compose uses **file-backed secrets**, compatible with its read-only service. Set these absolute protected paths, not secret values:

   ```sh
   export BB_MASTER_FILE=/protected/testnet-fixtures/master.secret
   export BB_CONFIG_FILE=/protected/budget-broker/config.json
   export BB_IMAGE=budget-broker:local
   export BB_DATA_VOLUME=budget-broker-data
   ```

   Both files must be outside the repository, 0600, readable by the mapped container uid 1000 and inaccessible to agents. On Linux provision under the correct protected uid; Compose file-secret uid/mode remapping is not portable. On Docker Desktop check file-sharing ownership. **Do not relax permissions** to make startup work. A secret manager may materialize these files. Fixtures generate binary master bytes: keep them verbatim in a file, never in an environment value. Environment/content-sourced Compose secrets do not work with this read-only service. `BB_MASTER_FILE` is the **host Compose path**; Compose mounts it at `/run/secrets/bb_master` and sets daemon `BB_MASTER_SECRET_FILE` to that container path. The config mounts at `/run/secrets/bb_config`. Direct `BB_MASTER_SECRET` is refused, even alongside a file setting.
6. Keep `BB_IMAGE` and `BB_DATA_VOLUME` consistent for every command. From the checkout root, build and **create through Compose before provisioning**:

   ```sh
   docker compose -f docker/docker-compose.yml config --quiet
   docker compose -f docker/docker-compose.yml build
   docker compose -f docker/docker-compose.yml create
   ```

   A fresh volume must first mount at the image's `/var/lib/budget-broker`, whose uid/gid 1000 ownership Docker copies. Mounting it first at `/data` can leave it root-owned. Do not delete or overwrite an existing installation to fix permissions.
7. Send only the encrypted envelope on stdin through a protected operator container, mounting at the **same target**, with no raw-key/fixture-directory bind mount:

   ```sh
   docker run --rm -i --read-only --network none --user 1000:1000 \
     --mount "type=volume,src=$BB_DATA_VOLUME,dst=/var/lib/budget-broker" \
     --entrypoint node "$BB_IMAGE" -e \
     'require("node:fs").writeFileSync("/var/lib/budget-broker/custody.json",require("node:fs").readFileSync(0),{flag:"wx",mode:0o600})' \
     < /protected/testnet-fixtures/broker-key.json
   docker compose -f docker/docker-compose.yml up -d --no-build
   ```

   For separate raw-key initialization, redirect its encrypted envelope instead. Exclusive `wx` refuses overwrite. This is **operator-only**, not an agent Docker capability. Keep deliberate protected backups of envelope/master and recovery material. Never mount owner/raw custody keys, host credential directories or Docker socket into the daemon/agent.

The source Dockerfile builds from src/lock/tsconfig, not the npm tarball. For a separately trusted prebuilt image, set `BB_IMAGE` and merge `examples/compose.prebuilt.yaml`, which removes the build section; omit the build step. The optional `compose.resources.yaml` adds memory/process bounds. Overrides retain loopback publications/isolation; validate the exact merged configuration before create/up. `!reset` needs Compose >=2.24.4.

Keep host ports **127.0.0.1:3210/3211** and container port/config numbers unchanged. Only the container listener binds 0.0.0.0. The image runs uid 1000, rootfs read-only, capabilities dropped, with named-volume state and bounded tmpfs. These protections do not defeat a Docker-controlling user. One volume/daemon/trust root per custody key; no active-active or independent replicas across volumes/hosts. See [Docker provisioning details](../docker/README.md), including ownership repair for an existing volume.

## Owner CLI reference

Prefix forms with `budget-broker` (or `node dist/main.js` in a built checkout). [cli-help.txt](cli-help.txt) is captured from the current real `--help` output and compared byte-for-byte with the **installed bin** in packaging tests. The expanded argument reference below comes from current command forms, verified through executed installed-bin commands and flags against an offline recording admin stub. This verifies CLI/wire behavior, not live payments.

`budget-broker --help`, `budget-broker help`, `budget-broker help owner` and `budget-broker owner --help` return 0 and print the general help on stdout, without key/network access. `budget-broker mcp --help` and `budget-broker help mcp` also return 0 but print help on **stderr**, keeping MCP stdout empty. Help is currently general, not a full bespoke page per command.

| Form | Purpose |
| --- | --- |
| `owner init-owner-key --out FILE` | Exclusive encrypted owner key creation; returns path/publicKey |
| `init-custody --key-file FILE --master-file FILE --out FILE` | Encrypt raw custody secret using exact master bytes |
| `daemon --config FILE` | Start daemon; `BB_CONFIG_FILE` fallback when flag omitted |
| `mcp` | Keyless stdio bridge using `BB_URL` and `BB_TOKEN_FILE` |
| `owner agent create NAME` | Create agent; returns generated UUID |
| `owner agent list` | Page agents |
| `owner agent revoke AGENT_ID REASON` | Permanent revocation, including credentials |
| `owner token issue AGENT_ID --out NEW_FILE` | Write one-time plaintext token to new 0600 file; print path + credentialId |
| `owner token rotate CREDENTIAL_ID --out NEW_FILE` | Revoke old credential, issue replacement; print path + credentialId |
| `owner token revoke CREDENTIAL_ID` | Immediately revoke credential |
| `owner policy set --file FILE` | Agent policy CAS update |
| `owner policy get AGENT_ID` | Inspect agent policy |
| `owner wallet-policy set --file FILE` | Wallet policy CAS update; required before spending |
| `owner approvals list` | Page pending-approval requests |
| `owner approvals approve REQUEST_ID EXPIRES_AT_EPOCH_MS` | Approve exact persisted request; expiry must be future |
| `owner approvals reject REQUEST_ID REASON` | Reject/release pre-signing hold |
| `owner standing grant --file FILE` | Grant bounded standing approval with future expiry |
| `owner standing revoke APPROVAL_ID` | Revoke standing grant |
| `owner standing list AGENT_ID` | Page standing grants |
| `owner freeze global REASON` | Stop global admission/dispatch |
| `owner freeze agent AGENT_ID REASON` | Stop one agent |
| `owner unfreeze global REASON` | Clear global freeze after review |
| `owner unfreeze agent AGENT_ID REASON` | Clear agent freeze, not revocation |
| `owner status` | Private wallet policy/balance/freshness/holds/global freeze |
| `owner audit-key` | Public audit verification key; pin independently |
| `owner requests list [AGENT_ID]` | Page requests, optionally scoped |
| `owner requests get REQUEST_ID` | Read request and testnet explorer URL |
| `owner reconcile [REQUEST_ID]` | Examine existing attempts/watches, not queued payments |
| `owner resolve-attempt REQUEST_ID REASON [--force]` | Exceptional resolution; see below |
| `owner receipts export CHAIN_ID [--out NEW_FILE]` | Export full chain, create latest-head checkpoint |
| `owner checkpoints list CHAIN_ID [--out NEW_FILE]` | Export checkpoint array |
| `owner receipts verify --file FILE --checkpoint FILE --audit-key KEY` | Offline verification against trusted key/pin |

**Agent/request/credential/approval IDs must be actual broker-issued UUIDs**, including IDs inside policy/grant files. Example UUIDs are placeholders, not existing identities. Reasons must be nonblank; quote multiword reasons. CLI validates local arguments/files before owner authentication.

Flags: `--key FILE` overrides `BB_OWNER_KEY_FILE`; `--url URL` overrides `BB_ADMIN_URL` (default `http://127.0.0.1:3211`). `--json` selects machine-readable errors/path output; structured results are already JSON. Remote owner reads/mutations are Ed25519-signed POSTs with replay-resistant nonces, never bearer tokens. Key initialization and offline receipt verification need no admin connection. `--force` is only valid with resolve-attempt. `--audit-key` is a **public** `ed25519:…` key, not private material.

List pagination: agent list, approvals list, standing list and requests list accept `--limit 1..1000` (default 1000) and `--after CURSOR`, using returned `nextCursor`. IDs sort by byte order, not timestamps. Receipt/checkpoint exports auto-page sequences and return arrays; `--out` exclusively creates a protected file and refuses overwrite/symlinks.

Token issuance/rotation prints the absolute path on one line and `credentialId: UUID` on the next; `--json` prints `{path,credentialId}`. Token plaintext appears only in its new 0600 file, never stdout/DB/logs. Use the returned credential ID directly for rotation/revocation (not the agent ID). Choose a new output path, deliver it to the isolated agent uid with mode 0600, and reconnect clients. Old credentials are revoked immediately; old sessions do not preserve access.

Exit status (all errors to stderr):

| Status | Meaning |
| --- | --- |
| 0 | Success, help, or clean shutdown |
| 1 | Operation/dependency/daemon failure or receipt verification failure |
| 2 | Usage/local argument or policy/grant file validation; stale policy-write revision (`POLICY_CHANGED` mapped to `USAGE`) |
| 3 | Authentication/authorization failure, including Host/Origin rejection on policy writes |

Malformed JSON/schema, tampering, signature or checkpoint errors in `receipts verify` exit **1**, not 2/3. Missing required verify flags exit 2. `--json` error shape is `{error:{code}}`; daemon failures may add the separate redacted `reason` (see troubleshooting). Wrong UUIDs, expired grant/approve expiry, invalid monetary files, invalid URL and blank reasons are local usage errors. A policy authorization failure is still exit 3, **not** a stale-revision error.

## Policies and gas

Use the JSON examples after replacing UUIDs/recipients. Owner **CLI** monetary fields (`perTxMax`, `rolling24hMax`, `lifetimeMax`, `gasBudget24h`, `approvalThreshold`, `safetyReserve`, standing `totalMax`) are ordinary unsigned decimal **NEAR strings**. No JSON numbers, exponents, leading integer zeros, whitespace or >24 decimals. CLI converts once; daemon config, admin wire, receipts and MCP already use **integer yoctoNEAR strings**. All amounts are u128-bounded. `gasBudget24h` is a monetary cap, not gas units.

Revision 1 creates a missing policy (`expectedRevision=null`); N compares against N-1. Read before updating; stale policy writes exit 2. Missing/expired policies deny, zero means zero, empty allowlist allows none. `approvalThreshold:null` removes only the approval gate. Optional `expiresAt` and approval expiries are epoch milliseconds; expiry applies at equality. Own caps compose with wallet rolling/safety reserve and fresh spendable balance; `budget_status` is no wallet-capacity promise.

Admission reserves principal + `feeReservePerTx`, including pending approvals. Outstanding holds count until safe settlement even beyond 24h. Settled rolling usage ages out after 24h; rate counts distinct admitted requests in 60s, not retries. Success spends principal; failed execution releases principal but charges aggregate actual `tokensBurnt` to the requesting agent exactly once. Unused fee reserve releases; actual fee overage still counts. Tune reserves conservatively; stale/unknown balance fails closed. `gasBurnt` is separately reported gas units.

## Approvals

Strictly above threshold: `pending_approval` with `APPROVAL_REQUIRED`, not necessarily an MCP exception. Use `owner approvals list`, inspect exact request, approve with a short future epoch-ms expiry or reject with a reason. Approval binds digest/current policy revision; `POLICY_CHANGED` requires reread/review. Approval never bypasses freeze/hard caps/stale capacity.

For standing approval, replace `examples/standing-approval.json`'s sample agent UUID, recipients, perTx/total maxima and illustrative expiry with a short future lifetime. Run `owner standing grant --file FILE`, retain returned ID, inspect with `owner standing list AGENT_ID`, revoke with `owner standing revoke APPROVAL_ID`. Absent recipients means any, empty means none. It bypasses only the approval prompt; reservations consume its total atomically, successful principal finalizes usage. Expiry/revocation before dispatch blocks use; executed payments cannot be undone.

## Receipts, checkpoints and recovery

`CHAIN_ID` is `owner` or `agent:AGENT_UUID`. Export to a new protected path; capture `owner audit-key` independently, not from an untrusted export. Receipt export creates a checkpoint for a nonempty new head. List checkpoints, select **one object** from the array and retain externally. `owner receipts verify --file receipts.json --checkpoint retained-object.json --audit-key ed25519:TRUSTED_KEY` is offline, needs no owner key, and checks signatures, canonical hashes, genesis/links and pinned-head inclusion. `valid:false` exits 1; malformed verification inputs also exit 1. A checkpoint array is not a valid single checkpoint input. Pins protect only their prefix; retain newer pins frequently.

SIGTERM/SIGINT stops scheduling/listeners and awaits work before custody lock/SQLite close; allow the 90s grace period to exceed RPC workload. Restart reconciles persisted signed bytes/nonce/holds, not blind re-signing. Freeze shares final dispatch serialization but cannot recall offered work; agent freeze may permanently fail never-offered signed work. Unfreeze never revives that failed request. Unknown offered work may retain holds indefinitely.

The daemon holds lifetime SQLite EXCLUSIVE kernel locks at `dataDir/daemon.lock` and `<OS-account-home>/.budget-broker-locks/<sha256(custodyPublicKey)>.sqlite`. The second fences the same key across different data dirs/ports within one OS user/namespace. The OS account database, **not HOME/TMPDIR**, determines the stable directory; no production config/env override exists. Existing unsafe ownership/mode/symlinks are refused, not repaired. Private directory 0700, lock files 0600. The image sets its OS-account home on the same named volume. **Retain lock files; never unlink them.** Kernel release after SIGKILL/crash permits restart without PID guessing/manual deletion. Different users/hosts/independent container volumes are not distributed fencing. When upgrading from the old text O_EXCL format only: stop the old daemon, then remove its old text daemon.lock once before starting this version; do not delete SQLite-format locks.

`resolve-attempt` is exceptional: normally requires fresh aged retained-history exclusion, not timeout/indexer absence. Positive pending/final evidence vetoes it. Explicit `--force` retires uncertain lane work **but retains principal+fee hold**; no replacement or new capacity. Durable watches charge late real execution once on both chains and globally freeze for review. Reconcile principal/fees/standing overrun before unfreezing. Never delete DB rows or holds to unblock agents.
