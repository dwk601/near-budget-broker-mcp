/** Review-gap mutation verification. Semantic reconstructions: reviewer supplied
 * IDs/descriptions, not patch files. Temporarily edits ONLY service.ts, runs real
 * regression tests, restores in finally. Run: npx tsx test/broker/mutations.ts
 * Equivalent/defense-only survivors identified as such by review are excluded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const file = 'src/broker/service.ts'; const original = readFileSync(file, 'utf8');
function replace(source: string, old: string, next: string): string {
  if (!source.includes(old) || source.indexOf(old) !== source.lastIndexOf(old)) throw new Error(`Nonunique mutation: ${old}`);
  return source.replace(old, next);
}
function scope(start: string, end: string, mutate: (text: string) => string): string {
  const a = original.indexOf(start); const b = original.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('Missing scope');
  return original.slice(0, a) + mutate(original.slice(a, b)) + original.slice(b);
}
const mutations: [string, () => string][] = [];
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
add('F3a-rebroadcast', 'await this.send(send);', "if (attempt.status !== 'outcome_unknown') await this.send(send);");
mutations.push(['F4-proof-release', () => scope('  private async recover(', '  private settle(', (s) => replace(replace(s,
  "const certain = attempt.status === 'proven_not_executed' || unoffered;", 'const certain = false;'),
  "if (attempt.status === 'proven_not_executed' || unoffered)", 'if (false)'))]);
add('F5-never-offered', 'const unoffered = this.o.store.read((r) => this.neverOffered(r, attempt));', 'const unoffered = false;');
add('F8-pending', "if (outcome.kind === 'pending')", "if (false && outcome.kind === 'pending')");
add('F9-preview', 'if (fresh) e.usage.balance = fresh;', 'void fresh;');
add('F10-clock', 'if (this.o.clock.now() >= request.updatedAt)', 'if (true)');
add('F11-grant-binding', "return ref?.kind !== 'standing' || a.id === ref.id;", 'return true;');
add('F12-reconcile', 'this.run(false, requestId)', 'this.run(true, requestId)');

const run = () => spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/broker/review.test.ts'], { encoding: 'utf8', timeout: 30000 });
const baseline = run();
if (baseline.status !== 0) throw new Error(`Baseline failed\n${baseline.stdout}\n${baseline.stderr}`);
let killed = 0;
try {
  for (const [id, mutate] of mutations) {
    writeFileSync(file, mutate());
    const result = run();
    const output = result.stdout + result.stderr;
    writeFileSync(file, original);
    if (result.status === 0 || !output.includes('AssertionError')) throw new Error(`${id}: survived or invalid mutant\n${output}`);
    console.log(`${id}: killed by regression assertions`); killed++;
  }
} finally { writeFileSync(file, original); }
console.log(`${killed}/${mutations.length} non-equivalent review-gap mutants killed; source restored`);
