# Daemon, CLI and isolation

Node 24+. Build with `npm ci && npm run build`; the executable is
`node dist/main.js` (`budget-broker` when installed). Native NEAR, **testnet only**.
Daemon output is redacted codes on stderr; bridge stdout is MCP only.

## Hard trust boundary

**A same-user agent with Docker socket access can `docker exec`, inspect memory,
read secrets, or mount the named volume. Docker cannot isolate that agent.** Run
agents as a separate OS user/sandbox without Docker/root access, owner key access,
owner unlock material or provisioning environment access. The owner signing
machine/environment must be protected. Encryption protects locked files, not an
unlocked/compromised daemon. Environment passphrases are weaker than a protected
TTY: same-user processes, process dumps, CI diagnostics and shell history can
expose them. Never pass secrets as command-line arguments.

## Provisioning

`owner init-owner-key --out /protected/owner.json` creates an exclusive 0600 file
using Ed25519 PKCS#8, scrypt (N=131072,r=8,p=1) and AES-256-GCM with authenticated
metadata. Unlock uses a non-echoing TTY prompt, or **weaker**
`BB_OWNER_PASSPHRASE` for protected automation. Minimum 12 characters; use a long
random passphrase. Output contains only the file path and public key. The daemon
receives only that public key. Keep an independent backup of the encrypted file.

Create a random master secret of at least 32 bytes (maximum 4096). The master
file must be a regular file (not a symlink), owned by the user running
`init-custody`, mode **0600** or **0400**, in a protected 0700 directory. Group,
other, execute and special permission bits are refused with `BROKER_UNAVAILABLE`;
check ownership and permissions if provisioning fails with that redacted code.
Files use verbatim bytes: a newline changes the secret. In a protected operator
environment:

```
budget-broker init-custody --key-file /protected/native-key --master-file /protected/master --out /protected/custody.json
```

`native-key` is a 0600 file containing the testnet broker's `ed25519:...` secret
key (not a JSON credentials record). Nothing echoes it. The output is only the
envelope path. Move **only the encrypted envelope** into the named volume at
`/var/lib/budget-broker/custody.json`, owned by uid/gid 1000, mode 0600, using a
protected one-shot provisioning container with stdin (no host bind mount). Do not
mount raw custody keys, owner private keys or host credentials into the daemon.
Remove temporary operator copies safely; retain deliberate protected backups.

Config secret JSON (amounts are **yoctoNEAR text**, not human NEAR):

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

There is no master secret field in config or the database. The audit key is a
separate daemon-generated 0600 private key inside the volume. Keep it across
restarts; independently pin its public key. Set wallet policy explicitly before
spending: missing policies deny. Fee reservation must cover plausible actual gas
(see `src/broker/README.md`); chain access requires a full-access custody key.
Startup attests RPC `chain_id=testnet` before custody unlock/recovery/serving.

Compose uses **file-backed secrets**, which work with `read_only: true`.
Environment/content-sourced Compose secrets do NOT work with a read-only service.
Set `BB_MASTER_FILE=/protected/budget-broker/master` and
`BB_CONFIG_FILE=/protected/budget-broker/config.json` to absolute paths **outside
this repository**, in a 0700 directory, both files mode **0600**. These are path
variables, never secret values. Protect this directory from agent OS users. On
Linux, source files must be owned by uid 1000 (or the mapped container uid), so
the non-root daemon can read them; Compose file-secret uid/mode remapping is not
portable. On Docker Desktop verify the file-sharing ownership mapping. Do not
relax file permissions to make a deployment work: provision under the correct
protected OS user. A secret manager may materialize these protected files.

Compose mounts these files at `/run/secrets/bb_master` and
`/run/secrets/bb_config`. Host paths for these two secrets are an explicit
protected-operator exception; DB, custody and audit keys remain exclusively in
the named volume, never host bind mounts. The daemon accepts ONLY
`BB_MASTER_SECRET_FILE`; direct `BB_MASTER_SECRET` is rejected, even if a file
is also supplied. No secret value belongs in config, the DB, argv or logs.

`BB_IMAGE` selects the built daemon image tag (default `budget-broker:local`).
`BB_DATA_VOLUME` selects the named data volume (default `budget-broker-data`).
Set both consistently for **all** provisioning and compose commands; never choose
another volume for a second daemon with the same custody key.

Create/initialize the volume through Compose **before** provisioning it. Docker
copies the image directory's uid/gid 1000 ownership only when a fresh named volume
is first mounted at the correct target. Mounting it first at `/data` (or another
empty path) leaves it root-owned and causes `DATA_DIR_UNAVAILABLE`.

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

The provisioning mount MUST be `/var/lib/budget-broker`, matching Compose and the
image. The sample is exclusive (`wx`): it will not overwrite an existing envelope.
For an accidentally root-owned existing volume: stop **every** daemon using the
key, confirm the volume name, and use a protected one-shot root container mounted
at `/var/lib/budget-broker` to repair uid/gid 1000 ownership (directory mode 0700,
envelope/audit/lock files 0600). Never delete live lock files to resolve this.
For a host daemon, create its data directory and stable OS-account lock directory
under the intended daemon OS user, not root.

The image runs uid 1000, rootfs read-only, capabilities dropped, no Docker socket;
only a named data volume and bounded /tmp tmpfs are writable. Both host ports
publish on **127.0.0.1 only**, even though container listeners bind 0.0.0.0.
Keep port numbers unchanged unless changing both config and publications.
Plain Compose secrets are not protection against the Docker-controlling host
user. No claim of protection from a privileged host user is made here.

Use **one named volume/trust root per custody key**, reused across deployments.
Two SQLite EXCLUSIVE transactions are held for the process lifetime:
`dataDir/daemon.lock` and an independent, **per-custody-public-key** lock at
`<OS-account-home>/.budget-broker-locks/<sha256(publicKey)>.sqlite`. The latter
refuses a second daemon even with a different data directory/ports/database. The
OS account database, not `HOME` or `TMPDIR`, determines this stable location;
there is no production config/env override. The runtime uid requires an OS passwd
entry with a writable home (the image provides this for uid 1000). An arbitrary
unmapped uid, e.g. `docker run --user 4242:4242`, is unsupported and fails closed
with `LOCK_UNAVAILABLE`, not a generic broker error. Its directory must be owned by the
current uid and mode 0700; existing bad ownership/modes or symlinks are refused,
not repaired. Files must be regular, uid-owned, mode 0600 and never unlinked.
The kernel releases both locks on SIGKILL/crash; restart needs no PID guessing or
manual deletion. Retain lock files even after shutdown. Never unlink or replace a
live lock or its directory (host-volume control is outside the threat boundary).

The image sets the node OS-account home to `/var/lib/budget-broker`, so the stable
key-lock directory is on the same private named volume, writable with a read-only
rootfs. File locks are NOT distributed leadership: different OS users, hosts, or
independent container filesystem namespaces/volumes cannot fence each other.
All containers with one custody key MUST share this named volume/trust root;
never deploy that key independently across hosts/volumes. Active-active is not
supported. Upgrading from the old O_EXCL format: stop the OLD daemon first, then
remove its old text `daemon.lock` once before starting the new version.

Distinct redacted stderr diagnostics are `LOCK_HELD`, `LOCK_UNAVAILABLE`,
`BAD_CONFIG`, `BAD_MASTER_SECRET`, `MASTER_SECRET_ENV_REFUSED`, `LISTEN_FAILED`,
`DATA_DIR_UNAVAILABLE` (mkdir/chmod/ownership/provisioning failure), and
`RPC_UNAVAILABLE` (startup transport/HTTP failure). A reachable RPC with a wrong or
unprovable chain identity still fails closed as `MAINNET_REFUSED`; a static
mainnet config/URL is also refused. Neither operational unavailability nor
identity refusal permits custody unlock. No diagnostic includes values, paths,
stacks or environment dumps; text and JSON outputs accept only exact allowlisted
tokens. SIGTERM/SIGINT stops scheduling, closes listeners, waits for invoked
broker work, locks custody and closes SQLite, then exits 0. A 90s compose grace
period must exceed the deployment RPC/in-flight workload duration.

## Owner CLI

Set `BB_OWNER_KEY_FILE` and `BB_ADMIN_URL` (default http://127.0.0.1:3211), or use
`--key FILE --url URL`. Every admin read/mutation is a fresh Ed25519-signed POST;
nonces are durably consumed even when a subsequent mutation fails. Agent tokens
are never admin credentials, even on the admin port. Repeated headers, duplicate
JSON keys, wrong Host/Origin, body/path/method tampering and replay are refused.
No owner operation is exposed through MCP.

Commands (`--json` selects machine-readable errors/path output; normal structured
results are JSON too). IDs and reasons are positional; quote multiword reasons.

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

Token issue/rotation prints the **path and public credential ID**, never the
token, on stdout (`--json`: `{path,credentialId}`). Use that ID directly for
rotation/revocation. Plaintext token is written only to an exclusively created
0600 file, never logs or DB. Choose a new path for rotation; existing
files/symlinks are refused. Keep the old token file only until bridge consumers
switch paths; revocation is immediate.
Discovery list commands show up to 1000 items with `nextCursor`; continue with
`--after CURSOR`, optionally `--limit 1..1000`. The signed admin API supports
continuation via the corresponding `query.after` (listAgents takes
`{after,limit}` directly). Receipt/checkpoint CLI exports iterate every sequence
page.

Policy JSON uses the contract shape including `agentId`, `revision`,
`ratePerMinute`, `maxOutstanding`, `recipients:{mode,accounts}`,
`approvalThreshold` (null means never), optional `expiresAt`. Monetary fields
`perTxMax`, `rolling24hMax`, `lifetimeMax`, `gasBudget24h`, `approvalThreshold`
are **human decimal NEAR strings**. Wallet JSON is `{revision,rolling24hMax,
safetyReserve}` with human NEAR strings. Grant JSON is `{agentId,perTxMax,
totalMax,expiresAt,recipients?}`, likewise human NEAR strings. Revision 1 means
insert; revision N compares against N-1. No floating point conversion occurs.
Output and HTTP API amounts are decimal **yoctoNEAR strings**. CLI performs no
budget bypass. Force resolution retains uncertain holds; it does not free funds.

`CHAIN_ID` is `owner` or `agent:ID`. Receipt export also creates a signed
checkpoint of the latest nonempty head through the broker. Save a checkpoint
object from the checkpoint list in a separately protected external pin store,
and pin the audit public key independently. Offline verify does not contact the
daemon and does not trust keys bundled with exports. It verifies signatures,
genesis, links, and inclusion of the independently retained checkpoint. It cannot
detect removal of a suffix newer than the retained pin.

Admin endpoints are `POST /admin/<OwnerBrokerService method name>` with strict
JSON body fields matching the operation, excluding principal (e.g.
`{agentId}`, `{requestId,expiresAt}`, `{policy,expectedRevision}`, `{target,reason}`).
`listCheckpoints` additionally takes `{chainId,afterSeq,limit}`. See exported
`adminSchemas` and `OwnerClient` for the full wire adapter. No arbitrary method
invocation, raw signer, SQL or secret endpoint exists.

Exit codes: 0 success/clean shutdown, 1 operation/dependency/verification failure,
2 usage/local argument or policy/grant file validation/stale policy revision
conflict (`POLICY_CHANGED`), 3 authentication/authorization failure (including
Host/Origin rejection on policy writes). Malformed JSON, schema errors, tampering,
signature or checkpoint failures in `receipts verify` are verification failures
and exit **1**, not usage/authentication failures. Missing verify flags exit 2. CLI IDs must be broker-issued UUIDs.
Errors expose only stable codes and daemon diagnostic reasons (never raw
RPC/SQL/key details).

## Agent bridge

```
BB_URL=http://127.0.0.1:3210 BB_TOKEN_FILE=/agent/private/token budget-broker mcp
```

The token file must be owned by the current uid with no group/other permissions.
The bridge holds no wallet, DB, custody key or master secret. SIGTERM/SIGINT and
stdin EOF close transports and exit, including with the stdin pipe left open.

Tests: `npm run test:cli`, `npm run test:isolation`, `npm run typecheck`,
`npm run build`. The trusted `startDaemon({dependencies:{chain,signer,clock}})`
composition seam supports offline tests without adding any environment-selectable
fake chain or production auth bypass. Isolation tests require working Docker +
Compose, actually build/create/up against an isolated fake testnet RPC, then
SIGKILL/restart and remove their containers, network, image and named volume.
Only an explicit `BB_SKIP_DOCKER=1` skips Docker integration, printing `SKIP`;
missing Docker otherwise FAILS. `npx tsx test/cli/mutations.ts` runs the review
mutants on isolated temporary copies, never edits the worktree, and requires
all mutants to be killed.
