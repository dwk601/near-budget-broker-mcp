import { BrokerError } from '../contracts/index.js';

const REASONS = ['LOCK_HELD', 'LOCK_UNAVAILABLE', 'BAD_CONFIG', 'BAD_MASTER_SECRET',
  'MASTER_SECRET_ENV_REFUSED', 'LISTEN_FAILED', 'DATA_DIR_UNAVAILABLE', 'RPC_UNAVAILABLE'] as const;
export type DaemonReason = typeof REASONS[number];

/** Operator diagnostics, not new domain/API error codes. Never include values. */
export class DaemonFailure extends BrokerError {
  constructor(readonly reason: DaemonReason) {
    super('BROKER_UNAVAILABLE');
  }
}

/** Treat even internal reason strings as untrusted at the output boundary. */
export function diagnosticReason(error: unknown): DaemonReason | undefined {
  if (error instanceof DaemonFailure && REASONS.includes(error.reason)) return error.reason;
  return undefined;
}
