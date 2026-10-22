// One append per IPC command. Both connections/logs remain alive between turns,
// so a log must observe the other writer's committed head, not a cached head.
import { AuditSigner, ReceiptLog } from '../../../src/audit/core/index.js';
import { SqliteStore } from '../../../src/storage/index.js';

const [filename, keyPath, prefix] = process.argv.slice(2);
if (!filename || !keyPath || !prefix || !process.send) throw new Error('Missing worker arguments/IPC');
const store = new SqliteStore(filename, { accountId: 'broker.testnet', busyTimeoutMs: 10_000 });
const log = new ReceiptLog(store, AuditSigner.load(keyPath));
let index = 0;
process.on('message', (command) => {
  try {
    if (command === 'stop') {
      store.close();
      process.disconnect();
      return;
    }
    if (command !== 'append') throw new Error('Unexpected append command');
    store.withImmediateTransaction((tx) => {
      log.append(tx, { chainId: 'agent:a1', type: 'queued', at: 1000 + index,
        payload: { agentId: 'a1', requestId: `${prefix}-${index}` } });
    });
    index++;
    process.send!('appended');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    store.close();
    process.disconnect();
  }
});
process.send('ready');
