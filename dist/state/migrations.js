export const STATE_MIGRATIONS = Object.freeze([
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
    Object.freeze({
        id: "20260924_002_autonomous_engine",
        sql: `
ALTER TABLE run_leases ADD COLUMN authority_hash TEXT;

CREATE TABLE control_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO control_metadata(key, value, updated_at) VALUES
  ('control_plane_contract_version', '2', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('control_plane_schema_version', '2', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('legacy_rc13_migration', 'terminal_only', CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE control_engine_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  lease_fence INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('continue','terminate')),
  decision_code TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_control_engine_decisions_run ON control_engine_decisions(run_id, id);

CREATE TABLE control_verified_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  lease_fence INTEGER NOT NULL,
  authority_hash TEXT NOT NULL,
  checkpoint_sha TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, checkpoint_sha, payload_digest)
);
CREATE INDEX idx_control_verified_checkpoints_run ON control_verified_checkpoints(run_id, id);

CREATE TABLE control_readiness_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  lease_fence INTEGER NOT NULL,
  ready INTEGER NOT NULL CHECK (ready IN (0,1)),
  verified_sha TEXT,
  failures_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_control_readiness_results_run ON control_readiness_results(run_id, id);

CREATE TABLE control_merge_authorizations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  actor_identity TEXT NOT NULL,
  conversation_identity TEXT NOT NULL,
  repository_identity TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  expected_head_sha TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_control_merge_authorizations_run ON control_merge_authorizations(run_id, issued_at);

CREATE TABLE control_engine_merge_intents (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  authorization_id TEXT NOT NULL UNIQUE REFERENCES control_merge_authorizations(id),
  expected_head_sha TEXT NOT NULL,
  merge_provider_idempotency TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('authorized','merged','merge_failed','verification_failed')),
  provider_merge_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(change_id)
);
`,
    }),
]);
export function applyStateMigrations(db, migrations = STATE_MIGRATIONS) {
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
        }
        catch (error) {
            try {
                db.exec("ROLLBACK");
            }
            catch { /* preserve the migration error */ }
            throw error;
        }
    }
}
//# sourceMappingURL=migrations.js.map