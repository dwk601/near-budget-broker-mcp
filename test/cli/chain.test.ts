import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { connectTestnetChain } from '../../src/daemon/chain.js';
import { fixture } from './helpers.js';

it('a hanging attestation RPC is RPC_UNAVAILABLE within the 5s transport bound, not B05’s 10s refusal', async () => {
  const f = await fixture(); let requests = 0;
  const rpc = createServer((req) => { requests++; req.resume(); /* deliberately never reply */ });
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = rpc.address(); if (!address || typeof address === 'string') throw new Error();
    f.config.rpcUrl = `http://127.0.0.1:${address.port}`;
    const start = performance.now();
    await expect(Promise.race([
      connectTestnetChain(f.config, f.dependencies.clock),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Attestation exceeded 6.5s')), 6500); }),
    ])).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE', reason: 'RPC_UNAVAILABLE' });
    expect(performance.now() - start).toBeGreaterThanOrEqual(4500);
    expect(performance.now() - start).toBeLessThan(6500);
    expect(requests).toBe(1);
  } finally {
    clearTimeout(timer); rpc.closeAllConnections();
    await new Promise<void>((resolve, reject) => rpc.close((e) => e ? reject(e) : resolve()));
    await f.cleanup();
  }
}, 9000);

it('307 attestation redirects are RPC_UNAVAILABLE and never follow even a valid testnet target', async () => {
  const f = await fixture(); let redirected = 0; let requests = 0;
  const rpc = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    requests++;
    if (req.url !== '/target') { res.writeHead(307, { Location: '/target' }); res.end(); return; }
    redirected++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: (JSON.parse(body) as { id: unknown }).id, result: { chain_id: 'testnet' } }));
  });
  await new Promise<void>((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  try {
    const address = rpc.address(); if (!address || typeof address === 'string') throw new Error();
    f.config.rpcUrl = `http://127.0.0.1:${address.port}`;
    await expect(connectTestnetChain(f.config, f.dependencies.clock)).rejects.toMatchObject({ code: 'BROKER_UNAVAILABLE', reason: 'RPC_UNAVAILABLE' });
    expect(requests).toBe(1); expect(redirected).toBe(0);
  } finally {
    rpc.closeAllConnections();
    await new Promise<void>((resolve, reject) => rpc.close((e) => e ? reject(e) : resolve()));
    await f.cleanup();
  }
});
