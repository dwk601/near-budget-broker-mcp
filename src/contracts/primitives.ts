import { z } from 'zod';

export const IdSchema = z.string().min(1).max(128);
/** Unix epoch milliseconds, always a safe integer; not ISO strings. */
export const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type Timestamp = z.infer<typeof TimestampSchema>;
export const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const AccountIdSchema = z.string().min(2).max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
/** Shape validation only; authenticators/custody must also decode and validate key length. */
export const Ed25519PublicKeySchema = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export type Ed25519PublicKey = z.infer<typeof Ed25519PublicKeySchema>;
export const Base64Schema = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const SignatureSchema = z.string().regex(/^[A-Za-z0-9+/]{85}[AQgw]==$/, 'Expected canonical base64 of a 64-byte Ed25519 signature');
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.string(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema),
]));
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
/** Keyset paging: ascending immutable ID using SQLite COLLATE BINARY (UTF-8 byte
 * order). `after` is the exclusive last ID, not an offset or authorization token.
 * Apply scope/filters on EVERY page. nextCursor is last returned ID iff more
 * matching rows exist, otherwise null. Separate pages are not one snapshot. */
export const PageQuerySchema = z.strictObject({
  after: IdSchema.optional(), limit: z.number().int().min(1).max(1000).default(100),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;
export interface Page<T> { items: T[]; nextCursor: string | null }
