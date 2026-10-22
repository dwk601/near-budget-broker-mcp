import { BrokerError } from '../contracts/index.js';

export type RpcFetch = typeof fetch;
export class RpcFailure extends Error {
  constructor(readonly response: unknown) { super('RPC request rejected'); }
}

/** Preserve JSON integer lexemes, including u64 nonces/gas exceeding 2^53.
 * JSON.parse's numeric reviver runs too late to recover rounded integers. */
export function parseRpcJson(text: string): unknown {
  const quotedIntegers = text.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g,
    (token) => token.startsWith('"') || /[.eE]/.test(token) ? token : `"${token}"`);
  return JSON.parse(quotedIntegers) as unknown;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError('BROKER_UNAVAILABLE');
  return value as Record<string, unknown>;
}
export function unsigned(value: unknown, max = (1n << 128n) - 1n): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new BrokerError('BROKER_UNAVAILABLE');
    value = String(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value)) throw new BrokerError('BROKER_UNAVAILABLE');
  const result = BigInt(value);
  if (result > max) throw new BrokerError('BROKER_UNAVAILABLE');
  return result;
}

export class RpcClient {
  #id = 0;
  constructor(private readonly url: string, private readonly fetcher: RpcFetch, private readonly timeoutMs: number) {}
  async call(method: string, params: unknown): Promise<unknown> {
    const id = String(++this.#id);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A race also bounds injected transports that don't honor AbortSignal.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new BrokerError('BROKER_UNAVAILABLE')); }, this.timeoutMs);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.fetcher(this.url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });
        if (!response.ok) throw new BrokerError('BROKER_UNAVAILABLE');
        const body = record(parseRpcJson(await response.text()));
        if (body['jsonrpc'] !== '2.0' || body['id'] !== id) throw new BrokerError('BROKER_UNAVAILABLE');
        if ('error' in body) throw new RpcFailure(body['error']);
        if (!('result' in body)) throw new BrokerError('BROKER_UNAVAILABLE');
        return body['result'];
      })()]);
    } catch (error) {
      if (error instanceof RpcFailure) throw error;
      throw new BrokerError('BROKER_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
}
