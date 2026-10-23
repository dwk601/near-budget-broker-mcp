# Budget Broker MCP

One NEAR **testnet** wallet, many mutually hostile agents. A custody daemon admits native NEAR transfers under per-agent and wallet limits, reserves principal and gas, records signed receipt chains, and provides owner/agent kill switches. Agents use eight MCP tools through a keyless stdio bridge. No FT, contract calls, arbitrary signing, or mainnet.

## Trust model — read before installing

The operator, daemon, configured testnet RPC and host are trusted. Agent bearer tokens are scoped capabilities, **not wallet keys**. Agents must have **no Docker socket/control, root, owner private key/passphrase, custody/recovery key, master secret, or daemon-volume access**. Same-user shell agents need a **separate OS user or properly isolated container/sandbox**; a second terminal is not isolation. Encryption at rest does not protect an unlocked, compromised daemon. One daemon/volume/trust root per custody key; no active-active deployment. Freeze cannot undo a broadcast payment. Testnet only; not production custody.

## Quickstart (protected operator environment)

Requires Node **24+**, npm, Docker Compose v2, and a source checkout for fixture provisioning and building the Docker image. The private npm package is installed from a local tarball, not the public registry.

1. **Fixtures:** `npm ci && npm run build`, then `npm run fixtures:native -- --apply` and `npm run fixtures:native -- --check`. These are live testnet operations (faucet/RPC required). They persist encrypted custody, recovery and receiver material **outside the repository**, by default `~/.budget-broker/testnet-fixtures`. Never run them in an agent shell or give that directory to agents.
2. **Owner key:** `node dist/main.js owner init-owner-key --out /protected/owner.json`. Choose a long passphrase at the non-echoing prompt; retain the returned **public** key for config. The daemon never receives this private key.
3. **Custody initialization:** fixtures already performed encryption: their `broker-key.json` is an encrypted envelope, **not** input for `init-custody`. Reuse it as volume `custody.json` with its exact binary `master.secret`. For a separately provisioned raw testnet key instead, run `node dist/main.js init-custody --key-file /protected/native-key --master-file /protected/master --out /protected/custody.json`. The raw file contains only the `ed25519:…` secret, mode 0600. Do not use the recovery key. See [provisioning](docs/operator-guide.md#provisioning) for the fixture/Compose bridge.
4. **Start daemon:** fill `examples/daemon-config.json` with the fixture custody account and owner public key. Provision the named volume and secrets as described in the operator guide, then `docker compose -f docker/docker-compose.yml -f examples/compose.fixture.yaml up -d --build`. Both published ports stay on **127.0.0.1**. Never mount owner/raw keys or the Docker socket into the daemon/agent.
5. **Create agent/policies/token:** in the operator shell:

   ```sh
   export BB_OWNER_KEY_FILE=/protected/owner.json
   export BB_ADMIN_URL=http://127.0.0.1:3211
   node dist/main.js owner agent create demo
   # Put the returned ID and fixture receiver A into agent-policy.json.
   node dist/main.js owner wallet-policy set --file examples/wallet-policy.json
   node dist/main.js owner policy set --file /protected/agent-policy.json
   node dist/main.js owner token issue AGENT_ID --out /protected/new-agent.token
   ```

   Start from `examples/agent-policy.json`. CLI policy/grant amounts are **human NEAR strings**; daemon config and MCP amounts are **integer yoctoNEAR strings**. `1 NEAR = 10^24 yoctoNEAR`. Missing policies deny; zero never means unlimited. Deliver only the token to the isolated agent, owned by its uid, mode 0600 (no symlinks).
6. **Pack and configure MCP:** `npm pack --pack-destination /protected/packages` after building. Replace paths/version in [Claude Desktop](examples/claude-desktop.json), [Claude Code](examples/claude-code.mcp.json), or [Cursor](examples/cursor.mcp.json). All launch the same path:

   ```sh
   BB_URL=http://127.0.0.1:3210 BB_TOKEN_FILE=/agent/private/token \
     npx --yes --package /abs/path/near-budget-broker-mcp-0.1.0.tgz budget-broker mcp
   ```

   The bridge is not a local signer or daemon. Agent containers cannot reach host loopback as their own localhost; supply a deliberately restricted network route, never publicly publish the ports as a shortcut.
7. **Try tools:** `budget_status {}`, then `preview_transfer` and `request_transfer` with `{"idempotencyKey":"demo-001","receiverId":"REPLACE.testnet","amount":"1000000000000000000000"}` (0.001 NEAR). Preview is advisory, not a reservation. Keep the same key and payload on ambiguous retries; inspect `get_request {"requestId":"…"}` until final. See [all eight tools](docs/agent-tools.md) and the [agent skill](skills/budget-broker/SKILL.md).
8. **Freeze:** agent: `freeze_self {"reason":"demo complete"}`; owner: `node dist/main.js owner freeze global "demo complete"`. Inspect/reconcile already offered work; freeze does not roll it back or release uncertain holds. Only the owner can unfreeze.

## Approvals, receipts and gas

Transfers strictly above `approvalThreshold` enter `pending_approval` with `APPROVAL_REQUIRED` and reserve principal plus fees. The owner can approve the exact digest/current policy revision or issue an expiring, recipient/per-transfer/total-bounded **standing approval**. Neither bypasses hard caps, wallet capacity, freeze, or revocation. See [operator commands](docs/operator-guide.md#approvals).

Each agent has its own signed receipt chain; owner events have a separate chain. Export with `owner receipts export agent:AGENT_ID --out /protected/receipts.json`; list checkpoints with `owner checkpoints list agent:AGENT_ID --out /protected/checkpoints.json`. Independently retain one checkpoint **object** and the trusted public audit key (`owner audit-key`). Verify offline with `owner receipts verify --file /protected/receipts.json --checkpoint /protected/retained-checkpoint.json --audit-key ed25519:TRUSTED_KEY` (prefix commands with `node dist/main.js` or installed `budget-broker`). Signatures alone cannot detect a deleted suffix; an external pin only protects history through that pin.

**Gas belongs to the requesting agent**, not a free shared pool: admission reserves the configured fee amount against its monetary `gasBudget24h`. Final accounting charges actual aggregate transaction/receipt `tokensBurnt`, **including failed transfers**, exactly once. Success consumes principal; failure releases principal but not actual fees. Unused reserves are released; unknown outcomes retain holds. Actual fees above reserve are still charged and can block subsequent work. `gasBurnt` is gas units, not the yoctoNEAR charge.

## Documentation and checks

- [Operator guide / verified CLI reference](docs/operator-guide.md)
- [Agent tools, outputs and error codes](docs/agent-tools.md)
- [Security model](docs/security-model.md) · [Troubleshooting](docs/troubleshooting.md)
- [Packaging checks and known amendment requests](docs/package-validation.md)

`npm run test:package` builds, packs, installs outside the checkout, validates shipped artifacts/examples/skill, exercises installed commands, and measures 30 help startups (p95 ≤1000 ms). `npm run typecheck` checks source, scripts and tests. No live payment or faucet is used by these checks.

MIT — see [LICENSE](LICENSE).
