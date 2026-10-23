// Review mutations are applied ONLY to an isolated source/test copy. Never
// patch worktree src, including on interruption. Run: npx tsx test/cli/mutations.ts
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

type Mutant = { name: string; file: string; before: string; after: string; test: string; all?: boolean; docker?: boolean };
const cli = 'src/cli/index.ts'; const keys = 'src/cli/keys.ts'; const compose = 'docker/docker-compose.yml';
const commands = 'test/cli/regressions.test.ts'; const isolation = 'test/isolation/isolation.test.ts';
const mutants: Mutant[] = [
  { name: 'global freeze arity', file: cli, before: "'freeze global': [4, 4]", after: "'freeze global': [9, 9]", test: commands },
  { name: 'unfreeze calls freeze', file: cli, before: 'call(group, { target, reason:', after: "call('freeze', { target, reason:", test: commands },
  { name: 'status calls audit-key', file: cli, before: "group === 'status') result = await call('walletStatus')", after: "group === 'status') result = await call('auditPublicKey')", test: commands },
  { name: 'revision >1 CAS broken', file: cli, before: 'expectedRevision: rev === 1 ? null : (rev as number) - 1', after: 'expectedRevision: null', test: commands },
  { name: 'agent request filter lost', file: cli, before: 'filter: rest[0] ? { agentId: rest[0] } : {}', after: 'filter: {}', test: commands },
  { name: 'after cursor ignored', file: cli, before: "...(flags.has('after') ? { after: required('after') } : {})", after: '...{}', test: commands },
  { name: 'receipt export first page only', file: cli, before: 'afterSeq = batch.at(-1)!.seq;', after: 'afterSeq = batch.at(-1)!.seq; break;', test: commands },
  { name: 'usage exits 1', file: cli, before: "if (code === 'USAGE') return 2;", after: "if (code === 'USAGE') return 1;", test: commands },
  { name: 'local schema validation removed', file: cli, before: 'adminSchemas[operation].parse(body);', after: '// validation omitted', test: commands },
  { name: 'local UUID validation removed', file: cli, before: "if (['agentId', 'requestId', 'credentialId', 'approvalId'].includes(key) && item !== undefined) z.uuid().parse(item);", after: '// validation omitted', test: commands },
  { name: 'owner permissions removed', file: keys, before: ' || (stat.mode & 0o077) !== 0', after: '', test: isolation },
  { name: 'owner ownership removed', file: keys, before: ' || (process.getuid && stat.uid !== process.getuid())', after: '', test: isolation },
  { name: 'scrypt N weakened', file: keys, before: 'N: 131072', after: 'N: 1024', test: isolation },
  { name: 'minimum passphrase removed', file: keys, before: 'passphrase.length < 12 || ', after: '', test: isolation },
  { name: 'master secret logged as hex', file: 'src/daemon/index.ts', before: "master = await readMasterSecret({ BB_MASTER_SECRET_FILE: env['BB_MASTER_SECRET_FILE'] });", after: "master = await readMasterSecret({ BB_MASTER_SECRET_FILE: env['BB_MASTER_SECRET_FILE'] }); console.error(master.toString('hex'));", test: 'test/cli/process.test.ts' },
  { name: 'token printed on stderr', file: cli, before: 'credentialId = issued.credential.id;', after: 'credentialId = issued.credential.id; console.error(issued.token);', test: 'test/cli/process.test.ts' },
  { name: 'token printed via injected stderr', file: cli, before: 'credentialId = issued.credential.id;', after: 'credentialId = issued.credential.id; err(issued.token);', test: 'test/cli/lifecycle.test.ts' },
  { name: 'public data directory', file: 'src/daemon/index.ts', before: 'await mkdir(config.dataDir, { recursive: true, mode: 0o700 });\n    await chmod(config.dataDir, 0o700);', after: 'await mkdir(config.dataDir, { recursive: true, mode: 0o777 });\n    await chmod(config.dataDir, 0o777);', test: commands },
  { name: 'cap_drop removed', file: compose, before: '    cap_drop: [ALL]\n', after: '', test: isolation },
  { name: 'no-new-privileges removed', file: compose, before: '    security_opt: [no-new-privileges:true]\n', after: '', test: isolation },
  { name: 'privileged container', file: compose, before: '    init: true', after: '    init: true\n    privileged: true', test: isolation },
  { name: 'host network', file: compose, before: '    init: true', after: '    init: true\n    network_mode: host', test: isolation },
  { name: 'plaintext master in compose', file: compose, before: '    environment:\n', after: '    environment:\n      BB_MASTER_SECRET: plaintext-secret\n', test: isolation },
  { name: 'env secrets with read-only', file: compose, before: 'file: ${BB_MASTER_FILE:?set protected master secret file path}', after: 'environment: BB_MASTER_MATERIAL', test: isolation },
  { name: 'Docker absence silently skipped', file: 'test/isolation/docker.ts', before: "catch { throw new Error('Docker + Compose are required; start Docker or explicitly set BB_SKIP_DOCKER=1'); }", after: 'catch { return false; }', test: isolation },
  { name: 'SQLite lock released too early', file: 'src/daemon/lock.ts', before: 'BEGIN EXCLUSIVE;', after: 'BEGIN EXCLUSIVE; ROLLBACK;', test: 'test/cli/process.test.ts' },
  { name: 'per-key singleton omitted', file: 'src/daemon/index.ts', before: 'releaseKey = await exclusiveLock(custodyLockPath(signer.publicKey, options.dependencies?.keyLockDirectory));', after: '// key fence omitted', test: 'test/cli/security.test.ts' },
  { name: 'per-key fence keyed by data dir', file: 'src/daemon/index.ts', before: 'custodyLockPath(signer.publicKey, options.dependencies?.keyLockDirectory)', after: 'custodyLockPath(config.dataDir, options.dependencies?.keyLockDirectory)', test: 'test/cli/security.test.ts' },
  { name: 'lock file mode unchecked', file: 'src/daemon/lock.ts', before: ' || (stat.mode & 0o777) !== 0o600', after: '', test: 'test/cli/locks.test.ts' },
  { name: 'lock file owner unchecked', file: 'src/daemon/lock.ts', before: "if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()))", after: 'if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)', test: 'test/cli/locks.test.ts' },
  { name: 'non-file lock unchecked', file: 'src/daemon/lock.ts', before: '!stat.isFile() || ', after: '', test: 'test/cli/locks.test.ts' },
  { name: 'lock symlinks followed', file: 'src/daemon/lock.ts', before: 'lstatSync', after: 'statSync', all: true, test: 'test/cli/locks.test.ts' },
  { name: 'private key directory mode unchecked', file: 'src/daemon/lock.ts', before: ' || (stat.mode & 0o777) !== 0o700', after: '', test: 'test/cli/locks.test.ts' },
  { name: 'private key directory owner unchecked', file: 'src/daemon/lock.ts', before: "if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid()))", after: 'if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700)', test: 'test/cli/locks.test.ts' },
  { name: 'LISTEN_FAILED mapping removed', file: 'src/daemon/index.ts', before: "catch { throw new DaemonFailure('LISTEN_FAILED'); }", after: 'catch (e) { throw e; }', test: 'test/cli/process.test.ts' },
  { name: 'data directory diagnostic removed', file: 'src/daemon/index.ts', before: "catch { throw new DaemonFailure('DATA_DIR_UNAVAILABLE'); }", after: 'catch (e) { throw e; }', test: 'test/cli/process.test.ts' },
  { name: 'RPC unavailable mislabeled mainnet', file: 'src/daemon/chain.ts', before: "if (unavailable) throw new DaemonFailure('RPC_UNAVAILABLE');", after: "if (unavailable) throw new BrokerError('MAINNET_REFUSED');", test: 'test/cli/process.test.ts' },
  { name: 'past standing-grant expiry unchecked', file: cli, before: "if (operation === 'grantStandingApproval' && fields.grant!.expiresAt <= Date.now()) usage();", after: '// past expiry allowed', test: 'test/cli/exit-codes.test.ts' },
  { name: 'verification error escapes as usage/auth', file: cli, before: "catch { throw new BrokerError('AUDIT_UNAVAILABLE'); }", after: 'catch (e) { throw e; }', test: 'test/cli/exit-codes.test.ts' },
  { name: 'policy authorization mislabeled usage', file: cli, before: "e.code === 'POLICY_CHANGED'", after: "['POLICY_CHANGED', 'FORBIDDEN'].includes(e.code)", test: 'test/cli/exit-codes.test.ts' },
  { name: 'diagnostic reason includes stack path env', file: 'src/daemon/diagnostics.ts', before: "super('BROKER_UNAVAILABLE');", after: "super('BROKER_UNAVAILABLE'); this.reason = (reason + '\\n/secret/path\\n' + new Error().stack + JSON.stringify({BB_DIAG_CANARY:process.env['BB_DIAG_CANARY']})) as typeof reason;", test: 'test/cli/process.test.ts' },
  { name: 'diagnostic renderer leaks stack path env', file: cli, before: 'const reason = diagnosticReason(e);', after: "const reason = diagnosticReason(e) ? diagnosticReason(e) + '\\n/secret/path\\n' + new Error().stack + JSON.stringify({BB_DIAG_CANARY:env['BB_DIAG_CANARY']}) : undefined;", test: 'test/cli/process.test.ts' },
  { name: 'unqualified extra published port', file: compose, before: '      - "127.0.0.1:3211:3211"', after: '      - "127.0.0.1:3211:3211"\n      - "3212:3211"', test: 'test/isolation/config.test.ts', docker: true },
  { name: 'host root bind added', file: compose, before: '      - bb_data:/var/lib/budget-broker', after: '      - bb_data:/var/lib/budget-broker\n      - /:/host:ro', test: 'test/isolation/config.test.ts', docker: true },
];
const root = resolve('.'); const scratch = mkdtempSync(join(tmpdir(), 'bb-b08-mutations-'));
const originals = new Map(mutants.map((m) => [m.file, readFileSync(join(root, m.file), 'utf8')]));
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const originalHashes = new Map([...originals].map(([file, content]) => [file, digest(content)]));
let lastOutput = '';
function run(tests: string[], docker = false): boolean {
  const result = spawnSync(process.execPath, [join(scratch, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, '--maxWorkers=1'], {
    cwd: scratch, env: { ...process.env, BB_SKIP_DOCKER: docker ? '0' : '1' }, encoding: 'utf8', timeout: 120_000,
  });
  lastOutput = `${result.stdout}\n${result.stderr}`;
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`Test subprocess terminated: ${result.signal}`);
  return result.status === 0;
}
try {
  for (const file of ['src', 'test', 'docker', 'package.json', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts']) cpSync(join(root, file), join(scratch, file), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  console.log('SKIP Docker build/up in baseline mutation copies: BB_SKIP_DOCKER=1; G2 mutants still REQUIRE real rendered Compose config.');
  if (!run(['test/cli', 'test/isolation'])) throw new Error(`Unmutated baseline failed: ${lastOutput}`);
  if (!run(['test/isolation/config.test.ts'], true)) throw new Error(`Unmutated rendered-Compose baseline failed (Docker is required): ${lastOutput}`);
  let survivors = 0;
  for (const m of mutants) {
    const original = originals.get(m.file)!;
    if (m.all ? !original.includes(m.before) : original.split(m.before).length !== 2) throw new Error(`Mutation anchor not unique: ${m.name}`);
    writeFileSync(join(scratch, m.file), m.all ? original.replaceAll(m.before, m.after) : original.replace(m.before, m.after));
    const survived = run([m.test], m.docker);
    writeFileSync(join(scratch, m.file), original);
    console.log(`${survived ? 'SURVIVED' : 'KILLED'}: ${m.name}`);
    if (survived) survivors++;
  }
  console.log(`${mutants.length - survivors}/${mutants.length} killed`);
  if (survivors) process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
  for (const [file, expected] of originalHashes) if (digest(readFileSync(join(root, file), 'utf8')) !== expected) throw new Error(`Worktree unexpectedly changed: ${file}`);
}
