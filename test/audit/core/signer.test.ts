import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditSigner, ReceiptLog, verifyReceipt } from '../../../src/audit/core/index.js';
import { sha256Hex } from '../../../src/contracts/index.js';
import type { Store } from '../../../src/contracts/index.js';

const dirs: string[] = [];
function location(): { auditKeyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bb-audit-key-'));
  dirs.push(dir);
  return { auditKeyPath: join(dir, 'audit.pem') };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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

  it('generation is exclusive and never replaces an existing key', () => {
    const config = location();
    const signer = AuditSigner.generate(config);
    const original = readFileSync(config.auditKeyPath);
    expect(() => AuditSigner.generate(config)).toThrow(expect.objectContaining({ code: 'AUDIT_UNAVAILABLE' }));
    expect(readFileSync(config.auditKeyPath)).toEqual(original);
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
