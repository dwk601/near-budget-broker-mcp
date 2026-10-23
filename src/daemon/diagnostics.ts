import { BrokerError } from '../contracts/index.js';

/** Operator diagnostics, not new domain/API error codes. Never include values. */
export class DaemonFailure extends BrokerError {
  constructor(readonly reason: 'LOCK_HELD' | 'LOCK_UNAVAILABLE' | 'BAD_CONFIG' | 'BAD_MASTER_SECRET' | 'MASTER_SECRET_ENV_REFUSED' | 'LISTEN_FAILED') {
    super('BROKER_UNAVAILABLE');
  }
}
