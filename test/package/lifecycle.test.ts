import { expect, test } from 'vitest';
import { Fixture, owner } from '../broker/fixtures.js';

// Execute the production defaults behind the documented approval/retry workflow.
test('pending approvals expire at 300 seconds, release both holds and retain the consumed key', async () => {
  const f = new Fixture({ autoDispatch: false });
  try {
    await f.init();
    const agent = await f.agent('expiry', { approvalThreshold: 0n });
    const input = f.input('approval-expiry');
    const pending = await f.broker.requestTransfer(agent, input);
    expect(pending.state).toBe('pending_approval');
    expect(pending.expiresAt! - pending.createdAt).toBe(300_000);
    f.now += 299_999;
    await f.broker.expirePending();
    expect((await f.broker.getRequest(agent, pending.id)).state).toBe('pending_approval');
    expect(f.store.read((r) => r.getHold(pending.id))).toMatchObject({ principal: input.amount, feeReserve: 10n, status: 'active' });
    f.now++;
    await f.broker.expirePending();
    const expired = await f.broker.getRequest(agent, pending.id);
    expect(expired.state).toBe('expired');
    expect(f.store.read((r) => r.getHold(pending.id)?.status)).toBe('released');
    expect(await f.broker.requestTransfer(agent, input)).toEqual(expired);
    expect((await f.broker.requestTransfer(agent, { ...input, idempotencyKey: 'owner-authorized-replacement' })).id).not.toBe(pending.id);
  } finally { f.close(); }
});

test.each([60_000, 600_000])('owner approval expiry %i ms can shorten but never extend the original deadline', async (ttl) => {
  const f = new Fixture({ autoDispatch: false });
  try {
    await f.init();
    const agent = await f.agent('approval-deadline', { approvalThreshold: 0n });
    const pending = await f.broker.requestTransfer(agent, f.input('approval-deadline'));
    const approved = await f.broker.approve(owner, pending.id, f.now + ttl);
    expect(approved.state).toBe('queued');
    expect(f.store.read((r) => r.getRequestApproval(pending.id)?.expiresAt)).toBe(pending.createdAt + Math.min(ttl, 300_000));
  } finally { f.close(); }
});

test.each(['rejected', 'cancelled'] as const)('%s unsent requests release holds but permanently retain their keys', async (state) => {
  const f = new Fixture({ autoDispatch: false });
  try {
    await f.init();
    const agent = await f.agent(state, { approvalThreshold: 0n });
    const input = f.input(state);
    const pending = await f.broker.requestTransfer(agent, input);
    if (state === 'rejected') await f.broker.reject(owner, pending.id, 'owner says no');
    else await f.broker.cancelRequest(agent, pending.id);
    const terminal = await f.broker.getRequest(agent, pending.id);
    expect(terminal.state).toBe(state);
    expect(f.store.read((r) => r.getHold(pending.id)?.status)).toBe('released');
    f.now += 120_000;
    expect(await f.broker.requestTransfer(agent, input)).toEqual(terminal);
  } finally { f.close(); }
});

test.each(['RATE_LIMITED', 'MAX_OUTSTANDING'] as const)('%s stored denials are not retried by replaying their key after capacity recovers', async (reason) => {
  const f = new Fixture({ autoDispatch: false });
  try {
    await f.init();
    const agent = await f.agent(reason, reason === 'RATE_LIMITED' ? { ratePerMinute: 1 } : { maxOutstanding: 1 });
    const first = await f.broker.requestTransfer(agent, f.input('occupy-slot'));
    const input = f.input('denied-key');
    const denied = await f.broker.requestTransfer(agent, input);
    expect(denied.state).toBe('denied');
    expect(denied.reasons).toContain(reason);
    expect(f.store.read((r) => r.getHold(denied.id))).toBeNull();
    await f.broker.cancelRequest(agent, first.id);
    f.now += 120_000;
    expect(await f.broker.requestTransfer(agent, input)).toEqual(denied);
    expect((await f.broker.requestTransfer(agent, { ...input, idempotencyKey: 'owner-authorized-new-request' })).state).toBe('queued');
  } finally { f.close(); }
});
