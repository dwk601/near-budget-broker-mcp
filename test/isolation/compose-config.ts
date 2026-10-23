import { expect } from 'vitest';
import { realpathSync } from 'node:fs';

/** Exact allowlist of the RENDERED, unmodified deployment, including defaults.
 * New Compose keys/defaults require explicit review, never a permissive matcher. */
export function assertComposeConfig(value: unknown, files: { master: string; config: string; volume: string; image: string }) {
  const config = structuredClone(value) as { services: { daemon: { build: { context: string } } }; volumes: unknown; secrets: unknown };
  // Compose may preserve a logical cwd alias (/var on macOS), while Node uses
  // its physical path. Normalize only context; retain every key for exact checks.
  config.services.daemon.build.context = realpathSync(config.services.daemon.build.context);
  expect(config.services).toEqual({
    daemon: {
      build: { context: realpathSync('.'), dockerfile: 'docker/Dockerfile' },
      image: files.image,
      command: null,
      entrypoint: null,
      user: '1000:1000',
      init: true,
      read_only: true,
      cap_drop: ['ALL'],
      security_opt: ['no-new-privileges:true'],
      stop_grace_period: '1m30s',
      environment: { BB_MASTER_SECRET_FILE: '/run/secrets/bb_master' },
      networks: { default: null },
      ports: [3210, 3211].map((port) => ({ mode: 'ingress', host_ip: '127.0.0.1', target: port, published: String(port), protocol: 'tcp' })),
      volumes: [{ type: 'volume', source: 'bb_data', target: '/var/lib/budget-broker', volume: {} }],
      secrets: [{ source: 'bb_master', target: '/run/secrets/bb_master' }, { source: 'bb_config', target: '/run/secrets/bb_config' }],
      tmpfs: ['/tmp:rw,noexec,nosuid,size=16m,mode=1777'],
    },
  });
  expect(config.volumes).toEqual({ bb_data: { name: files.volume } });
  expect(config.secrets).toEqual({
    bb_master: { file: files.master, name: expect.any(String) },
    bb_config: { file: files.config, name: expect.any(String) },
  });
}
