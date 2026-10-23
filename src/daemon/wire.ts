import { BrokerError, canonicalJson } from '../contracts/index.js';

/** Explicit bigint wire conversion, without changing BigInt.prototype. */
export function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item) ?? 'null') as unknown;
}
export function json(value: unknown): string { return canonicalJson(wire(value)); }

/** Validate raw duplicate keys before JSON.parse discards them. Bounded by HTTP reader. */
export function parseJson(text: string): unknown {
  let at = 0;
  function ws() { while (/[\x20\t\r\n]/.test(text[at] ?? 'x')) at++; }
  function str(): string {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') at++;
      else if (c === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new BrokerError('FORBIDDEN');
  }
  function value(depth: number): void {
    if (depth > 128) throw new BrokerError('FORBIDDEN');
    ws(); const c = text[at];
    if (c === '"') { str(); return; }
    if (c === '{' || c === '[') {
      at++; ws(); const end = c === '{' ? '}' : ']'; const keys = new Set<string>();
      if (text[at] === end) { at++; return; }
      for (;;) {
        if (c === '{') {
          ws(); if (text[at] !== '"') throw new BrokerError('FORBIDDEN');
          const key = str(); if (keys.has(key)) throw new BrokerError('FORBIDDEN');
          keys.add(key); ws(); if (text[at++] !== ':') throw new BrokerError('FORBIDDEN');
        }
        value(depth + 1); ws();
        if (text[at] === end) { at++; return; }
        if (text[at++] !== ',') throw new BrokerError('FORBIDDEN');
      }
    }
    const start = at;
    while (at < text.length && !/[\x20\t\r\n,\]}]/.test(text[at]!)) at++;
    if (at === start) throw new BrokerError('FORBIDDEN');
    JSON.parse(text.slice(start, at));
  }
  value(0); ws(); if (at !== text.length) throw new BrokerError('FORBIDDEN');
  const result: unknown = JSON.parse(text);
  // Monetary numbers are invalid even if fractional/unsafe. Classify before
  // canonical validation, without ever coercing one to bigint.
  const monetary = new Set(['amount', 'perTxMax', 'rolling24hMax', 'lifetimeMax', 'gasBudget24h', 'approvalThreshold', 'safetyReserve', 'totalMax', 'usedTotal', 'feeReservePerTx']);
  function checkMoney(item: unknown): void {
    if (!item || typeof item !== 'object') return;
    for (const [key, value] of Object.entries(item)) {
      if (monetary.has(key) && typeof value === 'number') throw new BrokerError('INVALID_AMOUNT');
      checkMoney(value);
    }
  }
  checkMoney(result); canonicalJson(result); return result;
}
