import { execFileSync } from 'node:child_process';

export function requireDocker(env: NodeJS.ProcessEnv = process.env, probe = () => {
  execFileSync('docker', ['compose', 'version'], { stdio: 'pipe', timeout: 10_000 });
  execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 10_000 });
}, print: (text: string) => void = (text) => { process.stderr.write(`${text}\n`); }): boolean {
  if (env['BB_SKIP_DOCKER'] === '1') { print('SKIP Docker integration: BB_SKIP_DOCKER=1 explicitly requested'); return false; }
  try { probe(); }
  catch { throw new Error('Docker + Compose are required; start Docker or explicitly set BB_SKIP_DOCKER=1'); }
  return true;
}
