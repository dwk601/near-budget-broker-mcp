import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initOwnerKey, unlockOwnerKey, writeProtected } from '../../src/cli/keys.js';
import { startDaemon } from '../../src/daemon/index.js';
import { OwnerClient } from '../../src/cli/client.js';
import { fixture } from '../cli/helpers.js';

it('compose uses named-volume data, file-mounted secrets without host paths, loopback-only ports and non-root read-only runtime', async () => {
  const compose = await readFile('docker/docker-compose.yml', 'utf8');
  const dockerfile = await readFile('docker/Dockerfile', 'utf8');
  expect(compose).toContain('bb_data:/var/lib/budget-broker');
  expect(compose).not.toMatch(/\/var\/run\/docker\.sock|\~\/|\.\/.*:\/var\/lib/);
  expect(compose).toContain('127.0.0.1:3210:3210'); expect(compose).toContain('127.0.0.1:3211:3211');
  expect(compose).toContain('read_only: true'); expect(compose).toContain('user: "1000:1000"');
  expect(compose).toContain('same-user Docker socket'); expect(compose).toContain('docker exec');
  expect(dockerfile).toContain('FROM node:24-slim'); expect(dockerfile).toContain('USER node');
  // No host bind source exists: DB, custody envelope and audit key resolve ONLY
  // under a Docker-managed named volume. The master source is a provisioning env
  // secret, not a path in a host agent's filesystem.
  expect(compose).not.toMatch(/^\s+file:/m);
  for (const path of ['/var/lib/budget-broker/broker.sqlite', '/var/lib/budget-broker/custody.json', '/run/secrets/bb_master']) expect(existsSync(path)).toBe(false);
  let available = true;
  try { execFileSync('docker', ['compose', 'version'], { stdio: 'pipe', timeout: 10_000 }); }
  catch { available = false; }
  if (!available) { console.error('Docker Compose unavailable: config validation skipped; static isolation assertions passed.'); return; }
  const config = JSON.parse(execFileSync('docker', ['compose', '-f', 'docker/docker-compose.yml', 'config', '--format', 'json'], { encoding: 'utf8', timeout: 15_000 })) as {
    services: { daemon: { user: string; read_only: boolean; volumes: { type: string; source: string; target: string }[]; ports: { host_ip: string }[]; secrets: unknown[] } };
    volumes: Record<string, unknown>; secrets: Record<string, { environment: string; file?: string }>;
  };
  const service = config.services.daemon;
  expect(service.volumes).toHaveLength(1); expect(service.volumes[0]).toMatchObject({ type: 'volume', source: 'bb_data' });
  expect(config.volumes).toHaveProperty('bb_data'); expect(service.secrets).toHaveLength(2);
  expect(service.ports.every((p) => p.host_ip === '127.0.0.1')).toBe(true);
  expect(service.user).toBe('1000:1000'); expect(service.read_only).toBe(true);
  expect(config.secrets['bb_master']).toEqual(expect.objectContaining({ environment: 'BB_MASTER_MATERIAL' }));
  expect(Object.values(config.secrets).every((s) => !s.file)).toBe(true);
  console.error('Docker Compose config validated. Image build is optional and is run separately, never implicitly in offline tests.');
});

it('owner keys are encrypted, authenticated, 0600 and never replaced; tokens are 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-isolation-'));
  try {
    const path = join(dir, 'owner'); const tokenPath = join(dir, 'token'); const password = 'test passphrase longer than 12';
    await initOwnerKey(path, password); const pem = await unlockOwnerKey(path, password);
    const bytes = await readFile(path); expect(bytes.toString()).not.toContain('PRIVATE KEY'); expect(bytes.includes(Buffer.from(pem))).toBe(false);
    const { createPrivateKey } = await import('node:crypto');
    const raw = createPrivateKey(pem).export({ format: 'jwk' }).d!;
    expect(bytes.includes(Buffer.from(raw, 'base64url'))).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(unlockOwnerKey(path, 'wrong passphrase long enough')).rejects.toThrow();
    await expect(initOwnerKey(path, password)).rejects.toThrow(); expect(await readFile(path)).toEqual(bytes);
    await writeProtected(tokenPath, 'token-test'); expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    await expect(writeProtected(tokenPath, 'replacement')).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

it('valid agent bearer cannot mutate the separate admin port', async () => {
  const f = await fixture(); let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({ config: f.config, dependencies: f.dependencies, log: () => {} });
    const owner = new OwnerClient(`http://127.0.0.1:${f.config.adminPort}`, f.owner.secretKey);
    const agent = await owner.call('createAgent', { name: 'hostile' }) as { id: string };
    const issued = await owner.call('issueToken', { agentId: agent.id }) as { token: string };
    const response = await fetch(`http://127.0.0.1:${f.config.adminPort}/admin/freeze`, { method: 'POST', headers: { Authorization: `Bearer ${issued.token}` }, body: '{"target":{"scope":"global"},"reason":"hostile"}' });
    expect([401, 403]).toContain(response.status); expect(await owner.call('getFreeze', { target: { scope: 'global' } })).toBeNull();
  } finally { await daemon?.close(); await f.cleanup(); }
});
