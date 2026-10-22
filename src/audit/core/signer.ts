import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { BrokerError } from '../../contracts/index.js';
import type { AuditSigner as AuditSignerPort, Config } from '../../contracts/index.js';
import { encodeAuditPublicKey } from './crypto.js';

type KeyLocation = string | Pick<Config, 'auditKeyPath'>;
const pathOf = (location: KeyLocation): string => typeof location === 'string' ? location : location.auditKeyPath;

/** Unencrypted daemon-internal PKCS#8 PEM, protected by the private volume and 0600.
 * Never use the owner or custody key here. Existing invalid keys are never replaced.
 */
export class AuditSigner implements AuditSignerPort {
  readonly publicKey: string;
  private constructor(private readonly key: KeyObject) {
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('Expected Ed25519 private key');
    this.publicKey = encodeAuditPublicKey(key);
  }

  static generate(location?: KeyLocation): AuditSigner {
    try {
      const signer = new AuditSigner(generateKeyPairSync('ed25519').privateKey);
      if (location !== undefined) {
        // Exclusive creation: never overwrite/rotate an existing chain's trust root.
        const fd = openSync(pathOf(location), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeFileSync(fd, signer.key.export({ format: 'pem', type: 'pkcs8' }));
          fsyncSync(fd);
        } finally { closeSync(fd); }
      }
      return signer;
    } catch { throw new BrokerError('AUDIT_UNAVAILABLE'); }
  }

  private static readKey(location: KeyLocation): AuditSigner {
    const fd = openSync(pathOf(location), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096
        || (process.getuid !== undefined && stat.uid !== process.getuid())) {
        throw new TypeError('Unsafe audit key file');
      }
      return new AuditSigner(createPrivateKey(readFileSync(fd)));
    } finally { closeSync(fd); }
  }

  static load(location: KeyLocation): AuditSigner {
    try { return AuditSigner.readKey(location); }
    catch { throw new BrokerError('AUDIT_UNAVAILABLE'); }
  }

  /** Bootstrap only. Missing keys may be generated; malformed/insecure keys fail closed. */
  static loadOrCreate(location: KeyLocation): AuditSigner {
    try { return AuditSigner.readKey(location); }
    catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return AuditSigner.generate(location);
      }
      throw new BrokerError('AUDIT_UNAVAILABLE');
    }
  }

  signHash(hashBytes: Uint8Array): Uint8Array {
    try {
      if (!(hashBytes instanceof Uint8Array) || hashBytes.byteLength !== 32) throw new TypeError('Expected 32 hash bytes');
      return sign(null, hashBytes, this.key);
    } catch { throw new BrokerError('AUDIT_UNAVAILABLE'); }
  }
}
