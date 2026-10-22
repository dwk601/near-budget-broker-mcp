import { verify as nodeVerify } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BrokerError, CheckpointVerificationSchema, GENESIS_PREV_HASH, checkpointHashInput, sha256Hex,
} from '../../../src/contracts/index.js';
import type { AuditSigner, Checkpoint, CheckpointPreimage, ReceiptEvent } from '../../../src/contracts/index.js';
import { CheckpointLog, exportReceiptChain, verifyCheckpoints, verifyExportedChain } from '../../../src/audit/checkpoints/index.js';
import { SqliteStore } from '../../../src/storage/index.js';
import { appendReceipt, clock, signCheckpoint, signReceipt, testSigner } from './fixtures.js';

const stores: SqliteStore[] = [];
const directories: string[] = [];
function database(filename = ':memory:'): SqliteStore {
  const store = new SqliteStore(filename, { accountId: 'custody.testnet' });
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const store = database();
  const signer = testSigner();
  const log = new CheckpointLog(store, signer);
  const first = store.withImmediateTransaction((tx) => {
    appendReceipt(tx, signer);
    return log.create(tx, 'agent:a', clock.now());
  });
  const second = store.withImmediateTransaction((tx) => {
    appendReceipt(tx, signer, 'agent:a', 'r2');
    appendReceipt(tx, signer, 'agent:a', 'r3');
    return log.create(tx, 'agent:a', clock.now() + 1);
  });
  return { store, signer, log, first, second };
}
function preimage(checkpoint: Checkpoint, changes: Partial<CheckpointPreimage> = {}): CheckpointPreimage {
  const { hash: _hash, signature: _signature, ...body } = checkpoint;
  return { ...body, ...changes };
}
function expectInvalid(value: ReturnType<typeof verifyCheckpoints>, seq?: number) {
  expect(CheckpointVerificationSchema.safeParse(value).success).toBe(true);
  expect(value.valid).toBe(false);
  expect(value.reason).toEqual(expect.any(String));
  if (seq !== undefined) expect(value.firstInvalidSeq).toBe(seq);
}

describe('transactional checkpoints', () => {
  test('signs canonical checkpoint hash bytes and lists exclusive increasing receipt sequences', () => {
    const { store, signer, log, first, second } = fixture();
    expect(first).toMatchObject({ version: 1, chainId: 'agent:a', seq: 1, previousCheckpointHash: null,
      at: clock.now(), auditPublicKey: signer.publicKey });
    expect(second).toMatchObject({ seq: 3, previousCheckpointHash: first.hash, at: clock.now() + 1 });
    expect(second.headHash).toBe(store.read((view) => view.getReceiptHead('agent:a'))?.hash);
    expect(second.hash).toBe(sha256Hex(checkpointHashInput(preimage(second))));
    expect(signer.signHash).toHaveBeenLastCalledWith(Buffer.from(second.hash, 'hex'));
    expect(nodeVerify(null, Buffer.from(second.hash, 'hex'), signer.nodePublicKey, Buffer.from(second.signature, 'base64'))).toBe(true);
    expect(nodeVerify(null, Buffer.from(second.hash, 'utf8'), signer.nodePublicKey, Buffer.from(second.signature, 'base64'))).toBe(false);
    expect(log.list('agent:a', 0, 1)).toEqual([first]);
    expect(log.list('agent:a', 1, 1)).toEqual([second]);
    expect(log.list('agent:a', 2, 1000)).toEqual([second]);
    expect(log.list('agent:a', 3, 1)).toEqual([]);
    expect(log.list('owner', 0, 10)).toEqual([]);
    expect(log.verify([first, second], signer.publicKey)).toEqual({ valid: true, chainId: 'agent:a', checked: 2, firstInvalidSeq: null, reason: null });
    expectInvalid(log.verify([first, second], testSigner().publicKey));
  });

  test('owner and agent chains have independent checkpoint ancestry', () => {
    const { store, signer, log, first } = fixture();
    const owner = store.withImmediateTransaction((tx) => {
      appendReceipt(tx, signer, 'owner');
      return log.create(tx, 'owner', clock.now());
    });
    expect(owner.previousCheckpointHash).toBeNull();
    expect(log.list('owner', 0, 10)).toEqual([owner]);
    expect(log.verify([owner], signer.publicKey).valid).toBe(true);
    expectInvalid(log.verify([first, owner], signer.publicKey), owner.seq);
  });

  test('rejects an empty chain, a duplicate head and invalid create/list inputs', () => {
    const store = database();
    const signer = testSigner();
    const log = new CheckpointLog(store, signer);
    expect(() => store.withImmediateTransaction((tx) => log.create(tx, 'owner', clock.now()))).toThrowError(new BrokerError('AUDIT_UNAVAILABLE'));
    expect(signer.signHash).not.toHaveBeenCalled();
    const first = store.withImmediateTransaction((tx) => {
      appendReceipt(tx, signer);
      return log.create(tx, 'agent:a', clock.now());
    });
    vi.mocked(signer.signHash).mockClear();
    expect(() => store.withImmediateTransaction((tx) => log.create(tx, 'agent:a', clock.now() + 5))).toThrowError(new BrokerError('AUDIT_UNAVAILABLE'));
    expect(signer.signHash).not.toHaveBeenCalled();
    expect(log.list('agent:a', 0, 10)).toEqual([first]);
    for (const time of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => store.withImmediateTransaction((tx) => log.create(tx, 'agent:a', time))).toThrowError(new BrokerError('AUDIT_UNAVAILABLE'));
    }
    expect(() => log.list('bad-chain', 0, 10)).toThrow();
    for (const [after, limit] of [[-1, 1], [0.5, 1], [0, 0], [0, 1001], [0, 1.5], [NaN, 1]]) {
      expect(() => log.list('agent:a', after!, limit!)).toThrow();
    }
  });

  test.each(['throw', 'short', 'wrong-key'] as const)('signer %s failure rolls back receipt and caller state', (failure) => {
    const store = database();
    const good = testSigner();
    const bad: AuditSigner = {
      publicKey: good.publicKey,
      signHash: failure === 'throw' ? () => { throw new Error('secret failure'); }
        : failure === 'short' ? () => new Uint8Array(63) : testSigner().signHash,
    };
    const log = new CheckpointLog(store, bad);
    expect(() => store.withImmediateTransaction((tx) => {
      tx.putAgent({ id: 'a', name: 'a', status: 'active', createdAt: clock.now() });
      appendReceipt(tx, good);
      log.create(tx, 'agent:a', clock.now());
    })).toThrowError(new BrokerError('AUDIT_UNAVAILABLE'));
    expect(store.read((view) => [view.getAgent('a'), view.getReceiptHead('agent:a'), view.getCheckpointHead('agent:a')])).toEqual([null, null, null]);
  });

  test('checkpoint insertion failure propagates and rolls back the whole caller transaction', () => {
    const store = database();
    const signer = testSigner();
    const log = new CheckpointLog(store, signer);
    expect(() => store.withImmediateTransaction((tx) => {
      appendReceipt(tx, signer);
      // Model storage failure at the injected port, not a nested transaction.
      vi.spyOn(tx, 'insertCheckpoint').mockImplementation(() => { throw new Error('disk failure'); });
      log.create(tx, 'agent:a', clock.now());
    })).toThrowError(new BrokerError('AUDIT_UNAVAILABLE'));
    expect(store.read((view) => view.getReceiptHead('agent:a'))).toBeNull();
    expect(log.list('agent:a', 0, 10)).toEqual([]);
  });

  test('successful create belongs to the caller transaction, not an independent commit', () => {
    const { store, log, signer, first } = fixture();
    expect(() => store.withImmediateTransaction((tx) => {
      appendReceipt(tx, signer);
      log.create(tx, 'agent:a', clock.now());
      throw new Error('caller aborted');
    })).toThrow('caller aborted');
    expect(log.list('agent:a', 0, 10)).toHaveLength(2);
    expect(exportReceiptChain(store, 'agent:a')).toHaveLength(3);
    expect(log.list('agent:a', 0, 1)).toEqual([first]);
  });

  test('storage CAS rejects stale checkpoint linkage and a mismatched receipt head', () => {
    const { store, signer, log, second } = fixture();
    store.withImmediateTransaction((tx) => appendReceipt(tx, signer));
    const head = store.read((view) => view.getReceiptHead('agent:a'))!;
    for (const changes of [{ previousCheckpointHash: null }, { headHash: 'f'.repeat(64) }]) {
      const candidate = signCheckpoint(signer, preimage(second, { seq: head.seq, headHash: head.hash, previousCheckpointHash: second.hash, ...changes }));
      expect(() => store.withImmediateTransaction((tx) => tx.insertCheckpoint(candidate))).toThrowError(new BrokerError('AUDIT_UNAVAILABLE'));
    }
    expect(log.list('agent:a', 0, 10)).toHaveLength(2);
  });
});

describe('trusted-key checkpoint verification', () => {
  test('rejects signed but broken ancestry, nonmonotonic seq and a partial checkpoint page', () => {
    const { log, signer, first, second } = fixture();
    const wrongLink = signCheckpoint(signer, preimage(second, { previousCheckpointHash: 'f'.repeat(64) }));
    expectInvalid(log.verify([first, wrongLink], signer.publicKey), 3);
    for (const seq of [1, 2]) {
      const backwards = signCheckpoint(signer, preimage(first, { seq, previousCheckpointHash: second.hash }));
      expectInvalid(log.verify([first, second, backwards], signer.publicKey), seq);
    }
    const crossChain = signCheckpoint(signer, preimage(second, { chainId: 'owner' }));
    expectInvalid(log.verify([first, crossChain], signer.publicKey), 3);
    expectInvalid(log.verify([second], signer.publicKey), 3);
    expectInvalid(log.verify([first, first], signer.publicKey), 1);
    expectInvalid(log.verify([], signer.publicKey));
  });

  test('rejects field/hash/signature tampering and attacker-supplied embedded key', () => {
    const { log, signer, first } = fixture();
    const attacker = testSigner();
    const forged = signCheckpoint(attacker, preimage(first, { auditPublicKey: attacker.publicKey }));
    expect(log.verify([forged], attacker.publicKey).valid).toBe(true);
    expectInvalid(log.verify([forged], signer.publicKey), 1);
    // Even a valid trusted-key signature must not mislabel its embedded key.
    const mislabeled = signCheckpoint(signer, preimage(first, { auditPublicKey: attacker.publicKey }));
    expectInvalid(log.verify([mislabeled], signer.publicKey), 1);
    const mutations = [
      { at: first.at + 1 }, { headHash: 'f'.repeat(64) }, { hash: 'f'.repeat(64) },
      { signature: Buffer.alloc(64).toString('base64') }, { signature: 'AQ==' },
      { auditPublicKey: attacker.publicKey }, { version: 2 }, { seq: 0 }, { extra: true },
    ];
    for (const mutation of mutations) {
      expectInvalid(log.verify([{ ...first, ...mutation } as Checkpoint], signer.publicKey));
    }
    // Shape-valid base58 can still decode to the wrong key length.
    expectInvalid(log.verify([first], `ed25519:${'z'.repeat(44)}`));
    expectInvalid(log.verify([first], 'not-a-key'));
    const nonPlain = Object.assign(Object.create({ inherited: true }) as Checkpoint, first);
    expectInvalid(log.verify([nonPlain], signer.publicKey), 1);
  });
});

describe('export verification with independently retained checkpoint', () => {
  test('round trips JSON and accepts valid extensions, including a retained non-first checkpoint', () => {
    const { store, log, signer, first, second } = fixture();
    store.withImmediateTransaction((tx) => appendReceipt(tx, signer));
    const exported = JSON.parse(JSON.stringify(exportReceiptChain(store, 'agent:a'))) as ReceiptEvent[];
    const retained = JSON.parse(JSON.stringify(second)) as Checkpoint;
    expect(verifyExportedChain(exported, retained, signer.publicKey)).toEqual({ valid: true, chainId: 'agent:a', checked: 4, firstInvalidSeq: null, reason: null });
    expect(verifyExportedChain(exported, first, signer.publicKey).valid).toBe(true);
    expect(log.verify([retained], signer.publicKey).valid).toBe(false); // Not the complete checkpoint history.
    expectInvalid(verifyExportedChain(exported, retained, testSigner().publicKey));
  });

  test('detects removed suffix, an empty export, omitted interior receipt and wrong chain', () => {
    const { store, signer, second } = fixture();
    const receipts = exportReceiptChain(store, 'agent:a');
    for (let end = 0; end < second.seq; end++) {
      expectInvalid(verifyExportedChain(receipts.slice(0, end), second, signer.publicKey), end + 1);
    }
    expectInvalid(verifyExportedChain([receipts[0]!, receipts[2]!], second, signer.publicKey), 2);
    expectInvalid(verifyExportedChain([...receipts].reverse(), second, signer.publicKey), 1);
    expectInvalid(verifyExportedChain([...receipts, receipts[2]!], second, signer.publicKey), 4);
    const owner = signReceipt(signer, { chainId: 'owner', seq: 1, prevHash: GENESIS_PREV_HASH, type: 'queued', at: clock.now(), payload: { requestId: 'r', agentId: 'a' } });
    expectInvalid(verifyExportedChain([owner], second, signer.publicKey), 1);
  });

  test('a valid signed fork and its locally valid replacement checkpoint fail the retained pin', () => {
    const { store, signer, first, second } = fixture();
    const forkStore = database();
    const forkLog = new CheckpointLog(forkStore, signer);
    const receipts = exportReceiptChain(store, 'agent:a');
    const forkCheckpoint = forkStore.withImmediateTransaction((tx) => {
      tx.insertReceipt(receipts[0]!);
      tx.insertCheckpoint(first);
      appendReceipt(tx, signer, 'agent:a', 'forked-r2');
      appendReceipt(tx, signer, 'agent:a', 'forked-r3');
      return forkLog.create(tx, 'agent:a', clock.now());
    });
    expect(forkLog.verify([first, forkCheckpoint], signer.publicKey).valid).toBe(true);
    const fork = exportReceiptChain(forkStore, 'agent:a');
    expect(verifyExportedChain(fork, forkCheckpoint, signer.publicKey).valid).toBe(true);
    expectInvalid(verifyExportedChain(fork, second, signer.publicKey), 3);
  });

  test('restoring and reopening an older DB looks locally valid but fails an external checkpoint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bb-checkpoints-'));
    directories.push(directory);
    const file = join(directory, 'live.sqlite');
    const backup = join(directory, 'old.sqlite');
    const signer = testSigner();
    const original = database(file);
    const originalLog = new CheckpointLog(original, signer);
    const first = original.withImmediateTransaction((tx) => {
      appendReceipt(tx, signer);
      return originalLog.create(tx, 'agent:a', clock.now());
    });
    original.close();
    cpSync(file, backup);
    const current = database(file);
    const currentLog = new CheckpointLog(current, signer);
    const retained = current.withImmediateTransaction((tx) => {
      appendReceipt(tx, signer);
      return currentLog.create(tx, 'agent:a', clock.now());
    });
    current.close();
    cpSync(backup, file);
    const restored = database(file);
    const restoredLog = new CheckpointLog(restored, signer);
    expect(restoredLog.list('agent:a', 0, 10)).toEqual([first]);
    expect(restoredLog.verify(restoredLog.list('agent:a', 0, 10), signer.publicKey).valid).toBe(true);
    expectInvalid(verifyExportedChain(exportReceiptChain(restored, 'agent:a'), retained, signer.publicKey), 2);
  });

  test('verifies every receipt, not just the pinned head or untrusted hash fields', () => {
    const { store, signer, second } = fixture();
    store.withImmediateTransaction((tx) => appendReceipt(tx, signer));
    const receipts = exportReceiptChain(store, 'agent:a');
    for (const index of [0, 2, 3]) {
      for (const mutation of [{ signature: Buffer.alloc(64).toString('base64') }, { hash: 'f'.repeat(64) }, { at: clock.now() + 9 }]) {
        const bad = receipts.map((receipt, i) => i === index ? { ...receipt, ...mutation } : receipt);
        expectInvalid(verifyExportedChain(bad, second, signer.publicKey), index + 1);
      }
    }
    const badCheckpoint = { ...second, headHash: 'f'.repeat(64) };
    expectInvalid(verifyExportedChain(receipts, badCheckpoint, signer.publicKey), 3);
    const foreign = testSigner();
    const foreignCheckpoint = signCheckpoint(foreign, preimage(second, { auditPublicKey: foreign.publicKey }));
    expectInvalid(verifyExportedChain(receipts, foreignCheckpoint, signer.publicKey), 3);
    const wrongSignature = { ...second, signature: Buffer.alloc(64).toString('base64') };
    expectInvalid(verifyExportedChain(receipts, wrongSignature, signer.publicKey), 3);
    expectInvalid(verifyExportedChain(receipts, second, `ed25519:${'z'.repeat(44)}`));
  });

  test('rejects cryptographically valid but unlinked or noncontiguous extensions after the pin', () => {
    const { store, signer, first } = fixture();
    const genesis = exportReceiptChain(store, 'agent:a')[0]!;
    for (const changes of [{ seq: 3 }, { prevHash: 'f'.repeat(64) }, { chainId: 'owner' }]) {
      const extension = signReceipt(signer, {
        chainId: 'agent:a', seq: 2, prevHash: genesis.hash, type: 'queued', at: clock.now(),
        payload: { requestId: 'r2', agentId: 'a' }, ...changes,
      });
      expectInvalid(verifyExportedChain([genesis, extension], first, signer.publicKey), 2);
    }
  });

  test('export reads beyond the 1000-item page limit within a single snapshot', () => {
    const store = database();
    const signer = testSigner();
    const log = new CheckpointLog(store, signer);
    const retained = store.withImmediateTransaction((tx) => {
      for (let i = 0; i < 1002; i++) appendReceipt(tx, signer);
      return log.create(tx, 'agent:a', clock.now());
    });
    const readSpy = vi.spyOn(store, 'read');
    const receipts = exportReceiptChain(store, 'agent:a');
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1002);
    expect(receipts.at(-1)?.seq).toBe(1002);
    expect(verifyExportedChain(receipts, retained, signer.publicKey).valid).toBe(true);
  });
});
