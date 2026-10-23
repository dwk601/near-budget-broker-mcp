import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentTokenSchema, BrokerError, parseNear, ReceiptEventSchema, CheckpointSchema, ChainIdSchema, ErrorCodeSchema } from '../contracts/index.js';
import type { Checkpoint, ReceiptEvent } from '../contracts/index.js';
import { json, parseJson } from '../daemon/wire.js';
import { runStdioBridge } from '../bridge/index.js';
import { initOwnerKey, ownerPassphrase, readProtected, unlockOwnerKey, writeProtected } from './keys.js';
import { OwnerClient } from './client.js';
import { adminSchemas } from '../daemon/admin.js';
import type { AdminOperation } from '../daemon/admin.js';
import { z } from 'zod';
import { DaemonFailure } from '../daemon/diagnostics.js';

class UsageError extends Error {}
function usage(): never { throw new UsageError(); }
export interface CliOptions { env?: NodeJS.ProcessEnv; stdout?: (text: string) => void; stderr?: (text: string) => void }
/** Returns an exit code. Only main owns process exit; injectable output keeps tests quiet. */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const out = options.stdout ?? ((text: string) => process.stdout.write(text));
  const err = options.stderr ?? ((text: string) => process.stderr.write(text));
  const args: string[] = []; const flags = new Map<string, string>(); let asJson = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === '--json') asJson = true;
      else if (arg === '--force') flags.set('force', 'true');
      else if (arg.startsWith('--')) {
        if (!['key', 'url', 'file', 'out', 'config', 'master-file', 'key-file', 'audit-key', 'checkpoint', 'after', 'limit'].includes(arg.slice(2)) || argv[i + 1] === undefined || argv[i + 1]!.startsWith('--') || flags.has(arg.slice(2))) usage();
        flags.set(arg.slice(2), argv[++i]!);
      } else args.push(arg);
    }
    const required = (name: string) => flags.get(name) ?? usage();
    const print = (value: unknown) => out(`${json(value)}\n`);
    const [command, group, action, ...rest] = args;
    if (command === 'daemon') {
      if (args.length !== 1) usage();
      const { loadConfig, runDaemon } = await import('../daemon/index.js');
      await runDaemon({ config: await loadConfig(flags.get('config') ?? env['BB_CONFIG_FILE'] ?? usage()), env }); return 0;
    }
    if (command === 'mcp') {
      if (args.length !== 1) usage();
      // B07 owns transport signal cleanup. Install the exit waiter BEFORE its
      // async startup so EOF/signals during token loading cannot be missed.
      let stop!: () => void;
      const stopped = new Promise<void>((done) => { stop = done; });
      process.on('SIGTERM', stop); process.on('SIGINT', stop); process.stdin.once('end', stop);
      try {
        const bridge = await runStdioBridge({ env });
        if (process.stdin.readableEnded || process.stdin.destroyed) stop();
        await stopped; await bridge.close(); process.stdin.pause();
      } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); process.stdin.off('end', stop); }
      return 0;
    }
    if (command === 'init-custody') {
      if (args.length !== 1) usage();
      const { EncryptedFileCustody, readMasterSecret } = await import('../custody/index.js');
      const key = await readProtected(required('key-file'));
      let master: Buffer | undefined;
      try {
        master = await readMasterSecret({ BB_MASTER_SECRET_FILE: required('master-file') });
        await new EncryptedFileCustody().createEncryptedKeyFile(required('out'), key.toString('utf8').trim(), master);
      } finally { key.fill(0); master?.fill(0); }
      asJson ? print({ path: resolve(required('out')) }) : out(`${resolve(required('out'))}\n`); return 0;
    }
    if (command !== 'owner') usage();
    const forms: Record<string, readonly [number, number]> = {
      'init-owner-key': [2, 2], status: [2, 2], 'audit-key': [2, 2], reconcile: [2, 3], 'resolve-attempt': [4, 4],
      'agent create': [4, 4], 'agent list': [3, 3], 'agent revoke': [5, 5],
      'token issue': [4, 4], 'token rotate': [4, 4], 'token revoke': [4, 4],
      'policy set': [3, 3], 'policy get': [4, 4], 'wallet-policy set': [3, 3],
      'approvals list': [3, 3], 'approvals approve': [5, 5], 'approvals reject': [5, 5],
      'standing grant': [3, 3], 'standing revoke': [4, 4], 'standing list': [4, 4],
      'freeze global': [4, 4], 'freeze agent': [5, 5], 'unfreeze global': [4, 4], 'unfreeze agent': [5, 5],
      'requests list': [3, 4], 'requests get': [4, 4], 'receipts export': [4, 4], 'receipts verify': [3, 3], 'checkpoints list': [4, 4],
    };
    const form = forms[group ?? ''] ?? forms[`${group} ${action}`];
    if (!form || args.length < form[0] || args.length > form[1] || (flags.has('force') && group !== 'resolve-attempt')) usage();
    if (group === 'init-owner-key') {
      if (args.length !== 2) usage();
      const path = required('out'); const passphrase = await ownerPassphrase(env);
      if (passphrase.length < 12 || passphrase.length > 4096) usage();
      const publicKey = await initOwnerKey(path, passphrase);
      print({ path: resolve(path), publicKey }); return 0;
    }
    if (group === 'receipts' && action === 'verify') {
      const { verifyExportedChain } = await import('../audit/checkpoints/index.js');
      const receipts = (parseJson(await readFile(required('file'), 'utf8')) as unknown[]).map((r) => ReceiptEventSchema.parse(r));
      const checkpoint = CheckpointSchema.parse(parseJson(await readFile(required('checkpoint'), 'utf8')));
      const verified = verifyExportedChain(receipts, checkpoint, required('audit-key'));
      print(verified); return verified.valid ? 0 : 1;
    }
    let client: OwnerClient | undefined;
    async function call(operation: AdminOperation, body: unknown = {}): Promise<unknown> {
      try {
        adminSchemas[operation].parse(body);
        function ids(value: unknown): void {
          if (!value || typeof value !== 'object') return;
          for (const [key, item] of Object.entries(value)) {
            if (['agentId', 'requestId', 'credentialId', 'approvalId'].includes(key) && item !== undefined) z.uuid().parse(item);
            ids(item);
          }
        }
        ids(body);
        const fields = body as { reason?: string; expiresAt?: number; grant?: { expiresAt: number } };
        if (fields.reason !== undefined && fields.reason.trim().length === 0) usage();
        if (operation === 'approve' && fields.expiresAt! <= Date.now()) usage();
        if (operation === 'grantStandingApproval' && fields.grant!.expiresAt <= Date.now()) usage();
        json(body); // Reject malformed Unicode/non-JSON arguments before signing.
      } catch { usage(); }
      if (!client) {
        const url = flags.get('url') ?? env['BB_ADMIN_URL'] ?? 'http://127.0.0.1:3211';
        try {
          const parsed = new URL(url);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/'
            || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) usage();
        } catch { usage(); }
        const key = await unlockOwnerKey(flags.get('key') ?? env['BB_OWNER_KEY_FILE'] ?? usage(), await ownerPassphrase(env));
        client = new OwnerClient(url, key);
      }
      try { return await client.call(operation, body); }
      catch (e) {
        // The transport's stable FORBIDDEN vocabulary also represents a stale
        // policy CAS. This is an owner input conflict, not failed authentication.
        if (e instanceof BrokerError && e.code === 'FORBIDDEN' && ['setPolicy', 'setWalletPolicy'].includes(operation)) usage();
        throw e;
      }
    }
    async function fileObject(): Promise<Record<string, unknown>> {
      try {
        const value = parseJson(await readFile(required('file'), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) usage();
        return value as Record<string, unknown>;
      } catch { usage(); }
    }
    const at = (index = 0) => rest[index] ?? usage();
    const money = (value: unknown) => { try { return parseNear(value).toString(); } catch { usage(); } };
    const limit = flags.has('limit') ? Number(flags.get('limit')) : 1000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) usage();
    const page = { limit, ...(flags.has('after') ? { after: required('after') } : {}) };
    let result: unknown;
    if (group === 'agent' && action === 'create') result = await call('createAgent', { name: at() });
    else if (group === 'agent' && action === 'list') result = await call('listAgents', page);
    else if (group === 'agent' && action === 'revoke') result = await call('revokeAgent', { agentId: at(), reason: at(1) });
    else if (group === 'token' && (action === 'issue' || action === 'rotate')) {
      // Public credential ID enables rotation/revocation without receipt scraping.
      const path = required('out'); let credentialId: string | undefined;
      await writeProtected(path, async () => {
        const issued = await call(action === 'issue' ? 'issueToken' : 'rotateToken', action === 'issue' ? { agentId: at() } : { credentialId: at() }) as { token: string; credential: { id: string } };
        credentialId = issued.credential.id;
        return `${AgentTokenSchema.parse(issued.token)}\n`;
      });
      asJson ? print({ path: resolve(path), credentialId }) : out(`${resolve(path)}\ncredentialId: ${credentialId}\n`); return 0;
    } else if (group === 'token' && action === 'revoke') result = await call('revokeToken', { credentialId: at() });
    else if (group === 'policy' && action === 'get') result = await call('getPolicy', { agentId: at() });
    else if ((group === 'policy' || group === 'wallet-policy') && action === 'set') {
      const policy = await fileObject();
      for (const field of group === 'policy' ? ['perTxMax', 'rolling24hMax', 'lifetimeMax', 'gasBudget24h', 'approvalThreshold'] : ['rolling24hMax', 'safetyReserve']) {
        if (policy[field] !== null) policy[field] = money(policy[field]);
      }
      const rev = policy['revision']; if (!Number.isSafeInteger(rev) || (rev as number) < 1) usage();
      result = await call(group === 'policy' ? 'setPolicy' : 'setWalletPolicy', { policy, expectedRevision: rev === 1 ? null : (rev as number) - 1 });
    } else if (group === 'approvals' && action === 'list') result = await call('listRequests', { filter: { states: ['pending_approval'] }, query: page });
    else if (group === 'approvals' && action === 'approve') result = await call('approve', { requestId: at(), expiresAt: Number(at(1)) });
    else if (group === 'approvals' && action === 'reject') result = await call('reject', { requestId: at(), reason: at(1) });
    else if (group === 'standing' && action === 'grant') {
      const grant = await fileObject(); grant['perTxMax'] = money(grant['perTxMax']); grant['totalMax'] = money(grant['totalMax']);
      result = await call('grantStandingApproval', { grant });
    } else if (group === 'standing' && action === 'revoke') result = await call('revokeStandingApproval', { approvalId: at() });
    else if (group === 'standing' && action === 'list') result = await call('listStandingApprovals', { agentId: at(), query: page });
    else if (group === 'freeze' || group === 'unfreeze') {
      // Here action is the scope, rest holds agent ID (if any), then reason.
      const target = action === 'global' ? { scope: 'global' } : action === 'agent' ? { scope: 'agent', agentId: at() } : usage();
      result = await call(group, { target, reason: action === 'global' ? at() : at(1) });
    } else if (group === 'status') result = await call('walletStatus');
    else if (group === 'audit-key') result = await call('auditPublicKey');
    else if (group === 'requests' && action === 'get') result = await call('getRequest', { requestId: at() });
    else if (group === 'requests' && action === 'list') result = await call('listRequests', { filter: rest[0] ? { agentId: rest[0] } : {}, query: page });
    else if (group === 'reconcile') result = await call('reconcile', action ? { requestId: action } : {});
    else if (group === 'resolve-attempt') result = await call('resolveAttempt', { requestId: action ?? usage(), reason: at(), force: flags.has('force') });
    else if ((group === 'receipts' && action === 'export') || (group === 'checkpoints' && action === 'list')) {
      const chainId = ChainIdSchema.parse(at()); const all: (ReceiptEvent | Checkpoint)[] = []; let afterSeq = 0;
      for (;;) {
        const batch = await call(group === 'receipts' ? 'exportReceipts' : 'listCheckpoints', { chainId, afterSeq, limit: 1000 }) as (ReceiptEvent | Checkpoint)[];
        if (!batch.length) break; all.push(...batch); afterSeq = batch.at(-1)!.seq;
      }
      if (flags.has('out')) { await writeProtected(required('out'), json(all)); asJson ? print({ path: resolve(required('out')) }) : out(`${resolve(required('out'))}\n`); return 0; }
      result = all;
    } else usage();
    print(result ?? null); return 0;
  } catch (e) {
    const code = e instanceof UsageError || (args[0] === 'owner' && e instanceof z.ZodError) ? 'USAGE' : e instanceof BrokerError ? e.code : 'BROKER_UNAVAILABLE';
    const reason = e instanceof DaemonFailure ? e.reason : undefined;
    const text = asJson ? json({ error: { code, ...(reason ? { reason } : {}) } }) : `Budget Broker: ${reason ?? code}${code === 'USAGE' ? ' (see docker/README.md for commands)' : ''}`;
    err(`${text}\n`);
    if (code === 'USAGE') return 2;
    return ErrorCodeSchema.safeParse(code).success && (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') ? 3 : 1;
  }
}
