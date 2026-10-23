# Troubleshooting

Never print keys/tokens, enable protocol logging on stdout, delete accounting holds, disable auth, or publish ports publicly to diagnose a problem.

| Symptom | Check / safe action |
| --- | --- |
| Node/sqlite/import failure | Node 24+; rebuild from source and reinstall fresh tarball; no legacy global bin |
| `--help` returns `USAGE` | Known B08 base CLI gap; see package-validation.md; do not treat usage error as working help |
| `Budget Broker bridge: invalid URL or protected token file` | Both BB_URL and BB_TOKEN_FILE required; URL root or /mcp only, no credentials/query/fragment; HTTP loopback or HTTPS; token file regular, caller-owned, no symlink/group/other bits, valid token syntax, ≤4096 bytes |
| MCP starts but tools unavailable | Bridge connects upstream lazily; verify daemon, exact port/host, token revocation and transport route; bridge stderr is diagnostic, stdout protocol-only |
| `UNAUTHENTICATED` after rotation | Replace agent file/path securely with new token, reconnect; revoked old credential cannot be restored by session reuse |
| Token/output file creation fails | Outputs are exclusive/no overwrite; select a new path, ensure protected parent exists; never loosen permissions |
| Owner `FORBIDDEN` | Owner key mode/ownership/passphrase, non-echo TTY or protected automation env; admin URL/Host/Origin; wall-clock within 60s; no bearer header on admin |
| Owner command hangs/fails offline | Most owner commands contact admin; receipts verify is local; failures suppress underlying secret-bearing errors |
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
| `BROKER_UNAVAILABLE` at startup | Config, RPC testnet identity, permissions, custody/master bytes, lock ownership and port conflicts; check redacted daemon stderr |
| Lock remains after crash | Prove old process/container is dead across deployments, back up state; only then remove stale daemon.lock/per-key tmp lock through operator-controlled recovery; never steal live locks |
| Fixture faucet outage | Rerun apply using same external directory; no account/key regeneration; --check alone never provisions missing state |
| Fixture envelope won't init-custody | Already encrypted; reuse broker-key.json and binary master.secret; init-custody accepts raw ed25519 text only |
| Compose secret decrypt fails | Exact bytes matter; fixture master is binary; use compose.fixture.yaml, not BB_MASTER_MATERIAL; never trim/re-encode master |
| Compose override tag error | Compose >=2.24.4 needed for !override/!reset; validate config --quiet without logging secrets |
| Docker build from tarball fails | Tarball intentionally excludes src/lock/tsconfig; build image from source checkout or use trusted prebuilt override |
| Containerized agent cannot reach localhost | Its localhost is not host loopback; arrange restricted route in deployment, never publish admin publicly |
| Offline receipt verification fails | Export must begin genesis; pass one independently retained checkpoint object (not array); trusted public audit key must match; never replace pin/key just to get valid=true |

For a minimal report include Node/package version, stable code, request ID/state and public transaction hash if applicable. Do not attach .env, token files, encrypted/unlocked key material, config-secret dumps, raw DB, process environment or entire RPC/SDK errors. Freeze if misuse is suspected. Keep backups/checkpoints protected outside agent reach.
