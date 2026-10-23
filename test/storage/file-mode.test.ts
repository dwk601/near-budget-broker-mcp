import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('creates and reopens the database and WAL/SHM with mode 0600 despite a loose umask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-storage-mode-'));
  try {
    // A child isolates umask from Vitest workers. Assert while connections are
    // live: closing the last connection normally removes WAL and SHM.
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { chmodSync, statSync } from 'node:fs';
      import { SqliteStore } from ${JSON.stringify(new URL('../../src/storage/sqlite-store.ts', import.meta.url).href)};
      process.umask(0);
      const path = ${JSON.stringify(join(dir, 'broker.sqlite'))};
      const files = [path, path + '-wal', path + '-shm'];
      const check = () => {
        for (const file of files) assert.equal(statSync(file).mode & 0o777, 0o600, file);
        assert.equal(process.umask(), 0, 'store must not change caller umask');
      };
      const first = new SqliteStore(path, { accountId: 'broker.testnet' });
      try {
        check();
        // Simulate files produced by a pre-fix deployment, including live WAL.
        for (const file of files) chmodSync(file, 0o644);
        const second = new SqliteStore(path, { accountId: 'broker.testnet' });
        try { check(); } finally { second.close(); }
      } finally { first.close(); }
      // SQLite recreates sidecars on reopen; the permissions must stay private.
      const reopened = new SqliteStore(path, { accountId: 'broker.testnet' });
      try { check(); } finally { reopened.close(); }
      console.log('private database and sidecars');
    `], { encoding: 'utf8', timeout: 20_000 });
    expect(output.trim()).toBe('private database and sidecars');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
