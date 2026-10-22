import { timingSafeEqual, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  AgentTokenSchema, BrokerError, OWNER_MAX_SKEW_MS, OwnerSignedRequestSchema,
  TimestampSchema, hashAgentToken, ownerSigningBytes, sha256Hex,
} from '../contracts/index.js';
import type {
  AgentPrincipal, Authenticator, Clock, Config, OwnerPrincipal, OwnerVerificationInput, Store,
} from '../contracts/index.js';
import { decodeOwnerPublicKey } from './owner-key.js';

export interface AuthenticatorOptions {
  store: Store;
  clock: Clock;
  ownerPublicKey: Config['ownerPublicKey'];
}

export class RequestAuthenticator implements Authenticator {
  private readonly ownerKey: KeyObject;
  private readonly store: Store;
  private readonly clock: Clock;

  constructor(options: AuthenticatorOptions) {
    this.ownerKey = decodeOwnerPublicKey(options.ownerPublicKey);
    this.store = options.store;
    this.clock = options.clock;
  }

  async authenticateAgent(token: string): Promise<AgentPrincipal> {
    if (!AgentTokenSchema.safeParse(token).success) throw new BrokerError('UNAUTHENTICATED');
    const hash = hashAgentToken(token);
    return this.store.read((view) => {
      const credential = view.findCredentialByHash(hash);
      // Always compare 32 bytes, even on a lookup miss. SQLite index lookup is
      // not claimed to be constant-time; secret/hash verification itself is.
      const expected = credential ? Buffer.from(credential.tokenHash, 'hex') : Buffer.alloc(32);
      const matches = timingSafeEqual(Buffer.from(hash, 'hex'), expected);
      if (!matches || !credential || credential.revokedAt !== null) throw new BrokerError('UNAUTHENTICATED');
      const agent = view.getAgent(credential.agentId);
      if (!agent || agent.status !== 'active') throw new BrokerError('FORBIDDEN');
      // No caller-supplied identity, session state, or cached revocation result.
      return { kind: 'agent', agentId: agent.id, credentialId: credential.id };
    });
  }

  async verifyOwnerRequest(input: OwnerVerificationInput): Promise<OwnerPrincipal> {
    let nonce: string;
    let expiresAt: number;
    let now: number;
    try {
      const { payload, signature } = OwnerSignedRequestSchema.parse(input.signed);
      now = this.clock.now();
      expiresAt = payload.issuedAt + OWNER_MAX_SKEW_MS;
      if (!TimestampSchema.safeParse(now).success || !TimestampSchema.safeParse(expiresAt).success
        || Math.abs(now - payload.issuedAt) > OWNER_MAX_SKEW_MS
        || input.method !== payload.method || input.path !== payload.path
        || !(input.bodyBytes instanceof Uint8Array)
        || sha256Hex(input.bodyBytes) !== payload.bodySha256
        || !verify(null, ownerSigningBytes(payload), this.ownerKey, Buffer.from(signature, 'base64'))) {
        throw new Error();
      }
      nonce = payload.nonce;
    } catch { throw new BrokerError('UNAUTHENTICATED'); }

    // Only valid signatures may consume replay state. A separate durable commit
    // intentionally burns the nonce even if the subsequent admin mutation fails.
    const consumed = this.store.withImmediateTransaction((tx) => tx.consumeOwnerNonce(nonce, expiresAt, now));
    if (!consumed) throw new BrokerError('UNAUTHENTICATED');
    return { kind: 'owner' };
  }
}

export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  return new RequestAuthenticator(options);
}
