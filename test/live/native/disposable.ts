import assert from 'node:assert/strict';
import { mkdtemp, open, rename, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { actions, KeyPair } from 'near-api-js';
import { formatNear, parseNear } from '../../../src/contracts/index.js';
import { sleep, summary } from '../../../scripts/demo/harness.js';
import { permissionStatus } from '../../../scripts/fixtures/native/fixtures.js';
import { Testnet, RpcFailure } from './network.js';
import type { PreparedRecovery } from './network.js';

interface Journal {
  version: 1; id: string; beneficiary: string; rpcUrl: string;
  recoverySecret: string; brokerSecret: string;
  create: PreparedRecovery | null; cleanup: PreparedRecovery | null;
  cleanupOffered?: boolean;
  beforeDelete: { custody: string; disposable: string } | null;
}
/** Durable BEFORE funding. Ambiguous creation/deletion is reconciled by hash, never re-signed. */
export class Disposable {
  readonly recovery: KeyPair;
  readonly broker: KeyPair;
  readonly journal: Journal;
  directory = ''; journalPath = '';
  private work: Promise<void> | undefined;
  private cleaned = false;
  constructor(readonly id: string, readonly beneficiary: string, readonly network: Testnet,
    private readonly delay: (ms: number) => Promise<void> = sleep,
    private readonly log: (line: string) => unknown = summary, persisted?: Journal) {
    this.recovery = persisted ? KeyPair.fromString(persisted.recoverySecret as `ed25519:${string}`) : KeyPair.fromRandom('ed25519');
    this.broker = persisted ? KeyPair.fromString(persisted.brokerSecret as `ed25519:${string}`) : KeyPair.fromRandom('ed25519');
    this.journal = persisted ?? { version: 1, id, beneficiary, rpcUrl: network.url, recoverySecret: this.recovery.toString(),
      brokerSecret: this.broker.toString(), create: null, cleanup: null, cleanupOffered: false, beforeDelete: null };
  }
  /** Resume only our protected temp journal; never recursively remove arbitrary directories. */
  static async resume(path: string, network: Testnet, delay: (ms: number) => Promise<void> = sleep,
    log: (line: string) => unknown = summary) {
    assert.equal(basename(path), 'recovery.json');
    assert.equal(await permissionStatus(path), 'ok', 'protected recovery record required');
    const directory = await realpath(dirname(path));
    assert.equal(dirname(directory), await realpath(tmpdir())); assert(basename(directory).startsWith('bb-disposable-'));
    assert.equal(await permissionStatus(directory, true), 'ok', 'protected recovery directory required');
    const journal = JSON.parse(await readFile(path, 'utf8')) as Journal;
    assert.equal(journal.version, 1); assert.equal(journal.rpcUrl, network.url);
    assert(journal.id.startsWith('b10-'), 'unexpected disposable ID');
    const life = new Disposable(journal.id, journal.beneficiary, network, delay, log, journal);
    life.directory = directory; life.journalPath = join(directory, 'recovery.json'); return life;
  }
  async init() {
    this.directory = await mkdtemp(join(tmpdir(), 'bb-disposable-')); this.journalPath = join(this.directory, 'recovery.json');
    await this.save();
    this.log(`disposable planned id=${this.id} recovery-record=${this.journalPath} (protected; no secret values logged)`);
    return this;
  }
  private async save() {
    const next = `${this.journalPath}.next`; const file = await open(next, 'w', 0o600);
    try { await file.chmod(0o600); await file.writeFile(JSON.stringify(this.journal)); await file.sync(); }
    finally { await file.close(); }
    await rename(next, this.journalPath);
  }
  async create(parentSecret: string, signal: AbortSignal) {
    const chain = new Testnet(this.network.url, this.network.fetcher, signal);
    this.journal.create = await chain.prepareRecovery(this.beneficiary, parentSecret, this.id, [actions.createAccount(), actions.transfer(parseNear('0.5')),
      actions.addFullAccessKey(this.recovery.getPublicKey()), actions.addFullAccessKey(this.broker.getPublicKey())]);
    await this.save(); signal.throwIfAborted();
    const result = await chain.submitRecovery(this.journal.create);
    this.log(`disposable create ${this.id} https://testnet.nearblocks.io/txns/${result.transaction.hash}`);
  }
  async cleanup(stopDaemon: () => Promise<void>) {
    if (this.cleaned) return;
    if (this.work) return this.work;
    this.work = this.runCleanup(stopDaemon);
    try { await this.work; } finally { this.work = undefined; }
  }
  private async runCleanup(stopDaemon: () => Promise<void>) {
    // Independent from an aborted/timed-out scenario; also called by onTestFinished and afterAll.
    const deadline = AbortSignal.timeout(180_000);
    const chain = new Testnet(this.network.url, this.network.fetcher, deadline);
    let complete = false; let stage = 'stop-daemon';
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        stage = 'stop-daemon'; await stopDaemon();
        if (this.journal.create) {
          stage = 'creation-finality'; await this.save();
          await chain.finishRecovery(this.journal.create);
          if (!this.journal.cleanup) {
            stage = 'capture-balance'; const before = await chain.snapshot(this.beneficiary, this.id);
            assert(before.receiver > parseNear('0.48'), 'disposable still holds its funded remainder');
            this.journal.beforeDelete = { custody: before.sender.toString(), disposable: before.receiver.toString() };
            stage = 'prepare-delete'; this.journal.cleanup = await chain.prepareRecovery(this.id, this.recovery.toString(), this.id, [actions.deleteAccount(this.beneficiary)]);
            await this.save();
          }
          // Never poll an unsent hash with wait_until=FINAL: some nodes block that
          // lookup until its deadline rather than returning UNKNOWN_TRANSACTION.
          const firstOffer = !this.journal.cleanupOffered;
          this.journal.cleanupOffered = true; await this.save();
          stage = firstOffer ? 'submit-delete' : 'reconcile-delete';
          const deleted = firstOffer ? await chain.submitRecovery(this.journal.cleanup) : await chain.finishRecovery(this.journal.cleanup);
          stage = 'confirm-absence'; assert.equal(await chain.account(this.id), null, 'FINAL UNKNOWN_ACCOUNT required after deletion');
          stage = 'confirm-return'; const custody = await chain.account(this.beneficiary); assert(custody);
          const before = this.journal.beforeDelete!;
          const returned = custody.amount + custody.locked - BigInt(before.custody);
          // Bound deletion gas/refund effects to 0.010, rather than merely checking total spend <1.5.
          // Losing the 0.5 funding, a missing beneficiary or a still-live account CANNOT pass this.
          assert(returned >= BigInt(before.disposable) - parseNear('0.010') && returned <= BigInt(before.disposable), 'custody recovered disposable remainder');
          assert(returned > parseNear('0.48'), 'at least 0.48 NEAR returned to custody');
          this.log(`PASS disposable cleanup: UNKNOWN_ACCOUNT; returned=${formatNear(returned)} NEAR to ${this.beneficiary} https://testnet.nearblocks.io/txns/${deleted.transaction.hash}`);
        }
        stage = 'remove-journal'; await rm(this.directory, { recursive: true, force: true });
        complete = true; this.cleaned = true;
        return;
      } catch (e) {
        const code = e instanceof RpcFailure && /^(HTTP_[0-9]{3}|UNKNOWN_ACCOUNT|UNKNOWN_TRANSACTION|FAILED)$/.test(e.code) ? e.code
          : e instanceof Error && e.name === 'TimeoutError' ? 'TIMEOUT' : e instanceof assert.AssertionError ? 'ASSERTION' : 'FAILED';
        if (attempt < 5 && !deadline.aborted) {
          this.log(`disposable cleanup retry ${attempt + 1}/5 id=${this.id} stage=${stage} code=${code} (persisted bytes; values redacted)`);
          await this.delay(Math.min(1000 * 2 ** attempt, 10_000));
        } else break;
      }
    }
    if (!complete) {
      // Never destroy the ONLY recovery key if the RPC remains unavailable.
      this.log(`FAIL disposable cleanup: stage=${stage} recovery record retained at ${this.journalPath} id=${this.id}`);
      throw new Error('disposable cleanup unconfirmed; protected recovery record retained');
    }
  }
}
