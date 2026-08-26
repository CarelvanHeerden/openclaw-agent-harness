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
  merge_recommendation     TEXT,             -- 'merge' | 'do_not_merge' | 'needs_human_review'
  merge_recommendation_reason TEXT,          -- human-readable reasoning
  deploy_status            TEXT,             -- 'ready'|'error'|'pending'|'unavailable'|'reverted'|'repair_budget_paused'|NULL
  deploy_detail            TEXT,             -- logs excerpt / deployment url / error
  deploy_repair_attempt    INTEGER,          -- beta.36: post-merge deploy-repair attempt count
  parent_session_id        TEXT,             -- beta.36: repair session -> parent session id
  -- beta.55 (B2): mid-run clarification pause (awaiting_clarification)
  clarification_question   TEXT,             -- the ONE question surfaced to the human
  clarification_seq        INTEGER,          -- sub-task seq the loop paused at
  clarification_answer     TEXT,             -- the human's answer, folded into the brief on resume
  clarification_subtask    TEXT,             -- beta.58: JSON { title, intent } of the paused sub-task (content-keyed skip)
  -- Recovery checkpointing
  current_cycle            INTEGER NOT NULL DEFAULT 0,
  last_completed_sub_task  TEXT,
  last_checkpoint_at       INTEGER,
  claude_sdk_session_id    TEXT,             -- lead's Claude Agent SDK session UUID
  last_worker_sdk_session  TEXT,              -- most recent worker SDK session
  -- beta.63 (Part A): session-level liveness heartbeat. Written on EVERY state
  -- transition (sub-task start/complete, review start/complete, finalize, push,
  -- PR-open). The stall watchdog checks non-terminal executing/reviewing/
  -- finalising sessions where now - last_progress_at > loop.session_stall_seconds
  -- and recovers or cleanly fails (preserving the worktree) a wedged run.
  last_progress_at         INTEGER,           -- epoch ms of the last forward progress
  -- beta.67 (Bug B): the branch FORK-POINT sha (merge-base of the default base
  -- branch and HEAD, captured once at plan_ready when the worktree exists).
  -- The adversary review diffs `git diff <plan_base_sha>..HEAD` against THIS
  -- so it sees ONLY the branch's own commits, not accumulated main history
  -- (beta.66 smoke #4 diffed against main-at-review-time and hallucinated
  -- unrelated commits => false-positive revise + a wasted cycle).
  plan_base_sha            TEXT,              -- fork-point sha for the adversary diff base
  -- beta.81 (Track A / A1): the harness-owned SESSION cost ESTIMATE surfaced up
  -- front (from recommendBudget). Persisted so harness_progress / terminal /
  -- the loop.start audit echo "Estimated ~$X; cap $Y" independent of whether
  -- the agent relays the harness_run note.
  estimated_usd            REAL,              -- session cost estimate (USD) at start
  -- beta.123: a per-session wall-clock ceiling, set when the operator answers
  -- the confirmation gate with something like "confirm, budget $40 with a time
  -- budget of 3 hours". NULL means "use loop.session_hard_timeout_seconds".
  hard_timeout_seconds     INTEGER,           -- per-session wall-clock override, seconds
  -- beta.129: 1 when an abort deliberately kept this worktree because it still
  -- holds unpushed commits. The startup self-heal reaps every worktree whose
  -- session is terminal, and `aborted` is terminal, so without this the
  -- "preserved, go and get your commits" promise expired at the next restart.
  worktree_preserved       INTEGER,           -- 1 = abort kept this worktree on purpose
  -- beta.132: proof that a loop is still sitting on a time-extension question.
  -- That pause is unlike every other one: the loop does not return, it polls
  -- this row in place. harness_answer used to infer "still listening" from the
  -- five-minute window alone, which is only true while the process lives.
  -- Session 2b4c1d33 answered 28 seconds in, to a listener that had already
  -- died, and was told the run would pick it up. Nothing did.
  clarification_heartbeat_at INTEGER          -- ms; stamped on every poll tick
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

-- Credential routes written by `harness_onboard`.
--
-- The routing tree `pat_routing.<provider>.<org>.<person>` lives in plugin
-- config, which is read-only at runtime. Onboarding could therefore store a
-- secret but nothing that told the router to use it: the token went into the
-- vault under a name no session looked up, every step reported success, and the
-- run died an hour later at clone.
--
-- These rows are the missing half -- the routing entry onboarding writes -- and
-- are merged BENEATH config at resolve time. A hand-written config tree always
-- wins, so a chat message can never silently override an operator.
--
-- Holds NO secret. `vault_service` NAMES a vault entry; the token itself lives
-- in the credential vault, which is a separate database under a separate key.
CREATE TABLE IF NOT EXISTS credential_routes (
  provider         TEXT NOT NULL,     -- github | gitlab
  org              TEXT NOT NULL,     -- repo owner, stored lower-cased for lookup
  person           TEXT NOT NULL,     -- person key, as it would read in config
  slack_user_id    TEXT NOT NULL,     -- authoritative link from request to person
  commit_name      TEXT NOT NULL,     -- git author name for commits on their behalf
  commit_email     TEXT NOT NULL,     -- git author email
  vault_service    TEXT NOT NULL,     -- names the vault entry; never the secret
  provider_login   TEXT,              -- login the token authenticated as, for re-auth checks
  token_expires_at INTEGER,           -- epoch ms, when the provider discloses it
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, org, person)
);

CREATE INDEX IF NOT EXISTS idx_credential_routes_requester ON credential_routes (slack_user_id, provider, org);

-- v2.0.0-beta.1: cached models.dev pricing catalogue.
--
-- One row, holding the whole validated document. Stored whole rather than
-- row-per-model because the validation rule is all-or-nothing: a partially
-- applied catalogue is the one failure with no legible symptom, since the
-- prices that survived look exactly like the prices that were checked.
--
-- Purely a cache. Losing it costs one refresh, and until that refresh lands
-- pricing falls back to the built-in PRICES table.
CREATE TABLE IF NOT EXISTS model_prices (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- single row, enforced
  fetched_at  INTEGER NOT NULL,                    -- epoch ms
  payload     TEXT NOT NULL                        -- JSON: the parsed Catalogue
);
