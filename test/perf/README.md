# Offline performance budgets (B14)

Run `npm run test:perf` with Node 24. No credentials or public RPC are used.
The single sequential test file builds current sources before measuring the real
`node dist/main.js --help` entrypoint. Build time is excluded; process creation,
imports, CLI work and exit are included. Three fresh-process warmups precede 30
samples (this is warm filesystem/module-cache startup, not cold-machine boot).

Each load case gets a fresh temporary **file-backed** SqliteStore, WAL with the
production FULL synchronous setting, real BrokerService, policy evaluator,
Ed25519 ReceiptLog, approvals, checkpoints and authenticator. A loopback HTTP
JSON-RPC server feeds the real NativeNearChain adapter testnet-shaped status,
account/key, protocol, block, send and FINAL execution responses. The fake RPC's
`startFakeRpc(latencyMs)` argument configures per-call latency (benchmarks: 1ms).
Random in-memory custody keys sign real native transfers; no funded wallet exists.

| Measurement | Warmup | Samples | p95 budget |
| --- | ---: | ---: | ---: |
| Built bin `--help` | 3 | 30 | 1,000ms |
| Admission: policy + active hold + signed decision/queued receipts | 30 | 1,000 | 50ms |
| MCP HTTP `request_transfer` queued acknowledgement | 30 | 1,000 | 250ms |
| MCP HTTP `freeze_self` acknowledgement during that HTTP load | 3 | 100 | 200ms |

- Admission leaves all measured requests queued, without dispatch, cancellation,
  idempotent replays or artificial hold removal. Post-run assertions check every
  active hold, reservation accounting and both receipt types, plus signed-chain
  verification. Warmups exercise real native dispatch through the fake RPC.
- Both load runs offer **20 requests/second total**, round-robin across three
  spending agents, for approximately 50 seconds each. Absolute arrival deadlines
  drive an open-loop stream; requests are not response-paced. Reported latency
  includes scheduler lateness from the intended arrival (no coordinated omission).
  All promises are joined, and an inability to sustain the arrival schedule fails.
- MCP uses real SDK clients, authenticated Streamable HTTP sessions and the real
  broker; connection/initialize are warmed outside measured tool-call latency.
  A separately joined 10ms dispatch pump runs against the fake chain during this
  case, and the final assertion requires all 1,030 transfers to have executed.
- Freeze samples use a fourth, nonspending probe agent on the **same custody key,
  database and dispatch/freeze lane**. This prevents the benchmark from getting
  faster by turning spend traffic into frozen denials. Each sample must durably
  freeze the probe and emit its receipt, then the trusted owner unfreezes it
  outside the measured acknowledgement. This measures agent freeze via MCP, not
  signed admin HTTP/global-freeze latency or public-RPC tail latency.
- The permitted 60s balance freshness window spans the 50s runs; this isolates
  policy/hold/receipt performance from freshness-boundary races. Real adapter
  balance reads prime the snapshot; fake execution debits it conservatively.
- Nearest-rank p50/p95 and count are printed without rounding before assertions
  (display is rounded to two decimals). Targets are fixed, with no retries,
  conditional skips or machine-dependent relaxation. Local CPU/disk scheduling
  still matters: CI runs perf separately from other suites/Docker work.
- Every child process has a timeout/SIGKILL bound. Clients, HTTP sessions,
  dispatch work, SQLite handles and temp directories are joined/closed/removed
  in `finally`, including failed assertions. Nothing binds off loopback.

## CI and amendments outside B14 ownership

`.github/workflows/ci.yml` runs on push/PR, installs on Node 24, typechecks, builds,
requires Docker/Compose, runs perf alone, then the full remaining offline set
(including package and isolation). The two test steps together are `npm test`'s
offline set; live tests remain excluded and no live-spending flag or secrets are
provided. The opt-in `test/near/live.spike.test.ts` outside `test/live` is explicitly
excluded too, rather than relying on its environment gate. Other suites are
worker-serialized to avoid build/isolation contention.

Base `5765067` still contains throwing placeholders in
`test/package/placeholder.test.ts` and `test/e2e/placeholder.test.ts`. **B08/B10
amendment requested:** replace those placeholders with genuine package/e2e tests.
B14 cannot edit them. CI deliberately includes them and will stay red until
those owner amendments land; it does not skip or conceal missing coverage.
