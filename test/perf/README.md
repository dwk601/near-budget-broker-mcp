# Offline performance budgets (B14)

Run `npm run test:perf` with Node 24. It uses no credentials and no public RPC. The single test file runs its cases in sequence. It builds the current sources and then measures the real `node dist/main.js --help` entry point. The measurement excludes build time and includes process creation, imports, CLI work, and exit. Three warmup runs in fresh processes come before 30 samples, so this measures startup with a warm filesystem and module cache, not a cold machine boot.

Each load case gets a fresh temporary SqliteStore backed by a file, in WAL mode with the production `FULL` synchronous setting. It uses the real BrokerService, policy evaluator, Ed25519 ReceiptLog, approvals, checkpoints, and authenticator. A loopback HTTP JSON-RPC server gives the real NativeNearChain adapter responses shaped like testnet: status, account and key, protocol, block, send, and FINAL execution. The `startFakeRpc(latencyMs)` argument sets the per-call latency of the fake RPC, which the benchmarks set to 1 ms. Random in-memory custody keys sign real native transfers, and no funded wallet exists.

| Measurement | Warmup | Samples | p95 budget |
| --- | ---: | ---: | ---: |
| Built bin `--help` | 3 | 30 | 1,000ms |
| Admission: policy, active hold, and signed decision and queued receipts | 30 | 1,000 | 50ms |
| MCP HTTP `request_transfer` queued acknowledgement | 30 | 1,000 | 250ms |
| MCP HTTP `freeze_self` acknowledgement under that HTTP load | 3 | 100 | 200ms |

- The admission case leaves every measured request queued. It does no dispatch, cancellation, idempotent replay, or artificial hold removal. Assertions after the run check every active hold, the reservation accounting, both receipt types, and the signed chain. The warmups run real native dispatch through the fake RPC.
- Both load runs send 20 requests per second in total, round-robin across three spending agents, for about 50 seconds each. Arrivals follow absolute deadlines in an open loop, so the test does not wait for a response before sending the next request. Reported latency includes any delay between the intended arrival time and the actual send, which avoids coordinated omission. The test awaits every promise, and it fails if it cannot keep up with the arrival schedule.
- The MCP case uses real SDK clients, authenticated Streamable HTTP sessions, and the real broker. Connections and initialization warm up outside the measured tool-call latency. A dispatch pump runs every 10 ms against the fake chain during this case and is awaited separately. The final assertion requires all 1,030 transfers to have executed.
- The freeze samples use a fourth agent that does not spend. It shares the same custody key, database, and dispatch and freeze lane as the spending agents. That way the benchmark cannot speed up by turning spending traffic into frozen denials. Each sample must durably freeze this agent and write its receipt, and then the trusted owner unfreezes it outside the measured time. This measures an agent freeze through MCP. It does not measure signed admin HTTP, a global freeze, or public RPC tail latency.
- The allowed 60-second balance freshness window covers each 50-second run, which keeps freshness-boundary races out of the policy, hold, and receipt numbers. Real adapter balance reads fill the initial snapshot, and fake executions debit it conservatively.
- The test prints the nearest-rank p50, p95, and count, unrounded, before the assertions run (the display rounds to two decimals). The targets are fixed. There are no retries, conditional skips, or relaxed limits for slow machines. Local CPU and disk scheduling still matter, so CI runs the perf suite apart from other suites and Docker work.
- Every child process has a timeout and is killed with SIGKILL if it overruns. The test closes or removes clients, HTTP sessions, dispatch work, SQLite handles, and temporary directories in `finally`, including after failed assertions. Nothing binds outside loopback.

## CI and changes outside B14

`.github/workflows/ci.yml` runs on every push and pull request. It installs on Node 24, typechecks, builds, requires Docker and Compose, runs the perf suite by itself, and then runs the rest of the offline set, including the package and isolation tests. Together these two test steps are the offline set that `npm test` covers. Live tests stay excluded, and CI provides no secrets and no flag that enables live spending. The opt-in `test/near/live.spike.test.ts`, which sits outside `test/live`, is excluded explicitly rather than through its environment gate. The other suites run in a single worker to avoid contention between builds and isolation tests.

`test/e2e` now runs the built daemon, the owner CLI, and real stdio MCP bridges against a fake testnet RPC on loopback, and injects faults into the cleanup of disposable accounts. `test/package/placeholder.test.ts` is still a placeholder that throws. CI includes it on purpose, and it will keep failing until the package owner replaces it with real coverage. No coverage gap is skipped or hidden.
