-- openclaw-agent-harness state schema
-- SQLite, applied once on first open. Additive migrations only.

CREATE TABLE IF NOT EXISTS sessions (
  id                       TEXT PRIMARY KEY,
  slack_thread             TEXT NOT NULL,
  slack_channel            TEXT NOT NULL,
  requester                TEXT NOT NULL,
  requester_gh             TEXT NOT NULL,
  repo                     TEXT NOT NULL,
  branch                   TEXT NOT NULL,
  worktree_path            TEXT NOT NULL,
  status                   TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  budget_usd               REAL NOT NULL,
  cost_usd                 REAL NOT NULL DEFAULT 0,
  cycles_ran               INTEGER NOT NULL DEFAULT 0,
  crystallised_prompt      TEXT,
  lead_plan_json           TEXT,             -- serialised LeadPlan
  final_pr_url             TEXT,
  reactions_json           TEXT,             -- serialised { shipIt, abort, pause, budgetBump } (reactions only; NOT PR lifecycle)
  -- PR lifecycle (populated by github-watcher on close/merge)
  pr_merged                INTEGER,          -- 0 | 1 | NULL (unknown)
  pr_closed_at             INTEGER,          -- epoch ms; NULL until watcher observes close
  pr_merged_at             INTEGER,          -- epoch ms; NULL if closed without merge
  -- beta.34: post-ship merge recommendation + deploy verification
  pr_number                INTEGER,          -- GitHub PR number (for harness_merge_pr)
  merge_recommendation     TEXT,             -- 'merge' | 'do_not_merge'
  merge_recommendation_reason TEXT,          -- human-readable reasoning
  deploy_status            TEXT,             -- 'ready'|'error'|'pending'|'unavailable'|'reverted'|'repair_budget_paused'|NULL
  deploy_detail            TEXT,             -- logs excerpt / deployment url / error
  deploy_repair_attempt    INTEGER,          -- beta.36: post-merge deploy-repair attempt count
  parent_session_id        TEXT,             -- beta.36: repair session -> parent session id
  -- Recovery checkpointing
  current_cycle            INTEGER NOT NULL DEFAULT 0,
  last_completed_sub_task  TEXT,
  last_checkpoint_at       INTEGER,
  claude_sdk_session_id    TEXT,             -- lead's Claude Agent SDK session UUID
  last_worker_sdk_session  TEXT               -- most recent worker SDK session
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_thread ON sessions (slack_channel, slack_thread);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_requester ON sessions (requester);

CREATE TABLE IF NOT EXISTS sub_tasks (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  cycle               INTEGER NOT NULL,
  seq                 INTEGER NOT NULL,   -- ordinal within the cycle's plan
  description         TEXT NOT NULL,
  worker_model        TEXT NOT NULL,
  status              TEXT NOT NULL,      -- pending|running|done|failed|interrupted
  cost_usd            REAL NOT NULL DEFAULT 0,
  files_touched       TEXT,
  summary             TEXT,
  commit_sha          TEXT,
  sdk_session_id      TEXT,
  started_at          INTEGER,
  completed_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_tasks_session ON sub_tasks (session_id, cycle, seq);

CREATE TABLE IF NOT EXISTS reviews (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  cycle        INTEGER NOT NULL,
  verdict      TEXT NOT NULL,
  findings     TEXT NOT NULL,
  summary      TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0,
  sdk_session_id TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews (session_id, cycle);

CREATE TABLE IF NOT EXISTS budgets_daily (
  day           TEXT NOT NULL,
  user          TEXT NOT NULL,
  spent_usd     REAL NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user)
);

CREATE TABLE IF NOT EXISTS budgets_monthly (
  month         TEXT NOT NULL,
  user          TEXT NOT NULL,
  spent_usd     REAL NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
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

-- Manual runtime log uploads. Populated by `harness_upload_logs` tool when
-- vercel.enabled=false, or when the requester wants to hand-supply logs
-- from a non-Vercel deploy target (Cloudflare, AWS, on-prem, etc).
-- The adversary reads the most recent row for a session and treats it as
-- `AdversaryInput.runtime` with provider="manual".
CREATE TABLE IF NOT EXISTS runtime_uploads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL,       -- slack user id
  source       TEXT,                -- free-form label
  status       TEXT NOT NULL,       -- ok | build_failed | no_deploy_yet | unavailable
  logs_excerpt TEXT NOT NULL,       -- capped at ~16KB by the tool
  error_count  INTEGER,             -- optional, uploader-supplied
  deployment_url TEXT,
  uploaded_at  INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_uploads_session ON runtime_uploads (session_id, uploaded_at DESC);
