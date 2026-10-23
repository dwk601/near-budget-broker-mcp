import { chmod, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { BrokerError, fromDecimalText, parseConfig, sha256Hex } from '../contracts/index.js';
import type { Clock, Config, CustodySigner, NearChain, Store } from '../contracts/index.js';
import { SqliteStore } from '../storage/index.js';
import { NativeNearChain } from '../near/index.js';
import { EncryptedFileCustody, readMasterSecret } from '../custody/index.js';
import { AuditSigner, ReceiptLog } from '../audit/core/index.js';
import { CheckpointLog } from '../audit/checkpoints/index.js';
import { TransactionalApprovalService } from '../approvals/index.js';
import { RequestAuthenticator } from '../auth/index.js';
import { BrokerService } from '../broker/index.js';
import { createAgentHttpServer } from '../mcp/http/index.js';
import { createAdminHttpServer } from './admin.js';
import { exclusiveLock } from './lock.js';
import { parseJson } from './wire.js';

/** Config monetary fields are canonical yoctoNEAR strings, never unlock secrets. */
export async function loadConfig(path: string): Promise<Config> {
  const value = parseJson(await readFile(path, 'utf8')) as Record<string, unknown>;
  return parseConfig({ ...value, safetyReserve: fromDecimalText(value['safetyReserve']),
    ...(value['feeReservePerTx'] === undefined ? {} : { feeReservePerTx: fromDecimalText(value['feeReservePerTx']) }) });
}
export interface DaemonOptions {
  config: Config;
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  log?: (code: string) => void;
  /** Trusted in-process composition seam ONLY. No env/config dynamic module loading. */
  dependencies?: { chain: NearChain; signer: CustodySigner; clock?: Clock };
}
async function listen(server: Server, port: number, host: string) {
  await new Promise<void>((res, rej) => {
    server.once('error', rej); server.listen(port, host, () => { server.off('error', rej); res(); });
  });
}
export async function startDaemon(options: DaemonOptions) {
  const config = parseConfig(options.config);
  const clock = options.dependencies?.clock ?? { now: () => Date.now() };
  const log = options.log ?? ((code: string) => process.stderr.write(`Budget Broker daemon: ${code}\n`));
  const intervalMs = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) throw new BrokerError('FORBIDDEN');
  // Private volume: custody envelope and database never enter the host bridge.
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
  const dataDir = await realpath(config.dataDir);
  const releaseData = await exclusiveLock(join(dataDir, 'daemon.lock'));
  let releaseKey: (() => Promise<void>) | undefined;
  let store: Store | undefined;
  const custody = new EncryptedFileCustody();
  let agent: ReturnType<typeof createAgentHttpServer> | undefined;
  let admin: ReturnType<typeof createAdminHttpServer> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let scheduled: Promise<void> | undefined;
  const calls = new Set<Promise<unknown>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  async function cleanup() {
    closing = true; if (timer) clearInterval(timer);
    // Close listeners/sessions, then wait for already invoked broker operations.
    const errors: unknown[] = [];
    const attempt = async (work: () => unknown) => { try { await work(); } catch (e) { errors.push(e); } };
    await Promise.all([attempt(() => agent?.close()), attempt(() => admin?.close())]);
    await attempt(() => scheduled);
    while (calls.size) await Promise.allSettled([...calls]);
    await attempt(() => custody.lock());
    await attempt(() => store?.close());
    await attempt(() => releaseKey?.()); await attempt(() => releaseData());
    if (errors.length) throw new BrokerError('BROKER_UNAVAILABLE');
  }
  try {
    store = new SqliteStore(join(dataDir, 'broker.sqlite'), { accountId: config.accountId });
    const chain = options.dependencies?.chain ?? await NativeNearChain.connect({ rpcUrl: config.rpcUrl, accountId: config.accountId, clock });
    if (await chain.verifyNetwork() !== 'testnet') throw new BrokerError('MAINNET_REFUSED');
    let signer = options.dependencies?.signer;
    if (!signer) {
      const master = await readMasterSecret(options.env ?? process.env);
      try { signer = await custody.loadKeyFile(join(dataDir, 'custody.json'), master); }
      finally { master.fill(0); }
    }
    // Same OS user cannot start a second data directory for this custody key.
    // Cross-container fencing requires reusing the SAME named volume (see README).
    releaseKey = await exclusiveLock(join(tmpdir(), `bb-custody-${process.getuid?.() ?? 'user'}-${sha256Hex(signer.publicKey)}.lock`));
    // Resolve the volume root once (e.g. macOS /var -> /private/var).
    const auditRelative = relative(resolve(config.dataDir), resolve(config.auditKeyPath));
    if (!auditRelative || auditRelative.startsWith('..') || isAbsolute(auditRelative)) throw new BrokerError('FORBIDDEN');
    const auditPath = join(dataDir, auditRelative);
    await mkdir(dirname(auditPath), { recursive: true, mode: 0o700 });
    const auditDir = await realpath(dirname(auditPath));
    if (!auditDir.startsWith(`${dataDir}/`) && auditDir !== dataDir) throw new BrokerError('FORBIDDEN');
    const audit = AuditSigner.loadOrCreate(auditPath);
    const receipts = new ReceiptLog(store, audit);
    const checkpoints = new CheckpointLog(store, audit);
    const auth = new RequestAuthenticator({ store, clock, ownerPublicKey: config.ownerPublicKey });
    const broker = new BrokerService({ store, chain, signer, receipts, checkpoints,
      approvals: new TransactionalApprovalService({ kind: 'owner' }, receipts), clock, config, autoDispatch: false });
    await broker.start();
    // Track even operations whose HTTP client disconnects before completion.
    const tracked = new Proxy(broker, { get(target, key) {
      const item: unknown = Reflect.get(target, key);
      if (typeof item !== 'function') return item;
      return (...args: unknown[]) => {
        if (closing) return Promise.reject(new BrokerError('BROKER_UNAVAILABLE'));
        const work = Promise.resolve(Reflect.apply(item, target, args));
        calls.add(work); void work.then(() => calls.delete(work), () => calls.delete(work)); return work;
      };
    } });
    agent = createAgentHttpServer({ config, broker: tracked, authenticator: auth, clock });
    admin = createAdminHttpServer(config, tracked, auth, checkpoints);
    await listen(agent.server, config.agentPort, config.bindHost);
    await listen(admin.server, config.adminPort, config.bindHost);
    timer = setInterval(() => {
      if (closing || scheduled) return;
      scheduled = (async () => { await broker.expirePending(); await broker.drain(); })()
        .catch((e: unknown) => log(e instanceof BrokerError ? e.code : 'BROKER_UNAVAILABLE'))
        .finally(() => { scheduled = undefined; });
    }, intervalMs);
    log('ready');
    return { close(): Promise<void> { return closePromise ??= cleanup(); } };
  } catch (e) { await cleanup(); throw e; }
}

/** Signal handlers belong to the executable, not to the reusable composition seam. */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  let stop!: () => void;
  const stopped = new Promise<void>((done) => { stop = done; });
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    const daemon = await startDaemon(options);
    await stopped; await daemon.close();
  } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}
