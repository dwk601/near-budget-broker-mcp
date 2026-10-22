/** Review-gap mutation verification. Semantic reconstructions: reviewer supplied
 * IDs/descriptions, not patch files. Mutates ONLY an isolated temporary copy.
 * The worktree is read-only even if this process is killed. Run: npx tsx test/broker/mutations.ts
 * Equivalent/defense-only survivors identified as such by review are excluded.
 */
import { readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const source = resolve('src/broker/service.ts'); const original = readFileSync(source, 'utf8');
const root = mkdtempSync(join(tmpdir(), 'bb-mutations-'));
const file = join(root, 'src/broker/service.ts');
function replace(source: string, old: string, next: string): string {
  if (!source.includes(old) || source.indexOf(old) !== source.lastIndexOf(old)) throw new Error(`Nonunique mutation: ${old}`);
  return source.replace(old, next);
}
function scope(start: string, end: string, mutate: (text: string) => string): string {
  const a = original.indexOf(start); const b = original.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('Missing scope');
  return original.slice(0, a) + mutate(original.slice(a, b)) + original.slice(b);
}
const mutations: [string, () => string, { path: string; mutate: (text: string) => string }?][] = [];
for (const [id, start, end] of [
  ['M01', '  async freeze(p:', '  async unfreeze('], ['M02', '  async unfreeze(', '  async exportReceipts('],
  ['M45b', '  async freezeSelf(', '  async createAgent('], ['M46b', '  async revokeAgent(', '  async listAgents('],
  ['M46c', '  async setPolicy(', '  async setWalletPolicy('], ['M47b', '  async setWalletPolicy(', '  async approve('],
  ['M49', '  async revokeStandingApproval(', '  private writeFreeze('], ['M50', '  async approve(', '  /** B12 uses'],
] as const) mutations.push([id, () => scope(start, end, (s) => replace(s, 'this.lane.run(', 'Promise.resolve().then('))]);
const add = (id: string, old: string, next: string) => mutations.push([id, () => replace(original, old, next)]);
add('M37', "if (request.expiresAt !== null && now >= request.expiresAt)", "if (false && request.expiresAt !== null && now >= request.expiresAt)");
add('M65', "if (!prior && current.expiresAt !== null && this.o.clock.now() >= current.expiresAt)", "if (false && !prior && current.expiresAt !== null && this.o.clock.now() >= current.expiresAt)");
mutations.push(['M76', () => scope('  private async send(', '  private neverOffered(', (s) => replace(s,
  'const decision = this.boundDecision(tx, this.evaluation(tx, request, request.id));',
  'const input = this.evaluation(tx, request, request.id); input.usage.agentFrozen = false; const decision = this.boundDecision(tx, input);'))]);
add('M62', 'tx.revokeAgentCredentials(agentId, this.o.clock.now());', '/* mutant: credential revocation omitted */');
add('M77', "for (const c of credentials) if (c.revokedAt === null) this.credentialEvent(tx, 'credential_revoked', agentId, c.id);", 'void credentials;');
mutations.push(['M24', () => scope('  async freezeSelf(', '  async createAgent(', (s) => replace(s, 'this.agent(tx, principal);', '/* mutant: authentication omitted */'))]);
add('M25-frozen', 'policy !== null && !u.agentFrozen &&', 'policy !== null &&');
add('M25-expired', '(policy.expiresAt === undefined || at < policy.expiresAt)', 'true');
add('M79', "if (request.state === 'queued') this.event(tx, { type: 'queued', payload: { requestId: request.id, agentId: request.agentId } }, request.agentId);", '/* mutant: queued receipt omitted */');
mutations.push(['M80', () => scope('  async approve(', '  /** B12 uses', (s) => replace(s,
  "this.event(tx, { type: 'queued', payload: { requestId, agentId: request.agentId } }, request.agentId);", '/* mutant: approval queued receipt omitted */'))]);
add('M81', "if (both && parsed.chainId !== 'owner')", "if (false && both && parsed.chainId !== 'owner')");
add('M82', "this.event(tx, { type: 'agent_created', payload: { agent } }, agent.id, true);", "this.event(tx, { type: 'agent_created', payload: { agent } }, agent.id, false);");
add('M83', "this.event(tx, { type, payload: { agentId, credentialId } }, agentId, true);", "this.event(tx, { type, payload: { agentId, credentialId } }, agentId, false);");
add('M40', "this.accounting(tx, next, 'fee_released', hold.feeReserve > outcome.tokensBurnt ? hold.feeReserve - outcome.tokensBurnt : 0n);", "this.accounting(tx, next, 'fee_released', 0n);");
mutations.push(['M60', () => {
  const a = original.indexOf('    if (signed.transfer.nonce !== nonce');
  const b = original.indexOf("throw new BrokerError('FORBIDDEN');", a) + "throw new BrokerError('FORBIDDEN');".length;
  if (a < 0 || b < a) throw new Error('Missing validation');
  return original.slice(0, a) + '    /* mutant: adapter output unchecked */' + original.slice(b);
}]);
add('M61', 'if (!access.fullAccess || access.publicKey !== this.o.signer.publicKey)', 'if (access.publicKey !== this.o.signer.publicKey)');
add('M56', "if (result.kind === 'accepted' && result.txHash === attempt.txHash)", "if (result.kind === 'accepted')");
add('M57', 'reserveStandingApproval(tx, current, standingId, this.o.clock.now())', "{ kind: 'standing' as const, id: standingId }");
add('M20', 'a.attempt.nonce < b.attempt.nonce ? -1 : a.attempt.nonce > b.attempt.nonce ? 1 : 0', 'a.attempt.nonce < b.attempt.nonce ? 1 : a.attempt.nonce > b.attempt.nonce ? -1 : 0');
add('M21', 'a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)', 'b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)');
add('M22', 'await this.expirePending();', '/* mutant: sweeper omitted */');
mutations.push(['M48', () => scope('  async approve(', '  /** B12 uses', (s) => replace(s, 'await this.refreshLocked();', '/* mutant: stale approval snapshot */'))]);

// Additional direct F1-F12 regressions beyond the review's named gap IDs.
mutations.push(['F2-refresh-each-attempt', () => scope('  private async run(', '  private authorizeQueued(',
  (s) => replace(s, 'await this.refreshLocked();', '/* mutant: only cached balance */'))]);
add('F3a-rebroadcast', 'if (!await this.send(send)) return null;', "if (attempt.status === 'outcome_unknown') return null; if (!await this.send(send)) return null;");
mutations.push(['F4-proof-release', () => scope('  private async recover(', '  private settle(', (s) => replace(replace(s,
  "const certain = attempt.status === 'proven_not_executed' || unoffered;", 'const certain = false;'),
  "if (attempt.status === 'proven_not_executed' || unoffered)", 'if (false)'))]);
add('F5-never-offered', 'const unoffered = this.o.store.read((r) => this.neverOffered(r, attempt));', 'const unoffered = false;');
add('F8-pending', "if (outcome.kind === 'pending')", "if (false && outcome.kind === 'pending')");
add('F9-preview', 'if (fresh) e.usage.balance = fresh;', 'void fresh;');
add('F10-clock', 'if (this.o.clock.now() >= request.updatedAt)', 'if (true)');
add('F11-grant-binding', "return ref?.kind !== 'standing' || a.id === ref.id;", 'return true;');
add('F12-reconcile', 'this.run(false, requestId)', 'this.run(true, requestId)');

// New-review non-equivalent survivors and proof/force/cache safety mutations.
mutations.push(['N08-resolution-pump', () => scope('  async resolveAttempt(', '  async drain(', (s) => replace(s, 'this.pump.run(', 'Promise.resolve().then('))]);
mutations.push(['N20-rebroadcast-lane', () => scope('  private async recover(', '  private settle(', (s) => replace(s, 'this.lane.run(', 'Promise.resolve().then('))]);
add('N13-stale-abandon', "decision.reasons.some((reason) => reason !== 'WALLET_CAPACITY')", 'true');
mutations.push(['N15-stale-abandon', () => scope('  private async recover(', '  private settle(', (s) => replace(s,
  "(reasons.length === 1 && reasons.includes('WALLET_CAPACITY') && this.o.store.read((r) => this.stale(r)))", 'false'))]);
mutations.push(['N17-drain-pump', () => scope('  private async run(', '  private authorizeQueued(', (s) => replace(s, 'this.pump.run(', 'Promise.resolve().then('))]);
add('N29-reconcile-id', 'if (requestId !== undefined && existing.request.id !== requestId) break;', '/* mutant: ignore ID */');
add('N29-watch-id', '.filter((request) => requestId === undefined || request.id === requestId)', '.filter(() => true)');
add('N2-final-recheck', 'const current = await this.status(prior);', "const current: ChainOutcome = { kind: 'not_executed', evidence: 'cached proof', invalidNonce: true };");
add('N3-explicit-force-required', "if (outcome.kind !== 'not_executed' && !force) throw new BrokerError('FORBIDDEN');", "if (outcome.kind !== 'not_executed') force = true;");
add('N3-retain-forced-hold', "force, outcome.kind !== 'not_executed'", 'force, false');
add('N3-watch-resolution', 'new Set<string>(await this.watchResolved(requestId))', 'new Set<string>()');
add('N7-intent-once', 'if (stored.lastOfferedAt === null) this.event', 'if (true) this.event');
add('N9-unsent-not-unknown', 'if (!await this.send(attempt)) return null;', 'await this.send(attempt);');
const others = new Map<string, string>();
function other(id: string, path: string, mutate: (text: string) => string) {
  others.set(path, readFileSync(path, 'utf8'));
  mutations.push([id, () => original, { path, mutate }]);
}
other('N1-history-retained', 'src/near/native.ts', (s) => replace(s,
  "const anchor = record(record(await this.#rpc.call('block', { block_id: t.blockHash }))['header']);",
  "const anchor = { hash: t.blockHash, height: '0' } as Record<string, unknown>;"));
other('N1-prolonged-lag', 'src/near/native.ts', (s) => replace(s,
  "if (attempt.offerCount !== 1 || (attempt.firstRejection !== 'INVALID_NONCE'\n        && attempt.firstRejection !== 'EXPIRED_BLOCK_HASH')) return unknownOutcome();",
  '/* mutant: negative lookup lag accepted as proof for accepted bytes */'));
other('N1-minimum-age', 'src/near/native.ts', (s) => replace(s, 'now - offered < NON_EXECUTION_MIN_AGE_MS', 'false'));
other('N4-negative-cache', 'src/broker/balance.ts', (s) => replace(s,
  'if (state.failedAt !== undefined && now >= state.failedAt && now - state.failedAt < BALANCE_FAILURE_BACKOFF_MS)', 'if (false)'));
other('N8-preview-cache', 'src/broker/balance.ts', (s) => replace(s,
  'if (state.cached && state.cached.observedAt <= now && now - state.cached.observedAt <= maxAge)', 'if (false)'));

const run = () => spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', 'test/broker/review.test.ts', 'test/broker/safety.test.ts', 'test/near/non-execution.test.ts'],
  { cwd: root, encoding: 'utf8', timeout: 30000 });
let killed = 0;
try {
  for (const path of ['src', 'test/broker', 'test/near', 'package.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.test.json']) cpSync(path, join(root, path), { recursive: true });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const baseline = run();
  if (baseline.status !== 0) throw new Error(`Baseline failed\n${baseline.stdout}\n${baseline.stderr}`);
  for (const [id, mutate, side] of mutations) {
    writeFileSync(file, mutate());
    if (side) writeFileSync(join(root, side.path), side.mutate(others.get(side.path)!));
    const result = run();
    const output = result.stdout + result.stderr;
    writeFileSync(file, original);
    if (side) writeFileSync(join(root, side.path), others.get(side.path)!);
    if (result.status === 0 || !output.includes('AssertionError')) throw new Error(`${id}: survived or invalid mutant\n${output}`);
    console.log(`${id}: killed by regression assertions`); killed++;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  if (readFileSync(source, 'utf8') !== original || [...others].some(([path, text]) => readFileSync(path, 'utf8') !== text)) {
    throw new Error('Worktree source changed outside the isolated mutation runner');
  }
}
console.log(`${killed}/${mutations.length} non-equivalent review-gap mutants killed in isolated copy; worktree unchanged`);
