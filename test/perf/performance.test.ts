import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { agentReceipts, atRate, createHarness, input, owner, summary } from './harness.js';

const exec = promisify(execFile);
const COUNT = 1000;
const RATE = 20;
const WARMUP = 30;

function decode(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

// ONE file, sequential tests and no concurrent benchmarks. CI also puts this
// suite in its own step, with other Vitest workers stopped. Never relax targets.
describe.sequential('offline performance budgets (real broker / FULL WAL SQLite / HTTP)', () => {
  beforeAll(async () => {
    // test:perf works from a fresh checkout too. Compile current sources; never
    // measure tsx, a mock CLI, or an old dist. Build time is outside startup time.
    await exec(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
      timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
  }, 70000);

  it('built bin --help startup: p95 <= 1000ms, 30 fresh processes', async () => {
    const samples: number[] = [];
    for (let i = -3; i < 30; i++) {
      const started = performance.now();
      const { stdout } = await exec(process.execPath, [resolve('dist/main.js'), '--help'], {
        timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      });
      const elapsed = performance.now() - started;
      expect(stdout).toContain('Usage: budget-broker');
      if (i >= 0) samples.push(elapsed);
    }
    const stats = summary('built bin startup (limit=1000ms)', samples);
    expect(stats.count).toBe(30);
    expect(stats.p95).toBeLessThanOrEqual(1000);
  }, 360000);

  it('policy + hold + signed receipts -> queued: p95 <= 50ms at 20/s across 3 agents', async () => {
    // A valid 60s snapshot spans this 50s admission-only run: avoid measuring
    // freshness-boundary denials instead of the required policy/hold/receipt path.
    const h = await createHarness(60000);
    try {
      const samples: number[] = [];
      const admitted: Array<{ id: string; agentId: string }> = [];
      for (let i = 0; i < WARMUP; i++) {
        expect((await h.broker.requestTransfer(h.agents[i % 3]!.principal, input(`warm-${i}`))).state).toBe('queued');
      }
      // Exercise the real signer/native adapter/fake send+FINAL shapes, then
      // leave measured admissions queued. No cancellation shortcut or SQL fake.
      await h.broker.drain();
      await atRate(COUNT, RATE, async (i, due) => {
        const principal = h.agents[i % 3]!.principal;
        const request = await h.broker.requestTransfer(principal, input(`admission-${i}`));
        samples.push(performance.now() - due);
        expect(request.state, JSON.stringify(request.reasons)).toBe('queued');
        expect(request.reasons).toEqual([]);
        admitted.push({ id: request.id, agentId: principal.agentId });
      });
      const stats = summary('admission queued (limit=50ms)', samples);
      expect(stats.count).toBe(COUNT);
      expect(new Set(admitted.map((r) => r.id)).size).toBe(COUNT);
      expect(new Set(admitted.map((r) => r.agentId)).size).toBe(3);
      // Post-measurement checks prove admissions paid the hold/accounting/audit
      // cost, rather than timing a preview, replay or fast policy denial.
      h.store.read((r) => {
        for (const request of admitted) {
          expect(r.getRequest(request.id)?.state).toBe('queued');
          expect(r.getHold(request.id)).toMatchObject({ status: 'active', principal: 1n, feeReserve: 10n });
          expect(r.listAccounting({ requestId: request.id }, { limit: 10 }).items.map((e) => e.kind).sort())
            .toEqual(['fee_reserved', 'principal_reserved']);
        }
      });
      for (const agent of h.agents.slice(0, 3)) {
        const events = agentReceipts(h, agent.principal.agentId);
        const ids = new Set(admitted.filter((r) => r.agentId === agent.principal.agentId).map((r) => r.id));
        expect(events.filter((e) => e.type === 'decision_allowed' && ids.has(e.payload.requestId))).toHaveLength(ids.size);
        expect(events.filter((e) => e.type === 'queued' && ids.has(e.payload.requestId))).toHaveLength(ids.size);
        expect(h.receipts.verify(`agent:${agent.principal.agentId}`).valid).toBe(true);
      }
      expect(h.rpc.errors).toEqual([]);
      expect(h.rpc.paid.size).toBe(WARMUP);
      expect(h.rpc.calls.get('query')).toBeGreaterThan(3); // real adapter account/access-key reads, not caller balance
      expect(stats.p95).toBeLessThanOrEqual(50);
    } finally { await h.close(); }
  }, 180000);

  it('MCP queued ack <= 250ms and freeze ack <= 200ms during 20/s load', async () => {
    const h = await createHarness();
    let stop = false;
    let pumping: Promise<void> | undefined;
    const pumpErrors: unknown[] = [];
    const freezes: Promise<void>[] = [];
    const freezeErrors: unknown[] = [];
    try {
      const clients = await h.connectClients();
      const probe = h.agents[3]!.principal;
      async function transfer(i: number, key: string) {
        return clients[i % 3]!.callTool({ name: 'request_transfer', arguments: { ...input(key), amount: '1' } }, undefined, { timeout: 15000 });
      }
      for (let i = 0; i < WARMUP; i++) expect(decode(await transfer(i, `warm-http-${i}`))['state']).toBe('queued');
      await h.broker.drain();
      for (let i = 0; i < 3; i++) {
        expect(decode(await clients[3]!.callTool({ name: 'freeze_self', arguments: { reason: 'warmup' } }))['frozen']).toBe(true);
        await h.broker.unfreeze(owner, { scope: 'agent', agentId: probe.agentId }, 'warmup complete');
      }
      // The real dispatch lane stays active against 1ms/RPC loopback testnet.
      // One pump promise: no overlapping timers and every operation is joined.
      pumping = (async () => {
        while (!stop) { await h.broker.drain(); if (!stop) await sleep(10); }
      })().catch((error: unknown) => { pumpErrors.push(error); });
      const acks: number[] = [];
      const freezeAcks: number[] = [];
      const ids = new Set<string>();
      await atRate(COUNT, RATE, async (i, due) => {
        // 100 kill-switch calls, offset between arrivals; never replace the
        // spending stream with frozen denials. The probe shares the custody lane.
        if (i % 10 === 0) {
          const freezeDue = due + 25;
          freezes.push((async () => {
            while (performance.now() < freezeDue) await sleep(Math.max(1, freezeDue - performance.now()));
            try {
              const result = await clients[3]!.callTool({ name: 'freeze_self', arguments: { reason: `load-${i}` } }, undefined, { timeout: 15000 });
              freezeAcks.push(performance.now() - freezeDue);
              expect(decode(result)).toMatchObject({ frozen: true, scope: 'agent', agentId: probe.agentId });
              expect(h.store.read((r) => r.getFreeze('agent', probe.agentId)?.frozen)).toBe(true);
            } finally {
              await h.broker.unfreeze(owner, { scope: 'agent', agentId: probe.agentId }, 'next performance sample');
            }
          })().catch((error: unknown) => { freezeErrors.push(error); }));
        }
        const result = await transfer(i, `http-${i}`);
        acks.push(performance.now() - due);
        const request = decode(result);
        expect(request['state']).toBe('queued');
        expect(request['amount']).toBe('1');
        expect(typeof request['id']).toBe('string');
        ids.add(request['id'] as string);
      });
      await Promise.all(freezes);
      const ackStats = summary('MCP HTTP queued ack (limit=250ms)', acks);
      const freezeStats = summary('MCP HTTP freeze ack under load (limit=200ms)', freezeAcks);
      stop = true; await pumping;
      await h.broker.drain(); // final arrival may have acknowledged during the pump's sleep
      expect(ackStats.count).toBe(COUNT);
      expect(ids.size).toBe(COUNT);
      expect(freezeStats.count).toBe(100);
      expect(freezeErrors).toEqual([]);
      expect(pumpErrors).toEqual([]);
      expect(h.rpc.errors).toEqual([]);
      expect(h.rpc.paid.size).toBe(COUNT + WARMUP);
      for (const agent of h.agents) expect(h.receipts.verify(`agent:${agent.principal.agentId}`).valid).toBe(true);
      expect(agentReceipts(h, probe.agentId).filter((e) => e.type === 'freeze' && e.payload.reason.startsWith('load-'))).toHaveLength(100);
      expect(ackStats.p95).toBeLessThanOrEqual(250);
      expect(freezeStats.p95).toBeLessThanOrEqual(200);
    } finally {
      stop = true;
      await Promise.all(freezes);
      await pumping;
      await h.close();
    }
  }, 240000);
});
