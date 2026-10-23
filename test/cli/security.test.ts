import { expect, it } from 'vitest';
import { request } from 'node:http';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { startDaemon } from '../../src/daemon/index.js';
import { OwnerClient } from '../../src/cli/client.js';
import { signOwnerRequest } from '../../src/auth/index.js';
import { SqliteStore } from '../../src/storage/index.js';
import { json } from '../../src/daemon/wire.js';
import { runCli } from '../../src/cli/index.js';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { fixture, port } from './helpers.js';

it('admin verifies exact bytes/path/method, duplicate JSON/headers, Host and Origin', async () => {
  const f = await fixture(); const daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, log: () => {} });
  try {
    const url = `http://127.0.0.1:${f.config.adminPort}`; const path = '/admin/createAgent'; const body = '{"name":"first"}';
    const headers = signOwnerRequest(f.owner.secretKey, 'POST', path, body);
    expect((await fetch(`${url}${path}`, { method: 'POST', headers, body: '{"name":"second"}' })).status).toBe(401);
    expect((await fetch(`${url}/admin/listAgents`, { method: 'POST', headers, body })).status).toBe(401);
    expect((await fetch(`${url}${path}`, { method: 'PUT', headers, body })).status).toBe(401);
    for (const raw of ['{"name":"a","na\\u006de":"b"}', '{"name":1.5}', '{"name":"a","extra":true}']) {
      expect((await fetch(`${url}${path}`, { method: 'POST', headers: signOwnerRequest(f.owner.secretKey, 'POST', path, raw), body: raw })).status).toBe(403);
    }
    for (const extra of [{ Host: `evil.example:${f.config.adminPort}` }, { Host: `127.0.0.1:${f.config.agentPort}` }, { Origin: 'null' }, { Origin: 'https://evil.example' }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(url + path, { method: 'POST', headers: { ...headers, ...extra } }, (res) => { res.resume(); resolve(res.statusCode!); });
        req.on('error', reject); req.end(body);
      });
      expect(status).toBe(403);
    }
    const duplicated = await new Promise<number>((resolve, reject) => {
      const h = Object.entries(headers).flatMap(([k, v]) => [k, v]);
      const req = request(url + path, { method: 'POST', headers: ['Host', `127.0.0.1:${f.config.adminPort}`, ...h, 'x-bb-owner-nonce', headers['x-bb-owner-nonce'], 'Content-Length', String(Buffer.byteLength(body))] }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end(body);
    });
    expect(duplicated).toBe(401);
    const owner = new OwnerClient(url, f.owner.secretKey);
    for (const perTxMax of [1.5, '01', '-1']) {
      const path = '/admin/grantStandingApproval';
      const body = JSON.stringify({ grant: { agentId: 'unknown', perTxMax, totalMax: '1', expiresAt: Date.now() + 60_000 } });
      const result = await fetch(url + path, { method: 'POST', body, headers: signOwnerRequest(f.owner.secretKey, 'POST', path, body) });
      expect(result.status).toBe(403); expect(await result.json()).toMatchObject({ error: { code: 'INVALID_AMOUNT' } });
    }
    expect(await owner.call('listAgents', { limit: 100 })).toMatchObject({ items: [] });
    // Failed tampering attempts do not consume the nonce of the authentic request.
    expect((await fetch(url + path, { method: 'POST', headers, body })).status).toBe(200);
  } finally { await daemon.close(); await f.cleanup(); }
});

it('per-key singleton covers different data directories in the same OS namespace', async () => {
  const f = await fixture(); const daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, log: () => {} });
  try {
    const dataDir = join(f.dir, 'second');
    await expect(startDaemon({ config: { ...f.config, dataDir, auditKeyPath: join(dataDir, 'audit.pem'), agentPort: await port(), adminPort: await port() }, dependencies: f.dependencies, log: () => {} })).rejects.toThrow('Exclusive custody lock');
    await expect(readFile(join(dataDir, 'daemon.lock'))).rejects.toThrow();
  } finally { await daemon.close(); await f.cleanup(); }
});

it('scheduler expires pending work; close awaits an in-flight owner call before closing store', async () => {
  const f = await fixture(); let now = Date.now(); f.dependencies.clock.now = () => now;
  const daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, intervalMs: 20, log: () => {} });
  const store = new SqliteStore(join(f.config.dataDir, 'broker.sqlite'), { accountId: f.config.accountId });
  let release: (() => void) | undefined;
  let alreadyClosed = false;
  try {
    const owner = new OwnerClient(`http://127.0.0.1:${f.config.adminPort}`, f.owner.secretKey);
    const agent = await owner.call('createAgent', { name: 'scheduler' }) as { id: string };
    const input = { agentId: agent.id, revision: 1, perTxMax: '100', rolling24hMax: '100', lifetimeMax: '100', gasBudget24h: '100', ratePerMinute: 10, maxOutstanding: 5,
      recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: '0' };
    await owner.call('setPolicy', { policy: input, expectedRevision: null });
    await owner.call('setWalletPolicy', { policy: { revision: 1, rolling24hMax: '1000', safetyReserve: '0' }, expectedRevision: null });
    const { RequestAuthenticator } = await import('../../src/auth/index.js');
    const { BrokerService } = await import('../../src/broker/index.js');
    const { AuditSigner, ReceiptLog } = await import('../../src/audit/core/index.js');
    const { CheckpointLog } = await import('../../src/audit/checkpoints/index.js');
    const { TransactionalApprovalService } = await import('../../src/approvals/index.js');
    const signer = AuditSigner.load(f.config.auditKeyPath); const receipts = new ReceiptLog(store, signer);
    const broker = new BrokerService({ store, ...f.dependencies, clock: f.dependencies.clock, receipts, checkpoints: new CheckpointLog(store, signer), approvals: new TransactionalApprovalService({ kind: 'owner' }, receipts), config: f.config, autoDispatch: false });
    const token = await owner.call('issueToken', { agentId: agent.id }) as { token: string };
    const auth = new RequestAuthenticator({ store, clock: f.dependencies.clock, ownerPublicKey: f.config.ownerPublicKey });
    const principal = await auth.authenticateAgent(token.token);
    const pending = await broker.requestTransfer(principal, { receiverId: 'receiver.testnet', amount: 1n, idempotencyKey: 'expire' });
    expect(pending.state).toBe('pending_approval');
    now += 300_001;
    const deadline = Date.now() + 2000;
    while (store.read((r) => r.getRequest(pending.id)?.state) !== 'expired') {
      if (Date.now() > deadline) throw new Error('scheduler did not expire'); await new Promise((r) => setTimeout(r, 20));
    }
    // Owner auth clock is now forward; restore it before signing a new HTTP call.
    now = Date.now();
    let entered!: () => void; const started = new Promise<void>((r) => { entered = r; });
    const original = f.chain.viewAccount.bind(f.chain);
    f.chain.viewAccount = async (accountId) => { entered(); await new Promise<void>((r) => { release = r; }); return original(accountId); };
    // Prepare unexpired pending work, then make its balance stale. HTTP approval
    // must wait for the chain refresh; shutdown must not close SQLite underneath it.
    now += 11_000;
    f.chain.viewAccount = original;
    const p2 = await broker.requestTransfer(principal, { receiverId: 'receiver.testnet', amount: 1n, idempotencyKey: 'wait' });
    now += 11_000;
    f.chain.viewAccount = async (accountId) => { entered(); await new Promise<void>((r) => { release = r; }); return original(accountId); };
    const path = '/admin/approve';
    // signOwnerRequest uses Date.now, within 60s of the injected clock.
    const approveBody = json({ requestId: p2.id, expiresAt: now + 60_000 });
    const response = fetch(`http://127.0.0.1:${f.config.adminPort}${path}`, { method: 'POST', body: approveBody, headers: signOwnerRequest(f.owner.secretKey, 'POST', path, approveBody) });
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('approval did not refresh')), 2000))]);
    let done = false; const closing = daemon.close().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 30)); expect(done).toBe(false);
    release!(); expect((await response).status).toBe(200); await closing; alreadyClosed = true;
  } finally { release?.(); store.close(); if (!alreadyClosed) await daemon.close(); await f.cleanup(); }
});

it('CLI init-custody reads protected key file, writes only an encrypted envelope and never echoes key', async () => {
  const f = await fixture();
  try {
    const key = KeyPair.fromRandom('ed25519'); const keyPath = join(f.dir, 'key'); const masterPath = join(f.dir, 'master'); const envelopePath = join(f.dir, 'envelope');
    await mkdir(f.config.dataDir); await writeFile(keyPath, key.toString(), { mode: 0o600 }); const master = randomBytes(32); await writeFile(masterPath, master, { mode: 0o600 });
    let output = '';
    expect(await runCli(['init-custody', '--key-file', keyPath, '--master-file', masterPath, '--out', envelopePath], { stdout: (s) => { output += s; }, stderr: (s) => { output += s; } })).toBe(0);
    expect(output).toBe(`${envelopePath}\n`); expect(await readFile(envelopePath, 'utf8')).not.toContain(key.toString());
    const custody = new EncryptedFileCustody(); const signer = await custody.loadKeyFile(envelopePath, master);
    expect(signer.publicKey).toBe(key.getPublicKey().toString()); await custody.lock(); master.fill(0);
  } finally { await f.cleanup(); }
}, 15_000);
