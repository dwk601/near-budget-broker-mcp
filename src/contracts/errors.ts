import { z } from 'zod';

export const ERROR_CODES = [
  'UNAUTHENTICATED', 'FORBIDDEN', 'AGENT_FROZEN', 'GLOBAL_FROZEN', 'NO_POLICY',
  'PER_TX_EXCEEDED', 'ROLLING_24H_EXCEEDED', 'LIFETIME_EXCEEDED', 'GLOBAL_CAP_EXCEEDED',
  'GAS_BUDGET_EXCEEDED', 'RATE_LIMITED', 'MAX_OUTSTANDING', 'RECIPIENT_NOT_ALLOWED',
  'WALLET_CAPACITY', 'APPROVAL_REQUIRED', 'IDEMPOTENCY_CONFLICT', 'NOT_FOUND',
  'BROKER_UNAVAILABLE', 'INVALID_AMOUNT', 'MAINNET_REFUSED', 'AUDIT_UNAVAILABLE',
  'NONCE_CONFLICT', 'POLICY_CHANGED',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ReasonCode = ErrorCode;
export const ReasonCodeSchema = ErrorCodeSchema;
export const BrokerErrorSchema = z.strictObject({ code: ErrorCodeSchema, message: z.string() });
export class BrokerError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) {
    super(message);
    this.name = 'BrokerError';
  }
}
