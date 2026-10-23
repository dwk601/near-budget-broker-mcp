import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, fchmodSync, lstatSync, mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../contracts/index.js';
import { DaemonFailure } from './diagnostics.js';

/** A separate rollback-journal SQLite database holds an EXCLUSIVE kernel lock.
 * The connection/transaction lives for the daemon lifetime; SIGKILL automatically
 * releases the OS locks. The file is deliberately retained, NEVER unlinked.
 * The containing directory is private (0700). Host/root control is outside
 * this boundary. Never open/close unrelated raw fds on a held lock inode. */
export function custodyLockPath(publicKey: string, directory?: string): string {
  try {
    directory ??= join(userInfo().homedir, '.budget-broker-locks');
    // mkdir is exclusive; existing insecure directories are REFUSED, not repaired.
    // userInfo uses the OS account database, not attacker-selected HOME/TMPDIR.
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (e) { if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') throw e; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    return join(directory, `${sha256Hex(publicKey)}.sqlite`);
  } catch { throw new DaemonFailure('LOCK_UNAVAILABLE'); }
}

export async function exclusiveLock(path: string): Promise<() => Promise<void>> {
  let db: DatabaseSync | undefined;
  try {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    } catch (e) {
      if (!e || typeof e !== 'object' || !('code' in e) || e.code !== 'EEXIST') throw e;
    }
    // Never open/close an extra raw fd on an already locked inode: POSIX would
    // release this process's advisory locks when that unrelated fd closes.
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
    let released = false;
    const held = db;
    return async () => {
      if (released) return;
      released = true;
      try { held.exec('ROLLBACK'); } finally { held.close(); }
    };
  } catch (e) {
    try { db?.close(); } catch { /* preserve failure */ }
    const busy = e !== null && typeof e === 'object' && 'errcode' in e && (e.errcode === 5 || e.errcode === 6);
    throw new DaemonFailure(busy ? 'LOCK_HELD' : 'LOCK_UNAVAILABLE');
  }
}
