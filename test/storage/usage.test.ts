import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StoreTransaction, TransferRequest, UsageSnapshot } from '../../src/contracts/index.js';
import { SqliteStore } from '../../src/storage/index.js';
import { ACCOUNT, HASH, HASH2, KEY, NOW, agent, attempt, request } from './fixtures.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const PRINCIPAL = 9_007_199_254_740_993n;
const GAS = 9_007_199_254_740_995n;
const stores: SqliteStore[] = [];
const dirs: string[] = [];
function open(filename = ':memory:'): SqliteStore {
  const store = new SqliteStore(filename, { accountId: ACCOUNT }); stores.push(store); return store;
}
function seed(store: SqliteStore): void {
  store.transaction((tx) => {
    tx.putAgent({ ...agent(), createdAt: NOW - 2 * 365 * DAY });
    tx.putAgent({ ...agent('b'), createdAt: NOW - 2 * 365 * DAY });
  });
}

/** Real Store writes through the complete signing/settlement state path. */
function settle(tx: StoreTransaction, r: TransferRequest, at: number, fee: bigint, hash: string, success = true): void {
  tx.insertRequest(r);
  tx.putHold({ requestId: r.id, agentId: r.agentId, principal: r.amount, feeReserve: 0n, status: 'active' });
  const nonce = tx.allocateNonce(KEY, 0n);
  const a = { ...attempt(`attempt-${r.id}`, r.id, nonce, hash), createdAt: r.createdAt, updatedAt: at };
  tx.putAttempt(a);
  const signed = { ...r, state: 'signed' as const, txHash: hash, signedAt: at, updatedAt: at };
  tx.updateRequest(signed, 'queued');
  const submitted = { ...signed, state: 'submitted' as const, submittedAt: at };
  tx.putAttempt({ ...a, status: 'submitted' });
  tx.updateRequest(submitted, 'signed');
  const state = success ? 'succeeded' : 'failed';
  tx.putAttempt({ ...a, status: state, gasBurnt: 123n, tokensBurnt: fee });
  tx.updateRequest({ ...submitted, state, gasBurnt: 123n, tokensBurnt: fee, completedAt: at }, 'submitted');
  tx.putHold({ requestId: r.id, agentId: r.agentId, principal: r.amount, feeReserve: 0n, status: 'committed' });
  if (success) tx.appendAccounting({ id: `principal-${r.id}`, requestId: r.id, agentId: r.agentId, kind: 'principal_committed', amount: r.amount, at });
  tx.appendAccounting({ id: `gas-${r.id}`, requestId: r.id, agentId: r.agentId, kind: 'gas_charged', amount: fee, at });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('real getUsageSnapshot windows and reservation exclusion', () => {
  it.each([
    { offset: -DAY - 1, included: false },
    { offset: -DAY, included: false },
    { offset: -DAY + 1, included: true },
    { offset: -1, included: true },
    { offset: 0, included: true },
    { offset: 1, included: false },
  ])('settled principal and actual fees use exclusive (now-24h, now], offset=$offset', ({ offset, included }) => {
    const store = open(); seed(store);
    store.transaction((tx) => {
      const at = NOW + offset;
      settle(tx, request('success-a', 'a', PRINCIPAL, NOW - 3 * DAY), at, GAS, HASH);
      settle(tx, request('success-b', 'b', 17n, NOW - 3 * DAY), at, 29n, HASH2);
      settle(tx, request('failed-a', 'a', 31n, NOW - 3 * DAY), at, 47n, '3'.repeat(32), false);
    });
    const usage = store.read((v) => v.getUsageSnapshot('a', NOW));
    expect(usage).toMatchObject({
      agentRolling24h: included ? PRINCIPAL : 0n,
      walletRolling24h: included ? PRINCIPAL + 17n : 0n,
      agentGas24h: included ? GAS + 47n : 0n, // Failed execution still charges actual gas.
      agentLifetime: offset <= 0 ? PRINCIPAL : 0n, // Old success never expires from lifetime.
      agentOutstanding: 0, agentRequestsLastMinute: 0, outstandingHolds: 0n,
    });
    // Successful and failed committed holds do not add a second reservation.
    expect(usage.standingReserved).toEqual({});
  });

  it.each([
    { offset: -MINUTE - 1, included: false },
    { offset: -MINUTE, included: false },
    { offset: -MINUTE + 1, included: true },
    { offset: -1, included: true },
    { offset: 0, included: true },
    { offset: 1, included: false },
  ])('distinct admissions use exclusive (now-60s, now], offset=$offset', ({ offset, included }) => {
    const store = open(); seed(store);
    const pending = { ...request('pending', 'a', 1n, NOW + offset), state: 'pending_approval' as const, reasons: ['APPROVAL_REQUIRED' as const] };
    const cancelled = request('cancelled', 'a', 1n, NOW + offset);
    store.transaction((tx) => {
      tx.insertRequest(pending);
      tx.putHold({ requestId: pending.id, agentId: 'a', principal: 1n, feeReserve: 2n, status: 'active' });
      tx.insertRequest(pending); // Idempotent replay is not a second admission.
      tx.insertRequest(cancelled);
      tx.putHold({ requestId: cancelled.id, agentId: 'a', principal: 1n, feeReserve: 2n, status: 'active' });
      tx.updateRequest({ ...cancelled, state: 'cancelled' }, 'queued');
      tx.putHold({ requestId: cancelled.id, agentId: 'a', principal: 1n, feeReserve: 2n, status: 'released' });
      tx.insertRequest({ ...request('denied', 'a', 1n, NOW + offset), state: 'denied', reasons: ['NO_POLICY'] });
      tx.insertRequest(request('other-agent', 'b', 1n, NOW + offset));
    });
    expect(store.read((v) => v.getUsageSnapshot('a', NOW).agentRequestsLastMinute)).toBe(included ? 2 : 0);
    expect(store.read((v) => v.getUsageSnapshot('b', NOW).agentRequestsLastMinute)).toBe(included ? 1 : 0);
    expect(store.read((v) => v.getUsageSnapshot('a', NOW, 'pending').agentRequestsLastMinute)).toBe(included ? 1 : 0);
    expect(store.read((v) => v.getUsageSnapshot('a', NOW, 'denied').agentRequestsLastMinute)).toBe(included ? 2 : 0);
    expect(store.read((v) => v.getUsageSnapshot('a', NOW, 'other-agent').agentRequestsLastMinute)).toBe(included ? 2 : 0);
  });

  it.each([DAY, DAY + 1, 10 * DAY, 365 * DAY].flatMap((age) =>
    (['pending_approval', 'queued', 'signed', 'submitted', 'outcome_unknown'] as const).map((state) => ({ age, state }))))(
    'active $state holds never age out (age=$age), and own-hold exclusion is exact across reopen', ({ age, state }) => {
      const dir = mkdtempSync(join(tmpdir(), 'budget-usage-')); dirs.push(dir);
      const filename = join(dir, 'state.sqlite'); const store = open(filename); seed(store);
      const old = NOW - age;
      const r = { ...request('own-old', 'a', PRINCIPAL, old), approvalRef: { kind: 'standing' as const, id: 'grant' } };
      store.transaction((tx) => {
        tx.putStandingApproval({ id: 'grant', agentId: 'a', perTxMax: PRINCIPAL, totalMax: PRINCIPAL * 2n, usedTotal: 0n, expiresAt: NOW - 1 });
        tx.insertRequest({ ...r, state: state === 'pending_approval' ? state : 'queued' });
        tx.putHold({ requestId: r.id, agentId: 'a', principal: PRINCIPAL, feeReserve: 7n, status: 'active' });
        if (state === 'signed' || state === 'submitted' || state === 'outcome_unknown') {
          const nonce = tx.allocateNonce(KEY, 0n);
          const a = { ...attempt('old-attempt', r.id, nonce, HASH), createdAt: old, updatedAt: old };
          tx.putAttempt(a);
          const signed = { ...r, state: 'signed' as const, txHash: HASH, signedAt: old };
          tx.updateRequest(signed, 'queued');
          if (state !== 'signed') {
            tx.putAttempt({ ...a, status: 'submitted' });
            const submitted = { ...signed, state: 'submitted' as const, submittedAt: old };
            tx.updateRequest(submitted, 'signed');
            if (state === 'outcome_unknown') {
              tx.putAttempt({ ...a, status: 'outcome_unknown' });
              tx.updateRequest({ ...submitted, state: 'outcome_unknown' }, 'submitted');
            }
          }
        }
        tx.insertRequest({ ...request('other-old', 'b', 13n, old), state: 'pending_approval' });
        tx.putHold({ requestId: 'other-old', agentId: 'b', principal: 13n, feeReserve: 11n, status: 'active' });
        // Background settled usage must NOT vanish when excluding this hold.
        settle(tx, request('settled-background', 'a', 3n, old), NOW, 5n, '3'.repeat(32));
      });
      const expected: UsageSnapshot = {
        agentRolling24h: PRINCIPAL + 3n, agentLifetime: PRINCIPAL + 3n, agentGas24h: 12n,
        agentRequestsLastMinute: 0, agentOutstanding: 1, walletRolling24h: PRINCIPAL + 16n,
        outstandingHolds: PRINCIPAL + 31n, standingReserved: { grant: PRINCIPAL }, balance: null, agentFrozen: false, globalFrozen: false,
      };
      const excludingSelf: UsageSnapshot = { ...expected, agentRolling24h: 3n, agentLifetime: 3n, agentGas24h: 5n,
        agentOutstanding: 0, walletRolling24h: 16n, outstandingHolds: 24n, standingReserved: {} };
      expect(store.transaction((tx) => tx.getUsageSnapshot('a', NOW))).toEqual(expected);
      expect(store.read((v) => v.getUsageSnapshot('a', NOW, r.id))).toEqual(excludingSelf);
      store.close(); const reopened = open(filename);
      expect(reopened.read((v) => v.getUsageSnapshot('a', NOW))).toEqual(expected);
      expect(reopened.read((v) => v.getUsageSnapshot('a', NOW, r.id))).toEqual(excludingSelf);
      expect(reopened.read((v) => v.getRequest(r.id)?.state)).toBe(state);
      if (state === 'signed' || state === 'submitted' || state === 'outcome_unknown') {
        expect(reopened.read((v) => v.listOutbox({ limit: 10 }).items.map((a) => a.status))).toEqual([state]);
      }
    },
  );
});
