import { BrokerError, ErrorCodeSchema } from '../contracts/index.js';
import { signOwnerRequest } from '../auth/index.js';
import { json } from '../daemon/wire.js';
import type { AdminOperation } from '../daemon/admin.js';

export class OwnerClient {
  private readonly url: URL;
  constructor(url: string, private readonly secretKey: string) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/') throw new BrokerError('FORBIDDEN');
    if (this.url.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(this.url.hostname)) throw new BrokerError('FORBIDDEN');
  }
  async call(operation: AdminOperation, body: unknown = {}): Promise<unknown> {
    const path = `/admin/${operation}`; const bytes = json(body);
    const response = await fetch(new URL(path, this.url), { method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', ...signOwnerRequest(this.secretKey, 'POST', path, bytes) } });
    const result = await response.json() as { result?: unknown; error?: { code?: unknown } };
    if (!response.ok) throw new BrokerError(ErrorCodeSchema.safeParse(result.error?.code).data ?? 'BROKER_UNAVAILABLE');
    return result.result;
  }
}
