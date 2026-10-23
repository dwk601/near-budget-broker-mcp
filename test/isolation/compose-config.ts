import { expect } from 'vitest';

/** Assert the RENDERED, unmodified deployment, not substrings or test overrides. */
export function assertComposeConfig(value: unknown, files: { master: string; config: string; volume: string }) {
  const config = value as {
    services: { daemon: { ports: { host_ip?: string; target: number; published: string }[]; volumes: { type: string; source: string; target: string }[];
      secrets: { source: string; target: string }[]; user: string; read_only: boolean; cap_drop: string[]; security_opt: string[]; privileged?: boolean; network_mode?: string;
      environment: Record<string, string> } };
    volumes: Record<string, { name: string }>; secrets: Record<string, { file?: string; environment?: string; content?: string; external?: boolean }>;
  };
  const service = config.services.daemon;
  expect(service.ports).toHaveLength(2);
  for (const port of service.ports) expect(port.host_ip).toBe('127.0.0.1');
  expect(service.ports.map((p) => [p.target, p.published]).sort()).toEqual([[3210, '3210'], [3211, '3211']]);
  expect(service.volumes).toHaveLength(1);
  expect(service.volumes[0]).toMatchObject({ type: 'volume', source: 'bb_data', target: '/var/lib/budget-broker' });
  expect(service.volumes.every((v) => v.type === 'volume')).toBe(true); // no host binds, especially /:/host
  expect(Object.keys(config.volumes)).toEqual(['bb_data']); expect(config.volumes['bb_data']!.name).toBe(files.volume);
  expect(service.secrets.map((s) => [s.source, s.target]).sort()).toEqual([['bb_config', '/run/secrets/bb_config'], ['bb_master', '/run/secrets/bb_master']]);
  expect(Object.keys(config.secrets).sort()).toEqual(['bb_config', 'bb_master']);
  expect(config.secrets['bb_master']).toEqual({ file: files.master, name: expect.any(String) });
  expect(config.secrets['bb_config']).toEqual({ file: files.config, name: expect.any(String) });
  expect(service.user).toBe('1000:1000'); expect(service.read_only).toBe(true);
  expect(service.cap_drop).toEqual(['ALL']); expect(service.security_opt).toContain('no-new-privileges:true');
  expect(service.privileged ?? false).toBe(false); expect(service.network_mode).not.toBe('host');
  expect(service.environment).toEqual({ BB_MASTER_SECRET_FILE: '/run/secrets/bb_master' });
}
