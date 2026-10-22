import { SqliteStore } from '../../src/storage/index.js';
import { ACCOUNT, NOW, request } from './fixtures.js';

// A real separate process/connection competes for the file's SQLite writer lock.
const filename = process.argv[2];
const prefix = process.argv[3];
if (!filename || !prefix) throw new Error('Missing worker arguments');
const store = new SqliteStore(filename, { accountId: ACCOUNT, busyTimeoutMs: 10_000 });
process.send?.('ready');
process.once('message', () => {
  try {
    let accepted = 0;
    for (let i = 0; i < 30; i++) {
      store.withImmediateTransaction((tx) => {
        const usage = tx.getUsageSnapshot('a', NOW);
        if (usage.agentLifetime + 1n > 10n) return;
        // Widen the interprocess race at the exact read/write boundary. This
        // small test-only delay would oversubscribe a deferred/non-atomic path.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        const r = request(`${prefix}-${i}`, 'a', 1n);
        tx.insertRequest(r);
        tx.putHold({ requestId: r.id, agentId: 'a', principal: 1n, feeReserve: 0n, status: 'active' });
        accepted++;
      });
    }
    process.send?.({ accepted });
  } finally {
    store.close();
    process.disconnect();
  }
});
