import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair, PublicKey } from 'near-api-js';
import { z } from 'zod';
import { EncryptedCustodyKeySchema } from '../../../src/contracts/index.js';
import { EncryptedFileCustody } from '../../../src/custody/index.js';
import { assertTestnet, FixtureFailure, RPC_URL, TestnetNetwork } from './network.js';
import type { FixtureNetwork } from './network.js';

export const FILES = ['manifest.json', 'recovery.json', 'receivers.json', 'broker-key.json', 'master.secret', 'fixtures.env'] as const;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifestSchema = z.strictObject({
  version: z.literal(1), network: z.literal('testnet'),
  custody: z.string().regex(/^bb-[a-f0-9]{16}\.testnet$/),
  receiverA: z.string(), receiverB: z.string(),
  recoveryPublic: z.string(), brokerPublic: z.string(), receiverAPublic: z.string(), receiverBPublic: z.string(),
}).refine((m) => m.receiverA === `receiver-a.${m.custody}` && m.receiverB === `receiver-b.${m.custody}`);
type Manifest = z.infer<typeof manifestSchema>;
const keySchema = z.strictObject({ account_id: z.string(), public_key: z.string(), private_key: z.string() });
const receiversSchema = z.strictObject({ a: keySchema, b: keySchema });
export interface Options { mode: 'check' | 'apply'; directory: string; network: string; rpcUrl: string }
export interface Dependencies { chain?: FixtureNetwork; out?: (text: string) => void; err?: (text: string) => void }

export function optionsFrom(args: string[], env: NodeJS.ProcessEnv = process.env): Options {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--apply' && args[0] !== '--check')) {
    throw new FixtureFailure('Usage: fixtures:native [--check|--apply]');
  }
  // Both common network settings must agree; never ignore a mainnet setting.
  const networks = [env['BB_NETWORK'], env['NEAR_NETWORK_ID'], env['NEAR_ENV']].filter((v) => v !== undefined);
  if (networks.some((v) => v !== 'testnet')) throw new FixtureFailure('MAINNET_REFUSED');
  const options: Options = { mode: args[0] === '--apply' ? 'apply' : 'check', network: 'testnet',
    directory: env['BB_FIXTURES_DIR'] ?? join(homedir(), '.budget-broker', 'testnet-fixtures'),
    rpcUrl: env['BB_RPC_URL'] ?? RPC_URL };
  assertTestnet(options.network, options.rpcUrl);
  return options;
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel));
}
async function assertExternal(path: string): Promise<void> {
  const root = await realpath(repoRoot);
  let ancestor = path;
  // Resolve the nearest existing parent as well as the lexical path, so a
  // symlink outside the worktree cannot smuggle keys back into the repository.
  while (true) {
    try {
      const physical = await realpath(ancestor);
      if (inside(root, path) || inside(root, physical)) throw new FixtureFailure('Fixture directory must be outside the repository');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new FixtureFailure('Invalid fixture directory');
      ancestor = parent;
    }
  }
}
export async function permissionStatus(path: string, directory = false): Promise<'ok' | 'missing' | 'unsafe'> {
  try {
    const stat = await lstat(path);
    return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
      && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600)
      && (process.getuid === undefined || stat.uid === process.getuid()) && (directory || stat.nlink === 1) ? 'ok' : 'unsafe';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unsafe';
  }
}
async function readPrivate(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid()) || stat.size > 16384) throw new FixtureFailure('Unsafe fixture file');
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function save(path: string, bytes: string | Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
function environment(dir: string, m: Manifest): string {
  const values: Record<string, string> = {
    BB_NETWORK: 'testnet', BB_RPC_URL: RPC_URL, BB_ACCOUNT_ID: m.custody, BB_CUSTODY_ACCOUNT_ID: m.custody,
    BB_RECEIVER_A_ID: m.receiverA, BB_RECEIVER_B_ID: m.receiverB,
    BB_RECOVERY_PUBLIC_KEY: m.recoveryPublic, BB_BROKER_PUBLIC_KEY: m.brokerPublic,
    BB_RECOVERY_KEY_FILE: join(dir, 'recovery.json'), BB_RECEIVER_KEYS_FILE: join(dir, 'receivers.json'),
    BB_CUSTODY_KEY_FILE: join(dir, 'broker-key.json'), BB_MASTER_SECRET_FILE: join(dir, 'master.secret'),
  };
  return Object.entries(values).map(([k, v]) => `${k}='${v.replaceAll("'", "'\\''")}'`).join('\n') + '\n';
}
function credential(id: string, pair: KeyPair) {
  return { account_id: id, public_key: pair.getPublicKey().toString(), private_key: pair.toString() };
}
async function initialize(dir: string): Promise<void> {
  const entries = await readdir(dir);
  if (entries.some((name) => name !== '.apply.lock')) throw new FixtureFailure('Incomplete fixture files; refusing to replace key material');
  const recovery = KeyPair.fromRandom('ed25519'); const broker = KeyPair.fromRandom('ed25519');
  const a = KeyPair.fromRandom('ed25519'); const b = KeyPair.fromRandom('ed25519');
  const custody = `bb-${randomBytes(8).toString('hex')}.testnet`;
  const m: Manifest = { version: 1, network: 'testnet', custody,
    receiverA: `receiver-a.${custody}`, receiverB: `receiver-b.${custody}`,
    recoveryPublic: recovery.getPublicKey().toString(), brokerPublic: broker.getPublicKey().toString(),
    receiverAPublic: a.getPublicKey().toString(), receiverBPublic: b.getPublicKey().toString() };
  const master = randomBytes(32);
  const custodyStore = new EncryptedFileCustody();
  try {
    const envelope = await custodyStore.encryptKey(broker.toString(), master);
    await save(join(dir, 'recovery.json'), JSON.stringify(credential(custody, recovery)));
    await save(join(dir, 'receivers.json'), JSON.stringify({ a: credential(m.receiverA, a), b: credential(m.receiverB, b) }));
    await save(join(dir, 'broker-key.json'), JSON.stringify(envelope));
    await save(join(dir, 'master.secret'), master);
    await save(join(dir, 'fixtures.env'), environment(dir, m));
    // All material is durable BEFORE any network mutation. A faucet outage can
    // always be retried with the same account and keys, never a fresh identity.
    await save(join(dir, 'manifest.json'), JSON.stringify(m));
  } finally { master.fill(0); await custodyStore.lock(); }
}
async function load(dir: string) {
  const buffers: Buffer[] = [];
  const read = async (name: string) => { const bytes = await readPrivate(join(dir, name)); buffers.push(bytes); return bytes; };
  const store = new EncryptedFileCustody();
  try {
    const m = manifestSchema.parse(JSON.parse((await read('manifest.json')).toString()));
    const recovery = keySchema.parse(JSON.parse((await read('recovery.json')).toString()));
    const receivers = receiversSchema.parse(JSON.parse((await read('receivers.json')).toString()));
    for (const [key, id, publicKey] of [[recovery, m.custody, m.recoveryPublic],
      [receivers.a, m.receiverA, m.receiverAPublic], [receivers.b, m.receiverB, m.receiverBPublic]] as const) {
      if (key.account_id !== id || key.public_key !== publicKey
        || KeyPair.fromString(key.private_key as `ed25519:${string}`).getPublicKey().toString() !== publicKey) throw new Error();
    }
    const publics = [m.recoveryPublic, m.brokerPublic, m.receiverAPublic, m.receiverBPublic];
    if (new Set(publics).size !== publics.length) throw new Error();
    const encrypted = EncryptedCustodyKeySchema.parse(JSON.parse((await read('broker-key.json')).toString()));
    const master = await read('master.secret');
    if (master.length !== 32 || encrypted.publicKey !== m.brokerPublic) throw new Error();
    const signer = await store.loadKey(encrypted, master);
    const message = randomBytes(32);
    if (!PublicKey.fromString(m.brokerPublic).verify(message, await signer.sign(message))) throw new Error();
    if ((await read('fixtures.env')).toString() !== environment(dir, m)) throw new Error();
    return { manifest: m, recoverySecret: recovery.private_key };
  } catch { throw new FixtureFailure('Fixture material invalid or incomplete'); }
  finally { for (const bytes of buffers) bytes.fill(0); await store.lock(); }
}
async function inspect(dir: string, chain: FixtureNetwork, out: (line: string) => void): Promise<boolean> {
  let safe = true;
  for (const [name, isDir] of [['directory', true], ...FILES.map((name) => [name, false] as const)] as const) {
    const status = await permissionStatus(isDir ? dir : join(dir, name), isDir);
    out(`permissions ${name}: ${status}`);
    if (status !== 'ok') safe = false;
  }
  if (!safe) return false;
  const { manifest: m } = await load(dir);
  await chain.verifyNetwork();
  let valid = true;
  for (const [role, id, expected] of [
    ['custody', m.custody, [['recovery', m.recoveryPublic], ['broker', m.brokerPublic]]],
    ['receiver-a', m.receiverA, [['receiver', m.receiverAPublic]]],
    ['receiver-b', m.receiverB, [['receiver', m.receiverBPublic]]],
  ] as const) {
    const state = await chain.account(id);
    out(`${role}: ${id} balance_yoctoNEAR=${state?.balance.toString() ?? 'missing'}`);
    if (!state || state.balance <= 0n) valid = false;
    for (const [label, key] of expected) {
      const present = state?.keys[key] === true;
      out(`key ${label}: ${key} full_access=${present ? 'present' : 'missing'}`);
      if (!present) valid = false;
    }
  }
  return valid;
}
export async function runFixtures(options: Options, dependencies: Dependencies = {}): Promise<number> {
  const out = dependencies.out ?? console.log; const err = dependencies.err ?? console.error;
  try {
    assertTestnet(options.network, options.rpcUrl);
    const dir = resolve(options.directory);
    if (/[\r\n\0]/.test(dir)) throw new FixtureFailure('Invalid fixture directory');
    await assertExternal(dir);
    const chain = dependencies.chain ?? new TestnetNetwork(options.rpcUrl);
    if (options.mode === 'check') return await inspect(dir, chain, out) ? 0 : 1;
    // Attest before writing even local secrets, and again at every chain mutation.
    await chain.verifyNetwork();
    if (await permissionStatus(dir, true) === 'missing') await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await permissionStatus(dir, true) !== 'ok') throw new FixtureFailure('Unsafe fixture directory permissions');
    await assertExternal(dir);
    const lockPath = join(dir, '.apply.lock');
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (await permissionStatus(join(dir, 'manifest.json')) === 'missing') await initialize(dir);
      for (const name of FILES) if (await permissionStatus(join(dir, name)) !== 'ok') throw new FixtureFailure('Unsafe or missing fixture file');
      const { manifest: m, recoverySecret } = await load(dir);
      let custody = await chain.account(m.custody);
      if (!custody) { await chain.verifyNetwork(); await chain.faucet(m.custody, m.recoveryPublic); custody = await chain.account(m.custody); }
      if (custody?.keys[m.recoveryPublic] !== true) throw new FixtureFailure('Recovery full-access key missing');
      if (custody.keys[m.brokerPublic] !== true) { await chain.verifyNetwork(); await chain.addBroker(m.custody, recoverySecret, m.brokerPublic); }
      for (const [id, key] of [[m.receiverA, m.receiverAPublic], [m.receiverB, m.receiverBPublic]] as const) {
        if (!await chain.account(id)) { await chain.verifyNetwork(); await chain.createReceiver(m.custody, recoverySecret, id, key); }
      }
      return await inspect(dir, chain, out) ? 0 : 1;
    } finally { await lock.close(); await unlink(lockPath); }
  } catch (error) {
    err(error instanceof FixtureFailure ? error.message : 'Fixture operation failed (details suppressed to protect secrets)');
    return 1;
  }
}
