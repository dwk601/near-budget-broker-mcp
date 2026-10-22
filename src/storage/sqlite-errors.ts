import type { DatabaseSync } from 'node:sqlite';
import { BrokerError } from '../contracts/index.js';

/** SQLite extended result codes preserve the primary code in the low byte. */
export function storageError(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_SQLITE_ERROR') {
    const primary = 'errcode' in error && typeof error.errcode === 'number' ? error.errcode & 0xff : undefined;
    return primary === 19
      ? new BrokerError('FORBIDDEN', 'Storage constraint rejected mutation')
      : new BrokerError('BROKER_UNAVAILABLE', 'Storage unavailable');
  }
  return error;
}

export function rollbackQuietly(db: DatabaseSync): void {
  // SQLITE_FULL/IOERR can roll back automatically. Never replace the original
  // failure with "cannot rollback - no transaction is active".
  try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
}
