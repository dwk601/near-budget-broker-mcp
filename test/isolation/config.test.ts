import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
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
    const rendered = JSON.parse(output) as { services: { daemon: { build: { context: string } } } };
    const files = { master, config, volume, image: 'budget-broker:render-test' };
    assertComposeConfig(rendered, files);
    // Exercise an alias on every platform, not only macOS's /var -> /private/var.
    const alias = join(dir, 'repo'); await symlink(process.cwd(), alias, 'dir');
    const aliased = structuredClone(rendered); aliased.services.daemon.build.context = alias;
    assertComposeConfig(aliased, files);
    expect(aliased.services.daemon.build.context).toBe(alias); // helper must not mutate input
    const wrong = structuredClone(rendered); wrong.services.daemon.build.context = dir;
    expect(() => assertComposeConfig(wrong, files)).toThrow();
    const extra = structuredClone(aliased); Object.assign(extra.services.daemon.build, { network: 'host' });
    expect(() => assertComposeConfig(extra, files)).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
