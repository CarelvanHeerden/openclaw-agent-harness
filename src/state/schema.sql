-- openclaw-agent-harness state schema
-- SQLite, applied once on first open.

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  slack_thread        TEXT NOT NULL,
  slack_channel       TEXT NOT NULL,
  requester           TEXT NOT NULL,
  requester_gh        TEXT NOT NULL,
  repo                TEXT NOT NULL,
  branch              TEXT NOT NULL,
  worktree_path       TEXT NOT NULL,
  status              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  budget_usd          REAL NOT NULL,
  cost_usd            REAL NOT NULL DEFAULT 0,
  crystallised_prompt TEXT,
  final_pr_url        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_requester ON sessions (requester);

CREATE TABLE IF NOT EXISTS sub_tasks (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  cycle          INTEGER NOT NULL,
  ordinal        INTEGER NOT NULL,
  description    TEXT NOT NULL,
  worker_model   TEXT NOT NULL,
  status         TEXT NOT NULL,
  cost_usd       REAL NOT NULL DEFAULT 0,
  files_touched  TEXT,
  summary        TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_tasks_session ON sub_tasks (session_id, cycle);

CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  cycle        INTEGER NOT NULL,
  verdict      TEXT NOT NULL,
  findings     TEXT NOT NULL,
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews (session_id, cycle);

CREATE TABLE IF NOT EXISTS budgets_daily (
  day       TEXT NOT NULL,
  user      TEXT NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user)
);

CREATE TABLE IF NOT EXISTS budgets_monthly (
  month     TEXT NOT NULL,
  user      TEXT NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (month, user)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  event      TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log (session_id);
