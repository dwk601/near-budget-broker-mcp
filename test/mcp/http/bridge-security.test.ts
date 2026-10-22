import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TOKEN_A } from '../local/fakes.js';

const file = vi.hoisted(() => ({ mode: 0o600, uid: process.getuid!(), size: 52, text: '', closed: 0 }));
vi.mock('node:fs/promises', () => ({
  open: vi.fn(async () => ({
    stat: async () => ({ isFile: () => true, mode: file.mode, uid: file.uid, size: file.size }),
    read: async (buffer: Buffer) => ({ bytesRead: buffer.write(file.text) }),
    close: async () => { file.closed++; },
  })),
}));
import { runStdioBridge } from '../../../src/bridge/index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  Object.assign(file, { mode: 0o600, uid: process.getuid!(), size: 52, text: TOKEN_A, closed: 0 });
});
async function launch(url: string) {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const bridge = await runStdioBridge({ env: { BB_URL: url, BB_TOKEN_FILE: '/virtual-token' }, stdin, stdout, stderr });
  cleanup.push(bridge.close);
  return bridge;
}
it('refuses non-owned token inodes, even if they have private mode bits', async () => {
  file.text = TOKEN_A;
  file.uid = process.getuid!() + 1;
  await expect(launch('http://127.0.0.1/mcp')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(file.closed).toBe(1);
});
it('bounds stat size and read size independently, including a file growing after fstat', async () => {
  file.text = TOKEN_A; file.size = 5000;
  await expect(launch('http://127.0.0.1/mcp')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  file.size = 0; file.text = TOKEN_A.padEnd(4097, ' ');
  await expect(launch('http://127.0.0.1/mcp')).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
it('rejects non-HTTP schemes and cleartext non-loopback URLs before starting stdio', async () => {
  file.text = TOKEN_A;
  for (const url of ['ftp://127.0.0.1/mcp', 'http://broker.example/mcp', 'http://evillocalhost/mcp', 'http://192.168.1.1/mcp', 'file:///mcp']) {
    await expect(launch(url)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  for (const url of ['https://broker.example/mcp', 'http://localhost/mcp', 'http://127.1.2.3/mcp', 'http://[::1]/mcp']) {
    await (await launch(url)).close();
  }
});
