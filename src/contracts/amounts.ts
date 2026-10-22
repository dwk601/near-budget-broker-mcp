import { z } from 'zod';
import { BrokerError } from './errors.js';

export type YoctoNear = bigint;
export const YOCTO_PER_NEAR = 10n ** 24n;
export const MAX_U128 = (1n << 128n) - 1n;
export const YoctoNearSchema = z.bigint().nonnegative().max(MAX_U128);
/** Canonical u128 decimal TEXT. The first stage bounds work BEFORE BigInt parsing. */
export const DecimalTextSchema = z.string().max(39).regex(/^(0|[1-9][0-9]*)$/)
  .pipe(z.string().refine((value) => BigInt(value) <= MAX_U128, 'INVALID_AMOUNT'));
export type DecimalText = z.infer<typeof DecimalTextSchema>;
function nearStringToYocto(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(fraction.padEnd(24, '0'));
}
export const NearAmountSchema = z.string().max(40).regex(/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,24})?$/)
  .pipe(z.string().refine((value) => nearStringToYocto(value) <= MAX_U128, 'INVALID_AMOUNT'));

export function parseNear(value: unknown): YoctoNear {
  const parsed = NearAmountSchema.safeParse(value);
  if (!parsed.success) throw new BrokerError('INVALID_AMOUNT');
  return nearStringToYocto(parsed.data);
}
export function formatNear(value: YoctoNear): string {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U128) throw new BrokerError('INVALID_AMOUNT');
  const fraction = (value % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return `${value / YOCTO_PER_NEAR}${fraction ? `.${fraction}` : ''}`;
}
export function toDecimalText(value: YoctoNear): DecimalText {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U128) throw new BrokerError('INVALID_AMOUNT');
  return value.toString();
}
export function fromDecimalText(value: unknown): YoctoNear {
  const parsed = DecimalTextSchema.safeParse(value);
  if (!parsed.success) throw new BrokerError('INVALID_AMOUNT');
  return BigInt(parsed.data);
}
