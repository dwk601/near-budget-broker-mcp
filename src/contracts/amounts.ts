import { z } from 'zod';
import { BrokerError } from './errors.js';

export type YoctoNear = bigint;
export const YOCTO_PER_NEAR = 10n ** 24n;
export const YoctoNearSchema = z.bigint().nonnegative();
/** Canonical unsigned decimal TEXT, for SQLite and all JSON boundaries. */
export const DecimalTextSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export type DecimalText = z.infer<typeof DecimalTextSchema>;
export const NearAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/);

export function parseNear(value: unknown): YoctoNear {
  if (typeof value !== 'string' || !NearAmountSchema.safeParse(value).success) {
    throw new BrokerError('INVALID_AMOUNT');
  }
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, '0'));
}
export function formatNear(value: YoctoNear): string {
  if (typeof value !== 'bigint' || value < 0n) throw new BrokerError('INVALID_AMOUNT');
  const fraction = (value % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return `${value / YOCTO_PER_NEAR}${fraction ? `.${fraction}` : ''}`;
}
export function toDecimalText(value: YoctoNear): DecimalText {
  if (typeof value !== 'bigint' || value < 0n) throw new BrokerError('INVALID_AMOUNT');
  return value.toString();
}
export function fromDecimalText(value: unknown): YoctoNear {
  const parsed = DecimalTextSchema.safeParse(value);
  if (!parsed.success) throw new BrokerError('INVALID_AMOUNT');
  return BigInt(parsed.data);
}
