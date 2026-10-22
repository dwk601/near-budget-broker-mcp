import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AuditSigner, ReceiptLog } from '../../../src/audit/core/index.js';
import { SqliteStore } from '../../../src/storage/index.js';

function startWorker(filename: string, keyPath: string, prefix: string) {
  const child = fork(fileURLToPath(new URL('./append-worker.ts', import.meta.url)), [filename, keyPath, prefix], {
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
  function append(): Promise<void> {
    return new Promise((resolve, reject) => {
      child.once('message', (message) => message === 'appended' ? resolve() : reject(new Error('Unexpected append result')));
      void done.then(() => reject(new Error('Worker exited before append')), reject);
      child.send('append', (error) => { if (error) reject(error); });
    });
  }
  return { child, ready, done, append };
}

it('interleaved appends from two live independent connections remain unique, contiguous and durable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bb-audit-concurrent-'));
  const filename = join(dir, 'audit.sqlite');
  const keyPath = join(dir, 'audit.pem');
  const signer = AuditSigner.generate(keyPath);
  // Initialize the schema before workers race admission, not migration.
  new SqliteStore(filename, { accountId: 'broker.testnet' }).close();
  const workers = [startWorker(filename, keyPath, 'left'), startWorker(filename, keyPath, 'right')];
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    // Explicit turns avoid a vacuous all-left-then-all-right schedule. Each
    // process keeps its ReceiptLog alive while the other commits between calls.
    for (let round = 0; round < 60; round++) {
      for (const worker of workers) await worker.append();
    }
    for (const worker of workers) worker.child.send('stop');
    await Promise.all(workers.map((worker) => worker.done));
    const store = new SqliteStore(filename, { accountId: 'broker.testnet' });
    try {
      const log = new ReceiptLog(store, AuditSigner.load(keyPath));
      const receipts = log.list('agent:a1', 0, 1000);
      expect(receipts).toHaveLength(120);
      expect(receipts.map((r) => r.seq)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
      expect(new Set(receipts.map((r) => r.hash)).size).toBe(120);
      const ids = receipts.map((r) => (r.payload as { requestId: string }).requestId);
      expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => [`left-${i}`, `right-${i}`]).flat());
      const sides = ids.map((id) => id.split('-')[0]);
      expect(sides.slice(1).filter((side, i) => side !== sides[i])).toHaveLength(119);
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
