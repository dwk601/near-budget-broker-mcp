import { afterEach, describe, expect, it } from 'vitest';
import { AuditSigner, ReceiptLog } from '../../../src/audit/core/index.js';
import { RECEIPT_EVENT_TYPES } from '../../../src/contracts/index.js';
import type { AppendReceipt } from '../../../src/contracts/index.js';
import { SqliteStore } from '../../../src/storage/index.js';

const decision = { requestId: 'r1', agentId: 'a1', receiverId: 'bob.testnet', amount: '1',
  requestDigest: 'a'.repeat(64), policyRevision: 1, approvalRef: null };
const request = { requestId: 'r1', agentId: 'a1' };
const settlement = { ...request, txHash: '1'.repeat(32), receiptIds: ['2'.repeat(32)], gasBurnt: '100', tokensBurnt: '50' };
const standing = { id: 's1', agentId: 'a1', perTxMax: '1', totalMax: '5', usedTotal: '0', expiresAt: 100 };
const agentPolicy = { agentId: 'a1', revision: 1, perTxMax: '1', rolling24hMax: '10', lifetimeMax: '100',
  gasBudget24h: '3', ratePerMinute: 1, maxOutstanding: 1, recipients: { mode: 'allow_all' as const, accounts: [] }, approvalThreshold: null };
const variants = [
  { type: 'decision_allowed', payload: { ...decision, reasons: [] } },
  { type: 'decision_denied', payload: { ...decision, reasons: ['PER_TX_EXCEEDED'] } },
  { type: 'approval_required', payload: { ...decision, reasons: ['APPROVAL_REQUIRED'] } },
  { type: 'approved', payload: { ...request, approvalId: 'p1', requestDigest: 'a'.repeat(64), policyRevision: 1, expiresAt: 100 } },
  { type: 'rejected', payload: { ...request, reason: 'owner rejected' } },
  { type: 'expired', payload: { ...request, reason: 'expired' } },
  { type: 'cancelled', payload: { ...request, reason: 'cancelled' } },
  { type: 'standing_approval_granted', payload: { agentId: 'a1', approval: standing } },
  { type: 'standing_approval_revoked', payload: { agentId: 'a1', approvalId: 's1', revokedAt: 50 } },
  { type: 'standing_approval_used', payload: { ...request, approvalId: 's1', amount: '1' } },
  { type: 'queued', payload: request },
  { type: 'submitted', payload: { ...request, attemptId: 't1', txHash: '1'.repeat(32), phase: 'intent' } },
  { type: 'succeeded', payload: settlement },
  { type: 'failed', payload: { ...settlement, reason: 'execution failed' } },
  { type: 'outcome_unknown', payload: { ...request, attemptId: 't1', txHash: '1'.repeat(32), reason: 'timeout' } },
  { type: 'freeze', payload: { scope: 'agent', agentId: 'a1', frozen: true, reason: 'halt', at: 1 } },
  { type: 'unfreeze', payload: { scope: 'agent', agentId: 'a1', frozen: false, reason: 'resume', at: 2 } },
  { type: 'policy_updated', payload: { scope: 'agent', policy: agentPolicy } },
  { type: 'agent_created', payload: { agent: { id: 'a1', name: 'one', status: 'active', createdAt: 1 } } },
  { type: 'agent_revoked', payload: { agentId: 'a1', reason: 'revoked' } },
  { type: 'credential_issued', payload: { agentId: 'a1', credentialId: 'c1' } },
  { type: 'credential_revoked', payload: { agentId: 'a1', credentialId: 'c1' } },
] satisfies Omit<AppendReceipt, 'chainId' | 'at'>[];
const events = variants.map((event) => ({ ...event, chainId: 'agent:a1', at: 3 })) as AppendReceipt[];
const stores: SqliteStore[] = [];
function setup(): { store: SqliteStore; log: ReceiptLog } {
  const store = new SqliteStore(':memory:', { accountId: 'broker.testnet' }); stores.push(store);
  return { store, log: new ReceiptLog(store, AuditSigner.generate()) };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('strict per-type payload validation', () => {
  it('covers every frozen receipt type', () => {
    expect(variants.map((event) => event.type)).toEqual([...RECEIPT_EVENT_TYPES]);
  });
  it.each(events)('appends, signs, validates and scopes $type', (event) => {
    const { store, log } = setup();
    const receipt = store.withImmediateTransaction((tx) => log.append(tx, event));
    expect(receipt.type).toBe(event.type);
    expect(receipt.payload).toEqual(event.payload);
    expect(log.verify('agent:a1').valid).toBe(true);
    expect(log.verifyReceipt(receipt).valid).toBe(true);
    for (const invalid of [
      { ...event, payload: {} },
      { ...event, payload: { ...event.payload, secretKey: 'must not be audited' } },
      { ...event, chainId: 'agent:a2' },
      { ...event, at: -1 },
      { ...event, unexpected: true },
    ]) {
      expect(() => store.withImmediateTransaction((tx) => log.append(tx, invalid as AppendReceipt)))
        .toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    }
    expect(log.list('agent:a1', 0, 100)).toHaveLength(1);
    expect(log.list('agent:a2', 0, 100)).toHaveLength(0);
    expect(log.verifyReceipt({ ...receipt, payload: { ...receipt.payload, extra: 'invalid' } } as unknown as typeof receipt).valid).toBe(false);
  });

  it('global freeze and wallet policies are owner-only; administrative agent events may be copied to owner', () => {
    const { store, log } = setup();
    const ownerOnly: AppendReceipt[] = [
      { chainId: 'owner', at: 1, type: 'freeze', payload: { scope: 'global', frozen: true, reason: 'halt', at: 1 } },
      { chainId: 'owner', at: 2, type: 'unfreeze', payload: { scope: 'global', frozen: false, reason: 'resume', at: 2 } },
      { chainId: 'owner', at: 3, type: 'policy_updated', payload: { scope: 'wallet', policy: { revision: 1, rolling24hMax: '10', safetyReserve: '1' } } },
    ];
    for (const event of ownerOnly) {
      expect(() => store.withImmediateTransaction((tx) => log.append(tx, { ...event, chainId: 'agent:a1' })))
        .toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
      store.withImmediateTransaction((tx) => log.append(tx, event));
    }
    store.withImmediateTransaction((tx) => log.append(tx, { ...events[18]!, chainId: 'owner' }));
    expect(log.verify('owner')).toMatchObject({ valid: true, checked: 4 });
    expect(log.list('agent:a1', 0, 100)).toEqual([]);
  });

  it('enforces wire amounts, nested identities, mandatory phase and per-type semantics', () => {
    const { store, log } = setup();
    const invalid: unknown[] = [
      { ...events[0], payload: { ...decision, amount: 1n, reasons: [] } },
      { ...events[0], payload: { ...decision, amount: '01', reasons: [] } },
      { ...events[0], payload: { ...decision, amount: (1n << 128n).toString(), reasons: [] } },
      { ...events[0], payload: { ...decision, reasons: ['FORBIDDEN'] } },
      { ...events[1], payload: { ...decision, reasons: [] } },
      { ...events[2], payload: { ...decision, reasons: ['FORBIDDEN'] } },
      { ...events[7], payload: { agentId: 'a1', approval: { ...standing, agentId: 'a2' } } },
      { ...events[7], payload: { agentId: 'a1', approval: { ...standing, usedTotal: '6' } } },
      { ...events[11], payload: { ...request, attemptId: 't1', txHash: '1'.repeat(32) } },
      { ...events[11], payload: { ...request, attemptId: 't1', txHash: '1'.repeat(32), phase: 'sent' } },
      { ...events[15], payload: { scope: 'agent', agentId: 'a1', frozen: false, reason: 'wrong', at: 1 } },
      { ...events[16], payload: { scope: 'agent', agentId: 'a1', frozen: true, reason: 'wrong', at: 1 } },
      { ...events[17], payload: { scope: 'agent', policy: { ...agentPolicy, agentId: 'a2' } } },
      { ...events[18], payload: { agent: { id: 'a2', name: 'two', status: 'active', createdAt: 1 } } },
      { ...events[20], payload: { agentId: 'a1', credentialId: 'c1', token: 'plaintext' } },
    ];
    for (const event of invalid) {
      expect(() => store.withImmediateTransaction((tx) => log.append(tx, event as AppendReceipt)))
        .toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    }
    expect(log.list('agent:a1', 0, 100)).toEqual([]);
    store.withImmediateTransaction((tx) => log.append(tx, { chainId: 'agent:a1', at: 3, type: 'submitted',
      payload: { ...request, attemptId: 't1', txHash: '1'.repeat(32), phase: 'acknowledged' } }));
    expect(log.verify('agent:a1').valid).toBe(true);
  });

  it('rejects lossy non-JSON objects before parsing or signing and snapshots caller payloads', () => {
    const { store, log } = setup();
    let calls = 0;
    const getter = Object.defineProperty({ agentId: 'a1' }, 'requestId', { enumerable: true, get() { calls++; return 'r1'; } });
    const hidden = Object.defineProperty({ agentId: 'a1', requestId: 'r1' }, 'secret', { value: 'hidden' });
    for (const payload of [getter, hidden, { agentId: 'a1', requestId: 'r1', extra: undefined },
      { agentId: 'a1', requestId: '\ud800' }, Object.assign(new Date(), { agentId: 'a1', requestId: 'r1' })]) {
      expect(() => store.withImmediateTransaction((tx) => log.append(tx, { chainId: 'agent:a1', type: 'queued', at: 1, payload } as AppendReceipt)))
        .toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    }
    expect(calls).toBe(0);
    const payload = { agentId: 'a1', requestId: 'r1' };
    const receipt = store.withImmediateTransaction((tx) => log.append(tx, { chainId: 'agent:a1', type: 'queued', at: 1, payload }));
    payload.requestId = 'changed after append';
    expect(receipt.payload).toEqual({ agentId: 'a1', requestId: 'r1' });
    expect(log.verify('agent:a1').valid).toBe(true);
  });
});
