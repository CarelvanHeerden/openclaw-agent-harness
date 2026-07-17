/**
 * beta.16 fix #2: `loop.subtask_observe_completed` audit breadcrumb.
 *
 * Context: beta.15 added `taskMode: observe|mutate|mixed`. Observe-mode
 * sub-tasks with `verify:[]` (or an empty inferred contract) correctly
 * produce no `loop.subtask_verification` event -- there's nothing to check.
 * Confirmed clean-pass on Staging (2026-07-17 session `b8b37f87`, PR #36):
 * sub-task 2 was silent in the audit stream from worker cost record to
 * adversary invocation (~2 min gap).
 *
 * This gap breaks the "audit stream tells the full story" invariant. beta.16
 * emits `loop.subtask_observe_completed` when an observe sub-task terminates
 * successfully, with a payload similar to `loop.subtask_verification` so
 * downstream consumers can treat the two events uniformly.
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

function config(overrides = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600 },
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

function insertSession(db, id, budget = 50) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, 'T1', 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, ?, 0, 0)`
  ).run(id, Date.now(), Date.now(), budget);
}

// Minimal probe set that satisfies the required beta.8 shape. All probes
// return values indicating success/existence -- individual tests aren't
// exercising verification failure, they're checking whether the observe
// breadcrumb fires.
const minimalProbes = () => ({
  remoteBranchExists: async () => ({ exists: true, detail: "" }),
  prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "" }),
  fileWrittenSince: async () => ({ written: true, detail: "" }),
  fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "" }),
  commitMadeSince: async () => ({ made: true, detail: "" }),
  fileCommittedSince: async () => ({ committed: true, detail: "" }),
});

test(
  "beta.16: observe sub-task with taskMode='observe' + verify:[] emits loop.subtask_observe_completed",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_OBS");

    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s_obs",
      subTasks: [
        {
          seq: 1,
          title: "Read-only observation",
          intent: "Verify state, do not mutate.",
          filesLikelyTouched: [],
          successCriteria: [],
          estimatedTokens: 100,
          taskMode: "observe",
          verify: [], // explicit empty
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
        filesChanged: [], // observe = no mutation
        commitSha: null,
        sdkSessionId: "sdk-obs-1",
        costUsd: 0.05,
        tokensIn: 10,
        tokensOut: 10,
        reason: "end_turn",
      }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "01ac598bb480deadbeef",
      buildVerifyProbes: minimalProbes,
    });

    const outcome = await loop.run("S_OBS", brief);
    assert.equal(outcome.status, "shipped");

    const observeEvents = state.audits.filter((e) => e.event === "loop.subtask_observe_completed");
    assert.equal(observeEvents.length, 1, `expected exactly one loop.subtask_observe_completed, got ${observeEvents.length}`);

    const payload = observeEvents[0].payload;
    assert.equal(payload.seq, 1);
    assert.equal(payload.taskMode, "observe");
    assert.equal(payload.verify_count, 0);
    assert.deepEqual(payload.worker_files_touched, []);
    assert.equal(payload.worker_commit_sha, null);
    assert.equal(payload.worker_end_reason, "end_turn");
    assert.equal(payload.cost_usd, 0.05);
  },
);

test(
  "beta.16: mutate sub-task does NOT emit loop.subtask_observe_completed",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_MUT");

    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s_mut",
      subTasks: [
        {
          seq: 1,
          title: "Write file",
          intent: "Write docs/X.md and commit.",
          filesLikelyTouched: ["docs/X.md"],
          successCriteria: [],
          estimatedTokens: 100,
          taskMode: "mutate",
          verify: [], // explicit empty verify -- but taskMode='mutate' means no breadcrumb
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
        commitSha: "aaabbb",
        sdkSessionId: "sdk-mut-1",
        costUsd: 0.05,
        tokensIn: 10,
        tokensOut: 10,
        reason: "end_turn",
      }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/2",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "01ac598bb480deadbeef",
      buildVerifyProbes: minimalProbes,
    });

    const outcome = await loop.run("S_MUT", brief);
    assert.equal(outcome.status, "shipped");

    const observeEvents = state.audits.filter((e) => e.event === "loop.subtask_observe_completed");
    assert.equal(observeEvents.length, 0, `mutate sub-task must not emit observe_completed`);
  },
);

test(
  "beta.16: unspecified taskMode with empty inferred contract emits observe_completed (defensive default)",
  { skip: OrchestratorLoop === null },
  async () => {
    // Backward-compat case: pre-beta.15 plans without taskMode where the
    // contract inference produces empty (e.g. no observable-side-effect
    // language). The breadcrumb still fires so the audit stream stays
    // self-describing.
    const state = makeStore();
    insertSession(state.db, "S_UNSPEC");

    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r",
      branch: "harness/x",
      worktreePath: "/tmp/wt/s_unspec",
      subTasks: [
        {
          seq: 1,
          title: "Think about the problem",
          intent: "No mutations, no observations. Just reasoning.",
          filesLikelyTouched: [],
          successCriteria: [],
          estimatedTokens: 100,
          // no taskMode, no verify -- inference will yield an empty contract
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
        filesChanged: [],
        commitSha: null,
        sdkSessionId: "sdk-unspec-1",
        costUsd: 0.03,
        tokensIn: 10,
        tokensOut: 10,
        reason: "end_turn",
      }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/3",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "01ac598bb480deadbeef",
      buildVerifyProbes: minimalProbes,
    });

    const outcome = await loop.run("S_UNSPEC", brief);
    assert.equal(outcome.status, "shipped");

    const observeEvents = state.audits.filter((e) => e.event === "loop.subtask_observe_completed");
    assert.equal(observeEvents.length, 1);
    assert.equal(observeEvents[0].payload.taskMode, "unspecified");
    assert.equal(observeEvents[0].payload.verify_count, 0);
  },
);
