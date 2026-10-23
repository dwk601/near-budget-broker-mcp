import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { KeyPair } from 'near-api-js';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { generateOwnerKeypair } from '../../src/auth/index.js';
import { OwnerClient } from '../../src/cli/client.js';
import { json } from '../../src/daemon/wire.js';
import { port } from '../cli/helpers.js';
import { requireDocker } from './docker.js';
import { assertComposeConfig } from './compose-config.js';

it('file secrets + read-only rootfs actually compose create/up, ready, SIGKILL/restart, and cleanup', async () => {
  if (!requireDocker()) return;
  const dir = await mkdtemp(join(tmpdir(), 'bb-compose-')); await chmod(dir, 0o700);
  const name = `bb-b08-${randomUUID().slice(0, 8)}`; const image = `${name}:test`; const volume = `${name}-data`;
  const masterPath = join(dir, 'master'); const configPath = join(dir, 'config'); const envelopePath = join(dir, 'custody'); const override = join(dir, 'compose.yml');
  const env = { ...process.env, BB_MASTER_FILE: masterPath, BB_CONFIG_FILE: configPath, BB_DATA_VOLUME: volume, BB_IMAGE: image };
  function docker(args: string[], timeout = 30_000, input?: Buffer) { return execFileSync('docker', args, { env, encoding: 'utf8', stdio: 'pipe', timeout, ...(input ? { input } : {}) }); }
  const compose = ['compose', '-p', name, '-f', resolve('docker/docker-compose.yml'), '-f', override];
  const owner = generateOwnerKeypair(); const agentPort = await port(); const adminPort = await port();
  try {
    const master = randomBytes(32); await writeFile(masterPath, master, { mode: 0o600 });
    await new EncryptedFileCustody().createEncryptedKeyFile(envelopePath, KeyPair.fromRandom('ed25519').toString(), master); master.fill(0);
    await writeFile(configPath, json({ network: 'testnet', rpcUrl: 'http://rpc:3030', accountId: 'broker.testnet', bindHost: '0.0.0.0', agentPort, adminPort,
      dataDir: '/var/lib/budget-broker', auditKeyPath: '/var/lib/budget-broker/audit.pem', ownerPublicKey: owner.publicKey, safetyReserve: '0' }), { mode: 0o600 });
    // Validate pristine publications/mounts BEFORE the test-only port override.
    assertComposeConfig(JSON.parse(docker(['compose', '-p', name, '-f', resolve('docker/docker-compose.yml'), 'config', '--format', 'json'])), { master: masterPath, config: configPath, volume, image });
    const rpc = "require('node:http').createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{let id=null;try{id=JSON.parse(body).id}catch{};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id,result:{chain_id:'testnet'}}))})}).listen(3030,'0.0.0.0')";
    // Only test ports and an isolated fake RPC differ from the shipped service.
    await writeFile(override, `services:\n  daemon:\n    ports: !override ["127.0.0.1:${agentPort}:${agentPort}", "127.0.0.1:${adminPort}:${adminPort}"]\n    depends_on:\n      rpc:\n        condition: service_healthy\n  rpc:\n    image: ${image}\n    entrypoint: ["node", "-e", ${JSON.stringify(rpc)}]\n    read_only: true\n    healthcheck:\n      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3030').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]\n      interval: 1s\n      retries: 20\n`);
    docker([...compose, 'config', '--quiet']);
    docker([...compose, 'build', 'daemon'], 180_000);
    // Native Linux bind mounts keep host ownership, so follow docker/README.md:
    // the daemon uid (1000) must own both secret files. Docker Desktop remaps
    // ownership itself, so only Linux runners with another uid need this.
    if (process.platform === 'linux' && process.getuid?.() !== 1000) {
      docker(['run', '--rm', '--user', '0:0', '--network', 'none', '--entrypoint', 'chown', '-v', `${dir}:/secrets`, image, '1000:1000', '/secrets/master', '/secrets/config']);
    }
    docker([...compose, 'create', '--pull', 'never'], 30_000); // Regression: config alone did not catch F1.
    const config = JSON.parse(docker([...compose, 'config', '--format', 'json'])) as { services: { daemon: { read_only: boolean } } };
    expect(config.services.daemon.read_only).toBe(true);
    // Exercise the documented non-root, stdin-only provisioning sequence.
    docker(['run', '--rm', '-i', '--name', `${name}-provision`, '--user', '1000:1000', '--read-only', '--network', 'none', '--entrypoint', 'node', '-v', `${volume}:/var/lib/budget-broker`, image, '-e', "const fs=require('node:fs');fs.writeFileSync('/var/lib/budget-broker/custody.json',fs.readFileSync(0),{flag:'wx',mode:0o600})"], 30_000, await readFile(envelopePath));
    docker([...compose, 'up', '-d', '--no-build', '--pull', 'never']);
    async function ready(count: number) {
      const deadline = Date.now() + 20_000;
      while ((docker([...compose, 'logs', '--no-color', 'daemon']).match(/daemon: ready/g) ?? []).length < count) {
        if (Date.now() > deadline) throw new Error(`Daemon not ready: ${docker([...compose, 'logs', '--no-color', 'daemon'])}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await ready(1);
    const client = new OwnerClient(`http://127.0.0.1:${adminPort}`, owner.secretKey);
    await client.call('freeze', { target: { scope: 'global' }, reason: 'crash recovery' });
    docker([...compose, 'kill', '-s', 'SIGKILL', 'daemon']); docker([...compose, 'start', 'daemon']);
    await ready(2);
    expect(await client.call('getFreeze', { target: { scope: 'global' } })).toMatchObject({ frozen: true });
  } finally {
    try { docker([...compose, 'down', '--volumes', '--remove-orphans'], 30_000); }
    finally {
      try { docker(['rm', '-f', `${name}-provision`]); } catch { /* already --rm */ }
      try { docker(['image', 'rm', image]); } catch { /* build may have failed */ }
      try { docker(['volume', 'rm', volume]); } catch { /* already down --volumes */ }
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 240_000);
