import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseEncode, KeyPair } from 'near-api-js';
import { EncryptedFileCustody, readMasterSecret } from '../../src/custody/index.js';
import { NativeNearChain } from '../../src/near/index.js';

const secret = KeyPair.fromRandom('ed25519').toString();
const master = Buffer.from('strong-test-master-secret-not-for-production');
const digest = createHash('sha256').update('native transaction').digest();
const dirs: string[] = [];
const custodians: EncryptedFileCustody[] = [];
function custody() { const value = new EncryptedFileCustody(); custodians.push(value); return value; }
async function temp() { const path = await mkdtemp(join(tmpdir(), 'bb-custody-')); dirs.push(path); return path; }
afterEach(async () => {
  await Promise.all(custodians.splice(0).map((c) => c.lock()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function safeError(operation: Promise<unknown>) {
  try { await operation; expect.unreachable('must fail'); }
  catch (error) {
    expect(error).toHaveProperty('code', 'BROKER_UNAVAILABLE');
    const text = String(error) + JSON.stringify(error);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(master.toString());
    expect(error).not.toHaveProperty('cause');
  }
}

describe('AES-256-GCM / pinned scrypt envelope v1', () => {
  it('roundtrips, signs exact transaction hashes, and randomizes salt/IV', async () => {
    const c = custody();
    const encrypted = await c.encryptKey(secret, master);
    const again = await c.encryptKey(secret, master);
    expect(encrypted).toMatchObject({ version: 1, algorithm: 'aes-256-gcm', kdf: 'scrypt' });
    expect(encrypted.saltBase64).not.toBe(again.saltBase64);
    expect(encrypted.ivBase64).not.toBe(again.ivBase64);
    expect(JSON.stringify(encrypted)).not.toContain(secret);
    expect(Buffer.from(encrypted.saltBase64, 'base64')).toHaveLength(32);
    expect(Buffer.from(encrypted.ivBase64, 'base64')).toHaveLength(12);
    expect(Buffer.from(encrypted.tagBase64, 'base64')).toHaveLength(16);
    const signer = await c.loadKey(encrypted, master);
    const pair = KeyPair.fromString(secret);
    expect(signer.publicKey).toBe(pair.getPublicKey().toString());
    expect(pair.verify(digest, await signer.sign(digest))).toBe(true);
    expect(master.toString()).toBe('strong-test-master-secret-not-for-production'); // caller-owned memory
    await safeError(signer.sign(Buffer.from('arbitrary raw-signing input')));
    await c.lock();
    await safeError(signer.sign(digest));
    const unlocked = await c.loadKey(encrypted, master);
    expect(pair.verify(digest, await unlocked.sign(digest))).toBe(true);
    await safeError(signer.sign(digest)); // old capability never revives
  });
  it('accepts canonical keys with leading-zero seed bytes (shorter base58)', async () => {
    const seed = Buffer.alloc(64);
    const seedPair = KeyPair.fromString(`ed25519:${baseEncode(seed)}`);
    Buffer.from(seedPair.getPublicKey().data).copy(seed, 32);
    const leadingZeroSecret = `ed25519:${baseEncode(seed)}`;
    const c = custody();
    const signer = await c.loadKey(await c.encryptKey(leadingZeroSecret, master), master);
    expect(seedPair.verify(digest, await signer.sign(digest))).toBe(true);
    seed.fill(0);
  });
  it('wrong master and tampering fail without secrets, RPC details, or crypto exceptions', async () => {
    const c = custody(); const encrypted = await c.encryptKey(secret, master);
    await safeError(c.loadKey(encrypted, Buffer.from('incorrect master secret')));
    for (const field of ['ciphertextBase64', 'saltBase64', 'ivBase64', 'tagBase64'] as const) {
      const bytes = Buffer.from(encrypted[field], 'base64'); bytes[0]! ^= 1;
      await safeError(c.loadKey({ ...encrypted, [field]: bytes.toString('base64') }, master));
    }
    await safeError(c.loadKey({ ...encrypted, publicKey: KeyPair.fromRandom('ed25519').getPublicKey().toString() }, master));
    for (const field of ['ciphertextBase64', 'saltBase64', 'ivBase64', 'tagBase64'] as const) {
      await safeError(c.loadKey({ ...encrypted, [field]: Buffer.alloc(2).toString('base64') }, master));
    }
    await safeError(c.loadKey({ ...encrypted, version: 2 } as never, master));
    await safeError(c.loadKey({ ...encrypted, N: 1 << 30 } as never, master));
    await safeError(c.encryptKey(`ed25519:${secret}`, master));
    await safeError(c.encryptKey(secret, Buffer.from('short')));
  });
  it('lock invalidates an in-progress unlock', async () => {
    const c = custody(); const encrypted = await c.encryptKey(secret, master);
    const unlocking = c.loadKey(encrypted, master);
    await c.lock();
    await safeError(unlocking);
  });
  it('custody signer integrates with native-only NearChain', async () => {
    const c = custody(); const signer = await c.loadKey(await c.encryptKey(secret, master), master);
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string };
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { chain_id: 'testnet' } });
    };
    const chain = await NativeNearChain.connect({ rpcUrl: 'http://test.invalid', accountId: 'broker.testnet', fetch: fetcher });
    const tx = await chain.buildAndSignNativeTransfer({ signerId: 'broker.testnet', receiverId: 'broker.testnet', amount: 1n,
      nonce: 123n, publicKey: signer.publicKey, blockHash: '1'.repeat(32) }, signer);
    expect(chain.decodeSignedTx(chain.encodeSignedTx(tx))).toEqual(tx);
  });
});

describe('daemon encrypted file and master-secret sources', () => {
  it('creates mode-0600 ciphertext, refuses overwrite, loads without any plaintext file', async () => {
    const path = join(await temp(), 'custody.json'); const c = custody();
    await c.createEncryptedKeyFile(path, secret, master);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain(secret);
    const signer = await c.loadKeyFile(path, master);
    expect(KeyPair.fromString(secret).verify(digest, await signer.sign(digest))).toBe(true);
    await safeError(c.createEncryptedKeyFile(path, secret, master));
    await safeError(c.loadKeyFile(path, Buffer.from('wrong master password')));
    const bad = join(await temp(), 'bad.json'); await writeFile(bad, `{malformed ${secret}`);
    await safeError(c.loadKeyFile(bad, master));
  });
  it('loads exactly one env/file source and uses verbatim bytes', async () => {
    const envSecret = await readMasterSecret({ BB_MASTER_SECRET: master.toString() });
    expect(envSecret).toEqual(master); envSecret.fill(0);
    const file = join(await temp(), 'unlock'); await writeFile(file, master, { mode: 0o600 });
    const fileSecret = await readMasterSecret({ BB_MASTER_SECRET_FILE: file });
    expect(fileSecret).toEqual(master); fileSecret.fill(0);
    await safeError(readMasterSecret({}));
    await safeError(readMasterSecret({ BB_MASTER_SECRET: master.toString(), BB_MASTER_SECRET_FILE: file }));
    await safeError(readMasterSecret({ BB_MASTER_SECRET_FILE: `${file}-missing` }));
    await safeError(readMasterSecret({ BB_MASTER_SECRET: 'short' }));
  });
});
