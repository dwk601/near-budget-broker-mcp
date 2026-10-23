import { BrokerError } from '../contracts/index.js';
import type { Clock, Config } from '../contracts/index.js';
import { NativeNearChain } from '../near/index.js';
import { DaemonFailure } from './diagnostics.js';

/** Keep B05's attestation mandatory. Only transport/HTTP failure gets the
 * operational RPC_UNAVAILABLE diagnostic; a reachable wrong/unknown chain still
 * fails MAINNET_REFUSED. No custody unlock is permitted in either case. */
export async function connectTestnetChain(config: Config, clock: Clock) {
  let attesting = true; let unavailable = false;
  const transport: typeof fetch = async (input, init) => {
    try {
      // Bound startup transport below B05's 10s deadline, so an unreachable node
      // is diagnosed before the adapter conservatively folds it into refusal.
      const response = await fetch(input, { ...init, redirect: 'error',
        ...(attesting ? { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])]) } : {}) });
      if (!response.ok) unavailable = true;
      const text = response.text.bind(response);
      response.text = async () => {
        try { return await text(); }
        catch (e) { unavailable = true; throw e; }
      };
      return response;
    } catch (e) { unavailable = true; throw e; }
  };
  try {
    const chain = await NativeNearChain.connect({ rpcUrl: config.rpcUrl, accountId: config.accountId, clock, fetch: transport });
    if (await chain.verifyNetwork() !== 'testnet') throw new BrokerError('MAINNET_REFUSED');
    return chain;
  } catch (e) {
    if (unavailable) throw new DaemonFailure('RPC_UNAVAILABLE');
    throw e;
  } finally { attesting = false; }
}
