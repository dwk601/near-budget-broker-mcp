import { runStdioBridge } from '../../../src/bridge/index.js';

try { await runStdioBridge(); }
catch { process.exitCode = 1; }
