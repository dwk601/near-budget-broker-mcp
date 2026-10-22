import { AccountBalanceSchema, BrokerError } from '../contracts/index.js';
import type { AccountBalance, Clock, NearChain } from '../contracts/index.js';

/** Shared per custody key, not per request/connection. Only one admission lane
 * entry and one RPC flight can exist during an outage. No timers are owned. */
export interface BalanceState {
  admissionFlight?: Promise<void>;
  rpcFlight?: Promise<AccountBalance | null>;
  cached?: AccountBalance;
  failedAt?: number;
  error?: BrokerError;
  generation: number;
}
const states = new Map<string, BalanceState>();
export const BALANCE_FAILURE_BACKOFF_MS = 250;
export function balanceState(accountId: string, publicKey: string): BalanceState {
  const key = `testnet:${accountId}:${publicKey}`;
  let state = states.get(key);
  if (!state) { state = { generation: 0 }; states.set(key, state); }
  return state;
}
export function invalidateBalance(state: BalanceState): void {
  state.generation++;
  delete state.cached;
}
export function fetchBalance(state: BalanceState, chain: NearChain, clock: Clock, accountId: string, maxAge: number): Promise<AccountBalance | null> {
  const now = clock.now();
  if (state.cached && state.cached.observedAt <= now && now - state.cached.observedAt <= maxAge) return Promise.resolve(state.cached);
  if (state.rpcFlight) return state.rpcFlight;
  if (state.failedAt !== undefined && now >= state.failedAt && now - state.failedAt < BALANCE_FAILURE_BACKOFF_MS) {
    return state.error ? Promise.reject(state.error) : Promise.resolve(null);
  }
  const generation = state.generation;
  const work = (async () => {
    try {
      try { if (await chain.verifyNetwork() !== 'testnet') throw new Error(); }
      catch { throw new BrokerError('MAINNET_REFUSED'); }
      const balance = AccountBalanceSchema.parse(await chain.viewAccount(accountId));
      const at = clock.now();
      if (balance.accountId !== accountId || balance.observedAt > at || at - balance.observedAt > maxAge) throw new Error('Invalid balance');
      // A preview can start RPC outside the lane. A settlement in the meantime
      // invalidates that generation so it cannot overwrite a post-payment debit.
      if (state.generation !== generation) return null;
      state.cached = balance; delete state.failedAt; delete state.error;
      return balance;
    } catch (error) {
      state.failedAt = clock.now();
      delete state.cached;
      if (error instanceof BrokerError && error.code === 'MAINNET_REFUSED') { state.error = error; throw error; }
      delete state.error;
      return null;
    }
  })();
  state.rpcFlight = work;
  void work.then(() => { if (state.rpcFlight === work) delete state.rpcFlight; }, () => { if (state.rpcFlight === work) delete state.rpcFlight; });
  return work;
}
