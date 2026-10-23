import { build, fixtures, Harness, standing, summary, threeAgents } from './harness.js';

let daemon: Harness | undefined;
try {
  summary('Budget Broker MCP — native NEAR / TESTNET (real daemon, signed owner CLI, MCP stdio agents)');
  const fixture = await fixtures(); await build();
  daemon = await new Harness(fixture).init();
  summary(`Custody: ${fixture.accountId}; receiver: ${fixture.receiver}`);
  await threeAgents(daemon); await standing(daemon);
  summary('PASS demo:testnet — only authorized payments executed; receipts above; temporary daemon cleaned up');
} catch {
  summary('FAIL demo:testnet — check protected fixtures and testnet RPC availability (details suppressed to protect secrets)');
  process.exitCode = 1;
} finally { await daemon?.close(); }
