import { randomBytes, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS, AgentCredentialSchema, AgentPolicySchema, AgentTokenSchema,
  BrokerError, ConfigSchema, DEFAULT_FEE_RESERVE_PER_TX, DecimalTextSchema, ERROR_CODES,
  EXPLORER_BASE, FreezeSchema, MCP_AGENT_TOOL_INPUT_SCHEMAS, MCP_AGENT_TOOL_NAMES,
  OWNER_MAX_SKEW_MS, OwnerSigningPayloadSchema, ReceiptEventSchema, SignatureSchema,
  StandingApprovalSchema, TRANSFER_STATES, TransferInputSchema, WalletPolicySchema,
  formatNear, fromDecimalText, parseConfig, parseNear, toDecimalText,
} from '../../src/contracts/index.js';
import type { TransferState } from '../../src/contracts/index.js';
import { actions, createTransaction, decodeSignedTransaction, encodeTransaction, KeyPair, Signature, SignedTransaction } from 'near-api-js';

const config = {
  network: 'testnet', rpcUrl: 'https://rpc.testnet.near.org', accountId: 'broker.testnet',
  dataDir: '/data', auditKeyPath: '/data/audit.key', ownerPublicKey: `ed25519:${'1'.repeat(32)}`, safetyReserve: 0n,
};
const policy = {
  agentId: 'a', revision: 1, perTxMax: 0n, rolling24hMax: 0n, lifetimeMax: 0n,
  gasBudget24h: 0n, ratePerMinute: 0, maxOutstanding: 0,
  recipients: { mode: 'allowlist', accounts: [] }, approvalThreshold: null,
};

describe('exact amounts (no floating point)', () => {
  it.each([
    ['0', 0n], ['1', 10n ** 24n], ['0.001', 10n ** 21n],
    ['0.000000000000000000000001', 1n], ['1.000000000000000000000001', 10n ** 24n + 1n],
    ['340282366920938.463463374607431768211455', 340282366920938463463374607431768211455n],
  ])('round trips %s', (text, expected) => {
    expect(parseNear(text)).toBe(expected);
    expect(formatNear(expected)).toBe(text);
    expect(fromDecimalText(toDecimalText(expected))).toBe(expected);
  });
  it('normalizes trailing fractional zeros without losing precision', () => {
    expect(formatNear(parseNear('1.230000000000000000000000'))).toBe('1.23');
    expect(formatNear(parseNear('0.000'))).toBe('0');
    expect(DEFAULT_FEE_RESERVE_PER_TX).toBe(1_000_000_000_000_000_000_000n);
  });
  it.each([
    '-1', '-0', '-0.001', '+1', 'NaN', 'Infinity', 'one', '', ' ', ' 1', '1 ',
    '1e-3', '0x10', '.1', '1.', '1.2.3', '01', '1_000', '1,000',
    '0.0000000000000000000000001', '1.1234567890123456789012345',
    0, 1, 0.001, NaN, Infinity, 1n, null, undefined, {}, [],
  ])('rejects invalid input %s', (value) => {
    try { parseNear(value); expect.unreachable(); }
    catch (error) { expect(error).toBeInstanceOf(BrokerError); expect(error).toHaveProperty('code', 'INVALID_AMOUNT'); }
  });
  it('rejects invalid formatted amounts and persisted numeric values', () => {
    expect(() => formatNear(-1n)).toThrow('INVALID_AMOUNT');
    expect(() => fromDecimalText(1)).toThrow('INVALID_AMOUNT');
    expect(() => fromDecimalText('01')).toThrow('INVALID_AMOUNT');
    for (const invalid of ['-1', '1.0', '1e3', '', '01', 1, 1n]) {
      expect(DecimalTextSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('testnet-only config', () => {
  it('accepts testnet and supplies frozen defaults', () => {
    const parsed = parseConfig(config);
    expect(parsed.explorerBase).toBe(EXPLORER_BASE);
    expect(parsed.feeReservePerTx).toBe(parseNear('0.001'));
    expect(parsed.agentPort).not.toBe(parsed.adminPort);
  });
  it('refuses mainnet with a machine-readable code', () => {
    expect(() => parseConfig({ ...config, network: 'mainnet' })).toThrow('MAINNET_REFUSED');
    try { parseConfig({ ...config, network: 'mainnet' }); }
    catch (error) { expect(error).toHaveProperty('code', 'MAINNET_REFUSED'); }
    expect(ConfigSchema.safeParse({ ...config, network: 'mainnet' }).success).toBe(false);
  });
  it.each([
    { network: 'localnet' }, { rpcUrl: 'https://rpc.mainnet.near.org' },
    { rpcUrl: 'ftp://testnet.example' }, { rpcUrl: 'https://secret:secret@testnet.example' },
    { agentPort: 4000, adminPort: 4000 }, { agentPort: 0 }, { adminPort: 65536 },
    { feeReservePerTx: 0.001 }, { safetyReserve: -1n }, { ownerPublicKey: 'secp256k1:bad' },
    { explorerBase: 'https://nearblocks.io/txns/' },
  ])('rejects unsafe config %s', (override) => {
    expect(ConfigSchema.safeParse({ ...config, ...override }).success).toBe(false);
  });
});

describe('state machine', () => {
  const transitions: Readonly<Record<TransferState, readonly TransferState[]>> = ALLOWED_TRANSITIONS;
  it('is exhaustive, has known unique targets, and forbids self transitions', () => {
    expect(Object.keys(transitions).sort()).toEqual([...TRANSFER_STATES].sort());
    for (const state of TRANSFER_STATES) {
      const targets = transitions[state];
      expect(new Set(targets).size).toBe(targets.length);
      expect(targets).not.toContain(state);
      for (const target of targets) expect(TRANSFER_STATES).toContain(target);
    }
  });
  it('keeps terminal outcomes terminal and ambiguity non-cancellable', () => {
    for (const state of ['denied', 'rejected', 'expired', 'cancelled', 'succeeded', 'failed'] as const) {
      expect(transitions[state]).toEqual([]);
    }
    for (const state of ['signed', 'submitted', 'outcome_unknown'] as const) {
      for (const forbidden of ['queued', 'cancelled', 'expired', 'approved']) {
        expect(transitions[state]).not.toContain(forbidden);
      }
    }
    expect(transitions.outcome_unknown).toEqual(['submitted', 'succeeded', 'failed']);
    expect(transitions.queued).toContain('signed');
    expect(transitions.queued).toContain('cancelled');
    expect(transitions.pending_approval).toContain('approved');
    expect(transitions.pending_approval).toContain('expired');
    expect(transitions.signed).toContain('outcome_unknown');
  });
});

describe('credentials and strict boundaries', () => {
  it('accepts canonical 32-byte tokens, including all possible final sextets', () => {
    for (const lastByte of Array.from({ length: 256 }, (_, i) => i)) {
      const bytes = Buffer.alloc(32); bytes[31] = lastByte;
      expect(AgentTokenSchema.parse(`bb_agent_${bytes.toString('base64url')}`)).toMatch(/^bb_agent_/);
    }
    expect(AgentTokenSchema.safeParse(`bb_agent_${randomBytes(32).toString('base64url')}`).success).toBe(true);
  });
  it.each([
    '', 'bb_agent_bad', `bb_agent_${'A'.repeat(42)}`, `bb_agent_${'A'.repeat(44)}`,
    `bb_agent_${'A'.repeat(42)}B`, `bb_agent_${'A'.repeat(43)}=`,
    `bb_agent_${'/'.repeat(43)}`, `other_${'A'.repeat(43)}`,
  ])('rejects malformed token %s', (token) => {
    expect(AgentTokenSchema.safeParse(token).success).toBe(false);
  });
  it('stores only credential hashes and rejects secrets in persisted records', () => {
    const credential = { id: 'c', agentId: 'a', tokenHash: 'a'.repeat(64), createdAt: 1, revokedAt: null };
    expect(AgentCredentialSchema.safeParse(credential).success).toBe(true);
    expect(AgentCredentialSchema.safeParse({ ...credential, token: `bb_agent_${'A'.repeat(43)}` }).success).toBe(false);
    expect(AgentCredentialSchema.safeParse({ ...credential, tokenHash: 'secret' }).success).toBe(false);
  });
  it('requires idempotency and derives identity outside tool arguments', () => {
    expect(TransferInputSchema.safeParse({ receiverId: 'bob.testnet', amount: 1n }).success).toBe(false);
    const tool = MCP_AGENT_TOOL_INPUT_SCHEMAS.request_transfer;
    const input = { receiverId: 'bob.testnet', amount: '1', idempotencyKey: 'once' };
    expect(tool.safeParse(input).success).toBe(true);
    for (const amount of [0.001, 1, '0', '-1', '0.001', 1n]) expect(tool.safeParse({ ...input, amount }).success).toBe(false);
    expect(tool.safeParse({ ...input, agentId: 'victim' }).success).toBe(false);
    expect(Object.keys(MCP_AGENT_TOOL_INPUT_SCHEMAS)).toEqual([...MCP_AGENT_TOOL_NAMES]);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('policy, audit, and owner request shapes', () => {
  it('zero limits remain zero and missing policy fields never default to unlimited', () => {
    expect(AgentPolicySchema.parse(policy)).toEqual(policy);
    expect(AgentPolicySchema.safeParse({ agentId: 'a' }).success).toBe(false);
    expect(AgentPolicySchema.safeParse({ ...policy, perTxMax: -1n }).success).toBe(false);
    expect(AgentPolicySchema.safeParse({ ...policy, revision: 0 }).success).toBe(false);
    expect(WalletPolicySchema.parse({ revision: 1, rolling24hMax: 0n, safetyReserve: 0n }).rolling24hMax).toBe(0n);
  });
  it('bounds standing approvals without default widening of recipient lists', () => {
    const approval = { id: 's', agentId: 'a', perTxMax: 1n, totalMax: 2n, usedTotal: 0n, expiresAt: 100 };
    expect(StandingApprovalSchema.parse({ ...approval, recipients: [] }).recipients).toEqual([]);
    expect(StandingApprovalSchema.safeParse({ ...approval, usedTotal: 3n }).success).toBe(false);
    expect(StandingApprovalSchema.safeParse({ ...approval, expiresAt: undefined }).success).toBe(false);
  });
  it('scopes freeze records unambiguously', () => {
    expect(FreezeSchema.safeParse({ scope: 'agent', frozen: true, reason: 'stop', at: 1 }).success).toBe(false);
    expect(FreezeSchema.safeParse({ scope: 'global', agentId: 'a', frozen: true, reason: 'stop', at: 1 }).success).toBe(false);
  });
  it('validates signed chain events without permitting bigint payloads', () => {
    const event = {
      chainId: 'agent:a', seq: 1, prevHash: '0'.repeat(64), type: 'decision_allowed', at: 1,
      payload: { agentId: 'a', requestId: 'r', receiverId: 'bob.testnet', amount: '1',
        requestDigest: 'b'.repeat(64), policyRevision: 1, approvalRef: null, reasons: [] },
      hash: 'a'.repeat(64), signature: Buffer.alloc(64).toString('base64'),
    };
    expect(ReceiptEventSchema.safeParse(event).success).toBe(true);
    expect(ReceiptEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(false);
    expect(ReceiptEventSchema.safeParse({ ...event, payload: { amount: 1n } }).success).toBe(false);
    expect(SignatureSchema.safeParse(Buffer.alloc(65).toString('base64')).success).toBe(false);
  });
  it('fixes owner signing fields and the replay window', () => {
    const signed = { method: 'POST', path: '/admin/agents', bodySha256: 'a'.repeat(64), nonce: 'a'.repeat(32), issuedAt: 1000 };
    expect(OwnerSigningPayloadSchema.parse(signed)).toEqual(signed);
    expect(OWNER_MAX_SKEW_MS).toBe(60_000);
    for (const path of ['//evil/admin', 'https://evil/admin', '/admin#fragment']) {
      expect(OwnerSigningPayloadSchema.safeParse({ ...signed, path }).success).toBe(false);
    }
  });
});

it('verifies pinned NEAR explicit-nonce and signed transaction codec APIs offline', () => {
  const pair = KeyPair.fromRandom('ed25519');
  const transaction = createTransaction('broker.testnet', pair.getPublicKey(), 'bob.testnet', 123n, [actions.transfer(1n)], new Uint8Array(32));
  expect(transaction.nonce).toBe(123n);
  const digest = createHash('sha256').update(transaction.encode()).digest();
  const signed = new SignedTransaction({ transaction, signature: new Signature({ keyType: 0, data: pair.sign(digest).signature }) });
  const bytes = signed.encode();
  expect(SignedTransaction.decode(bytes).transaction.nonce).toBe(123n);
  expect(decodeSignedTransaction(bytes).encode()).toEqual(bytes);
  expect(encodeTransaction(signed)).toEqual(bytes);
});
