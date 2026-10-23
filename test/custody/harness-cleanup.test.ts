import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, lstat, rm, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { expect, it } from 'vitest';
import { Harness, build } from '../../scripts/demo/harness.js';
import { fakeRpc } from '../e2e/fake-rpc.js';

it('removes only its own exact key-lock database and sidecars after SIGKILL', async () => {
  await build();
  const rpc = await fakeRpc(); const dir = await mkdtemp(join(tmpdir(), 'bb-killed-lock-'));
  const h = new Harness({ rpcUrl: rpc.url, accountId: 'broker.testnet', receiver: 'receiver.testnet',
    envelope: join(dir, 'envelope'), master: join(dir, 'master') });
  let neighbor = '';
  try {
    const raw = join(dir, 'raw');
    await writeFile(raw, KeyPair.fromRandom('ed25519').toString(), { mode: 0o600 });
    await writeFile(h.options.master, randomBytes(32), { mode: 0o600 });
    await h.command(['init-custody', '--key-file', raw, '--master-file', h.options.master, '--out', h.options.envelope, '--json']);
    await h.init();
    neighbor = `${h.keyLockPath}-journal-unrelated`;
    await writeFile(neighbor, 'keep', { flag: 'wx', mode: 0o600 });
    expect((await lstat(`${h.keyLockPath}-journal`)).isFile()).toBe(true);
    // Same filesystem state as stop()'s SIGKILL fallback, without waiting 30s.
    const exited = once(h.child!, 'close'); h.child!.kill('SIGKILL'); await exited;
    // The lock currently uses DELETE journals; cover exact WAL/SHM cleanup too.
    for (const suffix of ['-wal', '-shm']) await writeFile(`${h.keyLockPath}${suffix}`, '', { flag: 'wx', mode: 0o600 });
    await h.close();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      await expect(lstat(`${h.keyLockPath}${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readFile(neighbor, 'utf8')).toBe('keep');
  } finally {
    await h.close(); await rpc.close();
    if (neighbor) {
      await unlink(neighbor);
      // Keep the mutation-test run clean even when the cleanup fix is reverted.
      // This random test key was created here and the daemon is already dead.
      for (const suffix of ['', '-journal', '-wal', '-shm']) await rm(`${h.keyLockPath}${suffix}`, { force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
