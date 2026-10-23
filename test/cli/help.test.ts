import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { runCli } from '../../src/cli/index.js';

it('top-level and known subcommand help print usage and exit 0 without credentials or side effects', async () => {
  for (const args of [
    ['--help'], ['help'], ['daemon', '--help'], ['daemon', '--config', '/must-not-read', '--help'],
    ['init-custody', '--help'], ['owner', '--help'], ['owner', 'init-owner-key', '--help'],
    ['owner', 'agent', '--help'], ['owner', 'agent', 'create', '--help'],
    ['owner', 'freeze', 'global', '--help'], ['owner', 'receipts', 'verify', '--help'],
    ['help', 'owner'], ['help', 'owner', 'token', 'issue'],
  ]) {
    let stdout = ''; let stderr = '';
    expect(await runCli(args, { env: {}, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } }), args.join(' ')).toBe(0);
    expect(stdout).toContain('Usage: budget-broker');
    expect(stdout).toContain('BB_URL + BB_TOKEN_FILE');
    expect(stdout).toContain('owner token issue|rotate|revoke');
    expect(stderr).toBe('');
  }
});

it('real main mcp --help and help mcp exit 0 with usage ONLY on stderr, never the protocol stream', () => {
  for (const args of [['mcp', '--help'], ['help', 'mcp']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
      env: { ...process.env, BB_URL: 'invalid-help-must-not-start-bridge', BB_TOKEN_FILE: '/must-not-read' },
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toBe(''); expect(result.stderr).toContain('Usage: budget-broker');
    expect(result.stderr).not.toContain('invalid-help-must-not-start-bridge');
  }
});

it('help does not turn unknown commands, arguments or flags into success', async () => {
  for (const args of [
    ['unknown'], ['unknown', '--help'], ['help', 'unknown'], ['--help', '--unknown'],
    ['daemon', 'unexpected', '--help'], ['owner', 'unknown', '--help'],
    ['owner', 'agent', 'unknown', '--help'], ['mcp', 'unexpected', '--help'], ['help', 'mcp', 'unexpected'],
  ]) {
    let stdout = ''; let stderr = '';
    expect(await runCli(args, { env: {}, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } }), args.join(' ')).toBe(2);
    expect(stdout).toBe(''); expect(stderr).toContain('USAGE');
  }
});
