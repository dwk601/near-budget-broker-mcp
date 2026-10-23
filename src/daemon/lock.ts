import { open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { BrokerError } from '../contracts/index.js';

/** Fail closed, including stale/unknown locks. Never steal a live dispatch lane.
 * After a crash an operator must verify the old process/container is dead before
 * deleting the lock. PID namespaces make automatic PID-liveness stealing unsafe. */
export async function exclusiveLock(path: string): Promise<() => Promise<void>> {
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${process.pid}\n`); await file.sync(); }
    catch (e) { await file.close(); await unlink(path); throw e; }
    let released = false;
    return async () => { if (!released) { released = true; await file.close(); await unlink(path); } };
  } catch { throw new BrokerError('BROKER_UNAVAILABLE', 'Exclusive custody lock unavailable'); }
}
