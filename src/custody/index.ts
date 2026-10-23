import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { baseDecode, baseEncode, KeyPair } from 'near-api-js';
import {
  BrokerError, canonicalJson, EncryptedCustodyKeySchema,
} from '../contracts/index.js';
import type { Custody, CustodySigner, EncryptedCustodyKey } from '../contracts/index.js';

// Envelope v1 pins these parameters: untrusted files cannot request expensive KDFs.
// ~128 MiB memory (N=2^17, r=8, p=1); allow overhead with 256 MiB maxmem.
// Independently random 32-byte salts, 96-bit IVs. Master secrets must be at least
// 32 bytes; operators should generate them randomly, not use human passwords.
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const MIN_MASTER_BYTES = 32;
const denied = (): BrokerError => new BrokerError('BROKER_UNAVAILABLE', 'Custody operation failed');
function derive(master: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  if (master.byteLength < MIN_MASTER_BYTES || master.byteLength > 4096) return Promise.reject(denied());
  return new Promise((resolve, reject) => {
    scrypt(master, salt, 32, SCRYPT, (error, key) => error ? reject(denied()) : resolve(key));
  });
}
function keyBytes(secret: string): Buffer {
  let bytes: Buffer | undefined;
  try {
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(secret)) throw denied();
    bytes = Buffer.from(baseDecode(secret.slice(8)));
    if (bytes.length !== 64) throw denied();
    const pair = KeyPair.fromString(secret as `ed25519:${string}`);
    if (!Buffer.from(pair.getPublicKey().data).equals(bytes.subarray(32))) throw denied();
    return bytes;
  } catch { bytes?.fill(0); throw denied(); }
}
function header(encrypted: EncryptedCustodyKey): Buffer {
  return Buffer.from(canonicalJson({ version: encrypted.version, algorithm: encrypted.algorithm,
    kdf: encrypted.kdf, saltBase64: encrypted.saltBase64, ivBase64: encrypted.ivBase64, publicKey: encrypted.publicKey }));
}
function decode(text: string, length: number): Buffer {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== text) throw denied();
  return bytes;
}
async function readBounded(path: string, maximum: number, protectedFile = false): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw denied();
    if (protectedFile && ((stat.mode & 0o7777 & ~0o600) !== 0
      || (process.getuid && stat.uid !== process.getuid()))) throw denied();
    const bytes = Buffer.alloc(maximum + 1);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maximum) throw denied();
      return Buffer.from(bytes.subarray(0, offset));
    } finally { bytes.fill(0); }
  } finally { await file.close(); }
}

/** Trusted daemon-only Custody port. Never expose its signer through MCP/HTTP.
 * The sole signer capability is the frozen CustodySigner port consumed by
 * NearChain (32-byte native transaction hashes); no raw-signing endpoint exists.
 * SDK/JS strings cannot be reliably wiped: retain raw bytes, instantiate SDK
 * keys only during an operation, wipe owned buffers and invalidate on lock. */
export class EncryptedFileCustody implements Custody {
  #keys = new Set<Buffer>();
  #generation = 0;
  async encryptKey(secretKey: string, passphrase: Uint8Array): Promise<EncryptedCustodyKey> {
    let plain: Buffer | undefined; let derived: Buffer | undefined;
    const master = Buffer.from(passphrase);
    try {
      plain = keyBytes(secretKey);
      const pair = KeyPair.fromString(secretKey as `ed25519:${string}`);
      const salt = randomBytes(32); const iv = randomBytes(12);
      const envelope: EncryptedCustodyKey = {
        version: 1, algorithm: 'aes-256-gcm', kdf: 'scrypt', saltBase64: salt.toString('base64'),
        ivBase64: iv.toString('base64'), tagBase64: '', ciphertextBase64: '', publicKey: pair.getPublicKey().toString(),
      };
      derived = await derive(master, salt);
      const cipher = createCipheriv('aes-256-gcm', derived, iv, { authTagLength: 16 });
      cipher.setAAD(header(envelope));
      envelope.ciphertextBase64 = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
      envelope.tagBase64 = cipher.getAuthTag().toString('base64');
      return EncryptedCustodyKeySchema.parse(envelope);
    } catch { throw denied(); }
    finally { master.fill(0); plain?.fill(0); derived?.fill(0); }
  }
  async loadKey(encrypted: EncryptedCustodyKey, passphrase: Uint8Array): Promise<CustodySigner> {
    const generation = this.#generation;
    const master = Buffer.from(passphrase);
    let derived: Buffer | undefined; let plain: Buffer | undefined;
    try {
      // Bound untrusted strings before schema/Buffer work.
      if (JSON.stringify(encrypted).length > 4096) throw denied();
      const envelope = EncryptedCustodyKeySchema.parse(encrypted);
      const salt = decode(envelope.saltBase64, 32); const iv = decode(envelope.ivBase64, 12);
      const tag = decode(envelope.tagBase64, 16); const ciphertext = decode(envelope.ciphertextBase64, 64);
      derived = await derive(master, salt);
      const decipher = createDecipheriv('aes-256-gcm', derived, iv, { authTagLength: 16 });
      decipher.setAAD(header(envelope)); decipher.setAuthTag(tag);
      // Wipe even the unauthenticated partial plaintext on final() failure.
      plain = decipher.update(ciphertext);
      const tail = decipher.final();
      if (tail.length !== 0 || plain.length !== 64) throw denied();
      const validated = keyBytes(`ed25519:${baseEncode(plain)}`);
      validated.fill(0);
      const pair = KeyPair.fromString(`ed25519:${baseEncode(plain)}`);
      if (pair.getPublicKey().toString() !== envelope.publicKey || generation !== this.#generation) throw denied();
      const retained = plain; plain = undefined;
      this.#keys.add(retained);
      return Object.freeze({
        publicKey: envelope.publicKey,
        sign: async (message: Uint8Array): Promise<Uint8Array> => {
          try {
            if (!this.#keys.has(retained) || generation !== this.#generation || message.length !== 32) throw denied();
            const pair = KeyPair.fromString(`ed25519:${baseEncode(retained)}`);
            const signature = pair.sign(message).signature;
            if (generation !== this.#generation) { signature.fill(0); throw denied(); }
            return signature;
          } catch { throw denied(); }
        },
      });
    } catch { throw denied(); }
    finally { master.fill(0); derived?.fill(0); plain?.fill(0); }
  }
  async lock(): Promise<void> {
    this.#generation++;
    for (const bytes of this.#keys) bytes.fill(0);
    this.#keys.clear();
  }
  async createEncryptedKeyFile(path: string, secretKey: string, master: Uint8Array): Promise<void> {
    try {
      const encrypted = await this.encryptKey(secretKey, master);
      // Exclusive create: never overwrite existing custody material, mode 0600.
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(encrypted), 'utf8'); await file.sync(); }
      finally { await file.close(); }
    } catch { throw denied(); }
  }
  async loadKeyFile(path: string, master: Uint8Array): Promise<CustodySigner> {
    let bytes: Buffer | undefined;
    try {
      bytes = await readBounded(path, 4096);
      return await this.loadKey(JSON.parse(bytes.toString('utf8')) as EncryptedCustodyKey, master);
    } catch { throw denied(); }
    finally { bytes?.fill(0); }
  }
}

/** Supply exactly one source. Secret-file bytes are used verbatim (no trim).
 * Caller owns the returned buffer and must fill(0) after unlocking. */
export async function readMasterSecret(env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  try {
    const direct = env['BB_MASTER_SECRET']; const path = env['BB_MASTER_SECRET_FILE'];
    if ((direct === undefined) === (path === undefined)) throw denied();
    const secret = direct === undefined ? await readBounded(path!, 4096, true) : Buffer.from(direct, 'utf8');
    if (secret.length < MIN_MASTER_BYTES || secret.length > 4096) { secret.fill(0); throw denied(); }
    return secret;
  } catch { throw denied(); }
}
