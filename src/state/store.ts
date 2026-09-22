/**
 * State store: SQLite via the built-in `node:sqlite` module, sync API.
 * Applies schema on first open. Idempotent.
 *
 * The schema is loaded from schema.sql at package root. It is intentionally
 * copied into dist/state/schema.sql by the build (see package.json "files").
 *
 * We deliberately use `node:sqlite` (built into Node >= 22.13) rather than
 * `better-sqlite3` so the plugin has ZERO native dependencies. OpenClaw's
 * plugin loader installs deps with `npm install --ignore-scripts`, which
 * silently skips `better-sqlite3`'s `install` script and leaves the plugin
 * with no native binary. `node:sqlite` avoids the whole problem — it ships
 * with Node itself.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export interface StateStore {
  db: DatabaseSync;
  /** True while the underlying `DatabaseSync` handle is open. */
  isOpen: () => boolean;
  /** Idempotent. Safe to call more than once (e.g. double teardown). */
  close: () => void;
  audit: (event: string, payload: unknown, sessionId?: string) => void;
}

function locateSchema(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "schema.sql"),               // colocated with dist/state/store.js
    resolve(here, "../../src/state/schema.sql"), // dev mode: dist/state -> src/state
    resolve(here, "../state/schema.sql"),      // fallback
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`schema.sql not found near ${here}`);
}

/**
 * Open (or create) the state store.
 *
 * NOTE: This is intentionally synchronous. OpenClaw's plugin loader
 * requires `register()` to be synchronous, and this is called from that
 * critical path. All the underlying primitives (`mkdirSync`, `readFileSync`,
 * `DatabaseSync` constructor, `db.exec`, `db.prepare`) are sync anyway.
 *
 * The async wrapper is retained as a thin re-export below so callers that
 * were previously awaiting can continue to do so without a code change.
 */
export function openStateStoreSync(pathHint: string): StateStore {
  const path = resolve(pathHint.replace(/^~/, process.env.HOME ?? ""));
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // `node:sqlite` has no `.pragma()` helper; use `.exec` with PRAGMA text.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // beta.57 (P3): without a busy_timeout, a concurrent writer (teardown-drain
  // overlap of two runtimes on re-register churn, or the pr-watcher ticking
  // during a loop checkpoint) makes SQLite throw SQLITE_BUSY immediately
  // instead of waiting out the (short) lock -- crashing the loop mid-run.
  db.exec("PRAGMA busy_timeout = 5000");

  const schema = readFileSync(locateSchema(), "utf8");
  db.exec(schema);

  // Additive migrations. Each entry is 'try to add column, ignore if already there'.
  // Keep this list short and only ever ADD, never DROP or MODIFY (breaks rollback).
  const additiveMigrations: Array<{ table: string; column: string; type: string }> = [
    // 2026-07-13: promote pr_merged / pr_closed_at / pr_merged_at out of reactions_json.
    // reactions_json is for reaction state only; PR lifecycle deserves proper columns.
    { table: "sessions", column: "pr_merged",       type: "INTEGER" },   // 0/1
    { table: "sessions", column: "pr_closed_at",    type: "INTEGER" },   // epoch ms
    { table: "sessions", column: "pr_merged_at",    type: "INTEGER" },   // epoch ms (nullable)
    // beta.34: post-ship merge recommendation + PR number for the merge tool.
    { table: "sessions", column: "pr_number",                     type: "INTEGER" }, // GitHub PR number
    { table: "sessions", column: "merge_recommendation",         type: "TEXT" },    // 'merge' | 'do_not_merge' | 'needs_human_review'
    { table: "sessions", column: "merge_recommendation_reason",  type: "TEXT" },    // human-readable reasoning
    { table: "sessions", column: "deploy_status",                type: "TEXT" },    // 'ready'|'error'|'pending'|'unavailable'|'reverted'|'repair_budget_paused'|NULL
    { table: "sessions", column: "deploy_detail",                type: "TEXT" },    // logs excerpt / url / error
    { table: "sessions", column: "deploy_repair_attempt",        type: "INTEGER" }, // beta.36: post-merge deploy-repair attempt count
    { table: "sessions", column: "parent_session_id",            type: "TEXT" },    // beta.36: links a repair session to the session whose deploy it repairs
    // beta.55 (B2): mid-run clarification pause. When the loop transitions to
    // 'awaiting_clarification' it persists the question + the sub-task seq it
    // paused at, so a human answer (harness_answer) can re-drive from that seq.
    { table: "sessions", column: "clarification_question",       type: "TEXT" },    // the ONE question surfaced to the human
    { table: "sessions", column: "clarification_seq",            type: "INTEGER" }, // sub-task seq the loop paused at
    { table: "sessions", column: "clarification_answer",         type: "TEXT" },    // the human's answer, folded into the brief on resume
    // beta.58 (D1/D2): the paused sub-task's title+intent, captured at pause so a
    // `skip` answer can key the prohibition by CONTENT (not seq number, which a
    // full re-plan renumbers away) and strip the owning finding line from the brief.
    { table: "sessions", column: "clarification_subtask",        type: "TEXT" },    // JSON { title, intent } of the paused sub-task
    // beta.63 (Part A): session-level liveness heartbeat for the stall watchdog.
    // Written on EVERY state transition; the watchdog fails/recovers a session
    // whose last_progress_at froze past loop.session_stall_seconds.
    { table: "sessions", column: "last_progress_at",             type: "INTEGER" }, // epoch ms of last forward progress
    // beta.67 (Bug B): the branch fork-point sha, captured at plan_ready. The
    // adversary review diffs `git diff <plan_base_sha>..HEAD` against this so
    // it sees ONLY the branch's own commits (beta.66 smoke #4 diffed against
    // main-at-review-time and hallucinated unrelated commits => false revise).
    { table: "sessions", column: "plan_base_sha",                type: "TEXT" },    // fork-point sha for adversary diff base
    // beta.81 (Track A / A1): harness-owned session cost estimate (USD) surfaced
    // up front. Persisted so progress/terminal/loop.start echo it reliably.
    { table: "sessions", column: "estimated_usd",                type: "REAL" },    // session cost estimate at start
    // beta.123: a per-session wall-clock ceiling. The confirmation gate lets an
    // operator answer "confirm, budget $40 with a time budget of 3 hours"; the
    // money half landed in b122 and the time half had nowhere to go, because
    // the ceiling was config-only. NULL means "use loop.session_hard_timeout_seconds".
    { table: "sessions", column: "hard_timeout_seconds",         type: "INTEGER" }, // per-session wall-clock override
    // beta.129: set to 1 when an abort DELIBERATELY kept a worktree because it
    // still holds unpushed commits. Without it the startup self-heal reaps the
    // directory on the next restart -- it reaps any worktree whose session is
    // done/failed/aborted -- so b120's "preserved, go and get your commits"
    // promise expired at the next container bounce.
    { table: "sessions", column: "worktree_preserved",           type: "INTEGER" }, // 1 = abort kept this worktree on purpose
    // beta.132: liveness for the one pause the loop does not return from. The
    // window alone said "still listening" about a process that had exited.
    { table: "sessions", column: "clarification_heartbeat_at",   type: "INTEGER" }, // ms; stamped on every poll tick
    // rc.3: the revise baseline. A focused revision needs two review windows --
    // the whole PR for correctness, and only what the revision committed for
    // scope -- and neither can be recovered from branch state after the fact.
    // With one window, StitchGuard PR #1168's two-file revision reported ~46
    // pre-existing feature files as revision scope violations.
    { table: "sessions", column: "original_pr_base_sha",         type: "TEXT" },    // fork point of the PR being revised
    { table: "sessions", column: "revision_start_sha",           type: "TEXT" },    // PR head before any revision work
    { table: "sessions", column: "original_feature_brief",       type: "TEXT" },    // JSON: the root feature brief
    { table: "sessions", column: "operator_revision_brief",      type: "TEXT" },    // JSON: { guidance, directives }
    // rc.4: an operator-recovered PR association. `pr_number` is written on the
    // ship path only, so a session that failed after its PR existed had no way
    // to say so and no way to be revised.
    { table: "sessions", column: "pr_link_state",                type: "TEXT" },    // 'recovered' when a human asserted the link
    { table: "sessions", column: "pr_linked_at",                 type: "INTEGER" }, // epoch ms
    { table: "sessions", column: "pr_linked_by",                 type: "TEXT" },    // slack user id of the operator
    { table: "sessions", column: "pr_link_head_sha",             type: "TEXT" },    // PR head sha the evidence was gathered against
    { table: "sessions", column: "pr_link_evidence",             type: "TEXT" },    // JSON: the checks that passed
    // rc.5 (#2): PUBLICATION EVIDENCE. Which commit was proven to be on the
    // remote, and when it was read back. Before this, the only durable record
    // of a ship was `final_pr_url` + status 'done' -- and StitchGuard PR #1168
    // had both while 35 commits sat unpushed on local disk, because a PR URL
    // says a PR exists, not that it describes this run's work. NULL means
    // publication was never verified; it never means verified-absent.
    { table: "sessions", column: "published_sha",                type: "TEXT" },    // commit observed at the remote branch tip
    { table: "sessions", column: "published_at",                 type: "INTEGER" }, // epoch ms of that observation
    { table: "sessions", column: "published_branch",             type: "TEXT" },    // branch the SHA was observed on
    /*
     * rc.9: storage health, after StitchGuard f7c4e585.
     *
     * The worktrees root was a tmpfs mount, so a container restart took every
     * worktree AND the bare object cache with it -- the adapter puts `.repos`
     * INSIDE the worktrees root. The DB was on a host-backed mount and survived
     * intact, still naming a paused session, a worktree path and nine commit
     * SHAs that no longer existed anywhere. Startup reported success.
     *
     * `storage_state` is what a reverse reconciliation FOUND, so the answer
     * survives the process that discovered it. NULL means never checked, which
     * is deliberately different from `ok`.
     */
    { table: "sessions", column: "storage_state",                type: "TEXT" },    // ok | released | missing_worktree | missing_objects | missing_commits | unknown
    { table: "sessions", column: "storage_reason",               type: "TEXT" },    // operator-facing detail for storage_state
    { table: "sessions", column: "storage_checked_at",           type: "INTEGER" }, // ms; when the reconciliation last ran
    /*
     * rc.9: `last_completed_sub_task` did NOT mean completed.
     *
     * It is written by `checkpoint()` immediately after a worker result is
     * persisted, BEFORE harness-side verification decides whether the work is
     * real. In the incident it names sub-task 11, which is `failed_verification`
     * with `commit_sha: null`. Renaming the column would be a risky migration
     * for a cosmetic gain, so the honest name is added beside it: the attempted
     * one goes here, and `last_completed_sub_task` is now only written once
     * verification has actually passed.
     */
    { table: "sessions", column: "last_attempted_sub_task",      type: "TEXT" },    // last worker turn persisted, success or not
    { table: "sessions", column: "last_checkpoint_bundle",       type: "TEXT" },    // path of the last VERIFIED durable bundle
    { table: "sessions", column: "last_checkpoint_sha",          type: "TEXT" },    // tip the verified bundle contains
    // rc.11: scoped task amendments and an active-time clock. Human pause time
    // is represented explicitly instead of being reconstructed on resume.
    { table: "sessions", column: "clarification_id",              type: "TEXT" },
    { table: "sessions", column: "plan_revision",                 type: "INTEGER NOT NULL DEFAULT 0" },
    { table: "sessions", column: "active_limit_ms",               type: "INTEGER" },
    { table: "sessions", column: "active_elapsed_ms",             type: "INTEGER NOT NULL DEFAULT 0" },
    { table: "sessions", column: "active_segment_started_at",     type: "INTEGER" },
    { table: "sessions", column: "human_pause_started_at",        type: "INTEGER" },
    { table: "sessions", column: "deadline_policy_version",       type: "TEXT" },
    { table: "sessions", column: "minimum_runtime_version",       type: "TEXT" },
    { table: "sessions", column: "terminal_cause",                type: "TEXT" },
    { table: "sessions", column: "terminal_classification",       type: "TEXT" },
    { table: "sessions", column: "accounting_state",              type: "TEXT" },
    { table: "sub_task_attempts", column: "worker_status",        type: "TEXT" },
    { table: "sub_task_attempts", column: "verification_status",  type: "TEXT" },
    { table: "sub_task_attempts", column: "verification_json",    type: "TEXT" },
    { table: "sub_task_attempts", column: "task_outcome",         type: "TEXT" },
    { table: "provider_calls", column: "completion_fingerprint",  type: "TEXT" },
    { table: "provider_session_usage", column: "currency",       type: "TEXT NOT NULL DEFAULT 'USD'" },
    { table: "provider_session_usage", column: "checkpoint_version", type: "INTEGER NOT NULL DEFAULT 1" },
  ];
  for (const m of additiveMigrations) {
    try {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
    } catch (err) {
      const msg = String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }

  // One-shot backfill from legacy reactions_json blob into proper columns.
  // Safe to run on every open: it only touches rows where the column is still
  // NULL. On a fresh install this is a no-op.
  try {
    const legacyRows = db
      .prepare(
        `SELECT id, reactions_json FROM sessions
          WHERE reactions_json IS NOT NULL AND reactions_json != ''
            AND (pr_merged IS NULL OR pr_closed_at IS NULL)`,
      )
      .all() as Array<{ id: string; reactions_json: string }>;
    const upd = db.prepare(
      `UPDATE sessions SET pr_merged = COALESCE(?, pr_merged),
                            pr_closed_at = COALESCE(?, pr_closed_at),
                            pr_merged_at = COALESCE(?, pr_merged_at)
        WHERE id = ?`,
    );
    for (const row of legacyRows) {
      try {
        const j = JSON.parse(row.reactions_json) as { prMerged?: boolean; prClosedAt?: number; prMergedAt?: number };
        upd.run(
          typeof j.prMerged === "boolean" ? (j.prMerged ? 1 : 0) : null,
          typeof j.prClosedAt === "number" ? j.prClosedAt : null,
          typeof j.prMergedAt === "number" ? j.prMergedAt : null,
          row.id,
        );
      } catch { /* ignore per-row parse failures */ }
    }
  } catch { /* first open before column exists is fine */ }

  const insertAudit = db.prepare(
    `INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`,
  );

  let open = true;
  return {
    db,
    isOpen: () => open,
    close: () => {
      // Idempotent: on a re-register race two teardown paths can both reach
      // here. `node:sqlite` throws "database is not open" on a double close,
      // which is exactly the error we are trying to eliminate downstream.
      if (!open) return;
      open = false;
      db.close();
    },
    audit: (event, payload, sessionId) => {
      // beta.47: guard against a post-close write. On a terminal transition
      // the worktree-release path (loop.tryReleaseWorktree) can run AFTER the
      // teardown drain has closed the runtime (session 94a516a0, PR #858):
      // the release impl threw, its catch handler called audit(), and the
      // prepared statement was already finalized -> "statement has been
      // finalized" thrown at process level. Terminal state was already
      // persisted; only this trailing bookkeeping row is lost. Skip cleanly
      // when the store is closed, and never let a finalized-statement error
      // escape to the process.
      if (!open) return;
      try {
        insertAudit.run(sessionId ?? null, event, JSON.stringify(payload ?? {}), Date.now());
      } catch {
        // Store was closed concurrently between the `open` check and the
        // write (teardown race). Dropping a trailing audit row is acceptable;
        // crashing the process is not.
      }
    },
  };
}

/**
 * Async facade over {@link openStateStoreSync} for callers that previously
 * awaited this function. Prefer the sync variant in new code, especially
 * on the plugin `register()` critical path.
 */
export async function openStateStore(pathHint: string): Promise<StateStore> {
  return openStateStoreSync(pathHint);
}
