import { createPrivateKey, createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, fsyncSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditSigner, ReceiptLog, decodeAuditPublicKey, encodeAuditPublicKey, verifyReceipt } from '../../../src/audit/core/index.js';
import { SqliteStore } from '../../../src/storage/index.js';
import { sha256Hex } from '../../../src/contracts/index.js';
import type { Store } from '../../../src/contracts/index.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), fsyncSync: vi.fn(actual.fsyncSync) };
});

const dirs: string[] = [];
function location(): { auditKeyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bb-audit-key-'));
  dirs.push(dir);
  return { auditKeyPath: join(dir, 'audit.pem') };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AuditSigner', () => {
  it('creates a persistent 0600 Ed25519 key at auditKeyPath and reloads the same trust root', () => {
    const config = location();
    const signer = AuditSigner.loadOrCreate(config);
    expect(statSync(config.auditKeyPath).mode & 0o7777).toBe(0o600);
    const publicKey = createPublicKey(readFileSync(config.auditKeyPath));
    expect(publicKey.asymmetricKeyType).toBe('ed25519');
    const digest = Buffer.from(sha256Hex('exact audit bytes'), 'hex');
    const signature = signer.signHash(digest);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.byteLength).toBe(64);
    expect(verify(null, digest, publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from(sha256Hex('different bytes'), 'hex'), publicKey, signature)).toBe(false);
    expect(verify(null, Buffer.from(digest.toString('hex')), publicKey, signature)).toBe(false);
    const loaded = AuditSigner.load(config.auditKeyPath);
    expect(loaded.publicKey).toBe(signer.publicKey);
    expect(Buffer.from(loaded.signHash(digest))).toEqual(Buffer.from(signature));
    expect(AuditSigner.loadOrCreate(config).publicKey).toBe(signer.publicKey);
    expect(AuditSigner.generate().publicKey).not.toBe(signer.publicKey);
  });

  it('matches fixed RFC 8032 public-key encoding and a raw-hash signature vector', () => {
    const config = location();
    // Public test seed, never a deployment secret.
    const key = createPrivateKey({ key: Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), type: 'pkcs8', format: 'der' });
    writeFileSync(config.auditKeyPath, key.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const signer = AuditSigner.load(config);
    expect(signer.publicKey).toBe('ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z');
    const hash = Buffer.from('b2fd75c157db050b925cb115bf2441b10786f715b07579f055751e7a64a9047f', 'hex');
    const signature = 'DUoJPyAwn24qhXfYE2PfsDxPmjMclCkFRwRkYHdD3pzQoXfPfyhTRu0elNfSzj+HNWynG8aIy4wuuYQoIO2ZDA==';
    expect(Buffer.from(signer.signHash(hash)).toString('base64')).toBe(signature);
    expect(verifyReceipt({ type: 'queued', chainId: 'agent:a1', seq: 1, prevHash: '0'.repeat(64),
      at: 1700000000000, payload: { agentId: 'a1', requestId: 'r1' }, hash: hash.toString('hex'), signature },
    'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z').valid).toBe(true);
  });

  it('loads and signs with a generated key whose public bytes start with zero', () => {
    const config = location();
    let zeroKey: { publicKey: KeyObject; privateKey: KeyObject } | undefined;
    for (let i = 0; i < 16384; i++) {
      const pair = generateKeyPairSync('ed25519');
      const raw = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url');
      if (raw[0] === 0) { zeroKey = pair; break; }
    }
    expect(zeroKey, 'could not find a leading-zero Ed25519 key').toBeDefined();
    const original = zeroKey!.publicKey.export({ format: 'der', type: 'spki' });
    writeFileSync(config.auditKeyPath, zeroKey!.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    const signer = AuditSigner.load(config);
    expect(signer.publicKey.startsWith('ed25519:1')).toBe(true);
    expect(encodeAuditPublicKey(zeroKey!.privateKey)).toBe(signer.publicKey);
    expect(decodeAuditPublicKey(signer.publicKey).export({ format: 'der', type: 'spki' })).toEqual(original);
    const store = new SqliteStore(':memory:', { accountId: 'broker.testnet' });
    try {
      const log = new ReceiptLog(store, signer);
      const receipt = store.withImmediateTransaction((tx) => log.append(tx, { chainId: 'agent:a1', type: 'queued', at: 1,
        payload: { agentId: 'a1', requestId: 'zero-key' } }));
      expect(log.verifyReceipt(receipt).valid).toBe(true);
      expect(log.verify('agent:a1').valid).toBe(true);
    } finally { store.close(); }
  });

  it('rejects a mismatched file owner without requiring root', () => {
    const config = location();
    AuditSigner.generate(config);
    const before = readFileSync(config.auditKeyPath);
    vi.spyOn(process, 'getuid').mockReturnValue(statSync(config.auditKeyPath).uid + 1);
    expect(() => AuditSigner.load(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(() => AuditSigner.loadOrCreate(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(readFileSync(config.auditKeyPath)).toEqual(before);
  });

  it.each([0o277, 0o377])('creates reloadable 0600 keys even with restrictive umask %s', (mask) => {
    const config = location();
    const original = process.umask(mask);
    try {
      const signer = AuditSigner.generate(config);
      expect(statSync(config.auditKeyPath).mode & 0o7777).toBe(0o600);
      expect(AuditSigner.load(config).publicKey).toBe(signer.publicKey);
    } finally { process.umask(original); }
  });

  it.each(['write', 'file fsync', 'directory fsync'])('cleans up failed key creation (%s) and permits a clean retry', (failure) => {
    const config = location();
    const full = Object.assign(new Error('secret ENOSPC diagnostic'), { code: 'ENOSPC' });
    if (failure === 'write') vi.mocked(writeFileSync).mockImplementationOnce(() => { throw full; });
    if (failure === 'file fsync') vi.mocked(fsyncSync).mockImplementationOnce(() => { throw full; });
    if (failure === 'directory fsync') vi.mocked(fsyncSync).mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw full; });
    expect(() => AuditSigner.generate(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE', message: 'AUDIT_UNAVAILABLE' }));
    expect(existsSync(config.auditKeyPath)).toBe(false);
    expect(readdirSync(dirname(config.auditKeyPath))).toEqual([]);
    const signer = AuditSigner.loadOrCreate(config);
    expect(AuditSigner.load(config).publicKey).toBe(signer.publicKey);
    expect(readdirSync(dirname(config.auditKeyPath))).toEqual(['audit.pem']);
  });

  it('generation is exclusive and never replaces an existing key', () => {
    const config = location();
    const signer = AuditSigner.generate(config);
    const original = readFileSync(config.auditKeyPath);
    expect(() => AuditSigner.generate(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(readFileSync(config.auditKeyPath)).toEqual(original);
    expect(readdirSync(dirname(config.auditKeyPath))).toEqual(['audit.pem']);
    expect(AuditSigner.load(config).publicKey).toBe(signer.publicKey);
  });

  it.each([null, undefined, 'a'.repeat(64), [], new Uint8Array(0), new Uint8Array(31), new Uint8Array(33), new Uint8Array(64)])(
    'rejects non-byte and non-32-byte signing input %#', (value) => {
      expect(() => AuditSigner.generate().signHash(value as Uint8Array)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    },
  );

  it.each([0o644, 0o640, 0o666, 0o400, 0o700])('refuses insecure/non-0600 permissions %s without repairing them', (mode) => {
    const config = location();
    AuditSigner.generate(config);
    chmodSync(config.auditKeyPath, mode);
    expect(() => AuditSigner.load(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(() => AuditSigner.loadOrCreate(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(statSync(config.auditKeyPath).mode & 0o777).toBe(mode);
  });

  it('refuses missing, symlink, directory, oversized, malformed and wrong-type keys without replacement', () => {
    const config = location();
    expect(() => AuditSigner.load(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(() => AuditSigner.load(join(config.auditKeyPath, '..'))).toThrow();
    const real = `${config.auditKeyPath}.real`;
    AuditSigner.generate(real);
    symlinkSync(real, config.auditKeyPath);
    expect(() => AuditSigner.loadOrCreate(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    rmSync(config.auditKeyPath);
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    const publicOnly = createPublicKey(readFileSync(real)).export({ format: 'pem', type: 'spki' });
    for (const content of ['broken private secret', 'x'.repeat(4097), ec, publicOnly]) {
      writeFileSync(config.auditKeyPath, content, { mode: 0o600 });
      expect(() => AuditSigner.loadOrCreate(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE', message: 'AUDIT_UNAVAILABLE' }));
      expect(readFileSync(config.auditKeyPath, 'utf8')).toBe(content);
    }
  });

  it.each(['ed25519:' + '1'.repeat(33), 'ed25519:' + 'z'.repeat(44), 'rsa:bad'])('rejects malformed/wrong-length public keys %s', (publicKey) => {
    expect(() => new ReceiptLog({} as Store, { publicKey, signHash: () => new Uint8Array(64) }))
      .toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
  });
});
