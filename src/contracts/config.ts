import { z } from 'zod';
import { parseNear, YoctoNearSchema } from './amounts.js';
import { AccountIdSchema, Ed25519PublicKeySchema } from './primitives.js';
import { BrokerError } from './errors.js';

export const NETWORK = 'testnet' as const;
export const EXPLORER_BASE = 'https://testnet.nearblocks.io/txns/' as const;
export const DEFAULT_FEE_RESERVE_PER_TX = parseNear('0.001');
const PortSchema = z.number().int().min(1).max(65535);
export const ConfigSchema = z.strictObject({
  network: z.literal(NETWORK, { error: 'MAINNET_REFUSED' }),
  rpcUrl: z.url().refine((url) => {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !/mainnet/i.test(parsed.hostname)
      && !parsed.username && !parsed.password;
  }, 'MAINNET_REFUSED: mainnet RPCs and credentialed/non-HTTP URLs are forbidden'),
  accountId: AccountIdSchema,
  explorerBase: z.literal(EXPLORER_BASE).default(EXPLORER_BASE),
  agentPort: PortSchema.default(3210),
  adminPort: PortSchema.default(3211),
  dataDir: z.string().min(1),
  ownerPublicKey: Ed25519PublicKeySchema,
  feeReservePerTx: YoctoNearSchema.default(DEFAULT_FEE_RESERVE_PER_TX),
  safetyReserve: YoctoNearSchema,
}).refine((config) => config.agentPort !== config.adminPort, 'Agent and admin ports must differ');
export type Config = z.infer<typeof ConfigSchema>;
export function parseConfig(value: unknown): Config {
  if (typeof value === 'object' && value !== null && 'network' in value && value.network === 'mainnet') {
    throw new BrokerError('MAINNET_REFUSED');
  }
  return ConfigSchema.parse(value);
}
