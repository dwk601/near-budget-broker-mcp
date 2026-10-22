import { runStdioBridge } from '../../../src/bridge/index.js';

try { await runStdioBridge({ timeoutMs: Number(process.env['BB_TEST_TIMEOUT_MS'] ?? 5000) }); }
catch { process.exitCode = 1; }
