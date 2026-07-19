/**
 * beta.38: recovery re-entrancy guard + worktree collision fixes.
 *
 * ROOT CAUSE (Staging ProjectThanos smoke, session 36f53c40):
 * `recoverSessions` runs on EVERY plugin bootstrap. A plugin RE-REGISTER (the
 * OKF bundle-reindex churn) triggers bootstrap WITHOUT the process dying, so
 * the previous generation's `loop.run()` is still executing. Recovery saw the
 * still-`executing` session, assumed a dead process, and re-drove `loop.run()`
 * -> a SECOND concurrent loop -> `git worktree add` collided with the first
 * loop's live worktree (`fatal: '<branch>' is already checked out at ...`) ->
 * loop.plan_failed -> whole run killed after sub-task 1.
 *
 * Primary fix: a module-level `runningSessions` guard in loop.ts. A re-entrant
 * `run()` for a session already running in-process returns
 * `skipped_already_running` instead of starting a second loop.
 *
 * Secondary fixes (git-worktree.ts): reconcile a branch already checked out in
 * another worktree before `worktree add`, and robust dir removal with retries
 * for ENOTEMPTY/EBUSY (Next.js node_modules symlink trees).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database, isSessionLoopRunning, runningSessionIds;
try {
  ({ OrchestratorLoop, isSessionLoopRunning, runningSessionIds } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(overrides = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, stuck_loop_seconds: 2700 },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git", "echo"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
    ...overrides,
  };
}

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  const audits = [];
  return {
    db,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    audits,
    close() { db.close(); },
  };
}

function insertSession(db, id, status = "executing", budget = 50) {
  // Unique thread key per session (UNIQUE(slack_channel, slack_thread)).
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, ?, 'C1', 'U1', 'u1', '', '', '', ?, ?, ?, ?, 0, 0)`,
  ).run(id, `agent:${id}`, status, Date.now(), Date.now(), budget);
}

const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
const plan = {
  repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/s",
  subTasks: [{ seq: 1, title: "a", intent: "a", filesLikelyTouched: [], successCriteria: ["a"], estimatedTokens: 100 }],
  reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
};

function makeLoop(state, deps = {}) {
  return new OrchestratorLoop({
    config: deps.config ?? config(),
    state,
    budget: new BudgetEnforcer(config().budgets, state),
    pat: new PatRouter(config().pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => plan,
    runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "s", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
    pushBranchAndOpenPr: async () => "https://x/pr/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    ...deps,
  });
}

test("beta38: re-entrant run() for a session already running is skipped, not double-driven",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S1", "executing");

    // Block the first run inside runLead so it stays in-flight while we make a
    // second (re-entrant) call -- exactly what recovery auto-resume does on a
    // plugin re-register mid-run.
    let release;
    const gate = new Promise((r) => { release = r; });
    let leadCalls = 0;
    const loop = makeLoop(state, {
      runLead: async () => { leadCalls++; await gate; return plan; },
    });

    const first = loop.run("S1", brief); // starts, parks in runLead

    // Give the first call a tick to register in runningSessions.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(isSessionLoopRunning("S1"), true, "S1 should be marked running");

    // Second, re-entrant call -> must be skipped WITHOUT invoking runLead again.
    const second = await loop.run("S1", brief);
    assert.equal(second.status, "skipped_already_running");
    assert.equal(second.sessionId, "S1");
    assert.equal(leadCalls, 1, "runLead must NOT have been called a second time");

    // Audit trail records the skip.
    assert.ok(state.audits.some((a) => a.event === "loop.run_skipped_already_running"));

    release();
    const firstOutcome = await first;
    assert.equal(firstOutcome.status, "shipped");
    // Guard cleared after completion.
    assert.equal(isSessionLoopRunning("S1"), false, "S1 should be cleared after run");
  });

test("beta38: guard clears even when the loop throws/fails, and allows a later re-run",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S2", "planning");
    const loop = makeLoop(state, {
      runLead: async () => { throw new Error("boom"); }, // -> loop.plan_failed -> failed outcome
    });
    const out = await loop.run("S2", brief);
    assert.equal(out.status, "failed");
    // Even on failure the finally{} must have cleared the guard.
    assert.equal(isSessionLoopRunning("S2"), false);
    assert.ok(!runningSessionIds().includes("S2"));
  });

test("beta38: independent sessions run concurrently (guard is per-session, not global)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "A", "executing");
    insertSession(state.db, "B", "executing");
    let release;
    const gate = new Promise((r) => { release = r; });
    const loop = makeLoop(state, { runLead: async () => { await gate; return plan; } });

    const a = loop.run("A", brief);
    const b = loop.run("B", brief);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(isSessionLoopRunning("A"), true);
    assert.equal(isSessionLoopRunning("B"), true, "B must NOT be blocked by A (guard is per-session)");
    release();
    const [ao, bo] = await Promise.all([a, b]);
    assert.equal(ao.status, "shipped");
    assert.equal(bo.status, "shipped");
  });

// ============================================================
// beta.40: stuck-loop reclaim -- the guard must not permanently block
// recovery of a zombie loop (Staging beta.39 smoke: 07e4c28a wedged 110 min
// after the guard fired, because the tracked loop was torn down on re-register
// but its runningSessions entry survived).
// ============================================================

// Both tests below get a REAL in-flight loop into `runningSessions` via a
// gated first run (the module-level set isn't exported, so we can't seed it
// directly -- and this is more faithful to production anyway). We then make
// that in-flight session's DB progress stale (or fresh) and fire a second,
// re-entrant run() to exercise the stale-vs-fresh branch of the guard.

test("beta40: a STALE guard entry (no progress past stuck_loop_seconds) is reclaimed, not skipped",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "Z1", "executing");

    // First run parks in runLead -> registers Z1 in runningSessions and stays
    // in-flight (the "zombie" we can't otherwise fabricate).
    let release;
    const gate = new Promise((r) => { release = r; });
    let firstLead = 0, secondLead = 0;
    const loop = makeLoop(state, {
      config: config({ loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, stuck_loop_seconds: 60 } }),
      runLead: async () => { firstLead++; await gate; return plan; },
    });
    const first = loop.run("Z1", brief);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(isSessionLoopRunning("Z1"), true, "first run registered the guard");

    // Make the in-flight session look stale (last progress 1h ago) -> the
    // second run() must treat it as a zombie and reclaim.
    const longAgo = Date.now() - 60 * 60 * 1000;
    state.db.prepare(`UPDATE sessions SET last_checkpoint_at = ?, updated_at = ? WHERE id = ?`).run(longAgo, longAgo, "Z1");

    const loop2 = makeLoop(state, {
      config: config({ loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, stuck_loop_seconds: 60 } }),
      runLead: async () => { secondLead++; return plan; },
    });
    const out = await loop2.run("Z1", brief);
    assert.equal(out.status, "shipped", "a stuck/zombie loop must be reclaimed and re-driven to completion");
    assert.equal(secondLead, 1, "the reclaimed run must actually execute (runLead called)");
    assert.ok(state.audits.some((a) => a.event === "loop.run_reclaimed_stuck"), "must audit loop.run_reclaimed_stuck");

    // Let the original (zombie) first run finish so we don't leak a pending
    // promise; its finally{} clears the guard.
    release();
    await first.catch(() => undefined);
  });

test("beta40: a FRESH guard entry (recent progress) is still skipped, not reclaimed",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "Z2", "executing");
    let release;
    const gate = new Promise((r) => { release = r; });
    let secondLead = 0;
    const loop = makeLoop(state, {
      config: config({ loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, stuck_loop_seconds: 2700 } }),
      runLead: async () => { await gate; return plan; },
    });
    const first = loop.run("Z2", brief);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(isSessionLoopRunning("Z2"), true);

    // Recent progress (2s ago) -> a legitimately-busy loop must NOT be reclaimed.
    const recent = Date.now() - 2000;
    state.db.prepare(`UPDATE sessions SET last_checkpoint_at = ?, updated_at = ? WHERE id = ?`).run(recent, recent, "Z2");

    const loop2 = makeLoop(state, {
      config: config({ loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, stuck_loop_seconds: 2700 } }),
      runLead: async () => { secondLead++; return plan; },
    });
    const out = await loop2.run("Z2", brief);
    assert.equal(out.status, "skipped_already_running", "a busy loop must still be skipped");
    assert.equal(secondLead, 0, "the busy loop must NOT be re-driven");
    assert.ok(!state.audits.some((a) => a.event === "loop.run_reclaimed_stuck"));

    release();
    await first.catch(() => undefined);
  });
