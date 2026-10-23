import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { KeyPair } from 'near-api-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { BrokerService } from '../../src/broker/index.js';
import { SqliteStore } from '../../src/storage/index.js';
import { NativeNearChain } from '../../src/near/index.js';
import { AuditSigner, ReceiptLog } from '../../src/audit/core/index.js';
import { CheckpointLog } from '../../src/audit/checkpoints/index.js';
import { TransactionalApprovalService } from '../../src/approvals/index.js';
import { RequestAuthenticator, generateOwnerKeypair } from '../../src/auth/index.js';
import { startAgentHttpServer } from '../../src/mcp/http/index.js';
import type { AgentPrincipal, CustodySigner, OwnerPrincipal, ReceiptEvent } from '../../src/contracts/index.js';
import { startFakeRpc } from './fake-rpc.js';

export const owner: OwnerPrincipal = { kind: 'owner' };
export const input = (key: string) => ({ idempotencyKey: key, receiverId: 'receiver.testnet', amount: 1n });

export async function createHarness(balanceMaxAgeMs = 60000) {
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  async function close() {
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Performance fixture cleanup failed');
  }
  try {
    const dir = mkdtempSync(join(tmpdir(), 'bb-perf-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const rpc = await startFakeRpc(1);
    cleanup.push(() => rpc.close());
    const store = new SqliteStore(join(dir, 'broker.sqlite'), { accountId: 'perf-broker.testnet' });
    cleanup.push(() => store.close());
    const clock = { now: () => Date.now() };
    const pair = KeyPair.fromRandom('ed25519');
    const signer: CustodySigner = { publicKey: pair.getPublicKey().toString(), sign: async (bytes) => pair.sign(bytes).signature };
    const audit = AuditSigner.generate();
    const receipts = new ReceiptLog(store, audit);
    const chain = await NativeNearChain.connect({ accountId: 'perf-broker.testnet', rpcUrl: rpc.url, clock });
    const broker = new BrokerService({ store, chain, signer, receipts,
      checkpoints: new CheckpointLog(store, audit), approvals: new TransactionalApprovalService(owner, receipts),
      clock, config: { accountId: 'perf-broker.testnet', balanceMaxAgeMs, feeReservePerTx: 10n }, autoDispatch: false });
    const auth = new RequestAuthenticator({ store, clock, ownerPublicKey: generateOwnerKeypair().publicKey });
    await broker.setWalletPolicy(owner, { revision: 1, rolling24hMax: 10n ** 30n, safetyReserve: 0n }, null);
    await broker.start();
    const agents: Array<{ principal: AgentPrincipal; token: string }> = [];
    // Three spenders plus an independent kill-switch probe, so a freeze sample
    // never turns the workload into cheap denials. All share ONE custody lane.
    for (let i = 0; i < 4; i++) {
      const agent = await broker.createAgent(owner, `perf-${i}`);
      await broker.setPolicy(owner, { agentId: agent.id, revision: 1, perTxMax: 100n,
        rolling24hMax: 10n ** 25n, lifetimeMax: 10n ** 25n, gasBudget24h: 10n ** 25n,
        ratePerMinute: 10000, maxOutstanding: 10000, recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: null }, null);
      const { token } = await broker.issueToken(owner, agent.id);
      agents.push({ principal: await auth.authenticateAgent(token), token });
    }
    async function connectClients() {
      const listener = await startAgentHttpServer({ broker, authenticator: auth, clock,
        config: { bindHost: '127.0.0.1', agentPort: 0, allowedHosts: ['127.0.0.1'], allowedOrigins: [] } });
      cleanup.push(() => listener.close());
      const url = new URL(`http://127.0.0.1:${(listener.server.address() as AddressInfo).port}/mcp`);
      const clients: Client[] = [];
      for (const agent of agents) {
        const client = new Client({ name: 'bb-perf', version: '1' });
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        });
        cleanup.push(async () => {
          try { await transport.terminateSession(); } finally { await client.close(); }
        });
        await client.connect(transport as Transport, { timeout: 10000 });
        clients.push(client);
      }
      return clients;
    }
    return { broker, store, rpc, agents, receipts, connectClients, close };
  } catch (error) { await close(); throw error; }
}

/** Fixed-rate, open-loop arrivals, NOT "wait for response, then sleep 50ms".
 * Latency includes lateness against the intended arrival (no coordinated omission).
 * Keep every promise, including failures, and finish them before closing storage.
 */
export async function atRate(count: number, rate: number, work: (i: number, due: number) => Promise<void>) {
  const start = performance.now() + 25;
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const due = start + i * 1000 / rate;
    while (performance.now() < due) await sleep(Math.max(1, due - performance.now()));
    pending.push(work(i, due).catch((error: unknown) => { errors.push(error); }));
  }
  const launchMs = performance.now() - start;
  await Promise.all(pending);
  process.stdout.write(`[perf] offered count=${count} target=${rate}/s actual=${((count - 1) * 1000 / launchMs).toFixed(2)}/s\n`);
  if (errors.length) throw new AggregateError(errors, 'Load operations failed');
  // A slow closed-loop test must not claim that it exercised the required rate.
  if (launchMs > (count - 1) * 1000 / rate + 5000) throw new Error('Could not sustain offered load');
}

export function summary(name: string, samples: number[]) {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('Invalid samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.ceil(sorted.length * 0.50) - 1]!;
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
  process.stdout.write(`[perf] ${name} count=${samples.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms\n`);
  return { count: samples.length, p50, p95 };
}

export function agentReceipts(h: Awaited<ReturnType<typeof createHarness>>, agentId: string): ReceiptEvent[] {
  return h.store.read((r) => {
    const all: ReceiptEvent[] = [];
    for (;;) {
      const page = r.listReceipts(`agent:${agentId}`, all.at(-1)?.seq ?? 0, 1000);
      all.push(...page);
      if (page.length < 1000) return all;
    }
  });
}
