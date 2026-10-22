import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { EncryptedFileCustody } from '../../src/custody/index.js';
import { NativeNearChain, allocateNonce } from '../../src/near/index.js';

const enabled = process.env['BB_LIVE'] === '1'
  && Boolean(process.env['BB_TEST_ACCOUNT_ID']) && Boolean(process.env['BB_TEST_PRIVATE_KEY']);

// Explicitly funded testnet only. No faucet, mainnet fallback, retries/re-signing,
// saved artifacts, or servers. A 1-yocto transfer still burns real testnet gas.
it.skipIf(!enabled)('live spike: signed-byte replay hash matches broadcast and final success', async () => {
  const custody = new EncryptedFileCustody(); const master = randomBytes(32);
  try {
    const accountId = process.env['BB_TEST_ACCOUNT_ID']!;
    const chain = await NativeNearChain.connect({ accountId,
      rpcUrl: process.env['BB_TEST_RPC_URL'] ?? 'https://rpc.testnet.near.org' });
    const signer = await custody.loadKey(await custody.encryptKey(process.env['BB_TEST_PRIVATE_KEY']!, master), master);
    const access = await chain.viewAccessKey(accountId, signer.publicKey);
    expect(access.fullAccess).toBe(true);
    const recent = await chain.recentBlockHash();
    const signed = await chain.buildAndSignNativeTransfer({ signerId: accountId,
      receiverId: process.env['BB_TEST_RECEIVER_ID'] ?? accountId, amount: 1n,
      nonce: allocateNonce(0n, access.nonce, () => {}), publicKey: signer.publicKey, blockHash: recent.hash }, signer);
    const bytes = chain.encodeSignedTx(signed);
    const decoded = chain.decodeSignedTx(bytes);
    expect(chain.encodeSignedTx(decoded)).toEqual(bytes);
    expect(decoded.txHash).toBe(signed.txHash);
    const acknowledgment = await chain.broadcast(decoded.signedTxBase64);
    expect(acknowledgment.txHash).toBe(signed.txHash);
    expect(acknowledgment.kind).toBe('accepted');
    let outcome = await chain.txStatus(signed.txHash, accountId);
    for (let count = 0; count < 20 && outcome.kind !== 'succeeded' && outcome.kind !== 'failed'; count++) {
      await sleep(1000);
      outcome = await chain.txStatus(signed.txHash, accountId);
    }
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind === 'succeeded') { expect(outcome.final).toBe(true); expect(outcome.receiptIds.length).toBeGreaterThan(0); }
  } finally { master.fill(0); await custody.lock(); }
}, 120_000);
