/**
 * beta.19: `sub_tasks.started_at` column is now actually populated.
 *
 * The column existed in the schema since inception but nothing wrote to it,
 * so every row had `started_at IS NULL`. Staging flagged this as a
 * low-severity finding in the beta.18 smoke report.
 *
 * Fix: populate `started_at` at the same INSERT that sets `status='running'`,
 * using the same timestamp as `created_at`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config() {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600 },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git", "echo"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
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
  };
}

function insertSession(db, id, budget = 50) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, ?, 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, ?, 0, 0)`
  ).run(id, `T-${id}`, Date.now(), Date.now(), budget);
}

test(
  "beta.19: sub_tasks.started_at is populated on sub-task INSERT",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_START");

    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s",
      subTasks: [
        { seq: 1, title: "t1", intent: "do a thing", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 100 },
      ],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    };

    const tBeforeRun = Date.now();
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], commitSha: null, sdkSessionId: "sdk-1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      releaseWorktree: async () => ({ ok: true }),
    });

    const outcome = await loop.run("S_START", brief);
    const tAfterRun = Date.now();
    assert.equal(outcome.status, "shipped");

    const row = state.db.prepare(`SELECT started_at, created_at, completed_at FROM sub_tasks WHERE session_id = 'S_START'`).get();
    assert.ok(row, "sub_task row must exist");
    assert.ok(row.started_at !== null && row.started_at !== undefined, `started_at must not be NULL (got ${row.started_at})`);
    // Sanity: started_at is within the test's own execution window.
    assert.ok(row.started_at >= tBeforeRun && row.started_at <= tAfterRun,
      `started_at ${row.started_at} must be within [${tBeforeRun}, ${tAfterRun}]`);
    // started_at should equal or precede completed_at (basic ordering invariant).
    if (row.completed_at !== null) {
      assert.ok(row.started_at <= row.completed_at,
        `started_at ${row.started_at} must be <= completed_at ${row.completed_at}`);
    }
  },
);

test(
  "beta.19: multiple sub-tasks each get their own started_at",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_MULTI");

    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s",
      subTasks: [
        { seq: 1, title: "s1", intent: "first", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 100 },
        { seq: 2, title: "s2", intent: "second", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 100, dependsOn: [1] },
      ],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    };

    let workerCount = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => {
        workerCount++;
        // Small yield so successive sub-tasks get distinct timestamps.
        await new Promise((r) => setTimeout(r, 2));
        return { status: "completed", filesChanged: [], commitSha: null, sdkSessionId: `sdk-${workerCount}`, costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
      },
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      releaseWorktree: async () => ({ ok: true }),
    });

    const outcome = await loop.run("S_MULTI", brief);
    assert.equal(outcome.status, "shipped");

    const rows = state.db.prepare(`SELECT seq, started_at FROM sub_tasks WHERE session_id = 'S_MULTI' ORDER BY seq`).all();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.started_at !== null, `sub-task ${r.seq} started_at must not be NULL`);
    }
    // s1 started at or before s2 (topo-sorted, sequential concurrency=1 by default).
    assert.ok(rows[0].started_at <= rows[1].started_at,
      `s1 started_at ${rows[0].started_at} must be <= s2 started_at ${rows[1].started_at}`);
  },
);
