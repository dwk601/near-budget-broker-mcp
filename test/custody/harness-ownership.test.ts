import * as processes from 'node:child_process';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Harness } from '../../scripts/demo/harness.js';

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>() }));

it.each(['-journal', '-wal', '-shm'])('does not claim a new key-lock DB when %s already exists', async (suffix) => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-lock-ownership-'));
  const path = join(dir, 'key.sqlite'); const sidecar = `${path}${suffix}`;
  const h = new Harness({ rpcUrl: '', accountId: '', receiver: '', envelope: '', master: '' });
  h.keyLockPath = path;
  const child = { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null };
  try {
    await writeFile(sidecar, 'pre-existing operator file', { mode: 0o600 });
    const before = await lstat(sidecar);
    // Only process creation is faked; exercise the real asynchronous start/claim
    // and close paths. SQLite itself may remove recovery sidecars, so keep it out
    // of this ownership test and verify that the harness never deletes them.
    vi.spyOn(processes, 'spawn').mockImplementationOnce(() => {
      writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
      queueMicrotask(() => child.stderr.write('daemon: ready\n'));
      return child as unknown as processes.ChildProcess;
    });
    await h.start();
    child.exitCode = 0;
    await h.close();
    expect((await lstat(path)).isFile()).toBe(true);
    expect((await lstat(sidecar)).ino).toBe(before.ino);
    expect(await readFile(sidecar, 'utf8')).toBe('pre-existing operator file');
  } finally {
    child.exitCode = 0;
    await h.close();
    child.stdout.destroy(); child.stderr.destroy();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
