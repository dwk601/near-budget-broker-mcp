import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireDocker } from './docker.js';
import { assertComposeConfig } from './compose-config.js';

it('rendered SHIPPED compose config has only loopback ports, exactly the named volume, and file secrets', async () => {
  if (!requireDocker()) return;
  const dir = await mkdtemp(join(tmpdir(), 'bb-compose-config-'));
  try {
    const master = join(dir, 'master'); const config = join(dir, 'config'); const volume = 'bb-render-only-no-volume-created';
    await writeFile(master, 'render-only-not-a-real-secret', { mode: 0o600 }); await writeFile(config, '{}', { mode: 0o600 });
    const output = execFileSync('docker', ['compose', '-f', 'docker/docker-compose.yml', 'config', '--format', 'json'], {
      env: { ...process.env, BB_MASTER_FILE: master, BB_CONFIG_FILE: config, BB_DATA_VOLUME: volume, BB_IMAGE: 'budget-broker:render-test' }, encoding: 'utf8', stdio: 'pipe', timeout: 15_000,
    });
    assertComposeConfig(JSON.parse(output), { master, config, volume, image: 'budget-broker:render-test' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
