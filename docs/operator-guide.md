# Operator guide

Native NEAR, testnet only. Read the [security boundary](security-model.md) first. Run all owner/provisioning commands in a protected operator environment, never an agent shell. Node 24+, npm and Docker Compose v2 are prerequisites. The CLI does not provide a transfer/signing bypass.

## Provisioning

1. From source: `npm ci && npm run build`. `npm run fixtures:native -- --apply` creates a random funded testnet custody account, broker and recovery full-access keys, and receiver A/B subaccounts. `npm run fixtures:native -- --check` checks permissions, keys, network and positive balances without provisioning. Requires public RPC/faucet; rerun apply with the same external directory after an outage, not a new identity. Do not infer dispatch capacity from the fixture presence check.
2. `budget-broker owner init-owner-key --out /protected/owner.json` creates an encrypted Ed25519 owner key, exclusively mode 0600. Save its returned public key. Use a long random passphrase (minimum 12 characters). Unlock prompts on a TTY without echo. `BB_OWNER_PASSPHRASE` is only for protected automation; same-user environment inspection and CI logs can expose it. Never put secrets on command lines.
3. The fixture `broker-key.json` is **already encrypted**, with the exact binary bytes in `master.secret`. It is ready to install as volume `custody.json`; do not pass that envelope to `init-custody`. For a different raw broker key, the supported initialization is:

   ```sh
   budget-broker init-custody --key-file /protected/native-key --master-file /protected/master --out /protected/custody.json
   ```

   Raw input is only an `ed25519:…` secret string, not credentials JSON; 0600 and owned by the caller. Master file: 32..4096 bytes, verbatim, newline-sensitive. Output is an exclusive encrypted envelope, not plaintext. Never use the fixture recovery key as the daemon key. Custody encryption has no agent-facing API.
4. Copy/edit `examples/daemon-config.json` outside the repo. Set the custody account from fixture `manifest.json` and returned owner public key. Config amounts are canonical **yoctoNEAR strings**. Data/audit paths are container-internal. Set `BB_CONFIG_JSON` to the edited config's contents in the protected deployment environment (it contains no unlock secret).
5. For fixtures, set `BB_FIXTURES_DIR` to the absolute external directory (default `~/.budget-broker/testnet-fixtures`). Use `examples/compose.fixture.yaml` to mount the binary master as a secret. Do **not** put binary master bytes in `BB_MASTER_MATERIAL`; shell environment cannot represent arbitrary binary/NUL bytes. For a separate text master, the base Compose's `BB_MASTER_MATERIAL` must be exactly the same text used at encryption time, no added newline. Compose secrets are not a defense against a Docker-controlling user.
6. Populate the named volume before startup, in a protected shell. This example assumes the fixed base volume name, a fixture envelope, and a trusted local `node:24-slim` image (pull/build it separately if needed). It sends only the encrypted envelope on stdin and never mounts the fixture directory:

   ```sh
   docker volume create budget-broker-data
   docker run --rm -i --user 0:0 --network none --read-only --cap-drop ALL \
     --cap-add CHOWN --cap-add DAC_OVERRIDE \
     --mount type=volume,source=budget-broker-data,target=/data \
     --entrypoint sh node:24-slim -c \
     'test ! -e /data/custody.json && umask 077 && tee /data/custody.json >/dev/null && chown -R 1000:1000 /data' \
     < "$BB_FIXTURES_DIR/broker-key.json"
   ```

   This is **operator-only provisioning**, not a capability granted to agents. Never overwrite an existing installation, change trust roots, or delete the volume to clear an error. For non-fixture custody, redirect the separately initialized envelope instead. Preserve encrypted backups and exact master material in protected storage, outside agent access.
7. Validate and start from the checkout root:

   ```sh
   docker compose -f docker/docker-compose.yml -f examples/compose.fixture.yaml config --quiet
   docker compose -f docker/docker-compose.yml -f examples/compose.fixture.yaml up -d --build
   ```

   Overrides require Compose >=2.24.4. Base image builds require **source**, not just the tarball; `compose.prebuilt.yaml` can select a separately trusted image via `BB_DAEMON_IMAGE`. Keep host ports 127.0.0.1:3210/3211, container ports/config unchanged. Only the container's listener binds 0.0.0.0. Do not expose either port publicly. Clear provisioning secrets from the deployment environment when finished; supply them again through protected automation for restarts. Never put them in agent `.env` files.

The daemon refuses a non-testnet RPC identity and uses one SQLite DB, custody envelope and audit key in the named volume. It runs uid/gid 1000 with read-only rootfs, dropped capabilities and a bounded tmpfs. Keep a single volume/daemon for this custody key across deployments/hosts. Namespace-local locks cannot fence independent replicas.

## Owner CLI reference

Prefix each form below with `budget-broker` (or `node dist/main.js` in a built checkout). This table is derived from `src/cli/index.ts`'s command forms and exercised by the **installed-bin command matrix** in `test/package/package.test.ts` against an offline admin recording stub. It verifies parsing/flags and outgoing operations, not live payment success. Current base `--help` returns USAGE instead of help; the packaging test deliberately requires proper help (see [amendments](package-validation.md)). No undocumented subcommand help is assumed.

| Form | Purpose |
| --- | --- |
| `owner init-owner-key --out FILE` | Exclusive encrypted owner key creation; returns path/publicKey |
| `init-custody --key-file FILE --master-file FILE --out FILE` | Encrypt a raw custody secret using exact master bytes |
| `daemon --config FILE` | Start daemon; `BB_CONFIG_FILE` fallback when flag omitted |
| `mcp` | Keyless stdio bridge using `BB_URL` and `BB_TOKEN_FILE` |
| `owner agent create NAME` | Create agent; returns generated ID |
| `owner agent list` | Page agents |
| `owner agent revoke AGENT_ID REASON` | Permanent revocation, including credentials |
| `owner token issue AGENT_ID --out NEW_FILE` | Write one-time plaintext token to new 0600 file |
| `owner token rotate CREDENTIAL_ID --out NEW_FILE` | Revoke old credential and issue replacement |
| `owner token revoke CREDENTIAL_ID` | Immediately revoke credential |
| `owner policy set --file FILE` | Agent policy CAS update |
| `owner policy get AGENT_ID` | Inspect agent policy |
| `owner wallet-policy set --file FILE` | Wallet policy CAS update; required before spending |
| `owner approvals list` | Page pending-approval requests |
| `owner approvals approve REQUEST_ID EXPIRES_AT_EPOCH_MS` | Approve exact persisted request |
| `owner approvals reject REQUEST_ID REASON` | Reject/release pre-signing hold |
| `owner standing grant --file FILE` | Grant bounded standing approval |
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

Flags: `--key FILE` overrides `BB_OWNER_KEY_FILE`; `--url URL` overrides `BB_ADMIN_URL` (default `http://127.0.0.1:3211`). `--json` makes errors/path responses JSON; structured results are already JSON. Owner remote reads/mutations are Ed25519-signed POSTs with replay-resistant nonces, not bearer tokens. Local key initialization and offline receipt verification need no admin connection. Reasons with spaces must be quoted. `--force` is only valid with resolve-attempt. Never pass private material in `--audit-key`: this is a **public** `ed25519:…` key.

List pagination: agent list, approvals list, standing list and requests list accept `--limit 1..1000` (default 1000) and `--after CURSOR`, using returned `nextCursor`. IDs use ascending byte order, not timestamps. Receipt/checkpoint exports auto-page all sequences and return arrays; `--out` exclusively creates a protected file and refuses overwrite/symlinks. Token output likewise prints only a file path. Find credential IDs in `credential_issued` receipts; rotation takes the credential ID, not the agent ID. Deliver the new token file to its agent uid and reconnect clients; revocation is immediate.

Exit status: 0 success/clean shutdown, 1 dependency/operation/verification failure, 2 usage, 3 authentication/authorization failure. Errors go to stderr, codes only; MCP stdout is protocol only.

## Policies and gas

Use the JSON examples after replacing IDs/recipients. Owner **CLI** monetary fields (`perTxMax`, `rolling24hMax`, `lifetimeMax`, `gasBudget24h`, `approvalThreshold`, `safetyReserve`, standing `totalMax`) are ordinary unsigned decimal **NEAR strings**. No JSON numbers, exponent notation, leading integer zeros, whitespace or more than 24 decimals. CLI converts once to yoctoNEAR; daemon config, admin wire, receipts and MCP already use yoctoNEAR strings. All values are u128-bounded. `gasBudget24h` is a monetary cap, not gas units.

Revision 1 creates a missing policy (`expectedRevision=null`); revision N compares against N-1. Read before updating. Missing/expired policy denies, zero caps mean zero, empty allowlist means no recipients. `approvalThreshold:null` removes the approval gate, **not** hard limits. Optional `expiresAt` and all approval expiries are Unix epoch milliseconds; expiry applies at equality. Per-agent principal rolling/lifetime, gas, rate, outstanding and recipient limits compose with wallet rolling/safety reserve and fresh spendable balance. `budget_status` is not a wallet-capacity promise.

Admission reserves principal plus configured `feeReservePerTx`, including pending approvals. Outstanding holds count until safe settlement even beyond 24h. Settled rolling usage ages out after 24h; rate counts distinct admitted requests in 60s, not idempotent retries. Final successful principal is spent; failed transfers release principal but charge actual aggregate `tokensBurnt` to the requesting agent. Gas is charged once, including failed execution. Unused fee reserve is released; actual overage is charged, never hidden. Tune the reserve conservatively; stale/unknown RPC balance fails closed. `gasBurnt` is separately reported in gas units.

## Approvals

Strictly above threshold: `pending_approval` with reason `APPROVAL_REQUIRED`, not necessarily an MCP exception. Use `owner approvals list`, inspect the exact request, then approve with a short future epoch-ms expiry or reject with a reason. Approval binds digest and current policy revision; `POLICY_CHANGED` requires reread/review. Approval does not dispatch through current freeze, hard caps or stale capacity.

For standing approval, edit `examples/standing-approval.json`: agent, optional recipients (absent=any, empty=none), perTx/total maxima and mandatory near-term expiry. Run `owner standing grant --file FILE`, retain returned ID, inspect with `owner standing list AGENT_ID`, revoke with `owner standing revoke APPROVAL_ID`. It bypasses only the above-threshold prompt; principal is reserved against its total atomically and consumed only on successful settlement. Expiry/revocation before dispatch blocks use; it cannot undo executed payments.

## Receipts, checkpoints and recovery

`CHAIN_ID` is `owner` or `agent:AGENT_ID`. Export to a new protected path. Capture `owner audit-key` independently; do not learn the trust root from an untrusted export. Receipt export creates a checkpoint on a nonempty new head. List checkpoints, select **one object** from the array, and retain it in independent, protected external storage. `owner receipts verify --file receipts.json --checkpoint retained-object.json --audit-key ed25519:TRUSTED_KEY` works offline, needs no owner key, and checks signatures, canonical hash, genesis/linkage and retained-head inclusion. `valid:false` exits 1. The checkpoint array itself is not a valid `--checkpoint` input. A checkpoint proves only its prefix, not absence of deletion after that pin; retain newer pins frequently.

SIGTERM/SIGINT stops scheduling/listeners and awaits broker work before locking custody/closing SQLite; allow the 90s grace period to exceed RPC workload. On restart, persisted signed bytes/nonce/holds are reconciled, not blindly re-signed. Freeze is serialized with final dispatch authorization, but cannot recall offered work. Agent freeze may permanently fail never-offered signed work; unfreeze does not revive it. Unknown offered work keeps holds, possibly indefinitely.

`resolve-attempt` is exceptional: normal resolution requires fresh aged retained-history exclusion evidence, not merely a timeout/missing indexer row. Positive pending/final execution vetoes resolution. Explicit `--force` retires an uncertain lane item **but retains its principal+fee hold**. It does not free capacity or create a replacement. Durable watches keep checking late execution even after validity expiry; late actual execution is charged once on both chains and triggers global freeze for owner review. Reconcile real fees/principal/standing overrun before unfreezing; do not delete DB rows/holds to unblock agents.
