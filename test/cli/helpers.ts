import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/contracts/index.js';
import { generateOwnerKeypair } from '../../src/auth/index.js';
import { FakeChain } from '../broker/fixtures.js';

export async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  await new Promise<void>((r) => server.close(() => r())); return address.port;
}
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bb-cli-'));
  const owner = generateOwnerKeypair(); const clock = { now: () => Date.now() }; const chain = new FakeChain(clock);
  const config = parseConfig({ network: 'testnet', rpcUrl: 'http://127.0.0.1:12345', accountId: 'broker.testnet',
    dataDir: join(dir, 'data'), auditKeyPath: join(dir, 'data', 'audit.pem'), ownerPublicKey: owner.publicKey,
    safetyReserve: 0n, feeReservePerTx: 10n, agentPort: await port(), adminPort: await port() });
  return { dir, owner, chain, config, dependencies: { chain, signer: { ...chain.signer, publicKey: generateOwnerKeypair().publicKey }, clock, keyLockDirectory: join(dir, 'key-locks') }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
