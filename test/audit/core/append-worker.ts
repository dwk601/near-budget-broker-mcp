// Separate process: synchronous SQLite connections must genuinely contend on the
// writer lock, rather than Promise.all serializing callbacks in one JS thread.
import { AuditSigner, ReceiptLog } from '../../../src/audit/core/index.js';
import { SqliteStore } from '../../../src/storage/index.js';

const [filename, keyPath, prefix, countText] = process.argv.slice(2);
if (!filename || !keyPath || !prefix || !countText || !process.send) throw new Error('Missing worker arguments/IPC');
const store = new SqliteStore(filename, { accountId: 'broker.testnet', busyTimeoutMs: 10_000 });
const log = new ReceiptLog(store, AuditSigner.load(keyPath));
process.once('message', () => {
  try {
    for (let i = 0; i < Number(countText); i++) {
      store.withImmediateTransaction((tx) => {
        log.append(tx, { chainId: 'agent:a1', type: 'queued', at: 1000 + i,
          payload: { agentId: 'a1', requestId: `${prefix}-${i}` } });
      });
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    store.close();
    process.disconnect();
  }
});
process.send('ready');
