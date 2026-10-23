import { afterAll, beforeAll, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { AuditSigner } from '../../src/audit/core/index.js';
import { adminSchemas } from '../../src/daemon/admin.js';
import { loadConfig } from '../../src/daemon/index.js';
import { assertComposeConfig } from '../isolation/compose-config.js';
import {
  AgentPolicySchema, WalletPolicySchema, StandingApprovalGrantSchema,
  canonicalJson, checkpointHashInput, parseNear, receiptHashInput, sha256Hex,
} from '../../src/contracts/index.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(BB_|NEAR_)/.test(key) || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
let temporary = '';
let project = '';
let bin = '';
let packedFiles: string[] = [];
let tarball = '';

// Freeze non-generated package paths: adding an example must be reviewed explicitly.
const shippedArtifacts = new Set([
  'package.json', 'README.md', 'LICENSE', 'skills/budget-broker/SKILL.md',
  'examples/README.md', 'examples/agent-policy.json', 'examples/wallet-policy.json',
  'examples/standing-approval.json', 'examples/daemon-config.json',
  'examples/claude-desktop.json', 'examples/claude-code.mcp.json', 'examples/cursor.mcp.json',
  'examples/compose.prebuilt.yaml', 'examples/compose.resources.yaml',
  'docker/Dockerfile', 'docker/Dockerfile.dockerignore', 'docker/docker-compose.yml', 'docker/README.md',
]);
const allowedMember = (file: string) => shippedArtifacts.has(file) || /^dist\/.+/.test(file);
// Raw native-key files and either private_key/secret_key JSON are covered by
// the bare base58 secret pattern; public Ed25519 keys are only 32..44 chars.
const credentialMaterial = /-----BEGIN (?:ENCRYPTED |EC |RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16}|bb_agent_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|ed25519:[1-9A-HJ-NP-Za-km-z]{45,}/;

async function command(file: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) {
  try {
    const result = await exec(file, args, { cwd, env: { ...env, ...extra }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    return { ...result, status: 0 };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    if (typeof failure.code !== 'number') throw error; // Timeout/spawn failures are never valid CLI exits.
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', status: failure.code };
  }
}
async function ok(file: string, args: string[], cwd: string) {
  const result = await command(file, args, cwd);
  expect(result.status, `${file} ${args.join(' ')}\n${result.stderr}`).toBe(0);
  return result;
}
const installed = (args: string[], extra: NodeJS.ProcessEnv = {}) => command(bin, args, project, extra);

beforeAll(async () => {
  temporary = await mkdtemp(join(await realpath(tmpdir()), 'bb-package-'));
  const root = await realpath(repo);
  const rel = relative(root, temporary);
  expect(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)).toBe(true);
  project = join(temporary, 'consumer');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'bb-package-consumer', version: '1.0.0', private: true }));
  await rm(join(repo, 'dist'), { recursive: true, force: true });
  await ok('npm', ['run', 'build'], repo);
  const packed = await ok('npm', ['pack', '--json', '--pack-destination', temporary], repo);
  type PackManifest = { filename: string; files: { path: string }[] };
  const output = JSON.parse(packed.stdout) as PackManifest[] | Record<string, PackManifest>;
  // npm <=11 emits an array; npm 12 emits a package-name keyed object.
  const [manifest] = Array.isArray(output) ? output : Object.values(output);
  if (!manifest) throw new Error('npm pack produced no manifest');
  tarball = join(temporary, manifest.filename);
  packedFiles = manifest.files.map((file) => file.path);
  await ok('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], project);
  bin = join(project, 'node_modules', '.bin', 'budget-broker');
  expect((await realpath(bin)).startsWith(`${project}${sep}`)).toBe(true);
}, 180_000);

afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

test('tarball has the allowlisted runnable distribution, no secrets/state/tests/dependencies', async () => {
  const listed = await ok('tar', ['-tzf', tarball], project);
  const archive = listed.stdout.trim().split('\n').filter((name) => !name.endsWith('/')).map((name) => name.replace(/^package\//, '')).sort();
  expect(archive).toEqual([...packedFiles].sort());
  for (const file of packedFiles) {
    expect(file, 'absolute/traversal archive member').not.toMatch(/(^\/|(^|\/)\.\.($|\/))/);
    expect(allowedMember(file), `package allowlist: ${file}`).toBe(true);
    expect(file, 'secret/state/test/dependency member').not.toMatch(/(^|\/)(node_modules|test|tests|fixtures|\.env(?:\..*)?|\.git|secrets?|state|coverage)(\/|$)|\.(test|spec)\.[^/]+$|\.(sqlite(?:-wal|-shm)?|db|pem|key|secret|token|tgz)$|(^|\/)(custody|recovery|broker-key|master)\.json$/i);
  }
  for (const required of ['dist/main.js', 'README.md', 'LICENSE', 'skills/budget-broker/SKILL.md', 'examples/claude-desktop.json', 'examples/claude-code.mcp.json', 'examples/cursor.mcp.json', 'docker/Dockerfile', 'docker/docker-compose.yml']) expect(packedFiles).toContain(required);
  for (const file of packedFiles) {
    const contents = await readFile(join(project, 'node_modules/near-budget-broker-mcp', file), 'utf8');
    expect(contents, `private credential material in ${file}`).not.toMatch(credentialMaterial);
  }
  const metadata = JSON.parse(await readFile(join(project, 'node_modules/near-budget-broker-mcp/package.json'), 'utf8')) as { bin: Record<string, string>; scripts: Record<string, string> };
  expect(metadata.bin['budget-broker']).toBe('dist/main.js');
  expect(metadata.scripts['postinstall']).toBeUndefined();
  expect((await stat(bin)).mode & 0o111).not.toBe(0);
});

test('package guards reject unreviewed artifact names and raw or JSON private credentials', () => {
  for (const prefix of ['examples', 'docker', 'skills/budget-broker']) {
    for (const name of ['native-key', 'owner.json', 'receivers.json', 'fixtures.env', 'extra.md']) {
      expect(allowedMember(`${prefix}/${name}`)).toBe(false);
    }
  }
  for (const file of shippedArtifacts) expect(allowedMember(file)).toBe(true);
  const pair = KeyPair.fromRandom('ed25519');
  const secret = pair.toString();
  for (const contents of [secret, JSON.stringify({ private_key: secret }), JSON.stringify({ secret_key: secret }),
    `bb_agent_${randomBytes(32).toString('base64url')}`, '-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(32)]) {
    expect(credentialMaterial.test(contents)).toBe(true);
  }
  expect(credentialMaterial.test(pair.getPublicKey().toString())).toBe(false);
  expect(credentialMaterial.test('ed25519:REPLACE_WITH_OWNER_PUBLIC_KEY')).toBe(false);
});

test('shipped base and example Compose overrides render individually and together with preserved isolation', async () => {
  const shipped = join(project, 'node_modules/near-budget-broker-mcp');
  const master = join(temporary, 'compose-master'); const config = join(temporary, 'compose-config');
  const volume = 'bb-package-render-only-no-volume-created';
  const image = 'budget-broker:package-render-only';
  await writeFile(master, 'render-only-not-a-real-secret', { mode: 0o600 });
  await writeFile(config, '{}', { mode: 0o600 });
  const extra = { BB_MASTER_FILE: master, BB_CONFIG_FILE: config, BB_DATA_VOLUME: volume, BB_IMAGE: image };
  for (const overrides of [[], ['prebuilt'], ['resources'], ['prebuilt', 'resources']]) {
    const args = ['compose', '-f', join(shipped, 'docker/docker-compose.yml')];
    for (const override of overrides) args.push('-f', join(shipped, `examples/compose.${override}.yaml`));
    const quiet = await command('docker', [...args, 'config', '--quiet'], shipped, extra);
    expect(quiet.status, quiet.stderr).toBe(0);
    const rendered = await command('docker', [...args, 'config', '--format', 'json'], shipped, extra);
    expect(rendered.status, rendered.stderr).toBe(0);
    const value = JSON.parse(rendered.stdout);
    assertComposeConfig(value, { master, config, volume });
    const service = value.services.daemon;
    expect(service.image).toBe(image);
    if (overrides.includes('prebuilt')) expect(service.build).toBeUndefined();
    else expect(service.build).toBeDefined();
    if (overrides.includes('resources')) {
      expect(service.mem_limit).toBe('1073741824');
      expect(service.pids_limit).toBe(128);
    }
  }
}, 120_000);

test('all example JSON parses, MCP launch paths/policies are valid, skill has YAML frontmatter', async () => {
  const shipped = join(project, 'node_modules/near-budget-broker-mcp');
  const examples = join(shipped, 'examples');
  const files = await readdir(examples, { recursive: true });
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const text = await readFile(join(examples, file), 'utf8');
    expect(() => JSON.parse(text), `invalid example JSON: ${file}`).not.toThrow();
  }
  for (const name of ['claude-desktop.json', 'claude-code.mcp.json', 'cursor.mcp.json']) {
    const value = JSON.parse(await readFile(join(examples, name), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    const server = value.mcpServers['budget-broker']!;
    expect(server.command).toBe('npx');
    const metadata = JSON.parse(await readFile(join(shipped, 'package.json'), 'utf8')) as { version: string };
    expect(server.args).toEqual(['--yes', '--package', `/abs/path/near-budget-broker-mcp-${metadata.version}.tgz`, 'budget-broker', 'mcp']);
    expect(server.env).toEqual({ BB_URL: 'http://127.0.0.1:3210', BB_TOKEN_FILE: '/agent/private/token' });
  }
  for (const [file, schema, fields] of [
    ['agent-policy.json', AgentPolicySchema, ['perTxMax', 'rolling24hMax', 'lifetimeMax', 'gasBudget24h', 'approvalThreshold']],
    ['wallet-policy.json', WalletPolicySchema, ['rolling24hMax', 'safetyReserve']],
    ['standing-approval.json', StandingApprovalGrantSchema, ['perTxMax', 'totalMax']],
  ] as const) {
    const value = JSON.parse(await readFile(join(examples, file), 'utf8')) as Record<string, unknown>;
    for (const field of fields) if (value[field] !== null) value[field] = parseNear(value[field]);
    schema.parse(value);
  }
  const daemonConfig = JSON.parse(await readFile(join(examples, 'daemon-config.json'), 'utf8')) as Record<string, unknown>;
  expect(daemonConfig['ownerPublicKey']).toBe('ed25519:REPLACE_WITH_OWNER_PUBLIC_KEY');
  const publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const configFile = join(temporary, 'example-daemon-config.json');
  await writeFile(configFile, JSON.stringify({ ...daemonConfig, ownerPublicKey: publicKey }), { mode: 0o600 });
  const config = await loadConfig(configFile);
  expect(config.ownerPublicKey).toBe(publicKey);
  expect(config.feeReservePerTx).toBe(BigInt(daemonConfig['feeReservePerTx'] as string));
  expect(config.safetyReserve).toBe(BigInt(daemonConfig['safetyReserve'] as string));
  expect(config.bindHost).toBe('0.0.0.0');
  expect([config.agentPort, config.adminPort]).toEqual([3210, 3211]);
  const skill = await readFile(join(shipped, 'skills/budget-broker/SKILL.md'), 'utf8');
  // Deliberately support the simple YAML scalar frontmatter used by this skill,
  // without adding a runtime or development YAML dependency to the package.
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill)?.[1];
  expect(front).toBeDefined();
  const entries = front!.split(/\r?\n/).map((line) => /^([a-z]+): ([^\r\n]+)$/.exec(line));
  expect(entries.every(Boolean)).toBe(true);
  const fields = Object.fromEntries(entries.map((entry) => [entry![1], entry![2]]));
  expect(Object.keys(fields).sort()).toEqual(['description', 'name']);
  expect(fields['name']).toBe('budget-broker');
  expect(fields['description']!.length).toBeGreaterThan(40);
  expect(skill).toContain('never');
  expect(skill).toContain('budget-broker mcp');
});

test('installed mcp without a token fails cleanly on stderr, with no stdout', async () => {
  for (const extra of [{ BB_URL: 'http://127.0.0.1:3210' }, { BB_URL: 'http://127.0.0.1:3210', BB_TOKEN_FILE: join(temporary, 'missing-token') }]) {
    const result = await installed(['mcp'], extra);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Budget Broker');
    expect(result.stderr).not.toMatch(/\bat \S+ \(|Error:|bb_agent_/);
  }
});

test('installed owner command/flag matrix matches documented forms and real admin operations', async () => {
  const ownerKey = join(temporary, 'owner.json');
  const credentials = { BB_OWNER_KEY_FILE: ownerKey, BB_OWNER_PASSPHRASE: 'package-test-only-passphrase-not-a-secret' };
  const init = await installed(['owner', 'init-owner-key', '--out', ownerKey, '--json'], credentials);
  expect(init.status, init.stderr).toBe(0);
  expect(JSON.parse(init.stdout)).toHaveProperty('publicKey');
  expect((await stat(ownerKey)).mode & 0o777).toBe(0o600);
  const raw = join(temporary, 'raw-key'); const master = join(temporary, 'master');
  await writeFile(raw, KeyPair.fromRandom('ed25519').toString(), { mode: 0o600 });
  await writeFile(master, randomBytes(32), { mode: 0o600 });
  const custody = await installed(['init-custody', '--key-file', raw, '--master-file', master, '--out', join(temporary, 'custody.json'), '--json']);
  expect(custody.status, custody.stderr).toBe(0);
  expect(JSON.parse(custody.stdout)).toHaveProperty('path');
  // Real daemon flag/config-file path, deliberately missing file: never unlock/network.
  const daemon = await installed(['daemon', '--config', join(temporary, 'missing-config'), '--json']);
  expect(daemon.status).toBe(1);
  expect(JSON.parse(daemon.stderr)).toEqual({ error: { code: 'BROKER_UNAVAILABLE', reason: 'BAD_CONFIG' } });
  const daemonEnv = await installed(['daemon', '--json'], { BB_CONFIG_FILE: join(temporary, 'missing-config') });
  expect(daemonEnv).toEqual(daemon);

  const audit = AuditSigner.generate();
  const receiptPreimage = { chainId: 'owner', seq: 1, prevHash: '0'.repeat(64), type: 'freeze' as const, at: 1,
    payload: { scope: 'global' as const, frozen: true, reason: 'offline package test', at: 1 } };
  const hash = sha256Hex(receiptHashInput(receiptPreimage));
  const receipt = { ...receiptPreimage, hash, signature: Buffer.from(audit.signHash(Buffer.from(hash, 'hex'))).toString('base64') };
  const checkpointPreimage = { version: 1 as const, chainId: 'owner', seq: 1, headHash: hash, previousCheckpointHash: null, at: 1, auditPublicKey: audit.publicKey };
  const checkpointHash = sha256Hex(checkpointHashInput(checkpointPreimage));
  const checkpoint = { ...checkpointPreimage, hash: checkpointHash, signature: Buffer.from(audit.signHash(Buffer.from(checkpointHash, 'hex'))).toString('base64') };
  const receiptsFile = join(temporary, 'receipts.json'); const checkpointFile = join(temporary, 'checkpoint.json');
  await writeFile(receiptsFile, canonicalJson([receipt])); await writeFile(checkpointFile, canonicalJson(checkpoint));
  const verifyArgs = ['owner', 'receipts', 'verify', '--file', receiptsFile, '--checkpoint', checkpointFile, '--audit-key', audit.publicKey];
  const verify = await installed(verifyArgs);
  expect(verify.status, verify.stderr).toBe(0); expect(JSON.parse(verify.stdout)).toHaveProperty('valid', true);
  const corruptFile = join(temporary, 'corrupt-receipts.json');
  for (const corrupt of ['{', '{}', canonicalJson([{ ...receipt, signature: Buffer.alloc(64).toString('base64') }])]) {
    await writeFile(corruptFile, corrupt);
    const invalid = await installed(verifyArgs.map((arg) => arg === receiptsFile ? corruptFile : arg));
    expect(invalid.status, invalid.stderr).toBe(1);
  }
  for (const [flag, value] of [['--file', join(temporary, 'missing-receipts.json')], ['--audit-key', 'invalid-key']]) {
    for (const json of [false, true]) {
      const args = [...verifyArgs]; args[args.indexOf(flag!) + 1] = value!;
      if (json) args.push('--json');
      const invalid = await installed(args);
      expect(invalid.status).toBe(1);
      if (flag === '--audit-key') {
        expect(JSON.parse(invalid.stdout)).toMatchObject({ valid: false, reason: 'Invalid export, checkpoint or pinned key' });
        expect(invalid.stderr).toBe('');
      } else {
        expect(invalid.stdout).toBe('');
        expect(invalid.stderr).toBe(json ? '{"error":{"code":"AUDIT_UNAVAILABLE"}}\n' : 'Budget Broker: AUDIT_UNAVAILABLE\n');
      }
    }
  }
  for (const args of [[], ['owner', 'receipts', 'verify'], ['owner', 'requests', 'get', 'not-a-uuid'], ['owner', 'agent', 'list', '--limit', '0']]) {
    const invalid = await installed([...args, '--json']);
    expect(invalid.status, args.join(' ')).toBe(2);
    expect(invalid.stdout).toBe(''); expect(JSON.parse(invalid.stderr)).toEqual({ error: { code: 'USAGE' } });
  }

  const calls: { op: string; body: Record<string, unknown> }[] = [];
  const failures: string[] = [];
  const token = `bb_agent_${randomBytes(32).toString('base64url')}`;
  const agentId = randomUUID(); const credentialId = randomUUID(); const requestId = randomUUID(); const approvalId = randomUUID();
  let refused: 'FORBIDDEN' | 'UNAUTHENTICATED' | 'POLICY_CHANGED' | undefined;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const op = req.url?.slice('/admin/'.length) ?? '';
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (!req.headers['x-bb-owner-signature']) throw new Error('Missing real signed owner headers');
      if (!Object.hasOwn(adminSchemas, op)) throw new Error(`Unknown operation ${op}`);
      adminSchemas[op as keyof typeof adminSchemas].parse(body);
      calls.push({ op, body });
      if (refused) {
        res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: refused } })); return;
      }
      const result = op === 'issueToken' || op === 'rotateToken' ? { token, credential: { id: credentialId } }
        : op === 'exportReceipts' ? (body['afterSeq'] === 0 ? [receipt] : [])
        : op === 'listCheckpoints' ? (body['afterSeq'] === 0 ? [checkpoint] : []) : { ok: true };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result }));
    } catch (error) { failures.push(String(error)); res.writeHead(400); res.end('{"error":{"code":"FORBIDDEN"}}'); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing admin stub port');
  const url = `http://127.0.0.1:${address.port}`;
  const shipped = join(project, 'node_modules/near-budget-broker-mcp/examples');
  const agentPolicy = join(temporary, 'agent-policy.json'); const walletPolicy = join(shipped, 'wallet-policy.json');
  const grant = join(temporary, 'standing-approval.json');
  const policyValue = JSON.parse(await readFile(join(shipped, 'agent-policy.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(agentPolicy, JSON.stringify({ ...policyValue, agentId }));
  const grantValue = JSON.parse(await readFile(join(shipped, 'standing-approval.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(grant, JSON.stringify({ ...grantValue, agentId, expiresAt: Date.now() + 60_000 }));
  const cases: [string[], string][] = [
    [['agent', 'create', 'demo'], 'createAgent'], [['agent', 'list', '--after', 'cursor', '--limit', '2'], 'listAgents'],
    [['agent', 'revoke', agentId, 'review complete'], 'revokeAgent'],
    [['token', 'issue', agentId, '--out', join(temporary, 'token-issued')], 'issueToken'],
    [['token', 'rotate', credentialId, '--out', join(temporary, 'token-rotated')], 'rotateToken'],
    [['token', 'revoke', credentialId], 'revokeToken'],
    [['policy', 'set', '--file', agentPolicy], 'setPolicy'], [['policy', 'get', agentId], 'getPolicy'],
    [['wallet-policy', 'set', '--file', walletPolicy], 'setWalletPolicy'],
    [['approvals', 'list', '--limit', '2', '--after', 'cursor'], 'listRequests'],
    [['approvals', 'approve', requestId, String(Date.now() + 60_000)], 'approve'], [['approvals', 'reject', requestId, 'reviewed'], 'reject'],
    [['standing', 'grant', '--file', grant], 'grantStandingApproval'], [['standing', 'revoke', approvalId], 'revokeStandingApproval'],
    [['standing', 'list', agentId, '--after', 'cursor', '--limit', '2'], 'listStandingApprovals'],
    [['freeze', 'global', 'stop'], 'freeze'], [['freeze', 'agent', agentId, 'stop'], 'freeze'],
    [['unfreeze', 'global', 'reviewed'], 'unfreeze'], [['unfreeze', 'agent', agentId, 'reviewed'], 'unfreeze'],
    [['status'], 'walletStatus'], [['audit-key'], 'auditPublicKey'],
    [['requests', 'list', '--after', 'cursor', '--limit', '2'], 'listRequests'],
    [['requests', 'list', agentId], 'listRequests'], [['requests', 'get', requestId], 'getRequest'],
    [['reconcile'], 'reconcile'], [['reconcile', requestId], 'reconcile'],
    [['resolve-attempt', requestId, 'reviewed'], 'resolveAttempt'], [['resolve-attempt', requestId, 'reviewed', '--force'], 'resolveAttempt'],
    [['receipts', 'export', 'owner'], 'exportReceipts'],
    [['receipts', 'export', 'owner', '--out', join(temporary, 'export.json')], 'exportReceipts'],
    [['checkpoints', 'list', 'owner'], 'listCheckpoints'],
    [['checkpoints', 'list', 'owner', '--out', join(temporary, 'checkpoints.json')], 'listCheckpoints'],
  ];
  try {
    for (const [args, operation] of cases) {
      const start = calls.length;
      const result = await installed(['owner', ...args, '--key', ownerKey, '--url', url, '--json'], credentials);
      expect(result.status, `${args.join(' ')}: ${result.stderr}; ${failures.join('; ')}`).toBe(0);
      expect(calls.slice(start).map((call) => call.op)).toContain(operation);
      expect(result.stdout).not.toContain(token);
      if (['issueToken', 'rotateToken'].includes(operation)) {
        expect(JSON.parse(result.stdout)).toEqual({ path: args[args.indexOf('--out') + 1], credentialId });
      }
    }
    const byEnvironment = await installed(['owner', 'status'], { ...credentials, BB_ADMIN_URL: url });
    expect(byEnvironment.status, byEnvironment.stderr).toBe(0);
    expect(failures).toEqual([]);
    expect((calls.find((call) => call.op === 'setPolicy')!.body['policy'] as Record<string, unknown>)['perTxMax']).toBe('10000000000000000000000');
    expect(calls.filter((call) => call.op === 'resolveAttempt').map((call) => call.body['force'])).toEqual([false, true]);
    for (const file of ['token-issued', 'token-rotated']) {
      expect((await readFile(join(temporary, file), 'utf8')).trim()).toBe(token);
      expect((await stat(join(temporary, file))).mode & 0o777).toBe(0o600);
    }
    const plainTokenFile = join(temporary, 'plain-token');
    const plain = await installed(['owner', 'token', 'issue', agentId, '--out', plainTokenFile], { ...credentials, BB_ADMIN_URL: url });
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout).toBe(`${plainTokenFile}\ncredentialId: ${credentialId}\n`);
    for (const code of ['UNAUTHENTICATED', 'FORBIDDEN', 'POLICY_CHANGED'] as const) {
      refused = code;
      const args = code === 'POLICY_CHANGED' ? ['wallet-policy', 'set', '--file', walletPolicy] : ['status'];
      const result = await installed(['owner', ...args, '--json'], { ...credentials, BB_ADMIN_URL: url });
      expect(result.status, result.stderr).toBe(code === 'POLICY_CHANGED' ? 2 : 3);
      expect(JSON.parse(result.stderr)).toEqual({ error: { code: code === 'POLICY_CHANGED' ? 'USAGE' : code } });
      expect(result.stdout).toBe('');
    }
    console.log(`Installed CLI: ${cases.length} admin forms + local commands, verification and exits 0/1/2/3 exercised`);
  } finally { await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
}, 120_000);

test('documented help variants exit zero without credentials and keep MCP stdout clean', async () => {
  const reference = await readFile(join(repo, 'docs/cli-help.txt'), 'utf8');
  for (const args of [['help'], ['help', 'owner'], ['owner', '--help'], ['daemon', '--help'], ['init-custody', '--help'], ['owner', 'token', 'issue', '--help'], ['mcp', '--help'], ['help', 'mcp']]) {
    const result = await installed(args);
    expect(result.status, args.join(' ')).toBe(0);
    const mcp = args.includes('mcp');
    expect(result.stdout).toBe(mcp ? '' : reference);
    expect(result.stderr).toBe(mcp ? reference : '');
  }
});

test('installed --help is successful, meaningful and starts within p95 1000 ms over 30 runs', async () => {
  const durations: number[] = [];
  const results: Awaited<ReturnType<typeof installed>>[] = [];
  for (let run = 0; run < 30; run++) {
    const start = performance.now(); results.push(await installed(['--help'])); durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(0.95 * durations.length) - 1]!;
  // Direct output remains visible when Vitest hides passing-test console logs.
  process.stdout.write(`Installed budget-broker --help startup: n=30 p95=${p95.toFixed(1)} ms (limit 1000 ms)\n`);
  expect(p95).toBeLessThanOrEqual(1000);
  const reference = await readFile(join(repo, 'docs/cli-help.txt'), 'utf8');
  for (const result of results) {
    expect(result.status, `--help must succeed: ${result.stderr}`).toBe(0);
    expect(result.stdout).toBe(reference);
    expect(result.stdout).toMatch(/budget-broker/i);
    expect(result.stdout).toMatch(/mcp/);
    expect(result.stdout).toMatch(/owner/);
    expect(result.stderr).toBe('');
  }
}, 60_000);
