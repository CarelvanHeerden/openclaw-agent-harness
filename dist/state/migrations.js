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
  status TEXT NOT NULL CHECK (status IN ('authorized','merging','merged','merge_failed','verification_failed')),
  provider_merge_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(change_id)
);
`,
    }),
    Object.freeze({
        id: "20260924_003_canonical_control_plane",
        sql: `
CREATE TABLE control_proposals (
  run_id TEXT PRIMARY KEY REFERENCES control_runs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1,
  confirmable INTEGER NOT NULL CHECK (confirmable IN (0,1)),
  base_revision TEXT NOT NULL,
  brief_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  excluded_scope_json TEXT NOT NULL,
  credential_route_digest TEXT NOT NULL,
  security_class TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  proposal_expires_at INTEGER NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  published_sha TEXT,
  readiness_digest TEXT,
  spend_usd REAL,
  terminal_summary TEXT,
  policy_version TEXT NOT NULL DEFAULT 'control-plane-contract/v2',
  minimum_runtime_version TEXT NOT NULL DEFAULT '2.0.0-rc.13',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE control_host_attestations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('confirm_change','merge_change')),
  provenance TEXT NOT NULL CHECK (provenance = 'host_verified'),
  actor_identity TEXT NOT NULL,
  conversation_identity TEXT NOT NULL,
  host_event_id TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL UNIQUE,
  binding_digest TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL
);

CREATE TABLE control_dispatch_intents (
  run_id TEXT PRIMARY KEY REFERENCES control_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT
);
CREATE INDEX idx_control_dispatch_recovery ON control_dispatch_intents(status, lease_expires_at);

CREATE TABLE control_security_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0,1)),
  detected INTEGER NOT NULL CHECK (detected IN (0,1)),
  observed_at INTEGER NOT NULL
);
CREATE INDEX idx_control_security_receipts_run ON control_security_receipts(run_id, id DESC);

CREATE TABLE control_readiness_attestations (
  content_digest TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK (ready IN (0,1)),
  verified_sha TEXT,
  input_json TEXT NOT NULL,
  failures_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, generation)
);
CREATE INDEX idx_control_readiness_latest ON control_readiness_attestations(run_id, generation DESC);
`,
    }),
    Object.freeze({
        id: "20260924_004_merge_intent_recovery",
        sql: `
ALTER TABLE control_engine_merge_intents RENAME TO control_engine_merge_intents_old;
CREATE TABLE control_engine_merge_intents (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  authorization_id TEXT NOT NULL UNIQUE REFERENCES control_merge_authorizations(id),
  expected_head_sha TEXT NOT NULL,
  merge_provider_idempotency TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('authorized','merging','merged','merge_failed','verification_failed')),
  provider_merge_sha TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(change_id)
);
INSERT INTO control_engine_merge_intents SELECT * FROM control_engine_merge_intents_old;
DROP TABLE control_engine_merge_intents_old;

CREATE TABLE IF NOT EXISTS control_security_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES control_runs(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0,1)),
  detected INTEGER NOT NULL CHECK (detected IN (0,1)),
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_security_receipts_run ON control_security_receipts(run_id, id DESC);
`,
    }),
]);
function terminaliseLegacyControlChanges(db) {
    const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='control_changes'").get();
    if (!present)
        return;
    const rows = db.prepare("SELECT * FROM control_changes").all();
    for (const row of rows) {
        const id = String(row.change_id);
        const scope = (() => { try {
            return JSON.parse(String(row.scope_json));
        }
        catch {
            return ["**/*"];
        } })();
        const budget = Number(row.budget_usd ?? 0);
        const activeTimeMs = Number(row.time_limit_seconds ?? 0) * 1000;
        const createdAt = Number(row.created_at ?? Date.now());
        const state = String(row.state) === "merged" ? "done" : "failed";
        const authority = {
            version: 1, requesterId: String(row.actor_identity), conversationId: String(row.conversation_identity),
            repository: String(row.repository_identity), baseRef: String(row.base_ref), briefDigest: String(row.brief_digest),
            policyDigest: String(row.policy_digest), scope: { paths: scope.length ? scope : ["**/*"] },
            allowedActions: ["implement", "test", "commit", "push_feature_branch", "open_pull_request"],
            limits: { budgetUsd: budget, activeTimeMs, cycles: 0, retries: 0 }, issuedAt: createdAt,
            expiresAt: Math.max(createdAt + 1, Number(row.proposal_expires_at ?? createdAt + 1)), nonce: `legacy:${id}`,
        };
        db.prepare(`INSERT OR IGNORE INTO control_runs
      (id,state,version,requester_id,conversation_id,repository,base_ref,brief_digest,policy_digest,authority_envelope_json,pull_request_url,terminal_code,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, state, Number(row.generation ?? 1), String(row.actor_identity), String(row.conversation_identity), String(row.repository_identity), String(row.base_ref), String(row.brief_digest), String(row.policy_digest), JSON.stringify(authority), row.pr_url == null ? null : String(row.pr_url), state === "failed" ? String(row.terminal_code ?? "legacy_terminalised") : null, createdAt, Number(row.updated_at ?? createdAt));
        db.prepare(`INSERT OR IGNORE INTO control_proposals
      (run_id,generation,confirmable,base_revision,brief_json,scope_json,excluded_scope_json,credential_route_digest,
       security_class,assumptions_json,proposal_expires_at,pr_number,pr_url,published_sha,readiness_digest,spend_usd,
       terminal_summary,policy_version,minimum_runtime_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, Number(row.generation ?? 1), 0, String(row.base_revision), String(row.brief_json), String(row.scope_json), String(row.excluded_scope_json), String(row.credential_route), String(row.security_class), String(row.assumptions_json), Number(row.proposal_expires_at), row.pr_number == null ? null : Number(row.pr_number), row.pr_url == null ? null : String(row.pr_url), row.published_sha == null ? null : String(row.published_sha), row.readiness_digest == null ? null : String(row.readiness_digest), row.spend_usd === null ? null : Number(row.spend_usd), String(row.terminal_summary ?? "Legacy control record terminalised during migration."), "legacy-rc13/terminal-only", "2.0.0-rc.13", createdAt, Number(row.updated_at ?? createdAt));
    }
    db.exec("DROP TABLE IF EXISTS control_merge_intents; DROP TABLE IF EXISTS control_execution_intents; DROP TABLE IF EXISTS control_attestations; DROP TABLE IF EXISTS control_changes;");
}
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
                if (migration.id === "20260924_003_canonical_control_plane")
                    terminaliseLegacyControlChanges(db);
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