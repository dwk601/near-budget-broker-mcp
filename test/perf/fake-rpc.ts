import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { baseEncode, SignedTransaction } from 'near-api-js';

const hash = (text: string) => baseEncode(createHash('sha256').update(text).digest());

/** Loopback only: testnet-shaped JSON-RPC, real HTTP, no public RPC fallback.
 * Latency is per RPC, not per broker operation. Zero means instant fake chain.
 */
export async function startFakeRpc(latencyMs = 1) {
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) throw new RangeError('latencyMs');
  const blockHash = hash('perf-final-block');
  const paid = new Map<string, unknown>();
  const calls = new Map<string, number>();
  const errors: unknown[] = [];
  let nonce = 0n;
  let balance = 10n ** 30n;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        jsonrpc: string; id: string; method: string; params: Record<string, unknown>;
      };
      calls.set(rpc.method, (calls.get(rpc.method) ?? 0) + 1);
      if (latencyMs) await sleep(latencyMs);
      let result: unknown;
      switch (rpc.method) {
        case 'status': result = { chain_id: 'testnet' }; break;
        case 'query':
          if (rpc.params['account_id'] !== 'perf-broker.testnet') throw new Error('Unexpected account');
          if (rpc.params['request_type'] === 'view_account') {
            result = { amount: balance.toString(), locked: '0', storage_usage: 0, block_hash: blockHash, block_height: 100 };
          } else if (rpc.params['request_type'] === 'view_access_key') {
            result = { nonce: nonce.toString(), permission: 'FullAccess', block_hash: blockHash, block_height: 100 };
          } else throw new Error('Unexpected query');
          break;
        case 'block': result = { header: { hash: blockHash, height: 100 } }; break;
        case 'EXPERIMENTAL_protocol_config':
          result = { runtime_config: { storage_amount_per_byte: '10000000000000000000' }, transaction_validity_period: 86400 };
          break;
        case 'send_tx': {
          const signed = SignedTransaction.decode(Buffer.from(String(rpc.params['signed_tx_base64']), 'base64'));
          const tx = signed.transaction;
          const txHash = baseEncode(createHash('sha256').update(tx.encode()).digest());
          const amount = tx.actions[0]?.transfer?.deposit;
          if (tx.signerId !== 'perf-broker.testnet' || tx.receiverId !== 'receiver.testnet'
            || tx.actions.length !== 1 || amount !== 1n) throw new Error('Not a benchmark native transfer');
          if (!paid.has(txHash)) {
            if (tx.nonce <= nonce) throw new Error('Non-monotonic nonce');
            nonce = tx.nonce; balance -= amount + 2n;
            const receiptId = hash(txHash + ':receipt');
            const outcome = (id: string, children: string[]) => ({ id,
              outcome: { gas_burnt: '1', tokens_burnt: '1', receipt_ids: children } });
            paid.set(txHash, { final_execution_status: 'FINAL', transaction: { hash: txHash, signer_id: tx.signerId },
              status: { SuccessValue: '' }, transaction_outcome: outcome(txHash, [receiptId]),
              receipts_outcome: [outcome(receiptId, [])] });
          }
          result = { final_execution_status: 'INCLUDED', transaction: { hash: txHash, signer_id: tx.signerId } };
          break;
        }
        case 'tx':
          result = paid.get(String(rpc.params['tx_hash']));
          if (!result) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id,
              error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} }, code: -32000,
                message: 'Server error', data: 'Transaction is not in the fake chain' } }));
            return;
          }
          break;
        default: throw new Error(`Unexpected RPC method: ${rpc.method}`);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    })().catch((error: unknown) => {
      // Out-of-band errors cannot disappear inside the adapter's sanitization.
      errors.push(error); res.writeHead(500); res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls, errors, paid, latencyMs,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
      });
    },
  };
}
