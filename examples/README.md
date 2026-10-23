# Examples

Replace every placeholder; these files contain no credentials.

- Claude Desktop: merge `claude-desktop.json` into its MCP settings.
- Claude Code: use `claude-code.mcp.json` as project `.mcp.json` (or merge into existing settings).
- Cursor: use `cursor.mcp.json` as `.cursor/mcp.json` (or merge).

All three run `npx --yes --package /abs/path/near-budget-broker-mcp-0.1.0.tgz budget-broker mcp`. Build and pack first; update the absolute tarball path and agent-owned 0600 token path. Node 24+ and npx must be on the app's PATH. Restart/reconnect the MCP client after edits. Tokens belong in files, not JSON, args or source control. A project config's trust/enable prompt still needs operator review.

`agent-policy.json`, `wallet-policy.json` and `standing-approval.json` are **owner CLI** inputs: amounts are human decimal NEAR strings. Replace IDs/recipients, review caps, and set a short future epoch-ms expiry for the standing grant (the sample timestamp is illustrative, not an appropriate approval lifetime).

`daemon-config.json` uses **yoctoNEAR text**, not human NEAR; replace the custody account and public owner key. No private keys/master secret belong in it.

Compose overrides require Compose >=2.24.4 (`!override` / `!reset`). The base file is `docker/docker-compose.yml`. Use `compose.fixture.yaml` for the fixtures' binary master file instead of the base environment-text secret. `compose.prebuilt.yaml` disables the source build and requires `BB_DAEMON_IMAGE` to name a separately trusted image. Both preserve the base isolation/loopback ports. Compose file paths resolve against the first/base file; environment paths here must be absolute. See the source checkout's operator guide for volume provisioning. Never run Docker from the agent environment.

The tarball ships these examples, skill, Docker files and built CLI, but not fixture scripts or full docs/src. Use the source checkout for live provisioning and image builds; use the tarball for keyless bridges.
