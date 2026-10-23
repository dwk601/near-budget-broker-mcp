import { DatabaseSync } from 'node:sqlite';
import { constants, openSync, closeSync, fchmodSync, lstatSync } from 'node:fs';
import { DaemonFailure } from './diagnostics.js';

/** A separate rollback-journal SQLite database holds an EXCLUSIVE kernel lock.
 * The connection/transaction lives for the daemon lifetime; SIGKILL automatically
 * releases the OS locks. The file is deliberately retained, NEVER unlinked.
 * The containing data directory is private (0700) and must be shared by every
 * deployment of this custody key. Host/root control is outside this boundary. */
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
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error();
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
