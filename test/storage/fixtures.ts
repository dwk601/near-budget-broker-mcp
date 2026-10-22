import { requestDigest } from '../../src/contracts/index.js';
import type { Agent, AgentPolicy, Checkpoint, ReceiptEvent, TransferRequest, TxAttempt } from '../../src/contracts/index.js';

export const ACCOUNT = 'custody.testnet';
export const KEY = `ed25519:${'1'.repeat(32)}`;
export const HASH = '1'.repeat(32);
export const HASH2 = '2'.repeat(32);
export const SIGNATURE = Buffer.alloc(64).toString('base64');
export const NOW = 1_700_000_000_000;
export function agent(id = 'a'): Agent { return { id, name: id, status: 'active', createdAt: NOW - 100_000 }; }
export function policy(agentId = 'a', revision = 1): AgentPolicy {
  return { agentId, revision, perTxMax: 100n, rolling24hMax: 100n, lifetimeMax: 100n, gasBudget24h: 100n,
    ratePerMinute: 10, maxOutstanding: 10, recipients: { mode: 'allow_all', accounts: [] }, approvalThreshold: null };
}
export function request(id = 'r', agentId = 'a', amount = 10n, createdAt = NOW): TransferRequest {
  return { id, agentId, idempotencyKey: id, requestDigest: requestDigest({ agentId, receiverId: 'receiver.testnet', amount: amount.toString() }),
    receiverId: 'receiver.testnet', amount, state: 'queued', reasons: [], policyRevision: 1, approvalRef: null,
    createdAt, updatedAt: createdAt, expiresAt: null, signedAt: null, submittedAt: null, completedAt: null,
    txHash: null, gasBurnt: null, tokensBurnt: null };
}
export function attempt(id = 'attempt', requestId = 'r', nonce = 1n, txHash = HASH): TxAttempt {
  return { id, requestId, nonce, publicKey: KEY, blockHash: HASH, signedTxBase64: 'AQ==', txHash, status: 'signed',
    receiptIds: [], gasBurnt: null, tokensBurnt: null, createdAt: NOW, updatedAt: NOW, nonExecutionEvidence: null };
}
export function receipt(seq = 1, chainId = 'agent:a', prevHash = '0'.repeat(64)): ReceiptEvent {
  return { chainId, seq, prevHash, type: 'queued', at: NOW, payload: { requestId: 'r', agentId: 'a' },
    hash: seq.toString(16).padStart(64, '0'), signature: SIGNATURE };
}
export function checkpoint(event = receipt(), previousCheckpointHash: string | null = null): Checkpoint {
  return { version: 1, chainId: event.chainId, seq: event.seq, headHash: event.hash, previousCheckpointHash, at: NOW,
    auditPublicKey: KEY, hash: `f${event.seq.toString(16).padStart(63, '0')}`, signature: SIGNATURE };
}
