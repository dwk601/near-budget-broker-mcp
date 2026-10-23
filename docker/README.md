# Daemon, CLI and isolation

You need Node 24 or later. Build with `npm ci && npm run build`. The executable is `node dist/main.js`, or `budget-broker` when installed. Budget Broker handles native NEAR on testnet only. The daemon writes redacted codes to stderr, and the bridge writes only MCP messages to stdout.

## Hard trust boundary

**An agent running as the same user with Docker socket access can run `docker exec`, inspect memory, read secrets, or mount the named volume. Docker cannot isolate that agent.** Run agents as a separate OS user or in a sandbox, without Docker or root access, owner key access, owner unlock material, or access to the provisioning environment. Protect the machine or environment where the owner signs. Encryption protects locked files, not a daemon that is unlocked or compromised.

A passphrase in an environment variable is weaker than one typed at a protected TTY. Processes running as the same user, process dumps, CI diagnostics, and shell history can all expose it. Never pass secrets as command-line arguments.

## Provisioning

`owner init-owner-key --out /protected/owner.json` creates a new file with mode 0600 and refuses to overwrite. The file holds an Ed25519 PKCS#8 key, encrypted with scrypt (N=131072, r=8, p=1) and AES-256-GCM, with authenticated metadata. To unlock, type the passphrase at a TTY prompt that does not echo. For protected automation you can set `BB_OWNER_PASSPHRASE` instead, which is weaker. The passphrase must be at least 12 characters, and a long random one is best. The command prints only the file path and the public key, and the daemon receives only that public key. Keep a separate backup of the encrypted file.

Create a random master secret of 32 to 4096 bytes. The master file must be a regular file, not a symlink, owned by the user running `init-custody`, with mode 0600 or 0400, in a protected 0700 directory. The command refuses group, other, execute, and special permission bits with `BROKER_UNAVAILABLE`, so if provisioning fails with that redacted code, check ownership and permissions. The file is read verbatim, so a newline changes the secret. In a protected operator environment, run:

```
budget-broker init-custody --key-file /protected/native-key --master-file /protected/master --out /protected/custody.json
```

`native-key` is a 0600 file that holds the testnet broker's `ed25519:...` secret key, not a JSON credentials record. The command never echoes it and prints only the envelope path. Move only the encrypted envelope into the named volume at `/var/lib/budget-broker/custody.json`, owned by uid/gid 1000 with mode 0600. Use a protected one-shot provisioning container that reads from stdin, with no host bind mount. Do not mount raw custody keys, owner private keys, or host credentials into the daemon. Remove temporary operator copies safely, and keep deliberate protected backups.

The config is a secret JSON file. Amounts are yoctoNEAR strings, not human NEAR:

```json
{
  "network": "testnet",
  "rpcUrl": "https://rpc.testnet.near.org",
  "accountId": "YOUR-ACCOUNT.testnet",
  "bindHost": "0.0.0.0",
  "agentPort": 3210,
  "adminPort": 3211,
  "allowedHosts": ["127.0.0.1", "localhost"],
  "allowedOrigins": [],
  "dataDir": "/var/lib/budget-broker",
  "auditKeyPath": "/var/lib/budget-broker/audit.pem",
  "ownerPublicKey": "ed25519:REPLACE_WITH_OWNER_PUBLIC_KEY",
  "safetyReserve": "10000000000000000000000"
}
```

Neither the config nor the database has a field for the master secret. The daemon generates the audit key itself as a separate 0600 private key file inside the volume. Keep it across restarts and pin its public key in separate storage. Set the wallet policy before any spending, because a missing policy denies everything. The fee reservation must cover the gas a transfer can realistically burn (see `src/broker/README.md`). The custody key must be a full-access key. At startup the daemon checks that the RPC reports `chain_id=testnet` before it unlocks custody, runs recovery, or serves requests.

Compose passes secrets as files, which works with `read_only: true`. Compose secrets sourced from the environment or from inline content do not work with a read-only service. Set `BB_MASTER_FILE=/protected/budget-broker/master` and `BB_CONFIG_FILE=/protected/budget-broker/config.json` to absolute paths outside this repository, in a 0700 directory, with both files at mode 0600. These variables hold paths, never secret values. Keep agent OS users out of this directory.

On Linux, uid 1000 (or the mapped container uid) must own the source files so that the non-root daemon can read them, because Compose cannot remap file-secret uid or mode portably. On Docker Desktop, check the file-sharing ownership mapping. Do not loosen file permissions to make a deployment work. Provision as the correct protected OS user instead. A secret manager may write these files for you.

Compose mounts the files at `/run/secrets/bb_master` and `/run/secrets/bb_config`. These two host paths are a deliberate exception for the protected operator. The database, the custody key, and the audit key stay in the named volume and are never bind-mounted from the host. The daemon accepts only `BB_MASTER_SECRET_FILE`, and it rejects a direct `BB_MASTER_SECRET` even when a file is also set. Secret values never go in the config, the database, command-line arguments, or logs.

`BB_IMAGE` selects the built daemon image tag (default `budget-broker:local`). `BB_DATA_VOLUME` selects the named data volume (default `budget-broker-data`). Use the same values for every provisioning and Compose command. Never pick another volume for a second daemon with the same custody key.

Create the service through Compose before you provision the volume. Docker copies the image directory's uid/gid 1000 ownership only when a fresh named volume is first mounted at the right target. If you mount it at `/data` or another empty path first, the volume stays owned by root and the daemon fails with `DATA_DIR_UNAVAILABLE`.

```sh
export BB_MASTER_FILE=/protected/budget-broker/master
export BB_CONFIG_FILE=/protected/budget-broker/config.json
export BB_IMAGE=budget-broker:local
export BB_DATA_VOLUME=budget-broker-data
docker compose -f docker/docker-compose.yml config
docker compose -f docker/docker-compose.yml build
docker compose -f docker/docker-compose.yml create
# Only the ENCRYPTED envelope crosses stdin. No owner/raw custody key is mounted.
docker run --rm -i --read-only --network none --user 1000:1000 \
  --mount "type=volume,src=$BB_DATA_VOLUME,dst=/var/lib/budget-broker" \
  --entrypoint node "$BB_IMAGE" -e \
  'require("node:fs").writeFileSync("/var/lib/budget-broker/custody.json",require("node:fs").readFileSync(0),{flag:"wx",mode:0o600})' \
  < /protected/custody.json
docker compose -f docker/docker-compose.yml up -d --no-build
```

The provisioning mount must be `/var/lib/budget-broker`, the same path that Compose and the image use. The `wx` flag makes the copy refuse to overwrite an existing envelope.

If an existing volume ended up owned by root, stop every daemon that uses the key and confirm the volume name. Then use a protected one-shot root container, mounted at `/var/lib/budget-broker`, to give the files back to uid/gid 1000, with mode 0700 on the directory and 0600 on the envelope, audit key, and lock files. Never delete live lock files to fix this. For a daemon running directly on a host, create its data directory and its lock directory in the OS account home as the intended daemon user, not as root.

The image runs as uid 1000 with a read-only root filesystem, dropped capabilities, and no Docker socket. Only the named data volume and a size-limited `/tmp` tmpfs are writable. Both host ports publish on 127.0.0.1 only, even though the listeners inside the container bind 0.0.0.0. Keep the port numbers unchanged unless you change both the config and the publications. Plain Compose secrets do not protect against the user who controls Docker on the host. This document makes no claim of protection against a privileged host user.

Use one named volume, and so one trust root, per custody key, and reuse it across deployments. The daemon holds two SQLite EXCLUSIVE transactions for its whole lifetime. One is on `dataDir/daemon.lock`. The other is a separate lock for the custody public key, at `<OS-account-home>/.budget-broker-locks/<sha256(publicKey)>.sqlite`, which refuses a second daemon even when it has a different data directory, ports, or database. The location comes from the OS account database, not `HOME` or `TMPDIR`, and no production config or environment setting overrides it.

The runtime uid needs an OS passwd entry with a writable home, which the image provides for uid 1000. Running as an arbitrary uid with no passwd entry, such as `docker run --user 4242:4242`, is unsupported and fails with `LOCK_UNAVAILABLE` rather than a generic broker error. The lock directory must be owned by the current uid with mode 0700. The daemon refuses existing directories with the wrong owner or mode, and symlinks, and does not repair them. Lock files must be regular files owned by the uid, with mode 0600, and must never be unlinked. The kernel releases both locks on SIGKILL or a crash, so a restart needs no PID guessing or manual deletion. Keep the lock files after shutdown as well. Never unlink or replace a live lock or its directory. Control of the host volume is outside the threat model.

The image sets the node user's OS account home to `/var/lib/budget-broker`, so the key lock directory sits on the same private named volume and stays writable with a read-only root filesystem. File locks do not elect a leader across machines. Different OS users, hosts, or containers with independent filesystems or volumes cannot see each other's locks. Every container that uses a custody key must share this one named volume. Never deploy the same key separately across hosts or volumes. Active-active is not supported. When upgrading from the old O_EXCL lock format, stop the old daemon first, then remove its old text `daemon.lock` once before you start the new version.

The daemon writes these redacted diagnostics to stderr:

- `LOCK_HELD`
- `LOCK_UNAVAILABLE`
- `BAD_CONFIG`
- `BAD_MASTER_SECRET`
- `MASTER_SECRET_ENV_REFUSED`
- `LISTEN_FAILED`
- `DATA_DIR_UNAVAILABLE`, for a failure in mkdir, chmod, ownership, or provisioning
- `RPC_UNAVAILABLE`, for a transport or HTTP failure at startup

If the RPC is reachable but its chain identity is wrong or cannot be proven, the daemon still refuses with `MAINNET_REFUSED`. It also refuses a mainnet config or URL. Neither an unavailable service nor a refused identity lets custody unlock. Diagnostics never include values, paths, stack traces, or environment dumps, and both the text and JSON outputs accept only the exact listed tokens.

On SIGTERM or SIGINT the daemon stops scheduling, closes listeners, waits for broker work already in progress, locks custody, closes SQLite, and exits 0. Set the 90-second Compose grace period longer than your RPC and in-flight workload takes.

## Owner CLI

Set `BB_OWNER_KEY_FILE` and `BB_ADMIN_URL` (default http://127.0.0.1:3211), or pass `--key FILE --url URL`. Every admin read and write is a new Ed25519-signed POST. The daemon records each nonce as used even when the operation that follows fails. Agent tokens never work as admin credentials, not even on the admin port. The daemon refuses repeated headers, duplicate JSON keys, a wrong Host or Origin, tampering with the body, path, or method, and replays. MCP exposes no owner operations.

The commands are listed below. `--json` makes errors and path output machine-readable, and normal structured results are JSON either way. IDs and reasons are positional, and multiword reasons need quotes.

```
owner agent create NAME
owner agent list
owner agent revoke AGENT_ID REASON
owner token issue AGENT_ID --out NEW_TOKEN_FILE
owner token rotate CREDENTIAL_ID --out NEW_TOKEN_FILE
owner token revoke CREDENTIAL_ID
owner policy set --file POLICY_JSON
owner policy get AGENT_ID
owner wallet-policy set --file WALLET_POLICY_JSON
owner approvals list
owner approvals approve REQUEST_ID EXPIRES_AT_EPOCH_MS
owner approvals reject REQUEST_ID REASON
owner standing grant --file GRANT_JSON
owner standing revoke APPROVAL_ID
owner standing list AGENT_ID
owner freeze global REASON
owner freeze agent AGENT_ID REASON
owner unfreeze global REASON
owner unfreeze agent AGENT_ID REASON
owner status
owner audit-key
owner requests list [AGENT_ID]
owner requests get REQUEST_ID
owner reconcile [REQUEST_ID]
owner resolve-attempt REQUEST_ID REASON [--force]
owner receipts export CHAIN_ID [--out EXPORT_JSON]
owner checkpoints list CHAIN_ID [--out CHECKPOINTS_JSON]
owner receipts verify --file EXPORT_JSON --checkpoint RETAINED_CHECKPOINT_JSON --audit-key ed25519:TRUSTED_KEY
```

`token issue` and `token rotate` print the path and the public credential ID on stdout, never the token (`{path,credentialId}` with `--json`). Use that ID for rotation and revocation. The token itself goes only into a newly created 0600 file, never into logs or the database. Pick a new path for each rotation, because the command refuses existing files and symlinks. Keep the old token file only until the bridge clients switch paths, because revocation takes effect immediately.

The list commands show up to 1000 items and a `nextCursor`. Continue with `--after CURSOR`, and optionally set `--limit` from 1 to 1000. In the signed admin API, continuation uses the matching `query.after`, except `listAgents`, which takes `{after,limit}` directly. The CLI's receipt and checkpoint exports fetch every page.

A policy JSON file uses the contract shape, with `agentId`, `revision`, `ratePerMinute`, `maxOutstanding`, `recipients:{mode,accounts}`, `approvalThreshold` (null means never), and an optional `expiresAt`. The amount fields `perTxMax`, `rolling24hMax`, `lifetimeMax`, `gasBudget24h`, and `approvalThreshold` are human decimal NEAR strings. A wallet JSON file is `{revision,rolling24hMax,safetyReserve}`, also in human NEAR strings. A grant JSON file is `{agentId,perTxMax,totalMax,expiresAt,recipients?}`, also in human NEAR strings. Revision 1 inserts a new policy, and revision N succeeds only if the stored revision is N-1. No floating-point conversion happens. Output and the HTTP API use decimal yoctoNEAR strings. The CLI cannot bypass any budget. Forced resolution keeps uncertain holds and does not free funds.

`CHAIN_ID` is `owner` or `agent:ID`. A receipt export also has the broker sign a checkpoint of the latest nonempty head. Save one checkpoint object from the checkpoint list in a separate protected pin store, and pin the audit public key separately as well. Offline verification does not contact the daemon and ignores any keys bundled with the export. It checks signatures, the genesis entry, the links between entries, and that the chain includes the checkpoint you retained. It cannot detect the removal of entries newer than that checkpoint.

Admin endpoints are `POST /admin/<OwnerBrokerService method name>`. The body is strict JSON with the operation's fields, excluding the principal, for example `{agentId}`, `{requestId,expiresAt}`, `{policy,expectedRevision}`, or `{target,reason}`. `listCheckpoints` also takes `{chainId,afterSeq,limit}`. The exported `adminSchemas` and `OwnerClient` define the full wire format. There is no endpoint for calling arbitrary methods, raw signing, SQL, or secrets.

| Exit code | Meaning |
| --- | --- |
| 0 | Success or clean shutdown |
| 1 | Operation, dependency, or verification failure |
| 2 | Usage error, local argument error, policy or grant file validation error, or a stale policy revision (`POLICY_CHANGED`) |
| 3 | Authentication or authorization failure, including Host or Origin rejection on a policy write |

In `receipts verify`, malformed JSON, schema errors, tampering, bad signatures, and checkpoint failures count as verification failures and exit 1, not as usage or authentication failures. A missing verify flag exits 2. CLI IDs must be UUIDs issued by the broker. Errors expose only stable codes and daemon diagnostic reasons, never raw RPC, SQL, or key details.

## Agent bridge

```
BB_URL=http://127.0.0.1:3210 BB_TOKEN_FILE=/agent/private/token budget-broker mcp
```

The token file must belong to the current uid and have no group or other permissions. The bridge holds no wallet, database, custody key, or master secret. It closes its transports and exits on SIGTERM, SIGINT, or stdin EOF, even if the stdin pipe stays open.

## Tests

Run `npm run test:cli`, `npm run test:isolation`, `npm run typecheck`, and `npm run build`. Offline tests inject fakes through the trusted `startDaemon({dependencies:{chain,signer,clock}})` call. No environment variable can select a fake chain, and production has no authentication bypass.

The isolation tests need a working Docker and Compose. They build, create, and start the service against an isolated fake testnet RPC, kill it with SIGKILL, restart it, and then remove their containers, network, image, and named volume. Only an explicit `BB_SKIP_DOCKER=1` skips the Docker tests, printing `SKIP`. Without that variable, a missing Docker fails the run.

`npx tsx test/cli/mutations.ts` runs the review mutants on isolated temporary copies and never edits the worktree. Every mutant must be killed.
