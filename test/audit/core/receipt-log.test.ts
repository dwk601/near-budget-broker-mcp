import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditSigner, ReceiptLog, verifyReceipt, verifyReceiptChain } from '../../../src/audit/core/index.js';
import {
  GENESIS_PREV_HASH, ReceiptVerificationSchema, receiptHashInput, sha256Hex,
} from '../../../src/contracts/index.js';
import type { AppendReceipt, AuditSigner as SignerPort, ReceiptEvent, ReceiptPreimage, Store } from '../../../src/contracts/index.js';
import { SqliteStore } from '../../../src/storage/index.js';

const stores: SqliteStore[] = [];
const dirs: string[] = [];
function setup(file = false): { store: SqliteStore; signer: AuditSigner; log: ReceiptLog; filename: string } {
  let filename = ':memory:';
  if (file) {
    const dir = mkdtempSync(join(tmpdir(), 'bb-receipts-')); dirs.push(dir);
    filename = join(dir, 'audit.sqlite');
  }
  const store = new SqliteStore(filename, { accountId: 'broker.testnet' }); stores.push(store);
  const signer = AuditSigner.generate();
  return { store, signer, log: new ReceiptLog(store, signer), filename };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const queued = (agentId = 'a1', requestId = 'r1'): AppendReceipt => ({
  chainId: `agent:${agentId}`, type: 'queued', at: 1_700_000_000_000, payload: { requestId, agentId },
});
const principal = (agentId = 'a1') => ({ kind: 'agent' as const, agentId, credentialId: `credential-${agentId}` });
function signPreimage(preimage: ReceiptPreimage, signer: AuditSigner): ReceiptEvent {
  const hash = sha256Hex(receiptHashInput(preimage));
  return { ...preimage, hash, signature: Buffer.from(signer.signHash(Buffer.from(hash, 'hex'))).toString('base64') };
}

describe('transactional receipt log', () => {
  it('links independent agent and owner chains with canonical hashes and signatures', () => {
    const { log, store, signer } = setup();
    const receipts = store.withImmediateTransaction((tx) => [
      log.append(tx, queued()), log.append(tx, queued('a2')),
      log.append(tx, { chainId: 'owner', type: 'freeze', at: 2, payload: { scope: 'global', frozen: true, reason: 'kill', at: 2 } }),
      log.append(tx, queued('a1', 'r2')), log.append(tx, queued('a2', 'r2')),
    ]);
    const [a1, a2, owner, a1next, a2next] = receipts;
    for (const first of [a1!, a2!, owner!]) {
      expect(first.seq).toBe(1);
      expect(first.prevHash).toBe(GENESIS_PREV_HASH);
      expect(log.verifyReceipt(first)).toEqual({ valid: true, chainId: first.chainId, checked: 1, firstInvalidSeq: null, reason: null });
    }
    expect(a1next!.seq).toBe(2); expect(a1next!.prevHash).toBe(a1!.hash);
    expect(a2next!.seq).toBe(2); expect(a2next!.prevHash).toBe(a2!.hash);
    expect(log.verifyReceipt(a1next!).valid).toBe(true);
    expect(log.verifyReceipt(a2next!).valid).toBe(true);
    expect(a1!.hash).not.toBe(a2!.hash);
    const { hash, signature: _signature, ...preimage } = a1!;
    expect(hash).toBe(sha256Hex(receiptHashInput(preimage)));
    expect(hash).toBe('b2fd75c157db050b925cb115bf2441b10786f715b07579f055751e7a64a9047f');
    expect(log.auditPublicKey()).toBe(signer.publicKey);
    for (const chain of ['agent:a1', 'agent:a2', 'owner']) {
      const verification = log.verify(chain);
      expect(verification.valid).toBe(true);
      expect(verification.checked).toBe(chain === 'owner' ? 1 : 2);
      expect(ReceiptVerificationSchema.parse(verification)).toEqual(verification);
    }
    expect(log.verify('agent:empty')).toEqual({ valid: true, chainId: 'agent:empty', checked: 0, firstInvalidSeq: null, reason: null });
  });

  it('paginates only the selected chain and validates sequence cursors/limits', () => {
    const { store, log } = setup();
    store.withImmediateTransaction((tx) => { for (let i = 0; i < 5; i++) { log.append(tx, queued('a1', `r${i}`)); log.append(tx, queued('a2', `r${i}`)); } });
    expect(log.list('agent:a1', 0, 2).map((r) => r.seq)).toEqual([1, 2]);
    expect(log.list('agent:a1', 2, 2).map((r) => r.seq)).toEqual([3, 4]);
    expect(log.list('agent:a1', 4, 2).map((r) => r.seq)).toEqual([5]);
    expect(log.list('agent:a1', 5, 2)).toEqual([]);
    for (const [afterSeq, limit] of [[-1, 1], [0.5, 1], [NaN, 1], [Number.MAX_SAFE_INTEGER + 1, 1], [0, 0], [0, 1001], [0, 1.5]]) {
      expect(() => log.list('agent:a1', afterSeq!, limit!)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
  });

  it('agent-scoped list/chain verification/single verification cannot access another agent or owner', () => {
    const { store, log } = setup();
    const [own, other, owner] = store.withImmediateTransaction((tx) => [
      log.append(tx, queued()), log.append(tx, queued('a2')),
      log.append(tx, { ...queued(), chainId: 'owner' }),
    ]);
    const scoped = log.forAgent(principal());
    expect(scoped.list('agent:a1', 0, 100)).toEqual([own]);
    expect(scoped.verify('agent:a1').valid).toBe(true);
    expect(scoped.verifyReceipt(own!).valid).toBe(true);
    const read = vi.spyOn(store, 'read'); read.mockClear();
    for (const receipt of [other!, owner!]) {
      expect(() => scoped.list(receipt.chainId, 0, 100)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      expect(() => scoped.verify(receipt.chainId)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      expect(() => scoped.verifyReceipt(receipt)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
    expect(() => scoped.list('agent:nonexistent', 0, 100)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => scoped.forAgent(principal('a2'))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(read).not.toHaveBeenCalled();
    // Relabelling another agent's receipt does not make it a valid own receipt.
    expect(scoped.verifyReceipt({ ...other!, chainId: 'agent:a1' }).valid).toBe(false);
    expect(() => store.withImmediateTransaction((tx) => scoped.append(tx, queued('a2')))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('rolls back receipts and state on caller abort; retry starts at the unchanged head', () => {
    const { store, log } = setup();
    const first = store.withImmediateTransaction((tx) => log.append(tx, queued()));
    expect(() => store.withImmediateTransaction((tx) => {
      tx.putAgent({ id: 'temp', name: 'not committed', status: 'active', createdAt: 1 });
      log.append(tx, queued('a1', 'discarded'));
      log.append(tx, { ...queued(), chainId: 'owner' });
      throw new Error('abort caller transaction');
    })).toThrow('abort caller transaction');
    expect(store.read((view) => view.getAgent('temp'))).toBeNull();
    expect(log.list('agent:a1', 0, 100)).toEqual([first]);
    expect(log.list('owner', 0, 100)).toEqual([]);
    const next = store.withImmediateTransaction((tx) => log.append(tx, queued('a1', 'committed')));
    expect(next.seq).toBe(2); expect(next.prevHash).toBe(first.hash);
  });

  it.each(['sign throws', 'bad signature', 'wrong key', 'async signer', 'write throws', 'write then throws', 'head throws'])('audit failure aborts state and receipts: %s', (failure) => {
    const { store, signer } = setup();
    const faulty: SignerPort = { publicKey: signer.publicKey, signHash: (hash) => signer.signHash(hash) };
    if (failure === 'sign throws') faulty.signHash = () => { throw new Error('secret diagnostic'); };
    if (failure === 'bad signature') faulty.signHash = () => new Uint8Array(64);
    if (failure === 'wrong key') faulty.signHash = (hash) => AuditSigner.generate().signHash(hash);
    if (failure === 'async signer') faulty.signHash = (() => Promise.resolve(new Uint8Array(64))) as unknown as SignerPort['signHash'];
    const log = new ReceiptLog(store, faulty);
    expect(() => store.withImmediateTransaction((tx) => {
      tx.putAgent({ id: 'a1', name: 'rollback', status: 'active', createdAt: 1 });
      if (failure === 'head throws') vi.spyOn(tx, 'getReceiptHead').mockImplementation(() => { throw new Error('read failed'); });
      if (failure === 'write throws' || failure === 'write then throws') {
        const insert = tx.insertReceipt.bind(tx);
        vi.spyOn(tx, 'insertReceipt').mockImplementation((receipt) => {
          if (failure === 'write then throws') insert(receipt);
          throw new Error('write failed');
        });
      }
      log.append(tx, queued());
      throw new Error('audit failure was swallowed');
    })).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE', message: 'AUDIT_UNAVAILABLE' }));
    expect(store.read((view) => view.getAgent('a1'))).toBeNull();
    expect(log.list('agent:a1', 0, 100)).toEqual([]);
  });
});

describe('tamper detection and independent exports', () => {
  it('detects payload mutation, recomputed hash without signature, signature mutation and wrong trusted key', () => {
    const { store, log, signer } = setup();
    const receipt = store.withImmediateTransaction((tx) => log.append(tx, queued()));
    const changed = { ...receipt, at: receipt.at + 1 };
    expect(log.verifyReceipt(changed).valid).toBe(false);
    const payloadChanged = { ...receipt, payload: { requestId: 'changed', agentId: 'a1' } } as ReceiptEvent;
    expect(log.verifyReceipt(payloadChanged).valid).toBe(false);
    const { hash: _hash, signature: _signature, ...preimage } = payloadChanged;
    expect(log.verifyReceipt({ ...payloadChanged, hash: sha256Hex(receiptHashInput(preimage)) }).valid).toBe(false);
    expect(log.verifyReceipt({ ...receipt, signature: Buffer.alloc(64).toString('base64') }).valid).toBe(false);
    expect(log.verifyReceipt({ ...receipt, signature: receipt.signature + '\n' }).valid).toBe(false);
    expect(verifyReceipt(receipt, signer.publicKey + '\n').valid).toBe(false);
    expect(verifyReceipt(receipt, AuditSigner.generate().publicKey).valid).toBe(false);
    expect(verifyReceipt(receipt, 'ed25519:' + '1'.repeat(33)).valid).toBe(false);
    expect(verifyReceiptChain([receipt], 'agent:a1', AuditSigner.generate().publicKey).valid).toBe(false);
    expect(verifyReceiptChain([receipt], 'agent:a1', signer.publicKey).valid).toBe(true);
  });

  it('rejects validly signed reordering, gaps, deleted middle, duplicates and cross-chain substitutions', () => {
    const { store, log, signer } = setup();
    const receipts = store.withImmediateTransaction((tx) => [log.append(tx, queued()), log.append(tx, queued('a1', 'r2')), log.append(tx, queued('a1', 'r3'))]);
    const verify = (items: ReceiptEvent[]) => verifyReceiptChain(items, 'agent:a1', signer.publicKey);
    expect(verify(receipts)).toEqual({ valid: true, chainId: 'agent:a1', checked: 3, firstInvalidSeq: null, reason: null });
    for (const [items, seq] of [
      [[receipts[1]!, receipts[0]!, receipts[2]!], 1],
      [[receipts[0]!, receipts[2]!], 2],
      [[receipts[0]!, receipts[1]!, receipts[1]!], 3],
    ] as const) {
      expect(verify([...items])).toMatchObject({ valid: false, firstInvalidSeq: seq });
    }
    const { hash: _hash, signature: _signature, ...preimage } = receipts[1]!;
    // Even correct signatures cannot excuse missing sequence or broken linkage.
    const gap = signPreimage({ ...preimage, seq: 3 }, signer);
    const fork = signPreimage({ ...preimage, prevHash: 'f'.repeat(64) }, signer);
    expect(verify([receipts[0]!, gap])).toMatchObject({ valid: false, firstInvalidSeq: 2 });
    expect(verify([receipts[0]!, fork])).toMatchObject({ valid: false, firstInvalidSeq: 2 });
    expect(log.verifyReceipt(gap)).toMatchObject({ valid: false, firstInvalidSeq: 3 });
    expect(log.verifyReceipt(fork)).toMatchObject({ valid: false, firstInvalidSeq: 2 });
    const other = store.withImmediateTransaction((tx) => log.append(tx, queued('a2')));
    expect(verify([other])).toMatchObject({ valid: false, firstInvalidSeq: 1 });
    const badGenesis = signPreimage({ ...preimage, seq: 1, prevHash: 'f'.repeat(64) }, signer);
    expect(log.verifyReceipt(badGenesis).valid).toBe(false);
    expect(verify([badGenesis])).toMatchObject({ valid: false, firstInvalidSeq: 1 });
  });

  it.each(['payload', 'deleted middle', 'bad signature', 'malformed payload'])('live verification detects stored corruption: %s', (mutation) => {
    const { store, log, filename } = setup(true);
    const receipts = store.withImmediateTransaction((tx) => [log.append(tx, queued()), log.append(tx, queued('a1', 'r2')), log.append(tx, queued('a1', 'r3'))]);
    const db = new DatabaseSync(filename);
    try {
      if (mutation === 'deleted middle') db.prepare('DELETE FROM receipts WHERE chain_id = ? AND seq = 2').run('agent:a1');
      else {
        const changed = structuredClone(receipts[1]!) as unknown as Record<string, unknown>;
        if (mutation === 'payload') changed['payload'] = { agentId: 'a1', requestId: 'changed' };
        if (mutation === 'bad signature') changed['signature'] = Buffer.alloc(64).toString('base64');
        if (mutation === 'malformed payload') changed['payload'] = { agentId: 'a1', requestId: 'r2', token: 'do not accept extras' };
        db.prepare('UPDATE receipts SET data = ? WHERE chain_id = ? AND seq = 2').run(JSON.stringify(changed), 'agent:a1');
      }
    } finally { db.close(); }
    expect(log.verify('agent:a1')).toMatchObject({ valid: false, checked: 1, firstInvalidSeq: 2 });
    expect(log.verifyReceipt(receipts[2]!).valid).toBe(false);
  });

  it('does not extend an invalid signed head or silently change keys on restart', () => {
    const { store, log } = setup();
    store.withImmediateTransaction((tx) => log.append(tx, queued()));
    const wrongKeyLog = new ReceiptLog(store, AuditSigner.generate());
    expect(wrongKeyLog.verify('agent:a1').valid).toBe(false);
    expect(() => store.withImmediateTransaction((tx) => wrongKeyLog.append(tx, queued()))).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(log.list('agent:a1', 0, 100)).toHaveLength(1);
  });

  it('verifies across page boundaries in one read snapshot', () => {
    const { store, log } = setup();
    store.withImmediateTransaction((tx) => { for (let i = 0; i < 1003; i++) log.append(tx, queued('a1', `r${i}`)); });
    const read = vi.spyOn(store, 'read');
    expect(log.verify('agent:a1')).toMatchObject({ valid: true, checked: 1003 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(log.list('agent:a1', 1000, 1000).map((r) => r.seq)).toEqual([1001, 1002, 1003]);
  });

  it('reports iterator/storage corruption without claiming the scanned prefix is the whole chain', () => {
    const { store, log, signer } = setup();
    const receipt = store.withImmediateTransaction((tx) => log.append(tx, queued()));
    function* broken(): Generator<ReceiptEvent> { yield receipt; throw new Error('unreadable tail'); }
    expect(verifyReceiptChain(broken(), 'agent:a1', signer.publicKey)).toMatchObject({ valid: false, checked: 1, firstInvalidSeq: 2 });
    const brokenStore = { read: (cb: Parameters<Store['read']>[0]) => store.read((view) => cb(new Proxy(view, {
      get(target, property) {
        if (property === 'listReceipts') return () => { throw new Error('unreadable'); };
        return Reflect.get(target, property);
      },
    }))) } as Store;
    expect(new ReceiptLog(brokenStore, signer).verify('agent:a1')).toMatchObject({ valid: false, checked: 0, firstInvalidSeq: 1 });
  });
});
