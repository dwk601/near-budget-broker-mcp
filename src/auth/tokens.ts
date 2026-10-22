import { randomBytes, randomUUID } from 'node:crypto';
import { BrokerError, IdSchema, TimestampSchema, hashAgentToken } from '../contracts/index.js';
import type { AgentCredential, IssuedCredential, StoreTransaction } from '../contracts/index.js';

function validate(id: string, now: number): void {
  if (!IdSchema.safeParse(id).success || !TimestampSchema.safeParse(now).success) {
    throw new BrokerError('FORBIDDEN');
  }
}

/** Broker calls these helpers inside its existing immediate transaction and
 * appends credential events to owner/agent chains before commit. No nested
 * transactions or audit side effects; a receipt failure rolls back token writes.
 * Only the returned value contains plaintext; never put it in an event/log. */
export function issueAgentToken(tx: StoreTransaction, agentId: string, now: number): IssuedCredential {
  validate(agentId, now);
  const agent = tx.getAgent(agentId);
  if (!agent) throw new BrokerError('NOT_FOUND');
  if (agent.status !== 'active') throw new BrokerError('FORBIDDEN');
  const token = `bb_agent_${randomBytes(32).toString('base64url')}`;
  const credential: AgentCredential = {
    id: randomUUID(), agentId, tokenHash: hashAgentToken(token), createdAt: now, revokedAt: null,
  };
  tx.putCredential(credential);
  return { credential, token };
}

/** Revoke the old and issue the new credential in the SAME caller transaction. */
export function rotateAgentToken(tx: StoreTransaction, credentialId: string, now: number): IssuedCredential {
  validate(credentialId, now);
  const credential = tx.getCredential(credentialId);
  if (!credential) throw new BrokerError('NOT_FOUND');
  if (credential.revokedAt !== null || tx.getAgent(credential.agentId)?.status !== 'active') {
    throw new BrokerError('FORBIDDEN');
  }
  tx.putCredential({ ...credential, revokedAt: now });
  return issueAgentToken(tx, credential.agentId, now);
}

/** Idempotent revocation; the broker owns the corresponding receipt writes. */
export function revokeAgentToken(tx: StoreTransaction, credentialId: string, now: number): void {
  validate(credentialId, now);
  const credential = tx.getCredential(credentialId);
  if (!credential) throw new BrokerError('NOT_FOUND');
  if (credential.revokedAt === null) tx.putCredential({ ...credential, revokedAt: now });
}
