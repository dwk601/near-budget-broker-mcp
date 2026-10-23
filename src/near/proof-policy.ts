/** Testnet native expiry policy. Block heights are bigint throughout. A nominal
 * second per validity block is an additional wall-clock age gate; FINAL height
 * remains authoritative, with 1,000 extra blocks for lookup/indexing convergence.
 */
export const EXPIRY_SAFETY_BLOCKS = 1_000n;
export const VALIDITY_BLOCK_MS = 1_000n;
export const EXPIRY_LOOKUP_SPACING_MS = 1_000;
