import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ALLOWED_TRANSITIONS, BrokerError, TRANSFER_STATES } from '../../src/contracts/index.js';
import type { Hold, TransferRequest, TransferState, TxAttempt } from '../../src/contracts/index.js';
import { SCHEMA_VERSION, SqliteStore } from '../../src/storage/index.js';
import { ACCOUNT, HASH, HASH2, KEY, NOW, agent, attempt, checkpoint, policy, receipt, request } from './fixtures.js';

const KEY2 = `ed25519:${'2'.repeat(32)}`;
const MAX_NONCE = (1n << 64n) - 1n;
const stores: SqliteStore[] = [];
const dirs: string[] = [];
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'budget-integrity-')); dirs.push(dir); return join(dir, 'state.sqlite');
}
function open(filename = ':memory:', busyTimeoutMs = 50): SqliteStore {
  const store = new SqliteStore(filename, { accountId: ACCOUNT, busyTimeoutMs }); stores.push(store);
  store.transaction((tx) => { tx.putAgent(agent()); tx.putAgent(agent('b')); });
  return store;
}
function db(store: SqliteStore): DatabaseSync { return (store as unknown as { db: DatabaseSync }).db; }
function errorCode(operation: () => unknown, expected = 'FORBIDDEN'): void {
  expect(operation).toThrowError(expect.objectContaining({ name: 'BrokerError', code: expected }));
}
const h: Hold = { requestId: 'r', agentId: 'a', principal: 10n, feeReserve: 2n, status: 'active' };
function signed(store: SqliteStore): void {
  store.transaction((tx) => {
    tx.insertRequest(request()); tx.putHold(h); tx.allocateNonce(KEY, 0n); tx.putAttempt(attempt());
    tx.updateRequest({ ...request(), state: 'signed', txHash: HASH }, 'queued');
  });
}
function proven(store: SqliteStore): void {
  signed(store);
  store.transaction((tx) => tx.putAttempt({ ...attempt(), status: 'proven_not_executed', nonExecutionEvidence: 'positive final-block evidence' }));
}
// Test-only seeding isolates one guard at a time, rather than allowing a second
// guard (or a duplicate SQL key) to mask a mutant in the guard under test.
function seedState(store: SqliteStore, state: TransferState, txHash: string | null = HASH): TransferRequest {
  const r = { ...request(), state, txHash };
  db(store).prepare('UPDATE requests SET state = ?, data = ? WHERE id = ?').run(state, JSON.stringify(r, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v), 'r');
  return r;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('complete request transition and identity guards', () => {
  it.each(TRANSFER_STATES.flatMap((from) => TRANSFER_STATES.map((to) => ({ from, to }))))('$from -> $to matches ALLOWED_TRANSITIONS', ({ from, to }) => {
    const store = open(); signed(store);
    const r = seedState(store, from);
    // Settle the attempt first for terminal targets. This ensures rejection is
    // actually the transition guard, not the new outbox-coherence guard.
    if (['denied', 'rejected', 'expired', 'cancelled', 'succeeded', 'failed'].includes(to)) {
      store.transaction((tx) => tx.putAttempt({ ...attempt(), status: 'failed' }));
    }
    const operation = () => store.transaction((tx) => tx.updateRequest({ ...r, state: to }, from));
    if ((ALLOWED_TRANSITIONS[from] as readonly TransferState[]).includes(to)) {
      operation(); expect(store.read((v) => v.getRequest('r')?.state)).toBe(to);
    } else { errorCode(operation); expect(store.read((v) => v.getRequest('r')?.state)).toBe(from); }
  });

  it.each([
    { agentId: 'b' }, { receiverId: 'other.testnet' }, { idempotencyKey: 'changed' }, { createdAt: NOW + 1 },
    { amount: 11n }, { memo: 'changed' }, { requestDigest: 'f'.repeat(64) },
  ])('rejects immutable request patch %o', (patch) => {
    const store = open(); store.transaction((tx) => tx.insertRequest(request()));
    errorCode(() => store.transaction((tx) => tx.updateRequest({ ...request(), ...patch, state: 'cancelled' }, 'queued')));
    expect(store.read((v) => v.getRequest('r'))).toEqual(request());
  });

  it('requires a persisted attempt matching the new request hash', () => {
    const store = open(); store.transaction((tx) => { tx.insertRequest(request()); tx.allocateNonce(KEY, 0n); tx.putAttempt(attempt()); });
    errorCode(() => store.transaction((tx) => tx.updateRequest({ ...request(), state: 'signed', txHash: HASH2 }, 'queued')));
  });

  it.each(['signed', 'submitted', 'outcome_unknown'] as const)('%s requires a non-null recoverable transaction hash', (state) => {
    const store = open(); store.transaction((tx) => tx.insertRequest(request()));
    const from = state === 'signed' ? 'queued' : 'signed';
    const r = seedState(store, from, null);
    errorCode(() => store.transaction((tx) => tx.updateRequest({ ...r, state }, from)));
    expect(store.read((v) => v.listOutbox({ limit: 10 }).items)).toEqual([]);
  });

  it.each(['cancelled', 'expired', 'denied', 'failed', 'succeeded'] as const)('cannot enter %s with unresolved signed bytes in the outbox', (state) => {
    const store = open(); signed(store);
    const from = state === 'succeeded' ? 'submitted' : state === 'failed' ? 'signed' : 'queued';
    const r = seedState(store, from);
    errorCode(() => store.transaction((tx) => tx.updateRequest({ ...r, state }, from)));
    expect(store.read((v) => v.getHold('r'))).toEqual(h);
    expect(store.read((v) => v.listOutbox({ limit: 10 }).items)).toHaveLength(1);
    store.transaction((tx) => {
      tx.putAttempt({ ...attempt(), status: state === 'succeeded' ? 'succeeded' : 'failed' });
      tx.updateRequest({ ...r, state }, from);
    });
    expect(store.read((v) => v.listOutbox({ limit: 10 }).items)).toEqual([]);
  });
});

describe('signed-attempt persistence and replacement guards', () => {
  it('refuses replacement while submitted even when the current attempt is proven unexecuted', () => {
    const store = open(); proven(store);
    store.transaction((tx) => {
      tx.updateRequest({ ...request(), state: 'submitted', txHash: HASH }, 'signed'); tx.allocateNonce(KEY, 0n);
    });
    errorCode(() => store.transaction((tx) => tx.replaceUnexecutedAttempt('r', 'attempt', attempt('next', 'r', 2n, HASH2))));
    expect(store.read((v) => v.getRequest('r'))).toMatchObject({ state: 'submitted', txHash: HASH });
  });

  it('cannot replace an already-replaced prior hash a second time', () => {
    const store = open(); proven(store);
    store.transaction((tx) => { tx.allocateNonce(KEY, 0n); tx.replaceUnexecutedAttempt('r', 'attempt', attempt('next', 'r', 2n, HASH2)); tx.allocateNonce(KEY, 0n); });
    errorCode(() => store.transaction((tx) => tx.replaceUnexecutedAttempt('r', 'attempt', attempt('third', 'r', 3n, '3'.repeat(32)))));
    expect(store.read((v) => v.getRequest('r')?.txHash)).toBe(HASH2);
    expect(store.read((v) => v.listAttempts('r'))).toHaveLength(2);
  });

  it('cannot replace across public keys, even with a strictly higher allocated nonce', () => {
    const store = open(); proven(store);
    store.transaction((tx) => tx.allocateNonce(KEY2, 5n));
    errorCode(() => store.transaction((tx) => tx.replaceUnexecutedAttempt('r', 'attempt', { ...attempt('next', 'r', 6n, HASH2), publicKey: KEY2 })), 'NONCE_CONFLICT');
    expect(store.read((v) => v.getRequest('r')?.txHash)).toBe(HASH);
  });

  it.each([
    { signedTxBase64: 'Ag==' }, { blockHash: HASH2 }, { publicKey: KEY2 }, { nonce: 2n },
    { txHash: HASH2 }, { createdAt: NOW + 1 }, { requestId: 'other' },
  ] satisfies Partial<TxAttempt>[])('cannot rewrite persisted attempt identity %o', (patch) => {
    const store = open(); signed(store); store.transaction((tx) => tx.insertRequest(request('other')));
    errorCode(() => store.transaction((tx) => tx.putAttempt({ ...attempt(), ...patch })));
    expect(store.read((v) => v.listAttempts('r'))).toEqual([attempt()]);
  });

  it.each(['succeeded', 'failed', 'proven_not_executed'] as const)('cannot edit metadata on terminal %s attempts', (status) => {
    const store = open(); signed(store);
    const a = { ...attempt(), status, nonExecutionEvidence: status === 'proven_not_executed' ? 'positive final-block evidence' : null };
    store.transaction((tx) => tx.putAttempt(a));
    errorCode(() => store.transaction((tx) => tx.putAttempt({ ...a, updatedAt: NOW + 1 })));
    expect(store.read((v) => v.listAttempts('r'))).toEqual([a]);
  });

  it.each(['submitted', 'outcome_unknown'] as const)('never regresses %s back to signed', (status) => {
    const store = open(); signed(store); store.transaction((tx) => tx.putAttempt({ ...attempt(), status }));
    errorCode(() => store.transaction((tx) => tx.putAttempt(attempt())));
  });

  it('never rewrites positive evidence, independently of terminal status', () => {
    const store = open(); signed(store);
    const a = { ...attempt(), status: 'outcome_unknown' as const, nonExecutionEvidence: 'persisted positive observation' };
    store.transaction((tx) => tx.putAttempt(a));
    for (const nonExecutionEvidence of [null, 'different observation']) {
      errorCode(() => store.transaction((tx) => tx.putAttempt({ ...a, nonExecutionEvidence })));
    }
    expect(store.read((v) => v.listAttempts('r'))).toEqual([a]);
  });

  it.each([0n, 1n, 2n])('first attempt nonce %s must be positive and allocated', (nonce) => {
    const store = open(); store.transaction((tx) => tx.insertRequest(request()));
    // nonce=1 is unallocated; nonce=2 is above the allocated local value.
    if (nonce === 2n) store.transaction((tx) => tx.allocateNonce(KEY, 0n));
    errorCode(() => store.transaction((tx) => tx.putAttempt(attempt('attempt', 'r', nonce))), 'NONCE_CONFLICT');
    expect(store.read((v) => v.listAttempts('r'))).toEqual([]);
  });

  it.each(['submitted', 'outcome_unknown', 'failed', 'succeeded', 'proven_not_executed'] as const)('first attempt cannot start as %s', (status) => {
    const store = open(); store.transaction((tx) => { tx.insertRequest(request()); tx.allocateNonce(KEY, 0n); });
    errorCode(() => store.transaction((tx) => tx.putAttempt({ ...attempt(), status, nonExecutionEvidence: 'positive observation' })), 'NONCE_CONFLICT');
  });
});

describe('remaining mutation-sensitive store guards', () => {
  it.each(['agent', 'wallet'] as const)('%s policy starts at 1, increments contiguously and CASes the actual head', (scope) => {
    const store = open();
    const put = (revision: number, expected: number | null) => store.transaction((tx) => {
      if (scope === 'agent') tx.putPolicy(policy('a', revision), expected);
      else tx.putWalletPolicy({ revision, rolling24hMax: 100n, safetyReserve: 1n }, expected);
    });
    errorCode(() => put(7, null)); put(1, null);
    errorCode(() => put(3, 1)); // CAS matches, but skips revision 2.
    errorCode(() => put(3, 2)); // next=expected+1, but actual head is 1 (not 2).
    put(2, 1);
    expect(store.read((v) => scope === 'agent' ? v.getPolicy('a')?.revision : v.getWalletPolicy()?.revision)).toBe(2);
  });

  it('maps non-null balance freshness exactly and never overwrites a newer observation', () => {
    const filename = file(); const store = open(filename);
    const balance = { accountId: ACCOUNT, total: 100n, locked: 10n, storageReserve: 5n, spendable: 85n, observedAt: NOW, blockHash: HASH };
    store.transaction((tx) => tx.putBalance(balance, NOW + 777));
    expect(store.read((v) => v.getUsageSnapshot('a', NOW).balance)).toEqual({ spendable: 85n, observedAt: NOW, validUntil: NOW + 777 });
    errorCode(() => store.transaction((tx) => tx.putBalance({ ...balance, observedAt: NOW - 1, spendable: 99n }, NOW + 10_000)));
    store.close(); const reopened = open(filename);
    expect(reopened.read((v) => v.getUsageSnapshot('a', NOW + 778).balance)).toEqual({ spendable: 85n, observedAt: NOW, validUntil: NOW + 777 });
    reopened.transaction((tx) => tx.putBalance({ ...balance, observedAt: NOW + 1, spendable: 84n }, NOW + 1000));
    expect(reopened.read((v) => v.getUsageSnapshot('a', NOW + 1).balance)).toEqual({ spendable: 84n, observedAt: NOW + 1, validUntil: NOW + 1000 });
  });

  it('requires the held principal to match the request, and keeps fees immutable', () => {
    const store = open(); store.transaction((tx) => tx.insertRequest(request()));
    errorCode(() => store.transaction((tx) => tx.putHold({ ...h, principal: 9n })));
    store.transaction((tx) => tx.putHold(h));
    errorCode(() => store.transaction((tx) => tx.putHold({ ...h, feeReserve: 3n })));
    // Isolate the old-principal guard from the independent request-match guard.
    const changed = request('r', 'a', 11n);
    db(store).prepare('UPDATE requests SET data = ? WHERE id = ?').run(JSON.stringify(changed, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v), 'r');
    errorCode(() => store.transaction((tx) => tx.putHold({ ...h, principal: 11n })));
    expect(store.read((v) => v.getHold('r'))).toEqual(h);
  });

  it('never unrevokes credentials even when their agent remains active', () => {
    const store = open(); const c = { id: 'c', agentId: 'a', tokenHash: 'a'.repeat(64), createdAt: NOW, revokedAt: NOW + 1 };
    store.transaction((tx) => tx.putCredential(c));
    errorCode(() => store.transaction((tx) => tx.putCredential({ ...c, revokedAt: null })));
    expect(store.read((v) => v.getCredential('c'))).toEqual(c);
  });

  it('never unrevokes standing approvals even when usedTotal does not change', () => {
    const store = open(); const a = { id: 'grant', agentId: 'a', perTxMax: 10n, totalMax: 20n, usedTotal: 0n, expiresAt: NOW + 1000 };
    store.transaction((tx) => tx.putStandingApproval({ ...a, revokedAt: NOW }));
    errorCode(() => store.transaction((tx) => tx.putStandingApproval(a)));
    expect(store.read((v) => v.getStandingApproval('grant')?.revokedAt)).toBe(NOW);
  });

  it('checkpoint sequence cannot regress to an uncheckpointed older receipt even with correct CAS', () => {
    const store = open(); const first = receipt(); const second = receipt(2, 'agent:a', first.hash); const head = checkpoint(second);
    store.transaction((tx) => { tx.insertReceipt(first); tx.insertReceipt(second); tx.insertCheckpoint(head); });
    errorCode(() => store.transaction((tx) => tx.insertCheckpoint(checkpoint(first, head.hash))), 'AUDIT_UNAVAILABLE');
    expect(store.read((v) => v.getCheckpointHead('agent:a'))).toEqual(head);
  });

  it('rejects expired owner-nonce insertions, without consuming them', () => {
    const store = open(); const nonce = 'n'.repeat(22);
    errorCode(() => store.transaction((tx) => tx.consumeOwnerNonce(nonce, NOW - 1, NOW)));
    expect(store.transaction((tx) => tx.consumeOwnerNonce(nonce, NOW, NOW))).toBe(true);
  });

  it('revocation blocks admission writes, but not final settlement or release of existing work', () => {
    const store = open(); store.transaction((tx) => { tx.insertRequest(request()); tx.insertRequest(request('no-hold')); tx.putHold(h); tx.putAgent({ ...agent(), status: 'revoked' }); });
    errorCode(() => store.transaction((tx) => tx.insertRequest(request('new'))));
    errorCode(() => store.transaction((tx) => tx.putHold({ ...h, requestId: 'no-hold' })));
    errorCode(() => store.transaction((tx) => tx.putHold(h)));
    store.transaction((tx) => tx.putHold({ ...h, status: 'committed' }));
    expect(store.read((v) => v.getHold('r')?.status)).toBe('committed');
    expect(store.read((v) => v.getRequest('new'))).toBeNull();
  });

  it.each([{ amount: 11n }, { receiverId: 'other.testnet' }, { agentId: 'b' }, { memo: '' }, { requestDigest: 'f'.repeat(64) }])('recomputes admission digests for patch %o', (patch) => {
    const store = open(); errorCode(() => store.transaction((tx) => tx.insertRequest({ ...request(), ...patch })));
    expect(store.read((v) => v.getRequest('r'))).toBeNull();
  });

  it('validates replay fields against the digest too, without creating a second admission', () => {
    const store = open(); store.transaction((tx) => tx.insertRequest(request()));
    errorCode(() => store.transaction((tx) => tx.insertRequest({ ...request(), id: 'replay', amount: 11n })));
    expect(store.read((v) => v.listRequests({}, { limit: 10 }).items)).toEqual([request()]);
  });

  it.each([-1n, MAX_NONCE + 1n, 10n ** 100n])('rejects chain nonce %s without poisoning persistent allocation', (nonce) => {
    const store = open(); errorCode(() => store.transaction((tx) => tx.allocateNonce(KEY, nonce)), 'NONCE_CONFLICT');
    expect(store.read((v) => v.getLocalNonce(KEY))).toBe(0n);
    expect(store.transaction((tx) => tx.allocateNonce(KEY, 0n))).toBe(1n);
  });

  it('allocates the last NEAR u64 nonce exactly, but never wraps or persists u64+1', () => {
    const filename = file(); const store = open(filename);
    expect(store.transaction((tx) => tx.allocateNonce(KEY, MAX_NONCE - 1n))).toBe(MAX_NONCE); store.close();
    const reopened = open(filename);
    errorCode(() => reopened.transaction((tx) => tx.allocateNonce(KEY, 0n)), 'NONCE_CONFLICT');
    errorCode(() => reopened.transaction((tx) => tx.allocateNonce(KEY2, MAX_NONCE)), 'NONCE_CONFLICT');
    expect(reopened.read((v) => v.getLocalNonce(KEY))).toBe(MAX_NONCE);
    expect(reopened.read((v) => v.getLocalNonce(KEY2))).toBe(0n);
  });
});

describe('file custody identity, migration and infrastructure failures', () => {
  it('binds even an empty file on first open and rejects another custody identity', () => {
    const filename = file(); const store = open(filename); signed(store); store.close();
    errorCode(() => new SqliteStore(filename, { accountId: 'custody-b.testnet' }));
    const reopened = open(filename);
    expect(reopened.read((v) => v.listOutbox({ limit: 10 }).items)).toEqual([attempt()]);
    expect(reopened.read((v) => v.getLocalNonce(KEY))).toBe(1n);
    const emptyFilename = file(); const empty = new SqliteStore(emptyFilename, { accountId: ACCOUNT }); empty.close();
    errorCode(() => new SqliteStore(emptyFilename, { accountId: 'custody-b.testnet' }));
  });

  it('scopes outbox and attempt reads on every page even if foreign rows exist', () => {
    const store = open(); signed(store);
    const foreign = { ...attempt('foreign', 'r', 1n, HASH2) };
    // Same key+nonce is allowed by the namespaced SQL constraint, but must
    // never be visible through this wallet's reader or an invented cursor.
    db(store).prepare(`INSERT INTO attempts(id, request_id, network, account_id, status, public_key, nonce, tx_hash, data)
      VALUES (?, ?, 'testnet', 'custody-b.testnet', 'signed', ?, '1', ?, ?)`)
      .run(foreign.id, foreign.requestId, KEY, HASH2, JSON.stringify(foreign, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
    expect(store.read((v) => v.listAttempts('r'))).toEqual([attempt()]);
    expect(store.read((v) => v.listOutbox({ limit: 1 }))).toEqual({ items: [attempt()], nextCursor: null });
    expect(store.read((v) => v.listOutbox({ limit: 10, after: 'attempt' }).items)).toEqual([]);
  });

  function downgradeToV1(store: SqliteStore): void {
    db(store).exec(`BEGIN IMMEDIATE;
      ALTER TABLE attempts RENAME TO attempts_v2;
      DROP INDEX attempts_request; DROP INDEX attempts_outbox;
      CREATE TABLE attempts (id TEXT PRIMARY KEY COLLATE BINARY, request_id TEXT NOT NULL REFERENCES requests(id),
        status TEXT NOT NULL, public_key TEXT NOT NULL, nonce TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL, UNIQUE(public_key, nonce)) STRICT;
      INSERT INTO attempts SELECT id, request_id, status, public_key, nonce, tx_hash, data FROM attempts_v2;
      DROP TABLE attempts_v2;
      CREATE INDEX attempts_request ON attempts(request_id, id);
      CREATE INDEX attempts_outbox ON attempts(status, id);
      DROP TABLE store_identity; PRAGMA user_version = 1; COMMIT;`);
  }

  it('migrates V1 without changing signed bytes, policy history, holds or allocated nonce', () => {
    const filename = file(); const store = open(filename); signed(store);
    store.transaction((tx) => { tx.putPolicy(policy(), null); tx.putPolicy(policy('a', 2), 1); });
    downgradeToV1(store); store.close(); const reopened = open(filename);
    expect(db(reopened).prepare('PRAGMA user_version').get()?.['user_version']).toBe(SCHEMA_VERSION);
    expect(db(reopened).prepare('SELECT account_id, network FROM attempts').get()).toMatchObject({ account_id: ACCOUNT, network: 'testnet' });
    expect(reopened.read((v) => v.listOutbox({ limit: 10 }).items)).toEqual([attempt()]);
    expect(reopened.read((v) => v.getLocalNonce(KEY))).toBe(1n);
    expect(reopened.read((v) => v.getPolicy('a')?.revision)).toBe(2);
    expect(reopened.read((v) => v.getHold('r'))).toEqual(h);
  });

  it('refuses to relabel legacy V1 signed work to another account and leaves migration rolled back', () => {
    const filename = file(); const store = open(filename); signed(store); downgradeToV1(store); store.close();
    errorCode(() => new SqliteStore(filename, { accountId: 'custody-b.testnet' }));
    const raw = new DatabaseSync(filename);
    try { expect(raw.prepare('PRAGMA user_version').get()?.['user_version']).toBe(1); } finally { raw.close(); }
    expect(open(filename).read((v) => v.listOutbox({ limit: 10 }).items)).toEqual([attempt()]);
  });

  it('maps BEGIN IMMEDIATE lock timeouts to BROKER_UNAVAILABLE and remains usable', () => {
    const filename = file(); const store = open(filename, 1); const blocker = new DatabaseSync(filename);
    try {
      blocker.exec('BEGIN IMMEDIATE');
      errorCode(() => store.transaction((tx) => tx.putAgent(agent('blocked'))), 'BROKER_UNAVAILABLE');
      blocker.exec('ROLLBACK');
      store.transaction((tx) => tx.putAgent(agent('after-lock')));
    } finally { blocker.close(); }
    expect(store.read((v) => v.getAgent('blocked'))).toBeNull();
    expect(store.read((v) => v.getAgent('after-lock'))).not.toBeNull();
  });

  it('preserves SQLITE_FULL as BROKER_UNAVAILABLE even after SQLite automatically rolls back', () => {
    const store = open(file()); const raw = db(store); const pages = raw.prepare('PRAGMA page_count').get()?.['page_count'];
    raw.exec(`PRAGMA max_page_count = ${Number(pages)}`);
    errorCode(() => store.transaction((tx) => {
      tx.putFreeze({ scope: 'global', frozen: true, at: NOW, reason: 'must roll back' });
      for (let i = 0; i < 2000; i++) tx.putAgent({ ...agent(`large-${i}`), name: 'x'.repeat(256) });
    }), 'BROKER_UNAVAILABLE');
    expect(store.read((v) => v.getFreeze('global'))).toBeNull();
    expect(store.read((v) => v.getAgent('large-0'))).toBeNull();
    raw.exec('PRAGMA max_page_count = 1073741823');
    store.transaction((tx) => tx.putAgent(agent('recovered')));
    expect(store.read((v) => v.getAgent('recovered'))).not.toBeNull();
  });

  it('maps I/O errors on reads and writes without disguising them as authorization errors', () => {
    const store = open(); const io = Object.assign(new Error('sensitive device detail'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    const spy = vi.spyOn(db(store), 'prepare');
    spy.mockImplementationOnce(() => { throw io; });
    errorCode(() => store.read((v) => v.getAgent('a')), 'BROKER_UNAVAILABLE');
    // putAgent first reads the old agent; inject failure in the following write.
    const prepare = db(store).prepare.bind(db(store)); spy.mockRestore();
    vi.spyOn(db(store), 'prepare').mockImplementation((sql) => {
      if (sql.startsWith('INSERT')) throw io;
      return prepare(sql);
    });
    errorCode(() => store.transaction((tx) => tx.putAgent(agent('new'))), 'BROKER_UNAVAILABLE');
    expect(io).not.toBeInstanceOf(BrokerError);
  });
});
