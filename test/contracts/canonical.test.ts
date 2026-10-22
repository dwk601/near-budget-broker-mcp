import { createPrivateKey, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson, checkpointHashInput, hashAgentToken, ownerSigningBytes,
  receiptHashInput, requestDigest, sha256Hex,
} from '../../src/contracts/index.js';
import type { ReceiptPreimage } from '../../src/contracts/index.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const owner = { method: 'POST', path: '/admin/agents', bodySha256: EMPTY_SHA256,
  nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: 1700000000000 };
const ownerText = '{"bodySha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","issuedAt":1700000000000,"method":"POST","nonce":"AAAAAAAAAAAAAAAAAAAAAA","path":"/admin/agents"}';

describe('shared byte-exact canonical contracts (fixed golden vectors)', () => {
  it('orders integer-looking and nested keys lexically, escapes JSON, and canonicalizes -0', () => {
    expect(canonicalJson({ z: 'last', a: { b: 2, a: 1 }, list: [true, null, -0], 10: 'ten', 2: 'two' }))
      .toBe('{"10":"ten","2":"two","a":{"a":1,"b":2},"list":[true,null,0],"z":"last"}');
    expect(canonicalJson({ text: '\b\t\n\f\r"\\\u0000' })).toBe('{"text":"\\b\\t\\n\\f\\r\\\"\\\\\\u0000"}');
  });
  it('uses UTF-16 key order without Unicode normalization', () => {
    // Supplementary U+1F600 sorts before U+E000 in UTF-16, unlike UTF-8/codepoint sorting.
    expect(canonicalJson({ '\ue000': 3, '😀': 2, '\r': 1 })).toBe('{"\\r":1,"😀":2,"\ue000":3}');
    expect(canonicalJson(['e\u0301', 'é'])).toBe('["é","é"]');
  });
  it('accepts null-prototype JSON records and repeated references without cycles', () => {
    const plain: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    plain['__proto__'] = 'data'; plain['a'] = 1;
    expect(canonicalJson(plain)).toBe('{"__proto__":"data","a":1}');
    const shared = { a: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
  it.each([undefined, 1n, NaN, Infinity, 0.1, 9007199254740992, Symbol('x'), () => 1,
    new Date(0), new Map(), new Set(), new Uint8Array(1), '\ud800', { '\udfff': 1 },
    { a: undefined }, { a: 1n }, [undefined], Array(2),
  ])('rejects lossy/non-JSON values %#', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
  it('rejects getters, toJSON, symbols, non-enumerable fields, extended arrays, cycles and excessive depth', () => {
    let getterCalls = 0;
    const getter = Object.defineProperty({}, 'a', { enumerable: true, get() { getterCalls++; return 1; } });
    const hidden = Object.defineProperty({}, 'a', { value: 1 });
    const extended = Object.assign([1], { extra: 2 });
    const cycle: Record<string, unknown> = {}; cycle['cycle'] = cycle;
    let deep: unknown = null; for (let i = 0; i < 130; i++) deep = [deep];
    for (const value of [getter, hidden, extended, cycle, deep, { toJSON: () => ({}) }, { [Symbol('x')]: 1 }]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
    expect(getterCalls).toBe(0);
  });
  it('hashes UTF-8 strings and exact binary bytes without implicit JSON serialization', () => {
    expect(sha256Hex('')).toBe(EMPTY_SHA256);
    expect(sha256Hex(new Uint8Array())).toBe(EMPTY_SHA256);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from([0x61, 0x62, 0x63]))).toBe(sha256Hex('abc'));
    expect(() => sha256Hex('\ud800')).toThrow(TypeError);
  });
  it('pins request digest, memo normalization, and idempotency-independent fields', () => {
    const preimage = { agentId: 'a1', receiverId: 'bob.testnet', amount: '1' };
    const expected = '3b2b29fc30844d0d7e9a8750ca7859ece89d534733f2e5d0d6926fb103cab1ea';
    expect(requestDigest(preimage)).toBe(expected);
    expect(requestDigest({ ...preimage, memo: null })).toBe(expected);
    expect(requestDigest({ ...preimage, memo: '' })).not.toBe(expected);
    expect(requestDigest({ ...preimage, agentId: 'a2' })).not.toBe(expected);
    expect(() => requestDigest({ ...preimage, amount: '01' })).toThrow();
    expect(() => requestDigest({ ...preimage, idempotencyKey: 'extra' } as typeof preimage)).toThrow();
  });
  it('pins the exact full-token hash and never hashes decoded token bytes', () => {
    expect(hashAgentToken(`bb_agent_${'A'.repeat(43)}`)).toBe('95bbcfa173071336f75e4c067f950312808dda7495936cf94268340bf8f98d59');
    expect(() => hashAgentToken('bad')).toThrow();
    expect(() => hashAgentToken(`bb_agent_${'A'.repeat(43)}\n`)).toThrow();
  });
  it('pins owner signing bytes and a deterministic Ed25519 signature over RAW canonical bytes', () => {
    expect(Buffer.from(ownerSigningBytes(owner)).toString('utf8')).toBe(ownerText);
    expect(sha256Hex(ownerSigningBytes(owner))).toBe('dcd45ff93a40bddefc27c50c5d89929a2962c98a9d73409823edc8a41c1a4f74');
    // Public RFC 8032 test seed, not a deployment secret.
    const key = createPrivateKey({ key: Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), format: 'der', type: 'pkcs8' });
    expect(sign(null, ownerSigningBytes(owner), key).toString('base64'))
      .toBe('Mnixa7nGCVCDATPE+B3Wk0Ck32HZAxsqr+joE20BtuRRgWtugRrn6emDDONael9QXCelkbeUh4VXnWeu05xEDw==');
    expect(() => ownerSigningBytes({ ...owner, method: 'post' })).toThrow();
    expect(() => ownerSigningBytes({ ...owner, signature: 'extra' } as typeof owner)).toThrow();
  });
  it('pins receipt preimage bytes/hash and rejects accidentally hashing the signature/envelope', () => {
    const receipt: ReceiptPreimage = { type: 'queued', chainId: 'agent:a1', seq: 1,
      prevHash: '0'.repeat(64), at: 1700000000000, payload: { requestId: 'r1', agentId: 'a1' } };
    expect(Buffer.from(receiptHashInput(receipt)).toString('utf8')).toBe('{"at":1700000000000,"chainId":"agent:a1","payload":{"agentId":"a1","requestId":"r1"},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"type":"queued"}');
    expect(sha256Hex(receiptHashInput(receipt))).toBe('b2fd75c157db050b925cb115bf2441b10786f715b07579f055751e7a64a9047f');
    expect(() => receiptHashInput({ ...receipt, hash: 'a'.repeat(64) } as ReceiptPreimage)).toThrow();
  });
  it('pins checkpoint hashing to the same canonical primitives', () => {
    const checkpoint = { version: 1 as const, chainId: 'agent:a1', seq: 1, headHash: 'a'.repeat(64),
      previousCheckpointHash: null, at: 1700000000001, auditPublicKey: `ed25519:${'1'.repeat(32)}` };
    expect(sha256Hex(checkpointHashInput(checkpoint))).toBe('5b773ec61977fa4a2006147290c32d29f12c9b8a0507643fb212256cec506405');
    expect(sha256Hex(checkpointHashInput({ ...checkpoint, previousCheckpointHash: 'b'.repeat(64) })))
      .not.toBe(sha256Hex(checkpointHashInput(checkpoint)));
  });
});
