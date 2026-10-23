import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, chmod, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diagnosticReason, DaemonFailure } from '../../src/daemon/diagnostics.js';

// Preflight tests must prove a directory/FIFO-like input never reaches SQLite,
// not merely rely on SQLite rejecting it (or blocking forever opening a FIFO).
const mock = vi.hoisted(() => ({ database: vi.fn() }));
vi.mock('node:sqlite', () => ({ DatabaseSync: mock.database }));
import { exclusiveLock, custodyLockPath } from '../../src/daemon/lock.js';
beforeEach(() => { mock.database.mockImplementation(function () { return { exec: vi.fn(), close: vi.fn() }; }); });

async function refusal(path: string): Promise<unknown> {
  let release: (() => Promise<void>) | undefined;
  try { release = await exclusiveLock(path); return null; }
  catch (e) { return e; }
  finally { await release?.(); }
}
it('lock file permissions and ownership are checked BEFORE SQLite opens it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-lock-preflight-')); const path = join(dir, 'key.sqlite');
  try {
    await writeFile(path, '', { mode: 0o600 }); await chmod(path, 0o640);
    expect(await refusal(path)).toMatchObject({ reason: 'LOCK_UNAVAILABLE' }); expect(mock.database).not.toHaveBeenCalled();
    await chmod(path, 0o600);
    if (process.getuid) {
      const spy = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
      try { expect(await refusal(path)).toMatchObject({ reason: 'LOCK_UNAVAILABLE' }); expect(mock.database).not.toHaveBeenCalled(); }
      finally { spy.mockRestore(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('non-files and symlinks are refused before SQLite, even if the target has safe permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-lock-preflight-')); const target = join(dir, 'target'); const link = join(dir, 'link'); const directory = join(dir, 'directory');
  try {
    await writeFile(target, '', { mode: 0o600 }); await symlink(target, link);
    expect(await refusal(link)).toMatchObject({ reason: 'LOCK_UNAVAILABLE' }); expect(mock.database).not.toHaveBeenCalled();
    await mkdir(directory); await chmod(directory, 0o600);
    expect(await refusal(directory)).toMatchObject({ reason: 'LOCK_UNAVAILABLE' }); expect(mock.database).not.toHaveBeenCalled();
  } finally { await chmod(directory, 0o700).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});
it('stable per-user key directory is 0700, mode/owner checked, not silently repaired or followed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-key-directory-')); const keys = join(dir, 'keys');
  try {
    const path = custodyLockPath('ed25519:public-test-key', keys);
    expect(path).toMatch(/\/[a-f0-9]{64}\.sqlite$/); expect((await stat(keys)).mode & 0o777).toBe(0o700);
    expect(custodyLockPath('ed25519:public-test-key', keys)).toBe(path);
    await chmod(keys, 0o755); expect(() => custodyLockPath('key', keys)).toThrow(DaemonFailure); expect((await stat(keys)).mode & 0o777).toBe(0o755);
    await chmod(keys, 0o700);
    if (process.getuid) {
      const spy = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
      try { expect(() => custodyLockPath('key', keys)).toThrow(DaemonFailure); } finally { spy.mockRestore(); }
    }
    const link = join(dir, 'link'); await symlink(keys, link); expect(() => custodyLockPath('key', link)).toThrow(DaemonFailure);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it('diagnostics output accepts only exact allowlisted reason tokens, never stacks, paths, env dumps or fields', () => {
  for (const reason of ['BAD_CONFIG\n/secret/path', 'BAD_CONFIG\nError: stack\n at file', 'BAD_CONFIG '+JSON.stringify({ BB_DIAG_CANARY: 'env-value' }), '/tmp/value']) {
    const error = new DaemonFailure('BAD_CONFIG'); Object.defineProperty(error, 'reason', { value: reason });
    expect(diagnosticReason(error)).toBeUndefined();
  }
  expect(diagnosticReason(new DaemonFailure('BAD_CONFIG'))).toBe('BAD_CONFIG');
  expect(diagnosticReason({ reason: 'BAD_CONFIG' })).toBeUndefined();
});
