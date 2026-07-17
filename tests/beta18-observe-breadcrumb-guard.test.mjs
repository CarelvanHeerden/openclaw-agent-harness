/**
 * beta.18: observe-breadcrumb emitter must gate on taskMode !== "mutate".
 *
 * Bug from Staging's beta.17 smoke #2: `loop.subtask_observe_completed`
 * fired for a mutate sub-task with `taskMode:"mutate"` in the payload.
 * The event name says "observe_completed" but the payload's own field
 * admits it's a mutation -- semantic incoherence.
 *
 * Root cause: the else-branch that handles the "no probes wired / empty
 * contract, verify path skipped" case fired the breadcrumb whenever
 * `contract.length === 0`, without guarding on taskMode. The INNER
 * (verify-eligible) branch had the guard correctly. beta.18 brings this
 * branch in line so the two paths agree.
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

const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };

/**
 * Reproduce the exact beta.17 smoke #2 s1 case: mutate sub-task, worker
 * completed, but the verify path is skipped (no `buildVerifyProbes` dep,
 * simulating the else-branch of the emit guard). In beta.17 this fired
 * `loop.subtask_observe_completed` with `taskMode:"mutate"`; in beta.18
 * it must NOT fire.
 */
test(
  "beta.18: mutate sub-task with no probes does NOT emit loop.subtask_observe_completed",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_MUT_NOPROBES");

    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s",
      subTasks: [
        {
          seq: 1,
          title: "Append line and commit",
          intent: "Append a dated line to docs/X.md and commit locally.",
          filesLikelyTouched: ["docs/X.md"],
          successCriteria: [],
          estimatedTokens: 100,
          taskMode: "mutate",
        },
      ],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    };

    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({
        status: "completed",
        filesChanged: ["docs/X.md"],
        commitSha: "abc123",
        sdkSessionId: "sdk-mut-1",
        costUsd: 0.05,
        tokensIn: 10,
        tokensOut: 10,
        reason: "end_turn",
      }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      // Deliberately NO buildVerifyProbes dep -- exercises the else-branch
      // of the observe-breadcrumb guard.
      // Deliberately NO worktreeHeadSha either.
      releaseWorktree: async () => ({ ok: true }),
    });

    const outcome = await loop.run("S_MUT_NOPROBES", brief);
    assert.equal(outcome.status, "shipped");

    const observeEvents = state.audits.filter((e) => e.event === "loop.subtask_observe_completed");
    assert.equal(
      observeEvents.length,
      0,
      `mutate sub-task must NOT emit observe breadcrumb; got ${observeEvents.length} with payload ${JSON.stringify(observeEvents[0]?.payload)}`,
    );
  },
);

test(
  "beta.18: observe sub-task with no probes still emits the breadcrumb",
  { skip: OrchestratorLoop === null },
  async () => {
    // Regression guard: the beta.18 tightening must not accidentally
    // suppress the legitimate observe case.
    const state = makeStore();
    insertSession(state.db, "S_OBS_NOPROBES");

    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s",
      subTasks: [
        {
          seq: 1,
          title: "Read-only observation",
          intent: "Verify state, do not mutate.",
          filesLikelyTouched: [],
          successCriteria: [],
          estimatedTokens: 100,
          taskMode: "observe",
        },
      ],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    };

    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], commitSha: null, sdkSessionId: "sdk-obs-1", costUsd: 0.03, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      releaseWorktree: async () => ({ ok: true }),
    });

    const outcome = await loop.run("S_OBS_NOPROBES", brief);
    assert.equal(outcome.status, "shipped");

    const observeEvents = state.audits.filter((e) => e.event === "loop.subtask_observe_completed");
    assert.equal(observeEvents.length, 1);
    assert.equal(observeEvents[0].payload.taskMode, "observe");
  },
);

test(
  "beta.18: unspecified taskMode with empty inferred contract still emits (defensive default)",
  { skip: OrchestratorLoop === null },
  async () => {
    // Pre-beta.15 plans without taskMode should still get the breadcrumb
    // when the contract inference lands on empty. Same behaviour as beta.16
    // (i.e. the "unspecified" case in the original beta.16 test suite).
    const state = makeStore();
    insertSession(state.db, "S_UNSPEC");

    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s",
      subTasks: [
        {
          seq: 1,
          title: "Think about the problem",
          intent: "No mutations, no observations. Just reasoning.",
          filesLikelyTouched: [],
          successCriteria: [],
          estimatedTokens: 100,
          // no taskMode -- pre-beta.15 plan shape
        },
      ],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    };

    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], commitSha: null, sdkSessionId: "sdk-1", costUsd: 0.03, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      releaseWorktree: async () => ({ ok: true }),
    });

    const outcome = await loop.run("S_UNSPEC", brief);
    assert.equal(outcome.status, "shipped");

    const observeEvents = state.audits.filter((e) => e.event === "loop.subtask_observe_completed");
    assert.equal(observeEvents.length, 1);
    assert.equal(observeEvents[0].payload.taskMode, "unspecified");
  },
);
