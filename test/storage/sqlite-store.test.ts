import { afterEach, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { BrokerError, MAX_U128 } from '../../src/contracts/index.js';
import type { AccountingEntry, StoreTransaction, TransferRequest } from '../../src/contracts/index.js';
import { SCHEMA_VERSION, SqliteStore } from '../../src/storage/index.js';
import { ACCOUNT, HASH, HASH2, KEY, NOW, agent, attempt, checkpoint, policy, receipt, request } from './fixtures.js';

const stores: SqliteStore[] = [];
const dirs: string[] = [];
function file(): string { const dir = mkdtempSync(join(tmpdir(), 'budget-storage-')); dirs.push(dir); return join(dir, 'state.sqlite'); }
function open(filename = ':memory:', accountId = ACCOUNT): SqliteStore {
  const store = new SqliteStore(filename, { accountId }); stores.push(store); return store;
}
function seed(store: SqliteStore): void { store.transaction((tx) => { tx.putAgent(agent()); tx.putAgent(agent('b')); }); }
function hold(tx: StoreTransaction, r: TransferRequest, feeReserve = 2n): void {
  tx.insertRequest(r);
  tx.putHold({ requestId: r.id, agentId: r.agentId, principal: r.amount, feeReserve, status: 'active' });
}
function entry(id: string, requestId: string, agentId: string, kind: AccountingEntry['kind'], amount: bigint, at = NOW): AccountingEntry {
  return { id, requestId, agentId, kind, amount, at };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function code(operation: () => unknown, expected: string): void {
  try { operation(); throw new Error('Expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(BrokerError); expect((error as BrokerError).code).toBe(expected); }
}

describe('transactional SQLite Store', () => {
  it('uses WAL, FULL sync, FKs, busy timeout, versioned migrations and rejects future schemas', () => {
    const filename = file(); const store = open(filename); seed(store);
    const raw = new DatabaseSync(filename);
    try {
      expect(raw.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
      expect(raw.prepare('PRAGMA user_version').get()?.['user_version']).toBe(SCHEMA_VERSION);
      expect(raw.prepare("SELECT type FROM pragma_table_info('holds') WHERE name = 'principal'").get()?.['type']).toBe('TEXT');
      expect(raw.prepare("SELECT type FROM pragma_table_info('accounting') WHERE name = 'amount'").get()?.['type']).toBe('TEXT');
      // Configuration is connection-local: inspect the implementation connection
      // solely in this test, rather than exporting an unsafe raw DB API.
      const internal = (store as unknown as { db: DatabaseSync }).db;
      expect(internal.prepare('PRAGMA synchronous').get()?.['synchronous']).toBe(2);
      expect(internal.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
      expect(internal.prepare('PRAGMA busy_timeout').get()?.['timeout']).toBe(5000);
      code(() => store.transaction((tx) => tx.putPolicy(policy('missing'), null)), 'FORBIDDEN');
      store.close();
      raw.exec('PRAGMA user_version = 999');
      expect(() => new SqliteStore(filename, { accountId: ACCOUNT })).toThrow('Unsupported storage schema version');
    } finally { raw.close(); }
  });

  it('rolls back every multi-write on throw, including nonce/replay/audit failures', () => {
    const store = open(); seed(store);
    expect(() => store.transaction((tx) => {
      tx.putPolicy(policy(), null);
      tx.putWalletPolicy({ revision: 1, rolling24hMax: 100n, safetyReserve: 1n }, null);
      hold(tx, request());
      tx.appendAccounting(entry('e', 'r', 'a', 'principal_reserved', 10n));
      tx.allocateNonce(KEY, 0n);
      tx.putFreeze({ scope: 'global', frozen: true, reason: 'stop', at: NOW });
      tx.consumeOwnerNonce('n'.repeat(22), NOW + 60_000, NOW);
      tx.insertReceipt(receipt());
      tx.insertCheckpoint(checkpoint());
      throw new Error('simulated signer failure');
    })).toThrow('simulated signer failure');
    store.read((view) => {
      expect(view.getPolicy('a')).toBeNull(); expect(view.getWalletPolicy()).toBeNull();
      expect(view.getRequest('r')).toBeNull(); expect(view.getHold('r')).toBeNull();
      expect(view.listAccounting({}, { limit: 10 }).items).toEqual([]);
      expect(view.getFreeze('global')).toBeNull(); expect(view.getLocalNonce(KEY)).toBe(0n);
      expect(view.getReceiptHead('agent:a')).toBeNull(); expect(view.getCheckpointHead('agent:a')).toBeNull();
    });
    expect(store.transaction((tx) => tx.consumeOwnerNonce('n'.repeat(22), NOW + 60_000, NOW))).toBe(true);
    // A malformed append cannot leave the admission hold behind.
    expect(() => store.transaction((tx) => { hold(tx, request()); tx.insertReceipt({ ...receipt(), seq: 2 }); })).toThrow();
    expect(store.read((view) => view.getHold('r'))).toBeNull();
  });

  it('rejects async/thenable callbacks, nested transactions and escaped handles', () => {
    const store = open(); seed(store); let escaped: StoreTransaction | undefined;
    expect(() => store.transaction(async (tx) => { tx.putFreeze({ scope: 'global', frozen: true, reason: '', at: NOW }); })).toThrow();
    expect(() => store.transaction((tx) => { hold(tx, request()); return { then() {} }; })).toThrow();
    expect(store.read((v) => v.getRequest('r'))).toBeNull();
    expect(() => store.read(() => Promise.resolve(1))).toThrow();
    expect(() => store.transaction(() => store.transaction(() => 1))).toThrow();
    store.transaction((tx) => { escaped = tx; });
    expect(() => escaped?.allocateNonce(KEY, 0n)).toThrow();
    store.read((view) => expect(() => (view as StoreTransaction).putAgent(agent('x'))).toThrow());
    expect(store.read((view) => view.getFreeze('global'))).toBeNull();
  });

  it('reopen preserves all persisted entities, revisions, outbox and receipt/checkpoint chains', () => {
    const filename = file(); const first = open(filename); seed(first);
    const r = request(); const a = attempt(); const event = receipt(); const cp = checkpoint(event);
    const balance = { accountId: ACCOUNT, total: 1000n, locked: 10n, storageReserve: 10n, spendable: 980n, blockHash: HASH, observedAt: NOW };
    const standing = { id: 'standing', agentId: 'a', perTxMax: 100n, totalMax: 200n, usedTotal: 0n, expiresAt: NOW + 10_000 };
    const credential = { id: 'credential', agentId: 'a', tokenHash: 'a'.repeat(64), createdAt: NOW, revokedAt: null };
    const approval = { id: 'approval', requestId: 'r', agentId: 'a', requestDigest: r.requestDigest, policyRevision: 1, approvedAt: NOW, expiresAt: NOW + 1000 };
    first.transaction((tx) => {
      tx.putCredential(credential); tx.putPolicy(policy(), null); tx.putPolicy(policy('a', 2), 1);
      tx.putWalletPolicy({ revision: 1, rolling24hMax: 1000n, safetyReserve: 5n }, null);
      hold(tx, r); tx.appendAccounting(entry('accounting', 'r', 'a', 'principal_reserved', 10n));
      tx.putStandingApproval(standing); tx.putRequestApproval(approval);
      tx.putFreeze({ scope: 'agent', agentId: 'a', frozen: true, reason: 'stop', at: NOW });
      tx.putFreeze({ scope: 'global', frozen: true, reason: 'stop all', at: NOW });
      expect(tx.allocateNonce(KEY, 0n)).toBe(1n); tx.putAttempt(a);
      tx.updateRequest({ ...r, state: 'signed', txHash: HASH, signedAt: NOW }, 'queued');
      tx.putBalance(balance, NOW + 1000); tx.insertReceipt(event); tx.insertCheckpoint(cp);
      expect(tx.consumeOwnerNonce('n'.repeat(22), NOW + 60_000, NOW)).toBe(true);
    });
    first.close(); const second = open(filename);
    second.read((view) => {
      expect(view.listAgents({ limit: 10 }).items).toEqual([agent(), agent('b')]);
      expect(view.getCredential('credential')).toEqual(credential);
      expect(view.findCredentialByHash(credential.tokenHash)).toEqual(credential);
      expect(view.getPolicy('a')).toEqual(policy('a', 2)); expect(view.getWalletPolicy()?.revision).toBe(1);
      expect(view.getRequest('r')?.state).toBe('signed'); expect(view.findRequestByIdempotency('a', 'r')?.id).toBe('r');
      expect(view.getHold('r')?.status).toBe('active'); expect(view.listAccounting({}, { limit: 1 }).items).toHaveLength(1);
      expect(view.getStandingApproval('standing')).toEqual(standing); expect(view.getRequestApproval('r')).toEqual(approval);
      expect(view.getFreeze('agent', 'a')?.frozen).toBe(true); expect(view.getFreeze('global')?.frozen).toBe(true);
      expect(view.listAttempts('r')).toEqual([a]); expect(view.listOutbox({ limit: 1 }).items).toEqual([a]);
      expect(view.getLocalNonce(KEY)).toBe(1n); expect(view.getReceiptHead('agent:a')).toEqual(event);
      expect(view.listReceipts('agent:a', 0, 10)).toEqual([event]); expect(view.getCheckpointHead('agent:a')).toEqual(cp);
      expect(view.listCheckpoints('agent:a', 0, 10)).toEqual([cp]);
      expect(view.getWalletStatus(NOW)).toMatchObject({ balance, balanceValidUntil: NOW + 1000, outstandingHolds: 12n, walletRolling24h: 10n });
    });
    expect(second.transaction((tx) => tx.consumeOwnerNonce('n'.repeat(22), NOW + 60_000, NOW))).toBe(false);
    const raw = new DatabaseSync(filename);
    try { expect(raw.prepare('SELECT COUNT(*) AS n FROM policies').get()?.['n']).toBe(2); }
    finally { raw.close(); }
  });

  it('enforces immutable requests, transition/CAS rules, terminal states and idempotency digest uniqueness', () => {
    const store = open(); seed(store); const r = request();
    store.transaction((tx) => {
      tx.insertRequest(r);
      tx.insertRequest({ ...r, id: 'replay' });
      expect(tx.getRequest('replay')).toBeNull();
      expect(tx.listRequests({}, { limit: 10 }).items).toHaveLength(1);
      code(() => tx.insertRequest({ ...r, id: 'conflict', requestDigest: 'f'.repeat(64) }), 'IDEMPOTENCY_CONFLICT');
      // Different agents may use the same idempotency key.
      tx.insertRequest({ ...request('other', 'b'), idempotencyKey: 'r' });
      for (const bad of [
        { ...r, updatedAt: NOW + 1 }, // same-state metadata loophole
        { ...r, state: 'succeeded' as const },
        { ...r, state: 'cancelled' as const, amount: 11n },
        { ...r, state: 'cancelled' as const, memo: 'changed' },
        { ...r, state: 'cancelled' as const, requestDigest: 'f'.repeat(64) },
      ]) code(() => tx.updateRequest(bad, 'queued'), 'FORBIDDEN');
      code(() => tx.updateRequest({ ...r, state: 'cancelled' }, 'approved'), 'FORBIDDEN');
      tx.updateRequest({ ...r, state: 'cancelled' }, 'queued');
      code(() => tx.updateRequest(r, 'cancelled'), 'FORBIDDEN');
    });
    expect(store.read((view) => view.findRequestByIdempotency('a', 'r')?.state)).toBe('cancelled');
  });

  it('never reactivates revoked agents/credentials or issues new credentials to them', () => {
    const filename = file(); const store = open(filename); seed(store);
    const credential = { id: 'c', agentId: 'a', tokenHash: 'a'.repeat(64), createdAt: NOW, revokedAt: null };
    store.transaction((tx) => {
      tx.putCredential(credential); tx.putAgent({ ...agent(), status: 'revoked' }); tx.revokeAgentCredentials('a', NOW + 1);
      expect(tx.getCredential('c')?.revokedAt).toBe(NOW + 1);
      code(() => tx.putAgent(agent()), 'FORBIDDEN');
      code(() => tx.putCredential(credential), 'FORBIDDEN');
      code(() => tx.putCredential({ ...credential, id: 'new', tokenHash: 'b'.repeat(64) }), 'FORBIDDEN');
      tx.putFreeze({ scope: 'agent', agentId: 'a', frozen: false, reason: 'unfreeze cannot undo revoke', at: NOW });
      expect(tx.getAgent('a')?.status).toBe('revoked');
    });
    expect(store.read((v) => v.findCredentialByHash(credential.tokenHash)?.revokedAt)).toBe(NOW + 1);
    store.close(); const reopened = open(filename);
    code(() => reopened.transaction((tx) => tx.putAgent(agent())), 'FORBIDDEN');
    expect(reopened.read((v) => v.getAgent('a')?.status)).toBe('revoked');
  });

  it('allocates exact monotonic nonces across reopen and isolates account/key namespaces', () => {
    const filename = file(); const first = open(filename);
    expect(first.transaction((tx) => tx.allocateNonce(KEY, MAX_U128))).toBe(MAX_U128 + 1n);
    expect(first.transaction((tx) => tx.allocateNonce(KEY, 0n))).toBe(MAX_U128 + 2n);
    first.close(); const second = open(filename);
    expect(second.transaction((tx) => tx.allocateNonce(KEY, 7n))).toBe(MAX_U128 + 3n);
    const other = open(filename, 'another.testnet');
    expect(other.transaction((tx) => tx.allocateNonce(KEY, 0n))).toBe(1n);
    expect(second.read((v) => v.getLocalNonce(KEY))).toBe(MAX_U128 + 3n);
    expect(second.transaction((tx) => tx.allocateNonce(`ed25519:${'2'.repeat(32)}`, 10n))).toBe(11n);
    expect(() => second.transaction((tx) => { tx.allocateNonce(KEY, MAX_U128 + 100n); throw new Error('rollback'); })).toThrow();
    expect(second.read((v) => v.getLocalNonce(KEY))).toBe(MAX_U128 + 3n);
  });

  it('persists u128 max exactly as decimal TEXT, and fails closed on sum overflow', () => {
    const filename = file(); const store = open(filename); seed(store);
    store.transaction((tx) => {
      tx.putPolicy({ ...policy(), perTxMax: MAX_U128, rolling24hMax: MAX_U128, lifetimeMax: MAX_U128 }, null);
      hold(tx, request('max', 'a', MAX_U128), 0n);
      tx.appendAccounting(entry('max-entry', 'max', 'a', 'principal_reserved', MAX_U128));
      expect(tx.getUsageSnapshot('a', NOW).agentLifetime).toBe(MAX_U128);
      expect(tx.getRequest('max')?.amount).toBe(MAX_U128);
      expect(tx.listAccounting({}, { limit: 1 }).items[0]?.amount).toBe(MAX_U128);
      expect(tx.getPolicy('a')?.perTxMax).toBe(MAX_U128);
    });
    const raw = new DatabaseSync(filename);
    try {
      expect(raw.prepare("SELECT principal, typeof(principal) AS type FROM holds WHERE request_id = 'max'").get()).toMatchObject({ principal: MAX_U128.toString(), type: 'text' });
      expect(raw.prepare("SELECT json_extract(data, '$.amount') AS amount, json_type(data, '$.amount') AS type FROM requests WHERE id = 'max'").get()).toMatchObject({ amount: MAX_U128.toString(), type: 'text' });
    } finally { raw.close(); }
    store.transaction((tx) => { hold(tx, request('one', 'a', 1n), 0n); });
    code(() => store.read((v) => v.getUsageSnapshot('a', NOW)), 'INVALID_AMOUNT');
    expect(() => store.transaction((tx) => tx.insertRequest(request('too-big', 'a', MAX_U128 + 1n)))).toThrow();
  });

  it('computes exact accounting/hold windows, all-agent capacity, rates, freezes and exclusion', () => {
    const store = open(); seed(store);
    store.transaction((tx) => {
      // Old active holds count even outside both rolling windows.
      hold(tx, { ...request('old-hold', 'a', 5n, NOW - 90_000_000), approvalRef: { kind: 'standing', id: '__proto__' } }, 2n);
      hold(tx, request('new-hold', 'a', 7n), 3n);
      hold(tx, request('other-hold', 'b', 11n), 4n);
      tx.insertRequest(request('settled', 'a', 13n, NOW - 100_000));
      tx.insertRequest(request('boundary', 'a', 17n, NOW - 100_000));
      tx.insertRequest(request('other-settled', 'b', 19n, NOW - 100_000));
      tx.insertRequest({ ...request('denied'), state: 'denied', reasons: ['NO_POLICY'] });
      tx.insertRequest(request('rate-boundary', 'a', 1n, NOW - 60_000));
      tx.insertRequest(request('future', 'a', 1n, NOW + 1));
      tx.insertRequest(request('admitted-then-cancelled'));
      tx.updateRequest({ ...request('admitted-then-cancelled'), state: 'cancelled' }, 'queued');
      tx.appendAccounting(entry('a1', 'settled', 'a', 'principal_committed', 13n, NOW - 86_399_999));
      tx.appendAccounting(entry('a2', 'boundary', 'a', 'principal_committed', 17n, NOW - 86_400_000));
      tx.appendAccounting(entry('a3', 'other-settled', 'b', 'principal_committed', 19n));
      tx.appendAccounting(entry('g1', 'settled', 'a', 'gas_charged', 23n));
      tx.appendAccounting(entry('g2', 'boundary', 'a', 'gas_charged', 29n, NOW - 86_400_000));
      tx.putFreeze({ scope: 'agent', agentId: 'a', frozen: true, reason: '', at: NOW });
      tx.putFreeze({ scope: 'global', frozen: true, reason: '', at: NOW });
      expect(tx.getUsageSnapshot('a', NOW)).toEqual({
        agentRolling24h: 25n, agentLifetime: 42n, agentGas24h: 28n, agentRequestsLastMinute: 2, agentOutstanding: 2,
        walletRolling24h: 55n, outstandingHolds: 32n, standingReserved: { ['__proto__']: 5n }, balance: null, agentFrozen: true, globalFrozen: true,
      });
      expect(tx.getUsageSnapshot('a', NOW, 'new-hold')).toMatchObject({ agentRolling24h: 18n, agentLifetime: 35n, agentGas24h: 25n,
        agentRequestsLastMinute: 1, agentOutstanding: 1, walletRolling24h: 48n, outstandingHolds: 22n });
      expect(tx.getUsageSnapshot('a', NOW, 'old-hold').standingReserved).toEqual({});
      expect(tx.getUsageSnapshot('a', NOW, 'settled')).toMatchObject({ agentRolling24h: 12n, agentLifetime: 29n, agentGas24h: 5n, walletRolling24h: 42n });
      code(() => tx.appendAccounting(entry('duplicate-principal', 'settled', 'a', 'principal_committed', 13n)), 'FORBIDDEN');
      code(() => tx.appendAccounting(entry('duplicate-gas', 'settled', 'a', 'gas_charged', 23n)), 'FORBIDDEN');
      // Editing policy appends a revision, never erases usage history.
      tx.putPolicy(policy(), null); tx.putPolicy({ ...policy('a', 2), lifetimeMax: 50n }, 1);
      code(() => tx.putPolicy(policy('a', 3), 1), 'FORBIDDEN');
      expect(tx.getUsageSnapshot('a', NOW).agentLifetime).toBe(42n);
      tx.putHold({ requestId: 'new-hold', agentId: 'a', principal: 7n, feeReserve: 3n, status: 'released' });
      code(() => tx.putHold({ requestId: 'new-hold', agentId: 'a', principal: 7n, feeReserve: 3n, status: 'active' }), 'FORBIDDEN');
      expect(tx.getUsageSnapshot('a', NOW).outstandingHolds).toBe(22n);
    });
  });

  it('retains failed-transfer gas charges while excluding released principal', () => {
    const store = open(); seed(store); const r = request();
    store.transaction((tx) => {
      hold(tx, r); tx.allocateNonce(KEY, 0n); tx.putAttempt(attempt());
      tx.updateRequest({ ...r, state: 'signed', txHash: HASH }, 'queued');
      tx.updateRequest({ ...r, state: 'failed', txHash: HASH, tokensBurnt: 20n, gasBurnt: 500n }, 'signed');
      tx.putHold({ requestId: 'r', agentId: 'a', principal: 10n, feeReserve: 2n, status: 'committed' });
      tx.appendAccounting(entry('gas', 'r', 'a', 'gas_charged', 20n));
      expect(tx.getUsageSnapshot('a', NOW)).toMatchObject({ agentRolling24h: 0n, agentLifetime: 0n, agentGas24h: 20n, outstandingHolds: 0n, agentOutstanding: 0 });
    });
  });

  it('permits only evidence-bound replacements and returns only unresolved outbox rows', () => {
    const store = open(); seed(store); const r = request(); const original = attempt();
    store.transaction((tx) => {
      hold(tx, r); tx.allocateNonce(KEY, 0n); tx.putAttempt(original);
      tx.updateRequest({ ...r, state: 'signed', txHash: HASH }, 'queued');
      tx.updateRequest({ ...r, state: 'outcome_unknown', txHash: HASH }, 'signed');
      tx.putAttempt({ ...original, status: 'outcome_unknown' });
      tx.allocateNonce(KEY, 0n);
      const replacement = attempt('replacement', 'r', 2n, HASH2);
      code(() => tx.replaceUnexecutedAttempt('r', original.id, replacement), 'FORBIDDEN');
      expect(() => tx.putAttempt({ ...original, status: 'proven_not_executed' })).toThrow();
      code(() => tx.putAttempt(replacement), 'FORBIDDEN');
      tx.putAttempt({ ...original, status: 'proven_not_executed', nonExecutionEvidence: 'final adapter observation: access-key nonce unused and final block exclusion proof' });
      code(() => tx.replaceUnexecutedAttempt('r', original.id, { ...replacement, nonce: 1n }), 'NONCE_CONFLICT');
      tx.replaceUnexecutedAttempt('r', original.id, replacement);
      expect(tx.getRequest('r')).toMatchObject({ state: 'outcome_unknown', txHash: HASH2 });
      expect(tx.getHold('r')?.status).toBe('active'); expect(tx.listAttempts('r')).toHaveLength(2);
      expect(tx.listOutbox({ limit: 10 }).items.map((a) => a.id)).toEqual(['replacement']);
      expect(tx.listAttempts('r')[0]?.nonExecutionEvidence).not.toBeNull();
      code(() => tx.updateRequest({ ...r, state: 'submitted', txHash: HASH }, 'outcome_unknown'), 'FORBIDDEN');
      tx.putAttempt({ ...replacement, status: 'submitted' });
      tx.updateRequest({ ...r, state: 'submitted', txHash: HASH2 }, 'outcome_unknown');
      tx.putAttempt({ ...replacement, status: 'succeeded', gasBurnt: 2n, tokensBurnt: 3n });
      expect(tx.listOutbox({ limit: 10 }).items).toEqual([]);
      code(() => tx.putAttempt({ ...original, status: 'signed' }), 'FORBIDDEN');
    });
  });

  it('checks receipt append order/scope and checkpoint CAS without hashing or signing', () => {
    const store = open(); seed(store);
    store.transaction((tx) => {
      code(() => tx.insertReceipt(receipt(2)), 'AUDIT_UNAVAILABLE');
      tx.insertReceipt(receipt()); tx.insertReceipt(receipt(1, 'owner'));
      code(() => tx.insertReceipt(receipt()), 'AUDIT_UNAVAILABLE');
      code(() => tx.insertReceipt(receipt(2)), 'AUDIT_UNAVAILABLE');
      expect(() => tx.insertReceipt(receipt(1, 'agent:b'))).toThrow();
      const cp = checkpoint(); tx.insertCheckpoint(cp);
      code(() => tx.insertCheckpoint(cp), 'AUDIT_UNAVAILABLE');
      const second = receipt(2, 'agent:a', receipt().hash); tx.insertReceipt(second);
      code(() => tx.insertCheckpoint(checkpoint(second)), 'AUDIT_UNAVAILABLE');
      code(() => tx.insertCheckpoint({ ...checkpoint(second, cp.hash), headHash: 'f'.repeat(64) }), 'AUDIT_UNAVAILABLE');
      const cp2 = checkpoint(second, cp.hash); tx.insertCheckpoint(cp2);
      expect(tx.listReceipts('agent:a', 1, 1)).toEqual([second]);
      expect(tx.listCheckpoints('agent:a', 1, 10)).toEqual([cp2]);
      expect(tx.listReceipts('owner', 0, 1)).toHaveLength(1);
      expect(() => tx.listReceipts('agent:a', 0, 0)).toThrow();
      expect(() => tx.listCheckpoints('agent:a', -1, 10)).toThrow();
    });
  });

  it('consumes owner nonces exactly once across connections and retains expiry inclusively', () => {
    const filename = file(); const first = open(filename); const second = open(filename); const nonce = 'x'.repeat(22);
    expect(first.transaction((tx) => tx.consumeOwnerNonce(nonce, NOW + 60_000, NOW))).toBe(true);
    expect(second.transaction((tx) => tx.consumeOwnerNonce(nonce, NOW + 120_000, NOW + 60_000))).toBe(false);
    // Original verifier rejects expired signatures; storage may prune expired rows.
    expect(second.transaction((tx) => tx.consumeOwnerNonce(nonce, NOW + 120_000, NOW + 60_001))).toBe(true);
    const futureIssuedNonce = 'f'.repeat(22);
    expect(first.transaction((tx) => tx.consumeOwnerNonce(futureIssuedNonce, NOW + 120_000, NOW))).toBe(true);
    expect(second.transaction((tx) => tx.consumeOwnerNonce(futureIssuedNonce, NOW + 120_000, NOW + 119_999))).toBe(false);
  });

  it('keyset pages use UTF-8 BINARY IDs and reapply scopes/filters on every page', () => {
    const store = open(); seed(store);
    const ids = ['z', 'ä', '\u{10000}', '\ue000']; // UTF-8 order differs from JS UTF-16 sorting at the end.
    store.transaction((tx) => {
      for (const id of ids) {
        tx.putAgent(agent(id));
        tx.putCredential({ id, agentId: 'a', tokenHash: Buffer.from(id).toString('hex').padEnd(64, '0'), createdAt: NOW, revokedAt: null });
        tx.insertRequest(request(id));
        tx.putStandingApproval({ id, agentId: 'a', totalMax: 10n, perTxMax: 10n, usedTotal: 0n, expiresAt: NOW + 1000 });
        tx.appendAccounting(entry(id, id, 'a', 'principal_reserved', 10n));
        tx.allocateNonce(KEY, 0n); tx.putAttempt(attempt(id, id, tx.getLocalNonce(KEY), id === 'z' ? HASH : id === 'ä' ? HASH2 : id === '\ue000' ? '3'.repeat(32) : '4'.repeat(32)));
      }
      tx.insertRequest(request('b-request', 'b'));
      tx.putCredential({ id: 'b-credential', agentId: 'b', tokenHash: 'b'.repeat(64), createdAt: NOW, revokedAt: null });
    });
    store.read((v) => {
      const expected = ['z', 'ä', '\ue000', '\u{10000}'];
      const collect = <T extends { id: string }>(get: (after?: string) => { items: T[]; nextCursor: string | null }): string[] => {
        const result: string[] = []; let after: string | undefined;
        do { const page = get(after); result.push(...page.items.map((i) => i.id)); after = page.nextCursor ?? undefined; } while (after !== undefined);
        return result;
      };
      const q = (after?: string) => after === undefined ? { limit: 1 } : { limit: 1, after };
      expect(collect((after) => v.listAgents(q(after)))).toEqual(['a', 'b', ...expected]);
      expect(collect((after) => v.listCredentials('a', q(after)))).toEqual(expected);
      expect(collect((after) => v.listRequests({ agentId: 'a', states: ['queued'] }, q(after)))).toEqual(expected);
      expect(collect((after) => v.listStandingApprovals('a', q(after)))).toEqual(expected);
      expect(collect((after) => v.listAccounting({ agentId: 'a' }, q(after)))).toEqual(expected);
      expect(collect((after) => v.listOutbox(q(after)))).toEqual(expected);
      expect(v.listRequests({ agentId: 'a' }, { after: 'b-request', limit: 100 }).items.map((r) => r.id)).toEqual(expected);
      expect(v.listRequests({ agentId: 'b' }, { after: 'z', limit: 100 }).items).toEqual([]);
      expect(v.listRequests({ states: [] }, { limit: 100 }).items).toEqual([]);
      expect(v.listAccounting({ agentId: 'b', requestId: 'z' }, { limit: 10 }).items).toEqual([]);
      expect(v.listAccounting({ agentId: 'a', requestId: 'z' }, { limit: 10 }).items.map((e) => e.id)).toEqual(['z']);
      expect(() => v.listAgents({ limit: 1001 })).toThrow();
    });
  });

  it('standing grant reservations track holds, while usage and revocation never decrease', () => {
    const store = open(); seed(store);
    const approval = { id: 'grant', agentId: 'a', perTxMax: 10n, totalMax: 20n, usedTotal: 0n, expiresAt: NOW + 1000 };
    store.transaction((tx) => {
      tx.putStandingApproval(approval);
      hold(tx, { ...request(), approvalRef: { kind: 'standing', id: 'grant' } });
      expect(tx.getUsageSnapshot('a', NOW).standingReserved).toEqual({ grant: 10n });
      tx.putStandingApproval({ ...approval, usedTotal: 10n, revokedAt: NOW });
      code(() => tx.putStandingApproval(approval), 'FORBIDDEN');
      code(() => tx.putStandingApproval({ ...approval, usedTotal: 10n, revokedAt: NOW, totalMax: 30n }), 'FORBIDDEN');
      tx.putHold({ requestId: 'r', agentId: 'a', principal: 10n, feeReserve: 2n, status: 'committed' });
      expect(tx.getUsageSnapshot('a', NOW).standingReserved).toEqual({});
      tx.putStandingApproval({ ...approval, usedTotal: 20n, revokedAt: NOW }); // final debit after revocation is valid
      expect(tx.getStandingApproval('grant')?.usedTotal).toBe(20n);
    });
  });

  it('gives multi-read snapshots a consistent view while another WAL connection commits', () => {
    const filename = file(); const first = open(filename); seed(first); const second = open(filename);
    first.read((v) => {
      expect(v.getPolicy('a')).toBeNull();
      second.transaction((tx) => tx.putPolicy(policy(), null));
      expect(v.getPolicy('a')).toBeNull();
    });
    expect(first.read((v) => v.getPolicy('a'))?.revision).toBe(1);
  });

  it('serializes competing reservations in two actual processes without oversubscribing a cap', async () => {
    const filename = file(); const store = open(filename); seed(store); store.close();
    const worker = fileURLToPath(new URL('./reservation-worker.ts', import.meta.url));
    const children: ChildProcess[] = [];
    const done: Promise<number>[] = [];
    try {
      const ready: Promise<void>[] = [];
      for (const prefix of ['one', 'two']) {
        const child = fork(worker, [filename, prefix], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child);
        let stderr = ''; child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        ready.push(new Promise((resolve, reject) => {
          child.on('message', (message) => { if (message === 'ready') resolve(); });
          child.on('error', reject); child.on('exit', (status) => { if (status !== 0) reject(new Error(stderr)); });
        }));
        done.push(new Promise((resolve, reject) => {
          let accepted = -1;
          child.on('message', (message: unknown) => { if (typeof message === 'object' && message !== null && 'accepted' in message) accepted = Number(message.accepted); });
          child.on('error', reject);
          child.on('exit', (status) => { if (status === 0 && accepted >= 0) resolve(accepted); else reject(new Error(`worker exit ${status}: ${stderr}`)); });
        }));
      }
      await Promise.all(ready); for (const child of children) child.send('start');
      const counts = await Promise.all(done); expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
      const reopened = open(filename);
      expect(reopened.read((v) => v.getUsageSnapshot('a', NOW))).toMatchObject({ agentLifetime: 10n, agentRolling24h: 10n, outstandingHolds: 10n, agentOutstanding: 10 });
      expect(reopened.read((v) => v.listRequests({}, { limit: 100 }).items)).toHaveLength(10);
    } finally {
      await Promise.all(children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
        }
      }));
      await Promise.allSettled(done);
    }
  }, 20_000);
});
