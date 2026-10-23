import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrokerError } from '../../src/contracts/index.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

// A writable export wrapper permits deterministic EACCES/EPERM injection even
// under a privileged test runner, without requiring chown or changing uid.
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }));
const dirs: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'bb-private-files-')); dirs.push(dir); return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function unavailable(path: string) {
  let caught: unknown;
  try { new SqliteStore(path, { accountId: 'broker.testnet' }).close(); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(BrokerError);
  expect(caught).toMatchObject({ code: 'BROKER_UNAVAILABLE', message: 'Storage unavailable' });
  expect(caught).not.toHaveProperty('cause');
  expect(caught).not.toHaveProperty('path');
  expect(caught).not.toHaveProperty('syscall');
  expect(String(caught) + JSON.stringify(caught)).not.toContain(path);
}

it('redacts a nonexistent parent (ENOENT) and directory database (EISDIR)', () => {
  const dir = temp();
  unavailable(join(dir, 'missing', 'sensitive.sqlite'));
  unavailable(dir);
});

it.each(['open', 'chmod', 'sidecar-open', 'sidecar-chmod'] as const)('redacts %s filesystem errors and closes opened descriptors', (stage) => {
  const path = join(temp(), 'sensitive.sqlite');
  if (stage.startsWith('sidecar')) fs.writeFileSync(`${path}-wal`, '', { mode: 0o600 });
  const code = stage.endsWith('chmod') ? 'EPERM' : 'EACCES';
  const error = Object.assign(new Error(`${code}: protected operator path ${path}`),
    { code, path, syscall: stage });
  const open = fs.openSync;
  const chmod = fs.fchmodSync;
  const opened: number[] = []; const closed: number[] = [];
  const close = fs.closeSync;
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => { closed.push(fd); close(fd); });
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (stage === 'open' || (stage === 'sidecar-open' && args[0] === `${path}-wal`)) throw error;
    const fd = open(...args); opened.push(fd); return fd;
  });
  let chmods = 0;
  vi.spyOn(fs, 'fchmodSync').mockImplementation((...args) => {
    chmods++;
    if (stage === 'chmod' || (stage === 'sidecar-chmod' && chmods === 2)) throw error;
    chmod(...args);
  });
  unavailable(path);
  expect(closed).toEqual(opened);
});

for (const suffix of ['', '-wal', '-shm']) {
  it(`refuses a ${suffix || 'database'} symlink without changing its target`, () => {
    const dir = temp(); const path = join(dir, 'broker.sqlite'); const victim = join(dir, 'victim');
    fs.writeFileSync(victim, 'not broker data', { mode: 0o644 });
    fs.symlinkSync(victim, `${path}${suffix}`);
    const before = fs.statSync(victim);
    unavailable(path);
    const after = fs.statSync(victim);
    expect(after.mode & 0o777).toBe(0o644);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(victim, 'utf8')).toBe('not broker data');
    expect(fs.lstatSync(`${path}${suffix}`).isSymbolicLink()).toBe(true);
  });
  it(`refuses a dangling ${suffix || 'database'} symlink without creating its target`, () => {
    const dir = temp(); const path = join(dir, 'broker.sqlite'); const missing = join(dir, 'missing');
    fs.symlinkSync(missing, `${path}${suffix}`);
    unavailable(path);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.lstatSync(`${path}${suffix}`).isSymbolicLink()).toBe(true);
  });
}

it.each(['-wal', '-shm'])('refuses a %s sidecar replaced by a symlink between lstat and open', (suffix) => {
  const dir = temp(); const path = join(dir, 'broker.sqlite'); const victim = join(dir, 'victim');
  fs.writeFileSync(victim, 'untouched', { mode: 0o644 });
  fs.writeFileSync(`${path}${suffix}`, '', { mode: 0o600 });
  const lstat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = lstat(...args);
    if (args[0] === `${path}${suffix}`) {
      fs.unlinkSync(`${path}${suffix}`); fs.symlinkSync(victim, `${path}${suffix}`);
    }
    return stat;
  }) as typeof fs.lstatSync);
  unavailable(path);
  expect(fs.statSync(victim).mode & 0o777).toBe(0o644);
  expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
});
