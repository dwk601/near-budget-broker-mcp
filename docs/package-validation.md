# Package validation and verified compatibility

## Run

```sh
npm ci
npm run test:package && npm run typecheck
```

The package suite **builds dist itself** before packing; no prepack hook is needed or assumed. Operator tarball creation likewise uses `npm run build` followed by `npm pack`. Node 24+ is required. npm dependencies may need registry access; no live faucet, payment or public NEAR RPC is used by packaging tests. Package metadata, lockfile, source/configs and Docker implementation are unchanged by B09.

## What the package suite checks

`test/package/package.test.ts` creates one OS temp directory and a fresh consumer project **outside the checkout**, then:

1. Runs build, `npm pack --json --pack-destination TEMP`, and installs that tarball in the fresh project with scripts disabled. Supports npm's array (≤11) and package-keyed (12) pack manifests. The installed bin resolves inside that consumer, not the worktree.
2. Inspects the actual archive and compares manifest entries. Requires dist/bin/README/LICENSE/skill/examples/Docker files; rejects paths outside the frozen allowlist, tests, node_modules, .env, state/databases, private-key/token material and credential artifacts. No postinstall launch hook.
3. Parses every shipped example JSON, validates MCP npx argv and version, checks policy/grant shape with exact NEAR conversion, and validates the skill's simple YAML name/description frontmatter.
4. Launches the **installed bin** for missing/nonexistent token errors: nonzero, clean stderr only, no stdout/stacks/token leakage. Exercises real local encrypted owner/custody initialization, config flag/env fallback, valid offline signed receipt/checkpoint verification and corrupt JSON/schema/signature failures.
5. Executes 32 owner admin forms/optional positional variants/flags against a local recording stub using encrypted owner unlock and real signed HTTP requests. The stub validates strict admin schemas; it is not a live broker/owner-auth security test. Inputs use UUIDs, not generic labels. Tests check monetary conversion, force behavior, sequence exports, protected token files and **both plain and JSON path + credentialId output**. Refusal cases validate documented exits 0/1/2/3, including stale policy-write revision exit 2 and authorization exit 3.
6. Verifies help variants without credentials/network. `docs/cli-help.txt` is captured from current real CLI help and compared byte-for-byte with the installed help; root/owner help uses stdout, **mcp --help / help mcp use stderr with empty stdout**, all exit 0.
7. Times 30 separate installed `--help` processes, prints nearest-rank p95 and requires **≤1000 ms**, meaningful help, exit 0 and no stderr. Fast usage errors do not count. Direct stdout reporting keeps the timing visible even when Vitest hides passing console logs.
8. Cleans consumer/tarball/ephemeral secrets in suite cleanup, including assertion/setup failure. Only normal git-ignored dist build output remains. It does not write fixture/state/tarball artifacts into the checkout.

`npm run test:cli` additionally executes current CLI/main behavior against fake chain/RPC dependencies: local validation/stale policy revisions, verification corruption, authentication/Host/Origin exits, every daemon diagnostic, per-key locks across data directories and crash recovery. `npm run test:isolation` exercises real Docker build/create/provision/up with file secrets/read-only rootfs and SIGKILL/restart using isolated fake RPC; no Docker skip was requested. Base plus both example overrides (individually and combined) are rendered with real `docker compose config --quiet` / JSON assertions to check file-secret paths, BB_IMAGE/BB_DATA_VOLUME, loopback ports, sole named-volume mount and preserved hardening.

## Current reviewed candidate

B09 is rebased on B08 **ea21b74** (previous B09 commit became c2a59b7). On Node 24.16.0 / npm 12.0.2: **package 6/6, CLI 21/21, Docker isolation 6/6 and typecheck pass**. Final validation started with dist removed: the suite rebuilt it and successful installed help p95 was **82.7 ms** over 30 runs, comfortably below 1000 ms; each run prints its own measurement. The prior help failure is fixed, not skipped or relaxed. [Operator reference](operator-guide.md) now links captured help and documents the actual UUID validation, exit statuses, token output, file secrets and kernel locks.

## Compatibility assumptions; no outstanding amendment requests

- Package is private and npx uses a **local tarball**, not a claim of registry publication. Explicit build-before-pack is documented and performed by the suite; no package-script amendment is requested.
- Tarball allowlist intentionally includes README/examples/skill/Docker/dist, not full docs, src, fixture scripts, lockfile or compiler config. README's full-guide links target the source checkout. Build the daemon image and run live fixtures from source, or supply a separately trusted **BB_IMAGE** via the prebuilt override.
- Fixture broker-key.json is already encrypted; reuse it with exact binary master.secret. Base Compose file secrets already support that binary file through **BB_MASTER_FILE**. No environment/content-secret override remains.
- Absolute **BB_MASTER_FILE/BB_CONFIG_FILE** paths are protected operator exceptions (outside repo, 0600/0700, mapped uid 1000-readable). Daemon receives **BB_MASTER_SECRET_FILE**; direct BB_MASTER_SECRET is refused. Keep image/volume variables consistent, Compose **create before provisioning**, and mount stdin-only encrypted provisioning at **/var/lib/budget-broker** as uid 1000.
- SQLite data/per-custody-key lock files are retained; kernel lock release handles crashes. No stale PID/tmp-lock deletion procedure applies to current locks. Independent users/hosts/volumes are not distributed fencing. One daemon/trust root per custody key remains mandatory.
