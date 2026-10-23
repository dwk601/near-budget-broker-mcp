# Examples

Replace every placeholder and sample UUID; these files contain no credentials.

- Claude Desktop: merge `claude-desktop.json` into its MCP settings.
- Claude Code: use `claude-code.mcp.json` as project `.mcp.json` (or merge).
- Cursor: use `cursor.mcp.json` as `.cursor/mcp.json` (or merge).

All run `npx --yes --package /abs/path/near-budget-broker-mcp-0.1.0.tgz budget-broker mcp`. Build and pack first; update absolute tarball path and agent-owned 0600 token path. Node 24+/npx must be on the app's PATH. Restart/reconnect after edits. Tokens belong in files, not JSON/args/source control. Review project trust prompts. `budget-broker mcp --help` exits 0 with help on stderr, leaving MCP stdout empty.

`agent-policy.json`, `wallet-policy.json` and `standing-approval.json` are **owner CLI** inputs: amounts are human decimal NEAR strings. The sample `00000000-0000-4000-8000-000000000001` is a syntactically valid UUID, **not an existing agent**. Replace it with the actual broker-issued agent UUID, replace recipients, review caps and set a short future epoch-ms standing expiry. The illustrative timestamp is not a recommended approval lifetime. CLI UUID/file/money/expired-grant validation errors exit 2; no request is authorized by an example.

`daemon-config.json` uses **integer yoctoNEAR text**, not human NEAR. Replace custody account/public owner key; save edited config outside the repository, mode 0600 in a 0700 directory. No private key/master value belongs in config. Base Compose requires absolute `BB_MASTER_FILE`/`BB_CONFIG_FILE` host paths, file-backed secrets inaccessible to agents. The master must be a regular non-symlink file, 0600 or 0400, **owned by** the daemon uid (mapped uid 1000), not just readable by it (`BAD_MASTER_SECRET` otherwise); config must be readable by that uid. For fixtures, `BB_MASTER_FILE` can point directly to the protected binary master.secret; keep its exact bytes. Only fixture `broker-key.json` is encrypted; 0600 `recovery.json` (full-access key) and `receivers.json` contain plaintext ed25519 private keys. Protect the entire fixtures directory, including the binary master, as secret. No secret-value environment variables or secret override are needed. Daemon `BB_MASTER_SECRET` is refused; Compose sets only container `BB_MASTER_SECRET_FILE`.

Set `BB_IMAGE` (default budget-broker:local) and `BB_DATA_VOLUME` (default budget-broker-data) consistently across Compose and provisioning. Build from a source checkout; then **compose create before provisioning**, so the fresh volume inherits image uid/gid 1000. Copy only the encrypted custody envelope on stdin as uid 1000, mounting at **/var/lib/budget-broker**, never /data. Follow `docker/README.md` for the full sequence. Never expose Docker to agents.

Optional overrides (merge after `docker/docker-compose.yml`):

- `compose.prebuilt.yaml`: removes source build using `!reset` (Compose >=2.24.4); set **BB_IMAGE** to an independently trusted image. Omit build, but still create before provisioning. The base image/volume/secret variables remain authoritative.
- `compose.resources.yaml`: adds 1 GiB memory / 128-process limits without changing ports, secrets or isolation; tune deliberately for workload.

Validate the exact merged files with `docker compose … config --quiet` before create/up. Relative paths resolve against the first/base file; secret paths must be absolute. Both overrides preserve 127.0.0.1 publications and the named volume; no Docker socket, host credentials or state bind mounts. Lock files are SQLite kernel locks retained across restarts, not stale PID files to delete.

The tarball ships built CLI, README, examples, skill and Docker files, not full docs/src/fixture scripts. Use the source checkout for full guides, live provisioning and image builds, or supply a separately trusted image. Use tarball npx for keyless agent bridges.
