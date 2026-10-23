import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { SignedTransaction, baseEncode } from 'near-api-js';
import { parseNear } from '../../src/contracts/index.js';

export const INITIAL_NONCE = 274288383000000n;
/** Network boundary only: the production chain adapter, signer, outbox and daemon are real. */
export async function fakeRpc() {
  const hashOf = (text: string) => baseEncode(createHash('sha256').update(text).digest());
  let height = 274288383;
  const headers = new Map<string, { hash: string; height: number }>();
  function advance() {
    const header = { hash: hashOf(`B10 block ${++height}`), height }; headers.set(header.hash, header); return header;
  }
  let head = advance();
  const sends: { hash: string; nonce: bigint; amount: bigint }[] = [];
  const paid = new Map<string, { result: Record<string, unknown>; polls: number; amount: bigint; finalized: boolean }>();
  const violations: string[] = []; const accessKeyNonces: number[] = []; const waitUntil: unknown[] = [];
  const headsSeen: { hash: string; height: number }[] = [];
  let nonce = INITIAL_NONCE; let balance = parseNear('10');
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const r = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string; params: Record<string, unknown> };
    const reply = (result: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result })); };
    try {
      if (r.method === 'status') return reply({ chain_id: 'testnet', sync_info: { latest_block_hash: head.hash, latest_block_height: head.height } });
      if (r.method === 'block') {
        const pinned = r.params['block_id'];
        if (pinned !== undefined) { const header = headers.get(String(pinned)); assert(header, 'unknown pinned block'); return reply({ header }); }
        head = advance(); headsSeen.push(head); return reply({ header: head });
      }
      if (r.method === 'EXPERIMENTAL_protocol_config') return reply({ runtime_config: { storage_amount_per_byte: '10000000000000000000' }, transaction_validity_period: 86400 });
      if (r.method === 'query') {
        const header = r.params['block_id'] === undefined ? head : headers.get(String(r.params['block_id'])); assert(header);
        if (r.params['request_type'] === 'view_account') return reply({ amount: balance.toString(), locked: '0', storage_usage: 0,
          code_hash: '11111111111111111111111111111111', block_hash: header.hash, block_height: header.height });
        assert.equal(r.params['request_type'], 'view_access_key'); assert(Number.isSafeInteger(Number(nonce)));
        accessKeyNonces.push(Number(nonce));
        return reply({ nonce: Number(nonce), permission: 'FullAccess', block_hash: header.hash, block_height: header.height });
      }
      if (r.method === 'send_tx') {
        const signed = SignedTransaction.decode(Buffer.from(String(r.params['signed_tx_base64']), 'base64')); const tx = signed.transaction;
        const digest = createHash('sha256').update(tx.encode()).digest(); const hash = baseEncode(digest);
        assert(tx.publicKey.verify(digest, new Uint8Array(signed.signature.ed25519Signature!.data)), 'invalid transaction signature');
        assert.equal(tx.signerId, 'broker.testnet'); assert.equal(tx.receiverId, 'receiver.testnet');
        assert(headers.has(baseEncode(new Uint8Array(tx.blockHash))), 'signed anchor is retained');
        assert.equal(tx.actions.length, 1); assert(tx.actions[0]?.transfer); assert(tx.nonce > nonce);
        const amount = tx.actions[0].transfer.deposit; nonce = tx.nonce; head = advance();
        sends.push({ hash, nonce, amount }); waitUntil.push(r.params['wait_until']);
        const receiptId = hashOf(`${hash}:receipt`);
        const outcome = (id: string, fee: string, ids: string[]) => ({ id, block_hash: head.hash, proof: [], outcome: {
          executor_id: 'broker.testnet', logs: [], gas_burnt: 11, tokens_burnt: fee, receipt_ids: ids, status: { SuccessValue: '' } } });
        const transaction = { hash, signer_id: tx.signerId, receiver_id: tx.receiverId, nonce: Number(tx.nonce), public_key: tx.publicKey.toString() };
        const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction,
          transaction_outcome: outcome(hash, '3', [receiptId]), receipts_outcome: [outcome(receiptId, '4', [])] };
        const entry = { result, polls: 0, amount, finalized: false }; paid.set(hash, entry);
        if (r.params['wait_until'] === 'FINAL') { balance -= amount + 7n; entry.finalized = true; return reply(result); }
        assert.equal(r.params['wait_until'], 'INCLUDED');
        return reply({ final_execution_status: 'INCLUDED', transaction });
      }
      if (r.method === 'tx') {
        assert.equal(r.params['wait_until'], 'FINAL');
        const entry = paid.get(String(r.params['tx_hash'])); assert(entry, 'unknown tx'); entry.polls++;
        head = advance();
        // Honor the FINAL wait on the poll, not on the original INCLUDED offer.
        if (!entry.finalized) { balance -= entry.amount + 7n; entry.finalized = true; }
        return reply(entry.result);
      }
      throw new Error(`unexpected method ${r.method}`);
    } catch (e) {
      violations.push(e instanceof Error ? e.message : 'fake RPC violation');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32603, message: 'fake RPC rejected request' } }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, sends, violations, accessKeyNonces, headsSeen, waitUntil, paid,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
