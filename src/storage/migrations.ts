import type { DatabaseSync } from 'node:sqlite';

// Migrations run under the same writer lock as admission. Never rewrite an
// applied migration: append the next version and increment SCHEMA_VERSION.
export const SCHEMA_VERSION = 1;
const V1 = `
CREATE TABLE agents (id TEXT PRIMARY KEY COLLATE BINARY, data TEXT NOT NULL) STRICT;
CREATE TABLE credentials (
  id TEXT PRIMARY KEY COLLATE BINARY, agent_id TEXT NOT NULL REFERENCES agents(id),
  token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL
) STRICT;
CREATE INDEX credentials_agent ON credentials(agent_id, id);
CREATE TABLE policies (
  agent_id TEXT NOT NULL REFERENCES agents(id), revision INTEGER NOT NULL CHECK(revision >= 1),
  data TEXT NOT NULL, PRIMARY KEY(agent_id, revision)
) STRICT;
CREATE TABLE wallet_policies (revision INTEGER PRIMARY KEY CHECK(revision >= 1), data TEXT NOT NULL) STRICT;
CREATE TABLE requests (
  id TEXT PRIMARY KEY COLLATE BINARY, agent_id TEXT NOT NULL REFERENCES agents(id),
  idempotency_key TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
  created_at INTEGER NOT NULL, data TEXT NOT NULL,
  UNIQUE(agent_id, idempotency_key), UNIQUE(id, agent_id)
) STRICT;
CREATE INDEX requests_agent ON requests(agent_id, id);
CREATE INDEX requests_rate ON requests(agent_id, created_at, id);
CREATE TABLE admissions (request_id TEXT PRIMARY KEY REFERENCES requests(id)) STRICT;
CREATE TABLE holds (
  request_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  principal TEXT NOT NULL CHECK(principal = '0' OR (principal NOT GLOB '*[^0-9]*' AND principal GLOB '[1-9]*')),
  fee_reserve TEXT NOT NULL CHECK(fee_reserve = '0' OR (fee_reserve NOT GLOB '*[^0-9]*' AND fee_reserve GLOB '[1-9]*')),
  status TEXT NOT NULL CHECK(status IN ('active','committed','released')),
  FOREIGN KEY(request_id, agent_id) REFERENCES requests(id, agent_id)
) STRICT;
CREATE TABLE accounting (
  id TEXT PRIMARY KEY COLLATE BINARY, request_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  kind TEXT NOT NULL, amount TEXT NOT NULL CHECK(amount = '0' OR (amount NOT GLOB '*[^0-9]*' AND amount GLOB '[1-9]*')),
  at INTEGER NOT NULL, data TEXT NOT NULL,
  FOREIGN KEY(request_id, agent_id) REFERENCES requests(id, agent_id)
) STRICT;
CREATE INDEX accounting_agent ON accounting(agent_id, id);
CREATE INDEX accounting_request ON accounting(request_id, id);
CREATE INDEX accounting_window ON accounting(kind, at);
CREATE INDEX accounting_agent_window ON accounting(agent_id, kind, at);
CREATE UNIQUE INDEX accounting_settled_once ON accounting(request_id, kind)
  WHERE kind IN ('principal_committed','gas_charged');
CREATE TABLE standing_approvals (
  id TEXT PRIMARY KEY COLLATE BINARY, agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL
) STRICT;
CREATE INDEX standing_agent ON standing_approvals(agent_id, id);
CREATE TABLE request_approvals (
  request_id TEXT PRIMARY KEY REFERENCES requests(id), id TEXT NOT NULL UNIQUE, data TEXT NOT NULL
) STRICT;
CREATE TABLE freezes (id TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE TABLE attempts (
  id TEXT PRIMARY KEY COLLATE BINARY, request_id TEXT NOT NULL REFERENCES requests(id),
  status TEXT NOT NULL, public_key TEXT NOT NULL,
  nonce TEXT NOT NULL CHECK(nonce = '0' OR (nonce NOT GLOB '*[^0-9]*' AND nonce GLOB '[1-9]*')),
  tx_hash TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL, UNIQUE(public_key, nonce)
) STRICT;
CREATE INDEX attempts_request ON attempts(request_id, id);
CREATE INDEX attempts_outbox ON attempts(status, id);
CREATE TABLE nonces (
  network TEXT NOT NULL, account_id TEXT NOT NULL, public_key TEXT NOT NULL,
  nonce TEXT NOT NULL CHECK(nonce = '0' OR (nonce NOT GLOB '*[^0-9]*' AND nonce GLOB '[1-9]*')),
  PRIMARY KEY(network, account_id, public_key)
) STRICT;
CREATE TABLE balance (id INTEGER PRIMARY KEY CHECK(id = 1), valid_until INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
CREATE TABLE receipts (
  chain_id TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq >= 1), hash TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(chain_id, seq)
) STRICT;
CREATE TABLE checkpoints (
  chain_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(chain_id, seq), FOREIGN KEY(chain_id, seq) REFERENCES receipts(chain_id, seq)
) STRICT;
CREATE TABLE owner_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
`;

export function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get()?.['user_version'];
    if (typeof version !== 'number' || version < 0 || version > SCHEMA_VERSION) {
      throw new Error('Unsupported storage schema version');
    }
    if (version === 0) {
      db.exec(V1);
      db.exec('PRAGMA user_version = 1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
