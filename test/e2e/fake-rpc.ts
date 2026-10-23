import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { SignedTransaction, baseEncode } from 'near-api-js';
import { parseNear } from '../../src/contracts/index.js';

/** Network boundary only: the production chain adapter, signer, outbox and daemon are real. */
export async function fakeRpc() {
  const blockHash = baseEncode(createHash('sha256').update('B10 deterministic final block').digest());
  const sends: { hash: string; nonce: bigint; amount: bigint }[] = [];
  const paid = new Map<string, unknown>(); const violations: string[] = [];
  let nonce = 0n; let balance = parseNear('10');
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    const r = JSON.parse(Buffer.concat(chunks).toString()) as { id: unknown; method: string; params: Record<string, unknown> };
    const reply = (result: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result })); };
    try {
      if (r.method === 'status') return reply({ chain_id: 'testnet' });
      if (r.method === 'block') return reply({ header: { hash: blockHash, height: 1000 } });
      if (r.method === 'EXPERIMENTAL_protocol_config') return reply({ runtime_config: { storage_amount_per_byte: '10000000000000000000' }, transaction_validity_period: 86400 });
      if (r.method === 'query') return reply(r.params['request_type'] === 'view_account'
        ? { amount: balance.toString(), locked: '0', storage_usage: 0, code_hash: '11111111111111111111111111111111', block_hash: blockHash, block_height: 1000 }
        : { nonce: nonce.toString(), permission: 'FullAccess', block_hash: blockHash, block_height: 1000 });
      if (r.method === 'send_tx') {
        const signed = SignedTransaction.decode(Buffer.from(String(r.params['signed_tx_base64']), 'base64')); const tx = signed.transaction;
        const digest = createHash('sha256').update(tx.encode()).digest(); const hash = baseEncode(digest);
        assert(tx.publicKey.verify(digest, new Uint8Array(signed.signature.ed25519Signature!.data)), 'invalid transaction signature');
        assert.equal(tx.signerId, 'broker.testnet'); assert.equal(tx.receiverId, 'receiver.testnet');
        assert.equal(tx.actions.length, 1); assert(tx.actions[0]?.transfer); assert(tx.nonce > nonce);
        const amount = tx.actions[0].transfer.deposit; nonce = tx.nonce; balance -= amount + 7n;
        sends.push({ hash, nonce, amount });
        const receiptId = baseEncode(createHash('sha256').update(`${hash}:receipt`).digest());
        const outcome = (id: string, fee: string, ids: string[]) => ({ id, block_hash: blockHash, outcome: { executor_id: 'broker.testnet', logs: [], gas_burnt: 11, tokens_burnt: fee, receipt_ids: ids, status: { SuccessValue: '' } } });
        const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
          transaction: { hash, signer_id: tx.signerId, receiver_id: tx.receiverId, nonce: tx.nonce.toString(), public_key: tx.publicKey.toString() },
          transaction_outcome: outcome(hash, '3', [receiptId]), receipts_outcome: [outcome(receiptId, '4', [])] };
        paid.set(hash, result); return reply(result);
      }
      if (r.method === 'tx') { const result = paid.get(String(r.params['tx_hash'])); assert(result, 'unknown tx'); return reply(result); }
      throw new Error(`unexpected method ${r.method}`);
    } catch (e) {
      violations.push(e instanceof Error ? e.message : 'fake RPC violation');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, error: { code: -32603, message: 'fake RPC rejected request' } }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, sends, violations,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
