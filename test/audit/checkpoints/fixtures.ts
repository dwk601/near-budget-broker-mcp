import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { vi } from 'vitest';
import { GENESIS_PREV_HASH, checkpointHashInput, receiptHashInput, sha256Hex } from '../../../src/contracts/index.js';
import type { AuditSigner, ChainId, Checkpoint, CheckpointPreimage, Clock, ReceiptEvent, ReceiptPreimage, StoreTransaction } from '../../../src/contracts/index.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Buffer): string {
  let number = BigInt(`0x${bytes.toString('hex')}`);
  let text = '';
  while (number !== 0n) {
    text = ALPHABET[Number(number % 58n)] + text;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

export interface TestSigner extends AuditSigner { nodePublicKey: KeyObject }
export function testSigner(seedHex?: string): TestSigner {
  const privateKey = seedHex === undefined ? undefined : createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]),
    format: 'der', type: 'pkcs8',
  });
  const keys = privateKey ? { privateKey, publicKey: createPublicKey(privateKey) } : generateKeyPairSync('ed25519');
  const rawPublicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    publicKey: `ed25519:${base58(rawPublicKey)}`, nodePublicKey: keys.publicKey,
    signHash: vi.fn((bytes: Uint8Array): Uint8Array => {
      if (bytes.length !== 32) throw new Error('Expected decoded SHA-256');
      return sign(null, bytes, keys.privateKey);
    }),
  };
}
export const clock: Clock = { now: () => 1_700_000_000_123 };

export function signCheckpoint(signer: AuditSigner, preimage: CheckpointPreimage): Checkpoint {
  const hash = sha256Hex(checkpointHashInput(preimage));
  return { ...preimage, hash, signature: Buffer.from(signer.signHash(Buffer.from(hash, 'hex'))).toString('base64') };
}

export function signReceipt(signer: AuditSigner, preimage: ReceiptPreimage): ReceiptEvent {
  const hash = sha256Hex(receiptHashInput(preimage));
  return { ...preimage, hash, signature: Buffer.from(signer.signHash(Buffer.from(hash, 'hex'))).toString('base64') };
}

/** Only a fixture receipt writer; production ReceiptLog is the B04 port. */
export function appendReceipt(tx: StoreTransaction, signer: AuditSigner, chainId: ChainId = 'agent:a', marker = 'r'): ReceiptEvent {
  const head = tx.getReceiptHead(chainId);
  const receipt = signReceipt(signer, {
    chainId, seq: (head?.seq ?? 0) + 1, prevHash: head?.hash ?? GENESIS_PREV_HASH,
    type: 'queued', at: clock.now(), payload: { requestId: marker, agentId: chainId === 'owner' ? 'a' : chainId.slice(6) },
  });
  tx.insertReceipt(receipt);
  return receipt;
}
