import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
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

test.each(['queued', 'approved'] as const)('%s work expires at the original 300 s deadline even while globally frozen; unfreeze cannot revive its key', async (state) => {
  const f = new Fixture({ autoDispatch: false });
  try {
    await f.init();
    const agent = await f.agent(state, { approvalThreshold: state === 'approved' ? 0n : null });
    const input = f.input(`frozen-${state}`);
    const admitted = await f.broker.requestTransfer(agent, input);
    if (state === 'approved') {
      // Exercise the production approval transition's persisted intermediate
      // state (before BrokerService moves approved -> queued), as after a crash.
      f.store.withImmediateTransaction((tx) => f.options.approvals.approve(tx, {
        requestId: admitted.id, approvalId: randomUUID(), expiresAt: f.now + 600_000, now: f.now,
      }));
    }
    expect((await f.broker.getRequest(agent, admitted.id)).state).toBe(state);
    expect(admitted.expiresAt! - admitted.createdAt).toBe(300_000);
    await f.broker.freeze(owner, { scope: 'global' }, 'pause dispatch');
    f.now += 299_999;
    await f.broker.drain();
    expect((await f.broker.getRequest(agent, admitted.id)).state).toBe(state);
    expect(f.store.read((r) => r.getHold(admitted.id))).toMatchObject({ principal: input.amount, feeReserve: 10n, status: 'active' });
    f.now++;
    await f.broker.drain();
    const expired = await f.broker.getRequest(agent, admitted.id);
    expect(expired.state).toBe('expired');
    expect(f.store.read((r) => r.getHold(admitted.id)?.status)).toBe('released');
    expect(await f.broker.requestTransfer(agent, input)).toEqual(expired);
    await f.broker.unfreeze(owner, { scope: 'global' }, 'resume after review');
    await f.broker.drain();
    expect(await f.broker.requestTransfer(agent, input)).toEqual(expired);
    expect(f.chain.built).toHaveLength(0);
    expect(f.chain.broadcasts).toHaveLength(0);
  } finally { f.close(); }
});

test.each([60_000, 600_000])('owner approval expiry %i ms is capped at the unchanged original request deadline', async (ttl) => {
  const f = new Fixture({ autoDispatch: false });
  try {
    await f.init();
    const agent = await f.agent('approval-deadline', { approvalThreshold: 0n });
    const pending = await f.broker.requestTransfer(agent, f.input('approval-deadline'));
    const approved = await f.broker.approve(owner, pending.id, f.now + ttl);
    expect(approved.state).toBe('queued');
    expect(approved.expiresAt).toBe(pending.expiresAt);
    expect(f.store.read((r) => r.getRequestApproval(pending.id)?.expiresAt)).toBe(pending.createdAt + Math.min(ttl, 300_000));
  } finally { f.close(); }
});

test('queued work cannot adopt an unbound standing grant and requires owner approval instead', async () => {
  const f = new Fixture({ autoDispatch: false });
  try {
    await f.init();
    const agent = await f.agent('unbound-standing', { approvalThreshold: null });
    const input = f.input('unbound-standing');
    const queued = await f.broker.requestTransfer(agent, input);
    expect(queued.state).toBe('queued');
    expect(queued.approvalRef).toBeNull();
    const policy = (await f.broker.getPolicy(owner, agent.agentId))!;
    await f.broker.setPolicy(owner, { ...policy, revision: 2, approvalThreshold: 0n }, 1);
    const grant = await f.broker.grantStandingApproval(owner, { agentId: agent.agentId,
      perTxMax: input.amount, totalMax: input.amount, expiresAt: f.now + 600_000 });
    await f.broker.drain();
    const pending = await f.broker.getRequest(agent, queued.id);
    expect(pending).toMatchObject({ state: 'pending_approval', approvalRef: null,
      reasons: ['APPROVAL_REQUIRED'], expiresAt: queued.expiresAt });
    expect(f.store.read((r) => r.getHold(queued.id)?.status)).toBe('active');
    expect(f.store.read((r) => r.getStandingApproval(grant.id)?.usedTotal)).toBe(0n);
    expect(f.chain.built).toHaveLength(0);
    expect(f.chain.broadcasts).toHaveLength(0);
    expect(await f.broker.requestTransfer(agent, input)).toEqual(pending);
    await f.broker.approve(owner, queued.id, f.now + 60_000);
    await f.broker.drain();
    expect((await f.broker.getRequest(agent, queued.id)).state).toBe('succeeded');
    expect(f.store.read((r) => r.getStandingApproval(grant.id)?.usedTotal)).toBe(0n);
    expect(f.chain.broadcasts).toHaveLength(1);
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
