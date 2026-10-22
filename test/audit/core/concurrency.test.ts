import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AuditSigner, ReceiptLog } from '../../../src/audit/core/index.js';
import { SqliteStore } from '../../../src/storage/index.js';

function startWorker(filename: string, keyPath: string, prefix: string) {
  const child = fork(fileURLToPath(new URL('./append-worker.ts', import.meta.url)), [filename, keyPath, prefix, '60'], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Audit append worker failed (${code}/${signal}): ${stderr}`));
    });
  });
  // Attach a rejection handler immediately; initialization failures can happen
  // before the parent finishes awaiting the other worker's ready message.
  void done.catch(() => {});
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', (message) => message === 'ready' ? resolve() : reject(new Error('Unexpected worker message')));
    void done.then(() => reject(new Error('Worker exited before ready')), reject);
  });
  return { child, ready, done };
}

it('concurrent appends from independent connections keep one unique contiguous chain and survive reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-audit-concurrent-'));
  const filename = join(dir, 'audit.sqlite');
  const keyPath = join(dir, 'audit.pem');
  const signer = AuditSigner.generate(keyPath);
  // Initialize the schema before workers race admission, not migration.
  new SqliteStore(filename, { accountId: 'broker.testnet' }).close();
  const workers = [startWorker(filename, keyPath, 'left'), startWorker(filename, keyPath, 'right')];
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send('append');
    await Promise.all(workers.map((worker) => worker.done));
    const store = new SqliteStore(filename, { accountId: 'broker.testnet' });
    try {
      const log = new ReceiptLog(store, AuditSigner.load(keyPath));
      const receipts = log.list('agent:a1', 0, 1000);
      expect(receipts).toHaveLength(120);
      expect(receipts.map((r) => r.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
      expect(new Set(receipts.map((r) => r.hash)).size).toBe(120);
      const ids = receipts.map((r) => (r.payload as { requestId: string }).requestId).sort();
      expect(ids).toEqual(['left', 'right'].flatMap((side) => Array.from({ length: 60 }, (_, i) => `${side}-${i}`)).sort());
      expect(log.auditPublicKey()).toBe(signer.publicKey);
      expect(log.verify('agent:a1')).toEqual({ valid: true, chainId: 'agent:a1', checked: 120, firstInvalidSeq: null, reason: null });
    } finally { store.close(); }
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    }
    await Promise.allSettled(workers.map((worker) => worker.done));
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
