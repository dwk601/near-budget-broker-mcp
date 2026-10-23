# Budget Broker MCP

Budget Broker lets many mutually hostile agents share one NEAR testnet wallet. A custody daemon holds the wallet key and admits native NEAR transfers only within per-agent and wallet-wide limits. It reserves principal and gas for each request, records signed receipt chains, and gives both the owner and each agent a kill switch. Agents reach the daemon through eight MCP tools over a stdio bridge that holds no keys. The broker does not support fungible tokens, contract calls, arbitrary signing, or mainnet.

## Trust model

Read this before installing.

The broker trusts the operator, the daemon, the configured testnet RPC, and the host. An agent bearer token is a scoped capability, not a wallet key. Agents must not have any of the following:

- Docker socket or Docker control
- root
- the owner private key or its passphrase
- the custody key or recovery key
- the master secret
- access to the daemon volume

If an agent runs shell commands as the same OS user as the operator, give it a separate OS user or an isolated container or sandbox. A second terminal is not isolation. Encryption at rest does not protect a daemon that is unlocked and compromised. Run one daemon, one volume, and one trust root per custody key, and never run two daemons for the same key at once. A freeze cannot undo a payment that was already broadcast. This is a testnet tool, not production custody.

## Quickstart

Run these steps in a protected operator environment. You need Node 24 or later, npm, Docker Compose v2, and a source checkout, which provides the fixture scripts and the Docker image build. The npm package is private, so you install it from a local tarball rather than the public registry. After you build, `node dist/main.js --help` (or `budget-broker help` when installed) exits 0. `budget-broker mcp --help` writes its help to stderr so that protocol stdout stays empty.

1. **Create fixtures.** Run `npm ci && npm run build`, then `npm run fixtures:native -- --apply` and `npm run fixtures:native -- --check`. These commands act on live testnet and need the faucet and RPC. They write files outside the repository, by default to `~/.budget-broker/testnet-fixtures`. Only `broker-key.json`, the custody envelope, is encrypted. `recovery.json` holds a full-access key and `receivers.json` holds receiver keys, and both store plaintext ed25519 private keys with mode 0600. `master.secret` holds the binary unlock secret. Treat the whole fixtures directory as secret. Never run provisioning in an agent shell and never give that directory to an agent.
2. **Create the owner key.** Run `node dist/main.js owner init-owner-key --out /protected/owner.json`. Enter a long passphrase at the prompt, which does not echo. Keep the public key it prints, because the config needs it. The daemon never receives the owner private key.
3. **Set up the custody envelope.** The fixture step already encrypted the custody key. Its `broker-key.json` is an encrypted envelope, so do not pass it to `init-custody`. Install it as `custody.json` in the volume and use it with the exact binary `master.secret` from the same fixtures. If you provisioned a raw testnet key some other way, encrypt it with `node dist/main.js init-custody --key-file /protected/native-key --master-file /protected/master --out /protected/custody.json`. The raw key file holds only the `ed25519:…` secret and must have mode 0600. Do not use the recovery key. The [provisioning section](docs/operator-guide.md#provisioning) shows how to move fixtures into the Compose volume.
4. **Start the daemon.** Copy `examples/daemon-config.json` to a location outside the repository and edit it. Set the fixture custody account and the owner public key. Store the config and the master secret in 0600 files inside 0700 directories that agents cannot read. The master secret file must be a regular file, not a symlink, with mode 0600 or 0400, and the daemon uid must own it. Inside the container that uid is 1000. If any of these checks fail, startup reports `BAD_MASTER_SECRET`. Set `BB_CONFIG_FILE` to the absolute host path of the config and `BB_MASTER_FILE` to the path of the fixture's binary `master.secret`. Both variables hold paths, not secret values. The base Compose file passes these as file-backed secrets, which work with a read-only root filesystem. Set `BB_IMAGE=budget-broker:local` and `BB_DATA_VOLUME=budget-broker-data`, and use the same values in every command. Then follow the [provisioning steps](docs/operator-guide.md#provisioning) in order. Build with Compose, run `create` (which sets the volume ownership), copy the encrypted envelope over stdin as uid 1000 into `/var/lib/budget-broker`, and run `docker compose -f docker/docker-compose.yml up -d --no-build`. Do not mount a fresh volume at `/data` first. Both published ports stay on 127.0.0.1. Never mount the owner key, a raw key, or the Docker socket. The daemon refuses a `BB_MASTER_SECRET` value in the environment and reads the secret from the file named by `BB_MASTER_SECRET_FILE` inside the container.
5. **Create an agent, set policies, and issue a token.** In the operator shell:

   ```sh
   export BB_OWNER_KEY_FILE=/protected/owner.json
   export BB_ADMIN_URL=http://127.0.0.1:3211
   node dist/main.js owner agent create demo
   # Put the returned broker-issued UUID and fixture receiver A into agent-policy.json.
   node dist/main.js owner wallet-policy set --file examples/wallet-policy.json
   node dist/main.js owner policy set --file /protected/agent-policy.json
   node dist/main.js owner token issue AGENT_ID --out /protected/new-agent.token
   ```

   Start from `examples/agent-policy.json` and replace its sample UUID. Policy and grant files for the CLI take amounts as human NEAR strings. The daemon config and the MCP tools take integer yoctoNEAR strings, where 1 NEAR is 10^24 yoctoNEAR. An agent with no policy is denied, and a limit of zero means zero, not unlimited. `token issue` and `token rotate` print the token file path and a public credential ID. They never print the token itself. With `--json` the output is `{path,credentialId}`. Keep the credential ID for later rotation or revocation. Give only the token file to the isolated agent user, with mode 0600 and no symlinks.
6. **Pack the bridge and configure MCP.** After building, run `npm pack --pack-destination /protected/packages`. Edit the paths and version in the [Claude Desktop](examples/claude-desktop.json), [Claude Code](examples/claude-code.mcp.json), or [Cursor](examples/cursor.mcp.json) example. All three run the same command:

   ```sh
   BB_URL=http://127.0.0.1:3210 BB_TOKEN_FILE=/agent/private/token \
     npx --yes --package /abs/path/near-budget-broker-mcp-0.1.0.tgz budget-broker mcp
   ```

   The bridge does not sign anything and is not a daemon. An agent running in a container cannot reach the host's loopback through its own localhost. Give it a deliberately restricted network route. Do not publish the ports publicly as a shortcut.
7. **Try the tools.** Call `budget_status {}`. Then call `preview_transfer` and `request_transfer` with `{"idempotencyKey":"demo-001","receiverId":"REPLACE.testnet","amount":"1000000000000000000000"}`, which is 0.001 NEAR. A preview is advisory and reserves nothing. If a retry is ambiguous, send the same key and payload again, and call `get_request {"requestId":"…"}` until the request reaches a final state. See the [tool reference](docs/agent-tools.md) and the [agent skill](skills/budget-broker/SKILL.md).
8. **Freeze.** An agent calls `freeze_self {"reason":"demo complete"}`. The owner runs `node dist/main.js owner freeze global "demo complete"`. A freeze does not roll back work that was already offered to the network, and it does not release uncertain holds, so inspect and reconcile that work. Only the owner can unfreeze.

## Approvals, receipts and gas

A transfer whose amount is strictly above `approvalThreshold` enters `pending_approval` with reason `APPROVAL_REQUIRED`. The broker reserves its principal and fees while it waits.

Every request has a fixed time to live of 300 seconds from creation. The deadline applies to requests in `pending_approval`, `queued`, and `approved`, which are the states before signing. Once the deadline passes, a pending request expires the next time the sweeper or an owner action processes it. A queued or approved request expires the next time the dispatch gate processes it. Expiry releases both the principal hold and the fee hold. A freeze does not pause this clock. Queued or approved work can expire during a global freeze, and unfreezing does not revive it or free its idempotency key. The time to live never releases a request that was already signed or offered to the network.

An owner approval covers the exact request digest and the current policy revision. It expires at the time the owner gives or at the original request deadline, whichever comes first. The owner can also grant a **standing approval**, which has an expiry, an optional recipient list, a per-transfer maximum, and a total maximum. A standing approval removes the approval prompt. Neither kind of approval bypasses hard caps, wallet capacity, a freeze, or revocation.

Sometimes the current policy selects a standing grant that a queued request was never bound to. The broker then returns the request to `pending_approval` for the owner to review instead of switching it to that grant. Signed attempts never switch grants either. See the [recovery rules](docs/operator-guide.md#approvals). If an executed payment exceeds the remaining standing capacity, the broker still records it, revokes the grant, and sets the global kill switch.

Requests that end without being sent (`expired`, `rejected`, `cancelled`, `denied`) keep their idempotency key forever. Replaying the key returns the same request, even after rate limits or capacity recover. A new key or request needs the owner's explicit authorization. Agents must never retry after `rejected`. The [operator guide](docs/operator-guide.md#approvals) lists the owner commands.

Each agent has its own signed receipt chain, and owner events go on a separate chain. Prefix the following commands with `node dist/main.js` or the installed `budget-broker`:

- Export a chain with `owner receipts export agent:AGENT_ID --out /protected/receipts.json`.
- List checkpoints with `owner checkpoints list agent:AGENT_ID --out /protected/checkpoints.json`.
- Keep one checkpoint object and the trusted public audit key from `owner audit-key` in storage that you control separately.
- Verify offline with `owner receipts verify --file /protected/receipts.json --checkpoint /protected/retained-checkpoint.json --audit-key ed25519:TRUSTED_KEY`.

Signatures alone cannot show that the end of a chain was deleted. A retained checkpoint protects history only up to that checkpoint.

Gas is charged to the agent that requested the transfer. It does not come from a shared pool. At admission the broker reserves the configured fee amount against the agent's `gasBudget24h`, which is a yoctoNEAR budget. When the transfer settles, the broker charges the actual `tokensBurnt` summed over the transaction and its receipts, exactly once, and failed transfers pay too. A successful transfer spends the principal. A failed transfer releases the principal but still pays the actual fee. The broker releases any unused fee reserve. If the outcome is unknown, the broker keeps the holds. Actual fees above the reserve are still charged and can block later requests. `gasBurnt` counts gas units, not the yoctoNEAR charge.

## Documentation and checks

- [Operator guide and CLI reference](docs/operator-guide.md)
- [Agent tools, outputs and error codes](docs/agent-tools.md)
- [Security model](docs/security-model.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Package checks and compatibility](docs/package-validation.md)

`npm run test:package` cleans and builds `dist`, packs the tarball, and installs it outside the checkout. It then validates the shipped files, examples, skill, and captured help text, and runs the installed commands to check their exit codes. It also times 30 successful help startups and requires a p95 of 1000 ms or less. `npm run typecheck` checks sources, scripts, and tests. Neither command makes a live payment or uses the faucet.

CLI exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success or help |
| 1 | Operation failure, dependency failure, or failed receipt verification |
| 2 | Local usage or file validation error, or a stale policy revision |
| 3 | Authentication or authorization failure |

The [troubleshooting guide](docs/troubleshooting.md) lists the redacted daemon diagnostic reasons. The kernel releases the daemon's locks after a crash. Keep the SQLite lock files and never delete them to get a restart working.

MIT. See [LICENSE](LICENSE).
