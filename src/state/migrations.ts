import type { DatabaseSync } from "node:sqlite";

export interface StateMigration {
  readonly id: string;
  readonly sql: string;
}

export const STATE_MIGRATIONS: readonly StateMigration[] = Object.freeze([
  Object.freeze({
    id: "20260924_001_control_foundation",
    sql: `
CREATE TABLE control_runs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('draft','awaiting_confirmation','autonomous_run','pr_ready','awaiting_merge','done','failed','cancelled')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  requester_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  brief_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  authority_envelope_json TEXT NOT NULL,
  pull_request_url TEXT,
  terminal_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_control_runs_state ON control_runs(state, updated_at);
CREATE INDEX idx_control_runs_conversation ON control_runs(conversation_id, created_at);

CREATE TABLE control_state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_control_state_events_run ON control_state_events(run_id, id);

CREATE TABLE automation_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES control_runs(id) ON DELETE CASCADE,
  envelope_nonce TEXT NOT NULL UNIQUE,
  envelope_digest TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_automation_decisions_run ON automation_decisions(run_id, created_at);

CREATE TABLE run_leases (
  run_id TEXT PRIMARY KEY REFERENCES control_runs(id) ON DELETE CASCADE,
  owner_id TEXT,
  fence INTEGER NOT NULL CHECK (fence > 0),
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_run_leases_expiry ON run_leases(expires_at);
`,
  }),
]);

export function applyStateMigrations(db: DatabaseSync, migrations: readonly StateMigration[] = STATE_MIGRATIONS): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migration_ledger (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  for (const migration of migrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const applied = db.prepare("SELECT 1 AS present FROM migration_ledger WHERE id = ?").get(migration.id);
      if (!applied) {
        db.exec(migration.sql);
        db.prepare("INSERT INTO migration_ledger (id, applied_at) VALUES (?, ?)").run(migration.id, Date.now());
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve the migration error */ }
      throw error;
    }
  }
}
