# Troubleshooting

Never print keys/tokens, enable protocol logging on stdout, delete accounting holds, disable auth, or publish ports publicly to diagnose a problem.

| Symptom | Check / safe action |
| --- | --- |
| Node/sqlite/import failure | Node 24+; rebuild from source and reinstall fresh tarball; no legacy global bin |
| Help appears on stderr with empty stdout | Expected for `mcp --help` / `help mcp`, exit 0; top-level `--help` / `help` uses stdout. General help is captured in cli-help.txt |
| `Budget Broker bridge: invalid URL or protected token file` | Both BB_URL and BB_TOKEN_FILE required; URL root or /mcp only, no credentials/query/fragment; HTTP loopback or HTTPS; token file regular, caller-owned, no symlink/group/other bits, valid token syntax, ≤4096 bytes |
| MCP starts but tools unavailable | Bridge connects upstream lazily; verify daemon, exact port/host, token revocation and transport route; bridge stderr is diagnostic, stdout protocol-only |
| `UNAUTHENTICATED` after rotation | Replace agent file/path securely with new token, reconnect; revoked old credential cannot be restored by session reuse |
| Token/output file creation fails | Outputs are exclusive/no overwrite; select a new protected path. Token issue/rotate prints path **and credentialId** (`--json`: object); do not parse all stdout as one filename. Token plaintext stays only in its file |
| Owner `FORBIDDEN` | Owner key mode/ownership/passphrase, non-echo TTY or protected automation env; admin URL/Host/Origin; wall-clock within 60s; no bearer header on admin |
| Owner command hangs/fails offline | Most owner commands contact admin; help/init/receipts verify are local. CLI IDs must be broker-issued UUIDs, not labels. Local argument/policy/grant validation and stale policy-write revision exit 2; authentication/authorization (including Host/Origin on writes) exits 3 |
| `NO_POLICY` or zero budget | Set **both** agent and wallet policies, correct agent ID, revision, expiry; zero means zero; inspect own freeze |
| `INVALID_AMOUNT` | MCP/config/wire use integer yocto strings; policy/grant CLI files use human NEAR strings; never numbers/exponents/whitespace; transfer >0 and u128-bounded |
| `WALLET_CAPACITY` despite positive balance | Storage/locked/safety reserve and all holds reduce spendable; stale/failed RPC fails closed; fixture positive-balance check isn't available-capacity validation |
| `GAS_BUDGET_EXCEEDED` | Own actual burnt tokens plus fee holds count, including failed transfers; actual overages cannot be hidden/refunded |
| `APPROVAL_REQUIRED` / pending | Inspect existing request, ask owner to approve/reject or grant scoped standing approval; do not repeat with new keys; hard caps still apply |
| `POLICY_CHANGED` on approval | Reread request/policy and review current digest/revision; do not blindly approve stale work |
| `IDEMPOTENCY_CONFLICT` | Same agent/key had another payload; inspect original request and reconcile before any genuinely new intent |
| Submitted/unknown is stuck | Preserve ID/key/holds; owner reconcile polls existing attempts/watches only; missing history isn't proof; no fresh-key duplicate payment |
| Force resolution did not restore budget | Intentional: uncertain principal+fees stay held until mature exclusion/final execution; later evidence may charge and globally freeze |
| Agent unfreeze did not restart failed work | Never-offered signed requests may have been abandoned permanently; owner must authorize a genuinely new intent/key, never revive signed history |
| Global freeze after late execution | Review signed lateResolution on both chains, actual principal/gas/standing overrun, reconcile before owner unfreeze |
| `AUDIT_UNAVAILABLE` | Stop spending; check protected volume capacity/integrity and retained audit root; restore a coherent backup, not a fresh audit key beside old history |
| `BROKER_UNAVAILABLE` at startup | Check its separate redacted diagnostic reason below; do not expose raw config/environment/keys |
| Lock file remains after crash | **Expected**: SQLite kernel locks release automatically; retain files, never unlink/replace them. Same-key locks use stable OS-account home, not HOME/TMPDIR. Old text O_EXCL format alone needs migration after old daemon stops; see operator guide |
| Fixture faucet outage | Rerun apply using same external directory; no account/key regeneration; --check alone never provisions missing state |
| Fixture envelope won't init-custody | Already encrypted; reuse broker-key.json and binary master.secret; init-custody accepts raw ed25519 text only |
| Compose secret decrypt fails | Base uses file secrets: set BB_MASTER_FILE to exact binary master.secret and BB_CONFIG_FILE to edited config; absolute paths outside repo, 0600 files, 0700 parent. Ensure mapped uid 1000 can read, without relaxing permissions. No environment/content secret override needed |
| Compose override tag error | Compose >=2.24.4 needed for prebuilt !reset; set BB_IMAGE consistently, validate config --quiet without logging secrets |
| Docker build from tarball fails | Tarball intentionally excludes src/lock/tsconfig; build image from source checkout or use trusted prebuilt override |
| Containerized agent cannot reach localhost | Its localhost is not host loopback; arrange restricted route in deployment, never publish admin publicly |
| Offline receipt verification fails | Export begins at genesis; pass one retained checkpoint object, not array, with independently pinned public audit key. Corrupt JSON/schema/signature/checkpoint exits **1**; missing required flags exits 2. Never replace pin/key merely to get valid=true |

## Daemon diagnostics (not MCP/domain codes)

These allowlisted reasons accompany domain `BROKER_UNAVAILABLE` and exit **1**. Text: `Budget Broker: REASON`; `--json`: `{error:{code:"BROKER_UNAVAILABLE",reason:"REASON"}}`. No paths, values, stacks or environment dumps are included. Multiple problems may be masked by the first startup check.

| Reason | Safe action |
| --- | --- |
| `BAD_CONFIG` | Check file existence, JSON/config shape and internal paths; no secret values in config |
| `BAD_MASTER_SECRET` | Check daemon BB_MASTER_SECRET_FILE permissions/ownership/length and exact encryption bytes/envelope; do not trim or re-encode |
| `MASTER_SECRET_ENV_REFUSED` | Remove direct BB_MASTER_SECRET entirely, even if BB_MASTER_SECRET_FILE is set; only file-backed unlock allowed |
| `LISTEN_FAILED` | Port/interface unavailable or already bound; inspect host/config/publications, never publish publicly |
| `DATA_DIR_UNAVAILABLE` | mkdir/chmod/provisioning ownership failed; keep BB_DATA_VOLUME consistent, create via Compose before provisioning at /var/lib/budget-broker as uid 1000 |
| `LOCK_HELD` | Another process holds data or same-key lock; stop the real contender, never delete files or switch volumes/HOME to evade fencing |
| `LOCK_UNAVAILABLE` | Lock path/mode/ownership/symlink/format invalid; operator checks private 0700 directory and uid-owned 0600 SQLite files; no automatic permission repair |
| `RPC_UNAVAILABLE` | Startup RPC transport/HTTP unavailable; restore testnet RPC service, never bypass identity attestation |

Reachable wrong/unprovable RPC chain identity or rejected mainnet config reports **MAINNET_REFUSED** (exit 1), not RPC_UNAVAILABLE, and still blocks custody unlock. `BB_IMAGE` is the selected image and `BB_DATA_VOLUME` the sole private trust-root volume; independent containers/hosts/OS users are not distributed fencing. Never fix a running lock by choosing a fresh volume.

For a minimal report include Node/package version, stable code/reason, request ID/state and public transaction hash if applicable. Do not attach .env, token files, encrypted/unlocked key material, config-secret dumps, raw DB, process environment or entire RPC/SDK errors. Freeze if misuse is suspected. Keep backups/checkpoints protected outside agent reach.
