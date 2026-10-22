import { z } from 'zod';
import { parseNear, YoctoNearSchema } from './amounts.js';
import { AccountIdSchema, Ed25519PublicKeySchema } from './primitives.js';
import { BrokerError } from './errors.js';

export const NETWORK = 'testnet' as const;
export const EXPLORER_BASE = 'https://testnet.nearblocks.io/txns/' as const;
export const DEFAULT_FEE_RESERVE_PER_TX = parseNear('0.001');
export const DEFAULT_BALANCE_MAX_AGE_MS = 10_000;
const PortSchema = z.number().int().min(1).max(65535);
/** Lowercase hostname only, no port, URL, wildcard, userinfo or trailing dot. */
export const AllowedHostSchema = z.string().max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/);
/** Exact HTTP(S) serialized origin; no path/query, wildcard, opaque 'null' or userinfo. */
export const AllowedOriginSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch { return false; }
}, 'Expected exact HTTP(S) origin');
export const ConfigSchema = z.strictObject({
  network: z.literal(NETWORK, { error: 'MAINNET_REFUSED' }),
  rpcUrl: z.url().refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !/mainnet/i.test(decodeURI(value))
        && url.hostname !== 'free.rpc.fastnear.com' && !url.username && !url.password;
    } catch { return false; }
  }, 'MAINNET_REFUSED'),
  accountId: AccountIdSchema,
  explorerBase: z.literal(EXPLORER_BASE).default(EXPLORER_BASE),
  /** 0.0.0.0 is container-internal ONLY; Docker must publish on host 127.0.0.1. */
  bindHost: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
  agentPort: PortSchema.default(3210), adminPort: PortSchema.default(3211),
  allowedHosts: z.array(AllowedHostSchema).min(1).default(['127.0.0.1', 'localhost']),
  /** Empty list rejects all browser Origins; absent Origin allowed for authenticated CLI/bridge. */
  allowedOrigins: z.array(AllowedOriginSchema).default([]),
  balanceMaxAgeMs: z.number().int().min(1).max(60_000).default(DEFAULT_BALANCE_MAX_AGE_MS),
  dataDir: z.string().min(1), auditKeyPath: z.string().min(1),
  ownerPublicKey: Ed25519PublicKeySchema,
  feeReservePerTx: YoctoNearSchema.default(DEFAULT_FEE_RESERVE_PER_TX),
  safetyReserve: YoctoNearSchema,
}).refine((config) => config.agentPort !== config.adminPort, 'Agent and admin ports must differ');
export type Config = z.infer<typeof ConfigSchema>;
/** No case normalization: ONLY the exact literal testnet is accepted. Network/RPC
 * validation failures have one machine-readable code; other config errors stay ZodErrors. */
export function parseConfig(value: unknown): Config {
  const result = ConfigSchema.safeParse(value);
  if (result.success) return result.data;
  if (result.error.issues.some((issue) => issue.path[0] === 'network' || issue.path[0] === 'rpcUrl')) {
    throw new BrokerError('MAINNET_REFUSED');
  }
  throw result.error;
}
