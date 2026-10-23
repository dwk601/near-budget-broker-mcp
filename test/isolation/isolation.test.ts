import { expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initOwnerKey, unlockOwnerKey, writeProtected, readProtected } from '../../src/cli/keys.js';
import { startDaemon } from '../../src/daemon/index.js';
import { OwnerClient } from '../../src/cli/client.js';
import { fixture } from '../cli/helpers.js';
import { requireDocker } from './docker.js';
import { createDecipheriv, scrypt } from 'node:crypto';
import { canonicalJson } from '../../src/contracts/index.js';

it('compose isolation invariants: protected file secrets, volume, loopback, non-root, caps and no privilege escalation', async () => {
  const compose = await readFile('docker/docker-compose.yml', 'utf8');
  const dockerfile = await readFile('docker/Dockerfile', 'utf8');
  expect(compose).toContain('bb_data:/var/lib/budget-broker');
  expect(compose).not.toMatch(/\/var\/run\/docker\.sock|\~\/|\.\/.*:\/var\/lib/);
  expect(compose).toContain('127.0.0.1:3210:3210'); expect(compose).toContain('127.0.0.1:3211:3211');
  expect(compose).toContain('read_only: true'); expect(compose).toContain('user: "1000:1000"');
  expect(compose).toContain('same-user Docker socket'); expect(compose).toContain('docker exec');
  expect(dockerfile).toContain('FROM node:24-slim'); expect(dockerfile).toContain('USER node');
  expect(compose).toContain('cap_drop: [ALL]');
  expect(compose).toContain('security_opt: [no-new-privileges:true]');
  expect(compose).not.toMatch(/^\s*privileged:\s*true\s*$/m);
  expect(compose).not.toMatch(/^\s*network_mode:\s*["']?host/m);
  expect(compose).not.toMatch(/^\s*BB_MASTER_SECRET:/m);
  expect(compose).toContain('file: ${BB_MASTER_FILE:?'); expect(compose).toContain('file: ${BB_CONFIG_FILE:?');
  expect(compose).not.toMatch(/^\s*(?:content|environment):\s*BB_(?:MASTER_MATERIAL|CONFIG_JSON)/m);
  // Only secrets may be host-file mounts. DB/custody/audit remain in the volume.
  expect(compose).toContain('secrets: [bb_master, bb_config]');
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
    await chmod(path, 0o640); await expect(unlockOwnerKey(path, password)).rejects.toThrow(); await chmod(path, 0o600);
    if (process.getuid) {
      const uid = process.getuid(); const spy = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
      try { await expect(readProtected(path)).rejects.toThrow(); } finally { spy.mockRestore(); }
    }
    // Independently decrypt using the REQUIRED KDF, not the implementation's
    // encrypt/decrypt round-trip (which missed a lowered scrypt N mutant).
    const { tag, ciphertext, ...header } = JSON.parse(bytes.toString()) as Record<string, string>;
    const derived = await new Promise<Buffer>((resolve, reject) => scrypt(password, Buffer.from(header['salt']!, 'base64'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));
    try {
      const cipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(header['iv']!, 'base64'));
      cipher.setAAD(Buffer.from(canonicalJson(header))); cipher.setAuthTag(Buffer.from(tag!, 'base64'));
      expect(Buffer.concat([cipher.update(Buffer.from(ciphertext!, 'base64')), cipher.final()]).toString()).toBe(pem);
    } finally { derived.fill(0); }
    await expect(initOwnerKey(join(dir, 'short'), 'short')).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

it('Docker absence fails unless explicitly skipped, with a visible SKIP', () => {
  const absent = () => { throw new Error('not installed'); }; const print = vi.fn();
  expect(() => requireDocker({}, absent, print)).toThrow('Docker + Compose are required');
  expect(() => requireDocker({ BB_SKIP_DOCKER: '0' }, absent, print)).toThrow();
  expect(print).not.toHaveBeenCalled();
  expect(requireDocker({ BB_SKIP_DOCKER: '1' }, absent, print)).toBe(false);
  expect(print).toHaveBeenCalledWith(expect.stringContaining('SKIP'));
});

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
