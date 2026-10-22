import { z } from 'zod';
import { IdSchema, Sha256Schema, TimestampSchema } from './primitives.js';

/** Revocation is permanent; freeze state exists ONLY in Freeze records. */
export const AgentStatusSchema = z.enum(['active', 'revoked']);
export const AgentSchema = z.strictObject({
  id: IdSchema, name: z.string().min(1).max(256), status: AgentStatusSchema, createdAt: TimestampSchema,
});
export type Agent = z.infer<typeof AgentSchema>;
/** 32 random bytes, canonical unpadded base64url (43 characters). Never persisted. */
export const AgentTokenSchema = z.string().regex(/^bb_agent_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export type AgentToken = z.infer<typeof AgentTokenSchema>;
export const AgentCredentialSchema = z.strictObject({
  id: IdSchema, agentId: IdSchema, tokenHash: Sha256Schema,
  createdAt: TimestampSchema, revokedAt: TimestampSchema.nullable(),
});
export type AgentCredential = z.infer<typeof AgentCredentialSchema>;
export const AgentPrincipalSchema = z.strictObject({
  kind: z.literal('agent'), agentId: IdSchema, credentialId: IdSchema,
});
export type AgentPrincipal = z.infer<typeof AgentPrincipalSchema>;
export const OwnerPrincipalSchema = z.strictObject({ kind: z.literal('owner') });
export type OwnerPrincipal = z.infer<typeof OwnerPrincipalSchema>;
export const IssuedCredentialSchema = z.strictObject({ credential: AgentCredentialSchema, token: AgentTokenSchema });
export type IssuedCredential = z.infer<typeof IssuedCredentialSchema>;
export const FreezeSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('global'), frozen: z.boolean(), reason: z.string(), at: TimestampSchema }),
  z.strictObject({ scope: z.literal('agent'), agentId: IdSchema, frozen: z.boolean(), reason: z.string(), at: TimestampSchema }),
]);
export type Freeze = z.infer<typeof FreezeSchema>;
