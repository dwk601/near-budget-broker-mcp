# Examples

Replace every placeholder and sample UUID. These files contain no credentials.

- Claude Desktop: merge `claude-desktop.json` into its MCP settings.
- Claude Code: use `claude-code.mcp.json` as the project `.mcp.json`, or merge it in.
- Cursor: use `cursor.mcp.json` as `.cursor/mcp.json`, or merge it in.

All three run `npx --yes --package /abs/path/near-budget-broker-mcp-0.1.0.tgz budget-broker mcp`. Build and pack first. Then set the absolute tarball path and the path to the token file, which the agent user owns with mode 0600. Node 24 or later and npx must be on the app's PATH. Restart or reconnect the app after editing. Keep tokens in files, never in JSON, arguments, or source control. Review the app's project trust prompts. `budget-broker mcp --help` exits 0 and prints help on stderr, leaving MCP stdout empty.

`agent-policy.json`, `wallet-policy.json` and `standing-approval.json` are inputs to the owner CLI, so their amounts are human decimal NEAR strings. The sample UUID `00000000-0000-4000-8000-000000000001` is valid syntax but does not belong to any agent. Replace it with the real UUID the broker issued for your agent, replace the recipients, review the caps, and set a short standing expiry in future epoch milliseconds. The sample timestamp is not a recommended approval lifetime. The CLI exits 2 on an invalid UUID, file, or amount, or on a grant that has already expired. No example authorizes a request.

`daemon-config.json` uses integer yoctoNEAR strings, not human NEAR. Replace the custody account and the owner public key. Save the edited config outside the repository with mode 0600 in a 0700 directory. Config never contains a private key or the master secret.

The base Compose file needs absolute host paths in `BB_MASTER_FILE` and `BB_CONFIG_FILE`, pointing at file-backed secrets that agents cannot read. The master file must be a regular file, not a symlink, with mode 0600 or 0400, and owned by the daemon uid (mapped uid 1000). Read access alone is not enough, and startup reports `BAD_MASTER_SECRET` otherwise. That uid must be able to read the config. With fixtures, `BB_MASTER_FILE` can point straight at the protected binary `master.secret`. Keep its bytes exactly as they are.

Of the fixture files, only `broker-key.json` is encrypted. `recovery.json` (a full-access key) and `receivers.json` hold plaintext ed25519 private keys with mode 0600. Treat the whole fixtures directory, including the binary master, as secret. You need no environment variables holding secret values and no secret override. The daemon refuses `BB_MASTER_SECRET`, and Compose sets only the container's `BB_MASTER_SECRET_FILE`.

Set `BB_IMAGE` (default `budget-broker:local`) and `BB_DATA_VOLUME` (default `budget-broker-data`) to the same values for Compose and for provisioning. Build from a source checkout, then run `compose create` before provisioning so the fresh volume takes the image's uid/gid 1000. Copy only the encrypted custody envelope, over stdin, as uid 1000, with the volume mounted at `/var/lib/budget-broker` and never at `/data`. `docker/README.md` has the full sequence. Never give agents access to Docker.

These optional overrides merge after `docker/docker-compose.yml`:

- `compose.prebuilt.yaml` removes the source build with `!reset`, which needs Compose 2.24.4 or later. Set `BB_IMAGE` to an image you trust. Skip the build, but still run `create` before provisioning. The base file's image, volume, and secret variables still apply.
- `compose.resources.yaml` adds a 1 GiB memory limit and a 128-process limit without changing ports, secrets, or isolation. Tune it for your workload.

Validate the exact merged files with `docker compose … config --quiet` before `create` and `up`. Relative paths resolve against the first file, the base file, and secret paths must be absolute. Both overrides keep the 127.0.0.1 port publications and the named volume, and add no Docker socket, host credentials, or state bind mounts. Lock files are SQLite kernel locks that persist across restarts. They are not stale PID files, so do not delete them.

The tarball ships the built CLI, the README, the examples, the skill, and the Docker files. It does not ship the full docs, `src`, or the fixture scripts. Use the source checkout for the full guides, live provisioning, and image builds, or supply an image you trust. Use the tarball with npx to run the keyless agent bridge.
