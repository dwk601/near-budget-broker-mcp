import {
  createHash, createPublicKey, randomBytes, sign, timingSafeEqual, verify,
} from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AgentTokenSchema, BrokerError, canonicalJson, hashAgentToken,
} from '../../src/contracts/index.js';
import type {
  AgentCredential, Authenticator, ErrorCode, OwnerSigningPayload, OwnerVerificationInput, Store,
} from '../../src/contracts/index.js';
import {
  RequestAuthenticator, createAuthenticator, generateOwnerKeypair, issueAgentToken,
  ownerRequestFromHeaders, revokeAgentToken, rotateAgentToken, signOwnerRequest,
} from '../../src/auth/index.js';
import { SqliteStore } from '../../src/storage/index.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const NOW = 1_800_000_000_000;
const METHOD = 'POST';
const PATH = '/admin/agents/a?mode=x%2Fy&b=2';
const BODY = Buffer.from('{"name":"agent A"}');
const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
let directory: string;
let filename: string;
let store: SqliteStore;
let keys: ReturnType<typeof generateOwnerKeypair>;
let now: number;
let auth: Authenticator;

function makeAuth(db: Store = store): Authenticator {
  return createAuthenticator({ store: db, clock: { now: () => now }, ownerPublicKey: keys.publicKey });
}
function issue(agentId = 'a') {
  return store.withImmediateTransaction((tx) => issueAgentToken(tx, agentId, now));
}
/** Independent canonical payload fixture: explicit RFC8785 key ordering, Node
 * signing directly, NOT the implementation's signing helper. */
function request(overrides: Partial<OwnerSigningPayload> = {}, secretKey = keys.secretKey): OwnerVerificationInput {
  const payload: OwnerSigningPayload = {
    method: METHOD, path: PATH, bodySha256: digest(BODY),
    nonce: randomBytes(24).toString('base64url'), issuedAt: NOW, ...overrides,
  };
  const bytes = Buffer.from(JSON.stringify({
    bodySha256: payload.bodySha256, issuedAt: payload.issuedAt, method: payload.method,
    nonce: payload.nonce, path: payload.path,
  }));
  return { signed: { payload, signature: sign(null, bytes, secretKey).toString('base64') },
    method: METHOD, path: PATH, bodyBytes: BODY };
}
async function rejected(promise: Promise<unknown>, code: ErrorCode = 'UNAUTHENTICATED') {
  // Exact, stable message also proves no token/key/body/SQL details escape.
  await expect(promise).rejects.toMatchObject({ name: 'BrokerError', code, message: code });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bb-auth-'));
  filename = join(directory, 'broker.sqlite');
  store = new SqliteStore(filename, { accountId: 'custody.testnet' });
  keys = generateOwnerKeypair();
  now = NOW;
  auth = makeAuth();
  store.withImmediateTransaction((tx) => {
    for (const id of ['a', 'b']) tx.putAgent({ id, name: id, status: 'active', createdAt: now });
  });
});
afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe('agent credentials', () => {
  test('issues independent 32-byte tokens, stores only full-token SHA256, returns identity from token alone', async () => {
    const a = issue();
    const b = issue('b');
    expect(a.token).not.toBe(b.token);
    for (const item of [a, b]) {
      expect(AgentTokenSchema.safeParse(item.token).success).toBe(true);
      expect(Buffer.from(item.token.slice(9), 'base64url')).toHaveLength(32);
      expect(item.credential).toEqual({
        id: expect.any(String), agentId: item === a ? 'a' : 'b',
        tokenHash: createHash('sha256').update(item.token, 'utf8').digest('hex'),
        createdAt: NOW, revokedAt: null,
      });
      expect(item.credential.tokenHash).toBe(hashAgentToken(item.token));
      const persisted = store.read((view) => view.getCredential(item.credential.id));
      expect(persisted).toEqual(item.credential);
      expect(JSON.stringify(persisted)).not.toContain(item.token);
    }
    expect(await auth.authenticateAgent(a.token)).toEqual({ kind: 'agent', agentId: 'a', credentialId: a.credential.id });
    expect(await auth.authenticateAgent(b.token)).toEqual({ kind: 'agent', agentId: 'b', credentialId: b.credential.id });
    // Extra hostile identity arguments cannot influence authentication.
    const hostile = auth.authenticateAgent.bind(auth) as (token: string, identity: unknown) => ReturnType<Authenticator['authenticateAgent']>;
    expect(await hostile(a.token, { kind: 'owner', agentId: 'b', credentialId: b.credential.id }))
      .toEqual({ kind: 'agent', agentId: 'a', credentialId: a.credential.id });
    const batch = Array.from({ length: 32 }, () => issue().token);
    expect(new Set(batch).size).toBe(32);
    store.close();
    for (const file of readdirSync(directory)) {
      const data = readFileSync(join(directory, file));
      for (const token of [a.token, b.token, ...batch]) expect(data.includes(Buffer.from(token))).toBe(false);
      expect(data.includes(Buffer.from(keys.secretKey))).toBe(false);
    }
  });

  test('rejects malformed, unknown, bearer-prefixed, noncanonical, or modified tokens without leaking them', async () => {
    const { token } = issue();
    for (const invalid of ['', 'owner', `Bearer ${token}`, token + '=', token.slice(0, -1),
      `bb_agent_${'A'.repeat(42)}B`, `bb_agent_${'A'.repeat(43)}`, token.replace('bb_agent_', 'bb_owner_'),
      `bb_agent_${randomBytes(32).toString('base64url')}`, undefined as unknown as string]) {
      await rejected(auth.authenticateAgent(invalid));
    }
    await rejected(auth.authenticateAgent(token.slice(0, 9) + (token[9] === 'A' ? 'B' : 'A') + token.slice(10)));
    expect((await auth.authenticateAgent(token)).agentId).toBe('a');
  });

  test('uses constant-time full-digest verification on both hits and misses', async () => {
    const { token } = issue();
    const compare = vi.mocked(timingSafeEqual);
    compare.mockClear();
    await auth.authenticateAgent(token);
    await rejected(auth.authenticateAgent(`bb_agent_${randomBytes(32).toString('base64url')}`));
    expect(compare).toHaveBeenCalledTimes(2);
    for (const [actual, expected] of compare.mock.calls) {
      expect(actual.byteLength).toBe(32);
      expect(expected.byteLength).toBe(32);
    }
    expect(Buffer.from(compare.mock.calls[0]![0] as Uint8Array).toString('hex')).toBe(hashAgentToken(token));
  });

  test('lookup alone is not verification: mismatched credential hashes are denied', async () => {
    const { token, credential } = issue();
    const wrong: AgentCredential = { ...credential, tokenHash: 'f'.repeat(64) };
    const lookupStore: Store = {
      read: (operation) => store.read((reader) => operation(new Proxy(reader, {
        get(target, property) {
          if (property === 'findCredentialByHash') return () => wrong;
          const member: unknown = Reflect.get(target, property);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      }))),
      withImmediateTransaction: (operation) => store.withImmediateTransaction(operation),
      close: () => {},
    };
    await rejected(makeAuth(lookupStore).authenticateAgent(token));
  });

  test('rotation revokes only the old token and persists through reopening', async () => {
    const original = issue();
    const other = issue('b');
    now++;
    const replacement = store.withImmediateTransaction((tx) => rotateAgentToken(tx, original.credential.id, now));
    expect(replacement.token).not.toBe(original.token);
    expect(replacement.credential.id).not.toBe(original.credential.id);
    expect(replacement.credential.agentId).toBe('a');
    expect(store.read((view) => view.getCredential(original.credential.id)?.revokedAt)).toBe(now);
    store.close();
    store = new SqliteStore(filename, { accountId: 'custody.testnet' });
    auth = makeAuth();
    await rejected(auth.authenticateAgent(original.token));
    expect((await auth.authenticateAgent(replacement.token)).credentialId).toBe(replacement.credential.id);
    expect((await auth.authenticateAgent(other.token)).agentId).toBe('b');
    expect(() => store.withImmediateTransaction((tx) => rotateAgentToken(tx, original.credential.id, now)))
      .toThrowError('FORBIDDEN');
  });

  test('rotation and issue roll back with the caller transaction (including audit failure)', async () => {
    const original = issue();
    let uncommitted = '';
    expect(() => store.withImmediateTransaction((tx) => {
      uncommitted = rotateAgentToken(tx, original.credential.id, now).token;
      throw new BrokerError('AUDIT_UNAVAILABLE');
    })).toThrowError('AUDIT_UNAVAILABLE');
    expect((await auth.authenticateAgent(original.token)).agentId).toBe('a');
    await rejected(auth.authenticateAgent(uncommitted));
    expect(store.read((view) => view.listCredentials('a', { limit: 100 }).items)).toHaveLength(1);
  });

  test('token issuance/revocation never logs plaintext tokens or secrets', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')].map((spy) => spy.mockImplementation(() => {}));
    const original = issue();
    await auth.authenticateAgent(original.token);
    const rotated = store.withImmediateTransaction((tx) => rotateAgentToken(tx, original.credential.id, now));
    await rejected(auth.authenticateAgent(original.token));
    store.withImmediateTransaction((tx) => revokeAgentToken(tx, rotated.credential.id, now));
    await rejected(auth.authenticateAgent(rotated.token));
    for (const log of logs) {
      const output = JSON.stringify(log.mock.calls);
      for (const secret of [original.token, rotated.token, keys.secretKey]) expect(output).not.toContain(secret);
    }
  });

  test('revocation is immediate and idempotent, even on an existing authenticator', async () => {
    const a = issue();
    await auth.authenticateAgent(a.token);
    store.withImmediateTransaction((tx) => revokeAgentToken(tx, a.credential.id, now));
    now++;
    store.withImmediateTransaction((tx) => revokeAgentToken(tx, a.credential.id, now));
    expect(store.read((view) => view.getCredential(a.credential.id)?.revokedAt)).toBe(NOW);
    await rejected(auth.authenticateAgent(a.token));
  });

  test('revoked agent denies even an otherwise live credential; cannot issue or rotate', async () => {
    const a = issue();
    store.withImmediateTransaction((tx) => {
      const agent = tx.getAgent('a')!;
      tx.putAgent({ ...agent, status: 'revoked' });
    });
    await rejected(auth.authenticateAgent(a.token), 'FORBIDDEN');
    expect(() => store.withImmediateTransaction((tx) => issueAgentToken(tx, 'a', now))).toThrowError('FORBIDDEN');
    expect(() => store.withImmediateTransaction((tx) => rotateAgentToken(tx, a.credential.id, now))).toThrowError('FORBIDDEN');
    store.withImmediateTransaction((tx) => tx.revokeAgentCredentials('a', now));
    await rejected(auth.authenticateAgent(a.token));
  });

  test('freeze does not remove authenticated read access', async () => {
    const a = issue();
    store.withImmediateTransaction((tx) => {
      tx.putFreeze({ scope: 'global', frozen: true, reason: 'stop', at: now });
      tx.putFreeze({ scope: 'agent', agentId: 'a', frozen: true, reason: 'stop', at: now });
    });
    expect((await auth.authenticateAgent(a.token)).agentId).toBe('a');
  });
});

describe('owner verification', () => {
  test('verifies the B00 golden signature with its RFC8032 public key in base58', async () => {
    now = 1_700_000_000_000;
    const verifier = new RequestAuthenticator({ store, clock: { now: () => now },
      ownerPublicKey: 'ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z' });
    const input: OwnerVerificationInput = {
      signed: {
        payload: { method: 'POST', path: '/admin/agents',
          bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: now },
        signature: 'Mnixa7nGCVCDATPE+B3Wk0Ck32HZAxsqr+joE20BtuRRgWtugRrn6emDDONael9QXCelkbeUh4VXnWeu05xEDw==',
      }, method: 'POST', path: '/admin/agents', bodyBytes: new Uint8Array(),
    };
    expect(await verifier.verifyOwnerRequest(input)).toEqual({ kind: 'owner' });
  });

  test('accepts canonical Ed25519 signing bytes and rejects replay after reopening the database', async () => {
    const input = request();
    expect(await auth.verifyOwnerRequest(input)).toEqual({ kind: 'owner' });
    await rejected(auth.verifyOwnerRequest(input));
    store.close();
    store = new SqliteStore(filename, { accountId: 'custody.testnet' });
    await rejected(makeAuth().verifyOwnerRequest(input));
  });

  test('one concurrent verifier wins across separate database connections', async () => {
    const secondStore = new SqliteStore(filename, { accountId: 'custody.testnet' });
    try {
      const input = request();
      const outcomes = await Promise.allSettled([auth.verifyOwnerRequest(input), makeAuth(secondStore).verifyOwnerRequest(input)]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    } finally { secondStore.close(); }
  });

  test.each([-60_000, 60_000])('inclusive skew boundary %i is valid and replay protected', async (skew) => {
    const input = request({ issuedAt: NOW + skew });
    expect(await auth.verifyOwnerRequest(input)).toEqual({ kind: 'owner' });
    await rejected(auth.verifyOwnerRequest(input));
  });

  test.each([-60_001, 60_001, -120_000, 120_000])('rejects expired/future skew %i', async (skew) => {
    await rejected(auth.verifyOwnerRequest(request({ issuedAt: NOW + skew })));
  });

  test('future-issued nonces survive through the full expiry inclusive, even after restart', async () => {
    const input = request({ issuedAt: NOW + 60_000 });
    await auth.verifyOwnerRequest(input);
    now = NOW + 60_001;
    await auth.verifyOwnerRequest(request({ issuedAt: now })); // triggers nonce cleanup
    store.close();
    store = new SqliteStore(filename, { accountId: 'custody.testnet' });
    now = NOW + 120_000;
    await rejected(makeAuth().verifyOwnerRequest(input));
    now++;
    await rejected(makeAuth().verifyOwnerRequest(input)); // now expired too
  });

  test('old boundary nonce survives cleanup at expiry inclusive', async () => {
    const input = request({ issuedAt: NOW - 60_000 });
    await auth.verifyOwnerRequest(input);
    await auth.verifyOwnerRequest(request());
    await rejected(auth.verifyOwnerRequest(input));
  });

  test.each(['body', 'method', 'path', 'query'] as const)('rejects tampered actual %s before consuming nonce', async (field) => {
    const good = request();
    const bad = { ...good };
    if (field === 'body') bad.bodyBytes = Buffer.from('{"name":"hostile"}');
    if (field === 'method') bad.method = 'DELETE';
    if (field === 'path') bad.path = '/admin/agents/b?mode=x%2Fy&b=2';
    if (field === 'query') bad.path = '/admin/agents/a?mode=x/y&b=2';
    await rejected(auth.verifyOwnerRequest(bad));
    expect(await auth.verifyOwnerRequest(good)).toEqual({ kind: 'owner' });
  });

  test('changing signed fields or signature cannot authenticate, even when actual values also change', async () => {
    for (const field of ['method', 'path', 'bodySha256', 'nonce', 'issuedAt'] as const) {
      const input = request();
      const payload = input.signed.payload;
      if (field === 'method') { payload.method = 'GET'; input.method = 'GET'; }
      if (field === 'path') { payload.path = '/admin/other'; input.path = '/admin/other'; }
      if (field === 'bodySha256') { input.bodyBytes = Buffer.alloc(0); payload.bodySha256 = digest(input.bodyBytes); }
      if (field === 'nonce') payload.nonce = randomBytes(24).toString('base64url');
      if (field === 'issuedAt') payload.issuedAt++;
      await rejected(auth.verifyOwnerRequest(input));
    }
    const input = request();
    const signature = Buffer.from(input.signed.signature, 'base64');
    signature[0] = signature[0]! ^ 1;
    input.signed.signature = signature.toString('base64');
    await rejected(auth.verifyOwnerRequest(input));
  });

  test('wrong key cannot consume a nonce and agent tokens are never owner credentials', async () => {
    const wrongKey = generateOwnerKeypair();
    const nonce = randomBytes(24).toString('base64url');
    await rejected(auth.verifyOwnerRequest(request({ nonce }, wrongKey.secretKey)));
    expect(await auth.verifyOwnerRequest(request({ nonce }))).toEqual({ kind: 'owner' });
    const { token } = issue();
    const badSignature = request();
    badSignature.signed.signature = token;
    await rejected(auth.verifyOwnerRequest(badSignature));
    await rejected(auth.verifyOwnerRequest(token as unknown as OwnerVerificationInput));
    await rejected(auth.authenticateAgent(keys.secretKey));
  });

  test('rejects malformed/noncanonical signature, nonce, method, path and timestamps without leaking input', async () => {
    for (const overrides of [
      { nonce: 'short' }, { nonce: 'x'.repeat(129) }, { issuedAt: -1 }, { issuedAt: NOW + 0.5 },
      { issuedAt: Number.MAX_SAFE_INTEGER }, { method: 'post' }, { path: '//evil.example/admin' },
      { path: '/admin#fragment' }, { path: 'https://evil.example/admin' },
    ]) await rejected(auth.verifyOwnerRequest(request(overrides)));
    const input = request();
    const goodSignature = input.signed.signature;
    for (const signature of [goodSignature.slice(0, -2), goodSignature + '\n', 'A'.repeat(88), keys.secretKey]) {
      await rejected(auth.verifyOwnerRequest({ ...input, signed: { ...input.signed, signature } }));
    }
    expect(await auth.verifyOwnerRequest(input)).toEqual({ kind: 'owner' });
  });

  test('requires a 32-byte ed25519 config key, not just schema-valid base58 shape', () => {
    for (const publicKey of ['ed25519:' + 'z'.repeat(44), 'ed25519:' + '1'.repeat(33),
      'secp256k1:' + keys.publicKey.slice(8), keys.secretKey]) {
      expect(() => new RequestAuthenticator({ store, clock: { now: () => now }, ownerPublicKey: publicKey }))
        .toThrowError(new BrokerError('FORBIDDEN'));
    }
  });
});

describe('owner client helpers', () => {
  test('headers interoperate with verifier, signing raw UTF8/empty/binary bodies without reserialization', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const nonces = new Set<string>();
    for (const body of ['', canonicalJson({ z: '☃', a: 1 }), new Uint8Array([0, 255, 128, 1])]) {
      const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      const headers = signOwnerRequest(keys.secretKey, METHOD, PATH, body);
      nonces.add(headers['x-bb-owner-nonce']);
      expect(headers['x-bb-owner-nonce']).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
      expect(headers['x-bb-owner-body-sha256']).toBe(digest(bytes));
      expect(headers['x-bb-owner-issued-at']).toBe(String(NOW));
      const payload = Buffer.from(JSON.stringify({
        bodySha256: digest(bytes), issuedAt: NOW, method: METHOD,
        nonce: headers['x-bb-owner-nonce'], path: PATH,
      }));
      expect(verify(null, payload, createPublicKey(keys.secretKey), Buffer.from(headers['x-bb-owner-signature'], 'base64'))).toBe(true);
      expect(await auth.verifyOwnerRequest(ownerRequestFromHeaders(headers, METHOD, PATH, bytes)))
        .toEqual({ kind: 'owner' });
    }
    expect(nonces.size).toBe(3);
  });

  test('key generation is independent; client errors do not include private key or input', () => {
    const second = generateOwnerKeypair();
    expect(second.publicKey).not.toBe(keys.publicKey);
    expect(second.secretKey).not.toBe(keys.secretKey);
    for (const [secret, method, path] of [[keys.secretKey, 'post', PATH], [keys.secretKey, METHOD, '//bad'],
      [keys.secretKey + 'private-marker', METHOD, '/bad#fragment'], ['secret-marker', METHOD, PATH]]) {
      expect(() => signOwnerRequest(secret!, method!, path!, 'sensitive-body')).toThrowError(new BrokerError('FORBIDDEN'));
    }
  });

  test('transport helper rejects missing/duplicate headers and noncanonical timestamps', () => {
    const headers = signOwnerRequest(keys.secretKey, METHOD, PATH, BODY);
    for (const issuedAt of [undefined, ['1', '2'], '+123', '01', '1.5', '1e3', ' 123', '9'.repeat(100)]) {
      expect(() => ownerRequestFromHeaders({ ...headers, 'x-bb-owner-issued-at': issuedAt }, METHOD, PATH, BODY))
        .toThrowError(new BrokerError('UNAUTHENTICATED'));
    }
    expect(() => ownerRequestFromHeaders({ ...headers, 'x-bb-owner-signature': [headers['x-bb-owner-signature']] }, METHOD, PATH, BODY))
      .toThrowError(new BrokerError('UNAUTHENTICATED'));
  });
});
