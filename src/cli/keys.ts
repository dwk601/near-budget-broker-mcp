import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { BrokerError, canonicalJson } from '../contracts/index.js';
import { generateOwnerKeypair } from '../auth/index.js';

const envelopeSchema = z.strictObject({ version: z.literal(1), algorithm: z.literal('aes-256-gcm'), kdf: z.literal('scrypt'),
  publicKey: z.string().max(64), salt: z.string().length(44), iv: z.string().length(16), tag: z.string().length(24), ciphertext: z.string().max(4096) });
function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < 12 || passphrase.length > 4096) return Promise.reject(new BrokerError('FORBIDDEN'));
  return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (e, key) => e ? reject(new BrokerError('FORBIDDEN')) : resolve(key)));
}
export async function readProtected(path: string, maximum = 8192): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new BrokerError('FORBIDDEN');
    const bytes = Buffer.alloc(maximum + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum) { bytes.fill(0); throw new BrokerError('FORBIDDEN'); }
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
/** Exclusive create, never follow symlinks or overwrite an existing credential. */
export async function writeProtected(path: string, bytes: string | Buffer | (() => Promise<string>)): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(typeof bytes === 'function' ? await bytes() : bytes); await file.sync();
  } catch (e) { await unlink(path).catch(() => undefined); throw e; }
  finally { await file.close(); }
}
export async function initOwnerKey(path: string, passphrase: string): Promise<string> {
  const pair = generateOwnerKeypair(); const salt = randomBytes(32); const iv = randomBytes(12);
  const key = await derive(passphrase, salt); const plain = Buffer.from(pair.secretKey);
  try {
    const header = { version: 1 as const, algorithm: 'aes-256-gcm' as const, kdf: 'scrypt' as const, publicKey: pair.publicKey, salt: salt.toString('base64'), iv: iv.toString('base64') };
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(canonicalJson(header)));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    await writeProtected(path, canonicalJson({ ...header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
    return pair.publicKey;
  } finally { key.fill(0); plain.fill(0); }
}
export async function unlockOwnerKey(path: string, passphrase: string): Promise<string> {
  const bytes = await readProtected(path);
  let key: Buffer | undefined; let plain: Buffer | undefined;
  try {
    const { ciphertext, tag, ...header } = envelopeSchema.parse(JSON.parse(bytes.toString('utf8')));
    const salt = Buffer.from(header.salt, 'base64'); const iv = Buffer.from(header.iv, 'base64'); const authTag = Buffer.from(tag, 'base64');
    if (salt.length !== 32 || iv.length !== 12 || authTag.length !== 16) throw new Error();
    key = await derive(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(Buffer.from(canonicalJson(header))); decipher.setAuthTag(authTag);
    plain = decipher.update(Buffer.from(ciphertext, 'base64'));
    const tail = decipher.final();
    return Buffer.concat([plain, tail]).toString('utf8');
  } catch { throw new BrokerError('FORBIDDEN'); }
  finally { bytes.fill(0); key?.fill(0); plain?.fill(0); }
}
/** No terminal echo; env is supported only for separately protected automation. */
export async function ownerPassphrase(env: NodeJS.ProcessEnv): Promise<string> {
  if (env['BB_OWNER_PASSPHRASE'] !== undefined) return env['BB_OWNER_PASSPHRASE'];
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new BrokerError('FORBIDDEN');
  process.stderr.write('Owner passphrase (12+ characters): ');
  const input = process.stdin; input.setRawMode(true); input.resume();
  return new Promise<string>((resolve, reject) => {
    let text = '';
    const done = (error?: Error) => {
      input.off('data', data); input.setRawMode(false); input.pause(); process.stderr.write('\n');
      if (error) reject(error); else resolve(text);
    };
    const data = (bytes: Buffer) => {
      for (const c of bytes.toString('utf8')) {
        if (c === '\u0003' || c === '\u0004') { done(new BrokerError('FORBIDDEN')); return; }
        if (c === '\r' || c === '\n') { done(); return; }
        if (c === '\u007f' || c === '\b') text = text.slice(0, -1);
        else if (text.length < 4096) text += c;
      }
    };
    input.on('data', data);
  });
}
