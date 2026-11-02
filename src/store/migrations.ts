import type { DatabaseSync } from "node:sqlite";

/**
 * Schema migrations for the control service.
 *
 * Append a new migration; never edit one that has shipped. `schema_migrations`
 * records what has run, so opening an existing file is a no-op.
 */

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

const MIGRATION_1_IDENTITY = `
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    monthly_budget_usd REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
    key_alias TEXT NOT NULL UNIQUE,
    key_hash TEXT,
    blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
    blocked_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX members_team_idx ON members(team_id);
  CREATE UNIQUE INDEX members_key_hash_idx ON members(key_hash) WHERE key_hash IS NOT NULL;

  CREATE TABLE member_limits (
    member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    budget_usd REAL NOT NULL,
    period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
    token_cap INTEGER,
    rpm INTEGER,
    tpm INTEGER
  );

  CREATE TABLE member_models (
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    PRIMARY KEY (member_id, model_id)
  );

  CREATE TABLE models (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    route TEXT NOT NULL,
    input_per_1m_usd REAL NOT NULL,
    output_per_1m_usd REAL NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('enabled', 'approval-required', 'blocked')),
    sort_order INTEGER NOT NULL
  );
`;

const MIGRATION_2_REQUESTS = `
  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('budget', 'model', 'token_cap')),
    amount_usd REAL,
    model_id TEXT,
    token_cap INTEGER,
    request_id TEXT,
    issued_by TEXT NOT NULL,
    issued_by_id TEXT,
    starts_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX grants_member_idx ON grants(member_id, created_at);
  CREATE INDEX grants_expiry_idx ON grants(expires_at) WHERE expires_at IS NOT NULL;

  CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('more_budget', 'model_unlock', 'suggestion')),
    amount_usd REAL,
    model_id TEXT,
    message TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'approved', 'partly_approved', 'denied', 'expired', 'cancelled')
    ),
    spend_this_period_usd REAL NOT NULL,
    limit_usd REAL NOT NULL,
    top_models_json TEXT NOT NULL,
    last7_days_usd REAL NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX requests_team_state_idx ON requests(team_id, state, created_at);
  CREATE INDEX requests_member_idx ON requests(member_id, created_at);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'partly_approved', 'denied')),
    decided_by_id TEXT NOT NULL,
    decided_by_role TEXT NOT NULL,
    note TEXT,
    granted_amount_usd REAL,
    granted_model_id TEXT,
    grant_expires_at TEXT,
    grant_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('manager', 'rule')),
    decided_at TEXT NOT NULL
  );
  CREATE INDEX decisions_request_idx ON decisions(request_id);

  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    condition_kind TEXT NOT NULL CHECK (condition_kind IN ('budget_topup', 'model_unlock')),
    condition_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX rules_team_idx ON rules(team_id, created_at);

  CREATE TABLE team_policies (
    team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    off_hours_json TEXT NOT NULL,
    soft_ratio REAL NOT NULL,
    grace_ratio REAL NOT NULL,
    unusual_spend_min_usd REAL NOT NULL,
    notifications_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const MIGRATION_3_USAGE_AUDIT = `
  CREATE TABLE usage_rows (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    at TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    request_id TEXT
  );
  CREATE INDEX usage_member_at_idx ON usage_rows(member_id, at);
  CREATE UNIQUE INDEX usage_request_idx ON usage_rows(request_id) WHERE request_id IS NOT NULL;

  CREATE TABLE audit_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT,
    team_id TEXT
  );
  CREATE INDEX audit_team_idx ON audit_events(team_id, seq);
  CREATE INDEX audit_object_idx ON audit_events(object_type, object_id, seq);
  CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
  BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
  END;
  CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
  BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
  END;

  CREATE TABLE key_state (
    key_alias TEXT PRIMARY KEY,
    models_json TEXT NOT NULL,
    max_budget_usd REAL NOT NULL,
    budget_duration TEXT NOT NULL,
    tpm_limit INTEGER,
    rpm_limit INTEGER,
    blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE grant_expiry_log (
    grant_id TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
    at TEXT NOT NULL
  );
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "identity", up: (db) => db.exec(MIGRATION_1_IDENTITY) },
  { version: 2, name: "requests-grants-rules", up: (db) => db.exec(MIGRATION_2_REQUESTS) },
  { version: 3, name: "usage-audit-reconcile", up: (db) => db.exec(MIGRATION_3_USAGE_AUDIT) },
  {
    version: 4,
    name: "usage-api-format",
    up: (db) => db.exec("ALTER TABLE usage_rows ADD COLUMN api_format TEXT"),
  },
  {
    version: 5,
    name: "gateway-team-id",
    up: (db) => db.exec("ALTER TABLE teams ADD COLUMN gateway_team_id TEXT"),
  },
];

export interface MigrationResult {
  applied: number[];
  version: number;
}

export function migrate(db: DatabaseSync, at: string): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
  }>;
  const done = new Set(rows.map((row) => row.version));
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        at,
      );
      db.exec("COMMIT");
      applied.push(migration.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const latest = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return { applied, version: latest?.version ?? 0 };
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
