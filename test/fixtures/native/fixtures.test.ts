import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseEncode, KeyPair } from 'near-api-js';
import { AccountDoesNotExistError } from 'near-api-js/rpc-errors';
import { EncryptedFileCustody } from '../../../src/custody/index.js';

// Polling tests exercise every retry without sleeping or touching the network.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));
import { FILES, optionsFrom, permissionStatus, runFixtures } from '../../../scripts/fixtures/native/fixtures.js';
import type { Options } from '../../../scripts/fixtures/native/fixtures.js';
import { FAUCET_URL, FixtureFailure, RPC_URL, TestnetNetwork } from '../../../scripts/fixtures/native/network.js';
import type { AccountInfo, FixtureNetwork } from '../../../scripts/fixtures/native/network.js';

class MemoryNetwork implements FixtureNetwork {
  accounts = new Map<string, AccountInfo>();
  verifyNetwork = vi.fn(async () => {});
  account = vi.fn(async (id: string) => this.accounts.get(id) ?? null);
  faucet = vi.fn(async (id: string, key: string) => { this.accounts.set(id, { balance: 10n ** 25n, keys: { [key]: true } }); });
  addBroker = vi.fn(async (id: string, recoverySecret: string, key: string) => {
    const state = this.accounts.get(id)!;
    expect(state.keys[KeyPair.fromString(recoverySecret as `ed25519:${string}`).getPublicKey().toString()]).toBe(true);
    state.keys[key] = true;
  });
  createReceiver = vi.fn(async (_custody: string, _secret: string, id: string, key: string) => {
    this.accounts.set(id, { balance: 10n ** 23n, keys: { [key]: true } });
  });
}
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.mocked(delay).mockClear();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const parent = await mkdtemp(join(tmpdir(), 'bb-native-unit-')); temporary.push(parent);
  const options: Options = { mode: 'apply', directory: join(parent, 'fixtures'), network: 'testnet', rpcUrl: RPC_URL };
  const chain = new MemoryNetwork(); const stdout: string[] = []; const stderr: string[] = [];
  const dependencies = { chain, out: (line: string) => stdout.push(line), err: (line: string) => stderr.push(line) };
  const run = (mode: 'apply' | 'check' = 'apply') => runFixtures({ ...options, mode }, dependencies);
  return { parent, options, chain, stdout, stderr, dependencies, run };
}
async function manifest(dir: string) {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    custody: string; receiverA: string; receiverB: string; recoveryPublic: string; brokerPublic: string;
    receiverAPublic: string; receiverBPublic: string;
  };
}

describe('testnet native fixture lifecycle (offline)', () => {
  it('creates private material, two distinct full-access custody keys, and two receivers; reruns change nothing', async () => {
    const f = await setup(); expect(await f.run()).toBe(0); expect(f.stderr).toEqual([]);
    expect((await lstat(f.options.directory)).mode & 0o777).toBe(0o700);
    const before = new Map<string, Buffer>();
    for (const name of FILES) {
      const path = join(f.options.directory, name);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      before.set(name, await readFile(path));
    }
    const m = await manifest(f.options.directory);
    expect(m.custody).toMatch(/^bb-[0-9a-f]{16}\.testnet$/);
    expect(m.receiverA).toBe(`receiver-a.${m.custody}`); expect(m.receiverB).toBe(`receiver-b.${m.custody}`);
    expect(m.recoveryPublic).not.toBe(m.brokerPublic);
    expect(f.chain.accounts.get(m.custody)?.keys).toEqual({ [m.recoveryPublic]: true, [m.brokerPublic]: true });
    expect(f.chain.accounts.size).toBe(3);
    expect(f.chain.verifyNetwork.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(await f.run()).toBe(0); expect(await f.run('check')).toBe(0);
    expect(f.chain.faucet).toHaveBeenCalledTimes(1); expect(f.chain.addBroker).toHaveBeenCalledTimes(1);
    expect(f.chain.createReceiver).toHaveBeenCalledTimes(2);
    expect((await readdir(f.options.directory)).sort()).toEqual([...FILES].sort());
    for (const name of FILES) expect(await readFile(join(f.options.directory, name))).toEqual(before.get(name));
    const envelope = JSON.parse(before.get('broker-key.json')!.toString()) as Record<string, unknown>;
    expect(envelope['algorithm']).toBe('aes-256-gcm'); expect(envelope['kdf']).toBe('scrypt');
    expect(envelope['publicKey']).toBe(m.brokerPublic); expect(envelope['private_key']).toBeUndefined();
    const env = before.get('fixtures.env')!.toString();
    expect(env).toContain(`BB_CUSTODY_KEY_FILE='${join(f.options.directory, 'broker-key.json')}'`);
    expect(env).toContain(`BB_MASTER_SECRET_FILE='${join(f.options.directory, 'master.secret')}'`);
    expect(env).toContain(`BB_ACCOUNT_ID='${m.custody}'`);
    const recovery = JSON.parse(before.get('recovery.json')!.toString()) as { private_key: string };
    const receivers = JSON.parse(before.get('receivers.json')!.toString()) as { a: { private_key: string }; b: { private_key: string } };
    for (const secret of [recovery.private_key, receivers.a.private_key, receivers.b.private_key,
      before.get('master.secret')!.toString('base64'), before.get('master.secret')!.toString('hex'), baseEncode(before.get('master.secret')!),
      String(envelope['ciphertextBase64']), String(envelope['saltBase64']), String(envelope['ivBase64']), String(envelope['tagBase64'])]) {
      expect([...f.stdout, ...f.stderr].join('\n')).not.toContain(secret); expect(env).not.toContain(secret);
    }
    expect(f.stdout.join('\n')).toContain('full_access=present');
    expect(f.stdout.join('\n')).toContain('balance_yoctoNEAR=100000000000000000000000');
  });

  it('preserves identities after faucet failure and resumes without replacing keys', async () => {
    const f = await setup();
    f.chain.faucet.mockImplementationOnce(async () => { throw new FixtureFailure(`BLOCKED: faucet POST ${FAUCET_URL}: HTTP 429`); });
    expect(await f.run()).toBe(1); expect(f.stderr).toEqual([`BLOCKED: faucet POST ${FAUCET_URL}: HTTP 429`]);
    const original = await readFile(join(f.options.directory, 'manifest.json'));
    const key = await readFile(join(f.options.directory, 'broker-key.json'));
    expect(await f.run()).toBe(0);
    expect(await readFile(join(f.options.directory, 'manifest.json'))).toEqual(original);
    expect(await readFile(join(f.options.directory, 'broker-key.json'))).toEqual(key);
    expect(f.chain.faucet.mock.calls[0]).toEqual(f.chain.faucet.mock.calls[1]);
  });

  it('resumes partial chain provisioning without funding or duplicating completed receivers', async () => {
    const f = await setup(); f.chain.createReceiver.mockImplementationOnce(async () => { throw new Error('unavailable'); });
    expect(await f.run()).toBe(1); expect(await f.run()).toBe(0);
    expect(f.chain.faucet).toHaveBeenCalledTimes(1); expect(f.chain.addBroker).toHaveBeenCalledTimes(1);
    expect(f.chain.accounts.size).toBe(3);
  });

  it('check is read-only and fails for missing material, accounts, funds, or full-access keys', async () => {
    const f = await setup(); expect(await f.run('check')).toBe(1);
    expect(await permissionStatus(f.options.directory, true)).toBe('missing');
    expect(f.chain.verifyNetwork).not.toHaveBeenCalled();
    expect(await f.run()).toBe(0);
    const m = await manifest(f.options.directory); const state = f.chain.accounts.get(m.custody)!;
    state.keys[m.brokerPublic] = false; expect(await f.run('check')).toBe(1);
    expect(f.stdout.join('\n')).toContain(`key broker: ${m.brokerPublic} full_access=missing`);
    state.keys[m.brokerPublic] = true; state.balance = 0n; expect(await f.run('check')).toBe(1);
    state.balance = 1n; f.chain.accounts.delete(m.receiverB); expect(await f.run('check')).toBe(1);
    expect(f.stdout.join('\n')).toContain(`${m.receiverB} balance_yoctoNEAR=missing`);
    await unlink(join(f.options.directory, 'master.secret')); expect(await f.run('check')).toBe(1);
    expect(await f.run()).toBe(1); // never generates a replacement master
    expect(await permissionStatus(join(f.options.directory, 'master.secret'))).toBe('missing');
  });

  it.each(['manifest.json', 'recovery.json', 'receivers.json', 'broker-key.json', 'master.secret', 'fixtures.env', 'directory'])('refuses unsafe permissions on %s before network access', async (name) => {
    const f = await setup(); expect(await f.run()).toBe(0);
    const path = name === 'directory' ? f.options.directory : join(f.options.directory, name);
    await chmod(path, name === 'directory' ? 0o755 : 0o644);
    f.chain.account.mockClear(); f.chain.faucet.mockClear(); f.chain.addBroker.mockClear();
    expect(await f.run('check')).toBe(1); expect(f.chain.account).not.toHaveBeenCalled();
    expect(f.stdout).toContain(`permissions ${name}: unsafe`);
    expect(await f.run()).toBe(1); expect(f.chain.faucet).not.toHaveBeenCalled(); expect(f.chain.addBroker).not.toHaveBeenCalled();
    expect((await lstat(path)).mode & 0o777).toBe(name === 'directory' ? 0o755 : 0o644);
  });

  it.each([0o640, 0o660, 0o604, 0o400, 0o4600])('rejects file mode %i including group-only and special bits', async (mode) => {
    const f = await setup(); const path = join(f.parent, 'private-file');
    await writeFile(path, 'marker', { mode: 0o600 }); await chmod(path, mode);
    expect((await lstat(path)).mode & 0o7777).toBe(mode);
    expect(await permissionStatus(path)).toBe('unsafe');
  });

  it.each([0o750, 0o770, 0o705, 0o500])('rejects directory mode %i including group-only access', async (mode) => {
    const f = await setup(); await mkdir(f.options.directory, { mode: 0o700 });
    try {
      await chmod(f.options.directory, mode);
      expect(await permissionStatus(f.options.directory, true)).toBe('unsafe');
    } finally { await chmod(f.options.directory, 0o700); }
  });

  it('rejects a different uid without requiring root', async () => {
    const f = await setup(); const path = join(f.parent, 'owned-file');
    await writeFile(path, 'marker', { mode: 0o600 });
    expect(await permissionStatus(path)).toBe('ok');
    const actualUid = (await lstat(path)).uid;
    vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1);
    expect(await permissionStatus(path)).toBe('unsafe');
    expect(await permissionStatus(f.parent, true)).toBe('unsafe');
  });

  it('rechecks file ownership on the opened handle after the initial permission scan', async () => {
    const f = await setup(); expect(await f.run()).toBe(0);
    const actualUid = (await lstat(f.options.directory)).uid; let calls = 0;
    // The directory and six files pass lstat; the owner differs at open/fstat.
    vi.spyOn(process, 'getuid').mockImplementation(() => ++calls <= FILES.length + 1 ? actualUid : actualUid + 1);
    f.chain.account.mockClear();
    expect(await f.run('check')).toBe(1);
    expect(f.stderr).toEqual(['Fixture material invalid or incomplete']);
    expect(f.chain.account).not.toHaveBeenCalled();
  });

  it.each(['recovery', 'receiver-a', 'receiver-b'] as const)('check rejects a missing full-access %s key independently', async (role) => {
    const f = await setup(); expect(await f.run()).toBe(0);
    const m = await manifest(f.options.directory);
    const [id, key, label] = role === 'recovery' ? [m.custody, m.recoveryPublic, 'recovery']
      : role === 'receiver-a' ? [m.receiverA, m.receiverAPublic, 'receiver'] : [m.receiverB, m.receiverBPublic, 'receiver'];
    const state = f.chain.accounts.get(id!)!;
    for (const missing of [false, undefined]) {
      if (missing === undefined) delete state.keys[key!]; else state.keys[key!] = missing;
      f.stdout.length = 0;
      expect(await f.run('check')).toBe(1);
      expect(f.stdout).toContain(`key ${label}: ${key} full_access=missing`);
      state.keys[key!] = true;
    }
    expect(await f.run('check')).toBe(0);
  });

  it.each(['recovery', 'receiver-a', 'receiver-b'] as const)('rejects coherent fixture material with broker aliased to %s', async (role) => {
    const f = await setup(); expect(await f.run()).toBe(0);
    const m = await manifest(f.options.directory); const oldBroker = m.brokerPublic;
    const recovery = JSON.parse(await readFile(join(f.options.directory, 'recovery.json'), 'utf8')) as { public_key: string; private_key: string };
    const receivers = JSON.parse(await readFile(join(f.options.directory, 'receivers.json'), 'utf8')) as { a: typeof recovery; b: typeof recovery };
    const alias = role === 'recovery' ? recovery : role === 'receiver-a' ? receivers.a : receivers.b;
    m.brokerPublic = alias.public_key;
    const store = new EncryptedFileCustody(); const master = await readFile(join(f.options.directory, 'master.secret'));
    try {
      const envelope = await store.encryptKey(alias.private_key, master);
      await writeFile(join(f.options.directory, 'broker-key.json'), JSON.stringify(envelope));
    } finally { master.fill(0); await store.lock(); }
    await writeFile(join(f.options.directory, 'manifest.json'), JSON.stringify(m));
    const envPath = join(f.options.directory, 'fixtures.env');
    await writeFile(envPath, (await readFile(envPath, 'utf8')).replace(`BB_BROKER_PUBLIC_KEY='${oldBroker}'`, `BB_BROKER_PUBLIC_KEY='${alias.public_key}'`));
    const keys = f.chain.accounts.get(m.custody)!.keys;
    delete keys[oldBroker]; keys[alias.public_key] = true;
    f.chain.account.mockClear();
    expect(await f.run('check')).toBe(1);
    expect(f.stderr).toEqual(['Fixture material invalid or incomplete']);
    expect(f.chain.account).not.toHaveBeenCalled();
  });

  it('attests apply before creating local secrets or mutating the chain', async () => {
    const f = await setup();
    f.chain.verifyNetwork.mockRejectedValue(new FixtureFailure('MAINNET_REFUSED'));
    expect(await f.run()).toBe(1);
    expect(f.chain.verifyNetwork).toHaveBeenCalledTimes(1);
    expect(await permissionStatus(f.options.directory, true)).toBe('missing');
    expect(f.chain.account).not.toHaveBeenCalled(); expect(f.chain.faucet).not.toHaveBeenCalled();
    expect(f.chain.addBroker).not.toHaveBeenCalled(); expect(f.chain.createReceiver).not.toHaveBeenCalled();
    expect(f.stderr).toEqual(['MAINNET_REFUSED']);
  });

  it('attests every check before reading chain facts', async () => {
    const f = await setup(); expect(await f.run()).toBe(0);
    f.chain.verifyNetwork.mockClear(); f.chain.account.mockClear();
    f.chain.verifyNetwork.mockRejectedValue(new FixtureFailure('MAINNET_REFUSED'));
    expect(await f.run('check')).toBe(1);
    expect(f.chain.verifyNetwork).toHaveBeenCalledTimes(1); expect(f.chain.account).not.toHaveBeenCalled();
    expect(f.stderr).toEqual(['MAINNET_REFUSED']);
  });

  it('refuses an empty unsafe apply directory before contacting the chain or writing files', async () => {
    const f = await setup(); await mkdir(f.options.directory, { mode: 0o755 }); await chmod(f.options.directory, 0o755);
    expect(await f.run()).toBe(1); expect(await readdir(f.options.directory)).toEqual([]);
    expect(f.stderr).toEqual(['Unsafe fixture directory permissions']);
    expect(f.chain.verifyNetwork).not.toHaveBeenCalled(); expect(f.chain.account).not.toHaveBeenCalled();
    expect(f.chain.faucet).not.toHaveBeenCalled(); expect(f.chain.addBroker).not.toHaveBeenCalled(); expect(f.chain.createReceiver).not.toHaveBeenCalled();
  });

  it('refuses partial initialization without a manifest instead of adding or replacing material', async () => {
    const f = await setup(); await mkdir(f.options.directory, { mode: 0o700 });
    const partial = join(f.options.directory, 'partial-secret');
    await writeFile(partial, 'keep-existing-material', { mode: 0o600 });
    expect(await f.run()).toBe(1); expect(await readdir(f.options.directory)).toEqual(['partial-secret']);
    expect(await readFile(partial, 'utf8')).toBe('keep-existing-material');
    expect(f.stderr).toEqual(['Incomplete fixture files; refusing to replace key material']);
    expect(f.chain.account).not.toHaveBeenCalled(); expect(f.chain.faucet).not.toHaveBeenCalled();
  });

  it.each(['\n', '\r', '\0'])('rejects control characters in fixture paths before any IO: %j', async (character) => {
    const f = await setup(); const directory = join(f.parent, `bad${character}path`);
    expect(await runFixtures({ ...f.options, directory }, f.dependencies)).toBe(1);
    expect(f.stderr).toEqual(['Invalid fixture directory']); expect(await readdir(f.parent)).toEqual([]);
    expect(f.chain.verifyNetwork).not.toHaveBeenCalled(); expect(f.chain.faucet).not.toHaveBeenCalled();
  });

  it('honors an existing apply lock without deleting it and explains safe stale-lock recovery', async () => {
    const f = await setup(); await mkdir(f.options.directory, { mode: 0o700 });
    const path = join(f.options.directory, '.apply.lock'); await writeFile(path, 'other-apply', { mode: 0o600 });
    expect(await f.run()).toBe(1);
    expect(await readFile(path, 'utf8')).toBe('other-apply'); expect(await readdir(f.options.directory)).toEqual(['.apply.lock']);
    expect(f.stderr).toEqual(['Existing or stale .apply.lock; delete it only if no other apply is running']);
    expect(f.chain.account).not.toHaveBeenCalled(); expect(f.chain.faucet).not.toHaveBeenCalled();
    await unlink(path); expect(await f.run()).toBe(0);
  });

  it('intentionally checks positive funding and required keys, not dispatch reserves or an exclusive key set', async () => {
    const f = await setup(); expect(await f.run()).toBe(0); const m = await manifest(f.options.directory);
    const custody = f.chain.accounts.get(m.custody)!;
    custody.balance = 1n; custody.keys[KeyPair.fromRandom('ed25519').getPublicKey().toString()] = true;
    expect(await f.run('check')).toBe(0);
  });

  it('rejects symlinks and hardlinks even when target permissions are private', async () => {
    const f = await setup(); expect(await f.run()).toBe(0);
    const target = join(f.parent, 'target'); const path = join(f.options.directory, 'master.secret');
    await writeFile(target, await readFile(path), { mode: 0o600 }); await unlink(path); await symlink(target, path);
    expect(await permissionStatus(path)).toBe('unsafe'); expect(await f.run('check')).toBe(1);
    await unlink(path); await link(target, path);
    expect(await permissionStatus(path)).toBe('unsafe'); expect(await f.run()).toBe(1);
  });

  it('refuses repository paths and directory symlink aliases without creating secrets', async () => {
    const f = await setup();
    const alias = join(f.parent, 'alias'); await symlink(resolve('.'), alias);
    for (const directory of [resolve('must-not-create-fixtures'), join(alias, 'must-not-create-fixtures')]) {
      expect(await runFixtures({ ...f.options, directory }, f.dependencies)).toBe(1);
      expect(await permissionStatus(directory, true)).toBe('missing');
    }
    expect(f.chain.verifyNetwork).not.toHaveBeenCalled();
  });

  it('fails closed on corrupt envelope, mismatched local recovery key, and modified env', async () => {
    const f = await setup(); expect(await f.run()).toBe(0);
    for (const name of ['broker-key.json', 'recovery.json', 'fixtures.env']) {
      const path = join(f.options.directory, name); const original = await readFile(path);
      const replacement = name === 'fixtures.env' ? 'BB_MASTER_SECRET=do-not-leak' : '{}';
      await writeFile(path, replacement); expect(await f.run('check')).toBe(1); await writeFile(path, original);
    }
    expect(f.stderr.join('\n')).not.toContain('do-not-leak');
    const brokerPath = join(f.options.directory, 'broker-key.json');
    const originalEnvelope = await readFile(brokerPath, 'utf8');
    const encrypted = JSON.parse(originalEnvelope) as Record<string, unknown>;
    encrypted['tagBase64'] = Buffer.alloc(16).toString('base64');
    await writeFile(brokerPath, JSON.stringify(encrypted));
    expect(await f.run('check')).toBe(1); // valid envelope shape, invalid authentication tag
    await writeFile(brokerPath, originalEnvelope);
    const recoveryPath = join(f.options.directory, 'recovery.json');
    const recovery = JSON.parse(await readFile(recoveryPath, 'utf8')) as Record<string, unknown>;
    recovery['private_key'] = KeyPair.fromRandom('ed25519').toString();
    await writeFile(recoveryPath, JSON.stringify(recovery));
    expect(await f.run('check')).toBe(1);
  });

  it('suppresses arbitrary exception text even when it contains private material', async () => {
    const f = await setup(); expect(await f.run()).toBe(0);
    const secret = await readFile(join(f.options.directory, 'recovery.json'), 'utf8');
    f.chain.account.mockRejectedValueOnce(new Error(secret)); expect(await f.run('check')).toBe(1);
    expect(f.stderr).toEqual(['Fixture operation failed (details suppressed to protect secrets)']);
    expect(f.stdout.join('\n')).not.toContain(secret);
  });

  it.each(['mainnet', 'MAINNET', 'TESTNET', 'localnet'])('refuses network %s before local writes or chain calls', async (network) => {
    const f = await setup(); expect(await runFixtures({ ...f.options, network }, f.dependencies)).toBe(1);
    expect(f.stderr).toEqual(['MAINNET_REFUSED']); expect(f.chain.verifyNetwork).not.toHaveBeenCalled();
    expect(await permissionStatus(f.options.directory, true)).toBe('missing');
    expect(() => optionsFrom([], { BB_NETWORK: network })).toThrow('MAINNET_REFUSED');
  });

  it('validates CLI modes and refuses every conflicting network environment variable', () => {
    expect(optionsFrom([], {}).mode).toBe('check'); expect(optionsFrom(['--check'], {}).mode).toBe('check');
    expect(optionsFrom(['--apply'], {}).mode).toBe('apply');
    expect(() => optionsFrom(['--apply', '--check'], {})).toThrow('Usage:');
    for (const name of ['NEAR_ENV', 'NEAR_NETWORK_ID']) expect(() => optionsFrom([], { BB_NETWORK: 'testnet', [name]: 'mainnet' })).toThrow('MAINNET_REFUSED');
    for (const rpcUrl of ['https://rpc.mainnet.near.org', 'https://free.rpc.fastnear.com', 'https://secret@rpc.testnet.near.org']) {
      expect(() => optionsFrom([], { BB_RPC_URL: rpcUrl })).toThrow('MAINNET_REFUSED');
    }
  });

  it('CLI defaults to check, exits nonzero, and never creates absent fixtures', async () => {
    const f = await setup();
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/fixtures/native/index.ts'], {
      encoding: 'utf8', env: { ...process.env, BB_FIXTURES_DIR: f.options.directory, BB_NETWORK: 'testnet', NEAR_NETWORK_ID: 'testnet', NEAR_ENV: 'testnet' },
    });
    expect(result.status).toBe(1); expect(result.stdout).toContain('permissions directory: missing');
    expect(result.stderr).toBe(''); expect(await permissionStatus(f.options.directory, true)).toBe('missing');
  });
});

describe('live transport guards without network', () => {
  it('account preserves locked balance and distinguishes full-access from function-call permissions', async () => {
    const chain = new TestnetNetwork(RPC_URL); const id = 'bb-0000000000000000.testnet';
    const hash = baseEncode(new Uint8Array(32).fill(7));
    const view = vi.spyOn(chain.provider, 'viewAccount').mockResolvedValue({
      amount: 5n, locked: 7n, storage_usage: 100, code_hash: hash, block_hash: hash, block_height: 1,
    });
    const keys = vi.spyOn(chain.provider, 'viewAccessKeyList').mockResolvedValue({
      block_hash: hash, block_height: 1, keys: [
        { public_key: 'FULL', access_key: { nonce: 1, permission: 'FullAccess' } },
        { public_key: 'FC', access_key: { nonce: 2, permission: { FunctionCall: { allowance: '1', receiver_id: id, method_names: ['limited'] } } } },
      ],
    });
    expect(await chain.account(id)).toEqual({ balance: 12n, keys: { FULL: true, FC: false } });
    expect(view).toHaveBeenCalledWith({ accountId: id, blockQuery: { finality: 'final' } });
    expect(keys).toHaveBeenCalledWith({ accountId: id, finalityQuery: { finality: 'final' } });
    keys.mockClear(); view.mockRejectedValueOnce(new AccountDoesNotExistError(id, hash, 1));
    expect(await chain.account(id)).toBeNull(); expect(keys).not.toHaveBeenCalled();
    const unavailable = new Error('RPC unavailable'); view.mockRejectedValueOnce(unavailable);
    await expect(chain.account(id)).rejects.toBe(unavailable);
    keys.mockRejectedValueOnce(unavailable); await expect(chain.account(id)).rejects.toBe(unavailable);
  });

  it.each([500, 302])('rejects HTTP status %i even with a testnet body', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: { chain_id: 'testnet' } }, {
      status, headers: status === 302 ? { location: 'https://elsewhere.invalid' } : {},
    }));
    await expect(new TestnetNetwork(RPC_URL, fetcher).verifyNetwork()).rejects.toThrow('MAINNET_REFUSED');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
  });

  it('requires redirect refusal on RPC attestation requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.redirect === 'error') throw new TypeError('redirect refused');
      return Response.json({ result: { chain_id: 'testnet' } });
    });
    await expect(new TestnetNetwork(RPC_URL, fetcher).verifyNetwork()).rejects.toThrow('redirect refused');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
  });

  it.each([{ status: { Failure: 'rejected' } }, { status: { SuccessValue: Buffer.from('false').toString('base64') } }])('rejects unsuccessful HTTP-200 faucet outcomes: %j', async (body) => {
    const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(url === RPC_URL ? { result: { chain_id: 'testnet' } } : body));
    const chain = new TestnetNetwork(RPC_URL, fetcher); const account = vi.spyOn(chain, 'account').mockResolvedValue(null);
    await expect(chain.faucet('bb-0000000000000000.testnet', 'public-only')).rejects.toThrow('no successful account-creation outcome');
    expect(account).not.toHaveBeenCalled(); expect(delay).not.toHaveBeenCalled();
  });

  it('rejects faucet success when the account never appears after bounded finality polling', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(url === RPC_URL
      ? { result: { chain_id: 'testnet' } } : { status: { SuccessValue: '' } }));
    const chain = new TestnetNetwork(RPC_URL, fetcher); const account = vi.spyOn(chain, 'account').mockResolvedValue(null);
    await expect(chain.faucet('bb-0000000000000000.testnet', 'public-only')).rejects.toThrow('account absent at finality after 30 checks');
    expect(account).toHaveBeenCalledTimes(30); expect(account).toHaveBeenCalledWith('bb-0000000000000000.testnet');
    expect(delay).toHaveBeenCalledTimes(30); expect(delay).toHaveBeenCalledWith(1000);
  });

  it('waits for actual final account presence after a successful faucet response', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => Response.json(url === RPC_URL
      ? { result: { chain_id: 'testnet' } } : { status: { SuccessValue: '' } }));
    const chain = new TestnetNetwork(RPC_URL, fetcher);
    const account = vi.spyOn(chain, 'account').mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValue({ balance: 1n, keys: { public: true } });
    await expect(chain.faucet('bb-0000000000000000.testnet', 'public-only')).resolves.toBeUndefined();
    expect(account).toHaveBeenCalledTimes(3); expect(delay).toHaveBeenCalledTimes(2);
  });

  it('requires recovery FullAccess and successful setup transaction outcomes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: { chain_id: 'testnet' } }));
    const chain = new TestnetNetwork(RPC_URL, fetcher); const id = 'bb-0000000000000000.testnet';
    const recovery = KeyPair.fromRandom('ed25519'); const broker = KeyPair.fromRandom('ed25519');
    const state = { nonce: 1n, block_hash: baseEncode(new Uint8Array(32).fill(7)), block_height: 1 };
    const view = vi.spyOn(chain.provider, 'viewAccessKey').mockResolvedValue({ ...state,
      permission: { FunctionCall: { receiver_id: id, method_names: [], allowance: '1' } },
    });
    const send = vi.spyOn(chain.provider, 'sendTransactionUntil').mockResolvedValue({ status: { SuccessValue: '' } } as never);
    await expect(chain.addBroker(id, recovery.toString(), broker.getPublicKey().toString())).rejects.toThrow('Recovery full-access key missing');
    expect(send).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
    view.mockResolvedValue({ ...state, permission: 'FullAccess' });
    for (const result of [{ status: { Failure: {} } }, { status: 'Started' }, {}]) {
      send.mockResolvedValueOnce(result as never);
      await expect(chain.addBroker(id, recovery.toString(), broker.getPublicKey().toString())).rejects.toThrow('Fixture setup transaction did not succeed');
    }
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('signs only the intended setup actions with recovery key, explicit chain nonce, and repeated testnet attestation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: { chain_id: 'testnet' } }));
    const chain = new TestnetNetwork(RPC_URL, fetcher);
    const recovery = KeyPair.fromRandom('ed25519'); const broker = KeyPair.fromRandom('ed25519');
    const receiver = KeyPair.fromRandom('ed25519');
    const blockHash = baseEncode(new Uint8Array(32).fill(7));
    const view = vi.spyOn(chain.provider, 'viewAccessKey').mockResolvedValue({
      nonce: 9007199254740993n, permission: 'FullAccess', block_hash: blockHash, block_height: 1,
    });
    const send = vi.spyOn(chain.provider, 'sendTransactionUntil').mockResolvedValue({ status: { SuccessValue: '' } } as never);
    const id = 'bb-0000000000000000.testnet';
    await chain.addBroker(id, recovery.toString(), broker.getPublicKey().toString());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(view).toHaveBeenCalledWith({ accountId: id, publicKey: recovery.getPublicKey(), finalityQuery: { finality: 'final' } });
    const added = send.mock.calls[0]![0].transaction;
    expect(added.signerId).toBe(id); expect(added.receiverId).toBe(id);
    expect(added.publicKey.toString()).toBe(recovery.getPublicKey().toString());
    expect(added.nonce).toBe(9007199254740994n); expect(baseEncode(added.blockHash)).toBe(blockHash);
    expect(added.actions).toHaveLength(1);
    expect(added.actions[0]?.addKey?.publicKey.toString()).toBe(broker.getPublicKey().toString());
    expect(added.actions[0]?.addKey?.accessKey.permission.fullAccess).toBeDefined();
    expect(send.mock.calls[0]![1]).toBe('FINAL');
    await chain.createReceiver(id, recovery.toString(), `receiver-a.${id}`, receiver.getPublicKey().toString());
    expect(fetcher).toHaveBeenCalledTimes(4);
    const created = send.mock.calls[1]![0].transaction;
    expect(created.signerId).toBe(id); expect(created.receiverId).toBe(`receiver-a.${id}`);
    expect(created.actions).toHaveLength(3); expect(created.actions[0]?.createAccount).toBeDefined();
    expect(created.actions[1]?.transfer?.deposit).toBe(100000000000000000000000n);
    expect(created.actions[2]?.addKey?.publicKey.toString()).toBe(receiver.getPublicKey().toString());
    expect(created.actions[2]?.addKey?.accessKey.permission.fullAccess).toBeDefined();
    // A redirecting/compromised RPC changing identity blocks the broadcast.
    fetcher.mockResolvedValueOnce(Response.json({ result: { chain_id: 'testnet' } }));
    fetcher.mockResolvedValueOnce(Response.json({ result: { chain_id: 'mainnet' } }));
    await expect(chain.addBroker(id, recovery.toString(), broker.getPublicKey().toString())).rejects.toThrow('MAINNET_REFUSED');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(['mainnet', 'localnet', 'testnet-x', undefined])('refuses attested chain identity %s before hitting the faucet', async (chain_id) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ result: { chain_id } }));
    const chain = new TestnetNetwork(RPC_URL, fetcher);
    await expect(chain.faucet('bb-0000000000000000.testnet', 'public-only')).rejects.toThrow('MAINNET_REFUSED');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![0]).toBe(RPC_URL);
  });
  it('uses the researched faucet payload and reports exact HTTP status, not arbitrary server text', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => url === RPC_URL
      ? Response.json({ result: { chain_id: 'testnet' } }) : new Response('private-key-like-server-text', { status: 429 }));
    const chain = new TestnetNetwork(RPC_URL, fetcher);
    await expect(chain.faucet('bb-0000000000000000.testnet', 'public-only')).rejects.toThrow(`BLOCKED: faucet POST ${FAUCET_URL}: HTTP 429`);
    expect(fetcher.mock.calls[1]![0]).toBe(FAUCET_URL);
    const init = fetcher.mock.calls[1]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({ newAccountId: 'bb-0000000000000000.testnet', newAccountPublicKey: 'public-only' });
    expect(init.redirect).toBe('error');
  });
});
