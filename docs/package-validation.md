# Package validation and integration amendments

## What is tested

Run `npm run test:package` on Node 24+. The existing package script invokes `vitest run test/package`; no package/config changes are needed. `test/package/package.test.ts` replaces the placeholder with real checks:

1. Build TypeScript, `npm pack --json` into an OS temp directory, and install that tarball in a newly created consumer project **outside the repository**. Supports npm's array (≤11) and package-keyed (12) pack manifests. Dependencies may require registry access; broker/payment checks do not contact public NEAR RPCs.
2. Inspect the actual tar archive, compare it with the pack manifest, require dist/bin/README/LICENSE/skill/examples/Docker files, and reject non-allowlisted paths, tests, .env, secrets/state/credential material, databases, private keys, tokens and node_modules. Assert installed executable resolution is inside the isolated consumer and no postinstall daemon launch hook exists.
3. Parse every shipped example JSON; validate MCP launch commands/version and CLI policy/grant shapes after exact NEAR conversion. Validate the skill's simple YAML name/description frontmatter and broker-only fallback.
4. Launch the **installed bin**, not tsx or the repository dist path. Missing or nonexistent token input must exit nonzero, stderr-only, without stacks/token leakage. Exercise local owner key/custody initialization and offline signed receipt/checkpoint verification with ephemeral test-only keys. Exercise the daemon config flag's missing-file error without unlocking or contacting RPC.
5. Run 32 owner admin command/flag forms against a local recording stub using real encrypted owner-key unlock and signed HTTP requests. The stub validates actual operation bodies against strict admin schemas; it is deliberately not a live broker or an owner-auth security test. It checks exact monetary conversion, force behavior, token files and paginated exports. All reference commands/flags are checked by execution rather than assumed from a different CLI version. Local commands and optional positional variants are exercised too.
6. Time 30 separate installed `budget-broker --help` invocations, compute nearest-rank p95, print it and require ≤1000 ms. Separately require exit 0, meaningful help on stdout and no stderr. A fast usage error is **not** accepted as valid help.
7. Remove the consumer, tarball and ephemeral secrets in suite cleanup, including assertion/setup failure. Build output is the ordinary git-ignored dist directory; no fixture/state or tarball is left in the checkout.

Run `npm run typecheck` too. Source-only operator docs are not in the frozen package allowlist: the tarball ships README, examples (with their README), skills and docker alongside dist. Use the checkout for full docs, fixtures and Docker image builds. The package is private; tarball npx installation does not imply registry publication.

## Base 32bf601 results

On Node 24.16.0 / npm 12.0.2: archive/install, JSON/skill validation, missing-token clean error and installed command matrix pass. Latest help timing p95 was **164.2 ms** over 30 processes, under 1000 ms, but **all help processes returned usage status 2**, so the suite correctly reports **4 passed, 1 failed**. These timings measure the current failing help path, not a claim that functional help passed. Typecheck passes separately; `test:package && typecheck` stops at the help failure, so typecheck was also invoked independently. Base, fixture-secret and prebuilt-image Compose configurations validate with `docker compose … config --quiet`; no live daemon/faucet/payment was started for documentation validation.

## Amendment requests (not edited by B09)

### Required: B08 CLI help

`src/cli/index.ts` does not implement `--help`: the parser treats it as an unsupported flag and returns `Budget Broker: USAGE (see docker/README.md for commands)` on stderr, status 2. Add a cheap side-effect-free top-level `budget-broker --help` path before credential loading/daemon startup; return 0 with real command/flag help on stdout and no stderr. Include mcp, daemon/config, custody initialization and all owner forms/flags from the operator guide. Optional command-specific help is welcome but is not currently documented as supported. Keep the installed help p95 ≤1000 ms. **Do not weaken or skip the packaging assertion.** Re-run packaging/typecheck after the B08 fix; help-derived reference generation cannot truthfully claim success on this base, so the current reference is based on the actual command forms plus executed installed-bin matrix.

### Optional: B00 pack freshness

There is no prepack build hook. The documented operator flow and test explicitly build before packing, but bare `npm pack` in an unbuilt checkout can omit dist or package stale dist. Consider adding `prepack: npm run build` (package owner only); B09 intentionally does not edit package.json/lock/configs. The test must still inspect the tarball, not just the worktree.

### Deployment compatibility observations (documented, no source amendment required)

- `init-custody` takes a protected **raw** ed25519 string; fixtures output an **encrypted** broker-key.json. Reuse that envelope and exact master bytes rather than re-encrypting the JSON or switching to the recovery key.
- Fixture master.secret is random binary, while base Compose BB_MASTER_MATERIAL is environment text. `examples/compose.fixture.yaml` uses a file-backed secret override. Never place binary bytes in an environment variable.
- The shipped Dockerfile builds from src/lock/tsconfig, which are intentionally absent from the tarball. Build from a source checkout or provide a separately trusted prebuilt image using the override; no false claim that the tarball alone can build that Dockerfile.
- README relative docs links target the source checkout's docs; full docs distribution would require an owner-approved package allowlist amendment if desired.
