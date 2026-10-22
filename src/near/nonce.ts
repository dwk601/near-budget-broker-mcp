import { BrokerError } from '../contracts/index.js';
import type { Store, StoreTransaction } from '../contracts/index.js';

/** Caller serializes the per-key dispatch lane; persist before returning/signing.
 * No database/connection is owned here. A failed persistence never yields a nonce. */
export function allocateNonce(persisted: bigint, chain: bigint, persist: (next: bigint) => void): bigint {
  if (typeof persisted !== 'bigint' || typeof chain !== 'bigint' || persisted < 0n || chain < 0n) throw new BrokerError('NONCE_CONFLICT');
  const next = (persisted > chain ? persisted : chain) + 1n;
  if (next > (1n << 64n) - 1n) throw new BrokerError('NONCE_CONFLICT');
  const result: unknown = persist(next);
  if (result && typeof (result as { then?: unknown }).then === 'function') throw new BrokerError('NONCE_CONFLICT');
  return next;
}

/** Store's atomic allocation implements the same rule under BEGIN IMMEDIATE.
 * Chain nonce must be fetched before entering the synchronous callback. */
export function allocateStoreNonce(store: Store, publicKey: string, chain: bigint): bigint {
  return store.withImmediateTransaction((tx: StoreTransaction) => {
    const expected = allocateNonce(tx.getLocalNonce(publicKey), chain, () => {});
    const next = tx.allocateNonce(publicKey, chain);
    if (next !== expected) throw new BrokerError('NONCE_CONFLICT');
    return next;
  });
}
