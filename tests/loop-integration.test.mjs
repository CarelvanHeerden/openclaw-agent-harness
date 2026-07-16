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
    safety: {
      worker_permission_mode: "acceptEdits",
      bash_whitelist: ["git","echo"],
      bash_denylist_tokens: ["rm"],
      path_denylist: [".env"],
    },
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

test("loop: happy path shipping on first cycle when adversary passes",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S1");

    const brief = { title: "Add hello", motivation: "smoke test", acceptanceCriteria: ["GET /hello"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r",
      branch: "harness/hello",
      worktreePath: "/tmp/wt/s1",
      subTasks: [{ seq: 1, title: "impl", intent: "write handler", filesLikelyTouched: ["src/hello.ts"], successCriteria: ["file exists"], estimatedTokens: 1000 }],
      reviewChecklist: ["route works"],
      riskLevel: "low",
      approxCostUsd: 0.5,
    };

    const calls = { worker: 0, adversary: 0, pr: 0 };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => { calls.worker++; return { status: "completed", filesChanged: ["src/hello.ts"], commitSha: "abc", sdkSessionId: "sdk-1", costUsd: 0.10, tokensIn: 100, tokensOut: 200, reason: "end_turn" }; },
      runAdversary: async () => { calls.adversary++; return { verdict: "pass", findings: [], summary: "ok", sdkSessionId: "sdk-2", costUsd: 0.05, tokensIn: 50, tokensOut: 50 }; },
      pushBranchAndOpenPr: async () => { calls.pr++; return "https://github.com/o/r/pull/1"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });

    const outcome = await loop.run("S1", brief);
    assert.equal(outcome.status, "shipped");
    assert.equal(outcome.prUrl, "https://github.com/o/r/pull/1");
    assert.equal(calls.worker, 1);
    assert.equal(calls.adversary, 1);
    assert.equal(calls.pr, 1);

    const row = state.db.prepare(`SELECT status, final_pr_url FROM sessions WHERE id = 'S1'`).get();
    assert.equal(row.status, "done");
    assert.equal(row.final_pr_url, "https://github.com/o/r/pull/1");
  });

test("loop: adversary revise once then pass",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S2");
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt", subTasks: [{ seq:1, title:"a", intent:"a", filesLikelyTouched:[], successCriteria:["a"], estimatedTokens:100 }], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    let advCallNo = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "s", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => {
        advCallNo++;
        return advCallNo === 1
          ? { verdict: "revise", findings: [{ dimension:"quality", severity:"low", title:"t", detail:"d" }], summary:"try again", costUsd: 0.02, tokensIn:1, tokensOut:1 }
          : { verdict: "pass", findings: [], summary:"ok", costUsd: 0.02, tokensIn:1, tokensOut:1 };
      },
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("S2", brief);
    assert.equal(outcome.status, "shipped");
    assert.equal(outcome.cycles, 2);
    assert.equal(advCallNo, 2);
  });

test("loop: user abort reaction short-circuits",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S3");
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [{ seq:1, title:"a", intent:"a", filesLikelyTouched:[], successCriteria:["a"], estimatedTokens:100 }], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => { throw new Error("worker should not run"); },
      runAdversary: async () => { throw new Error("adversary should not run"); },
      pushBranchAndOpenPr: async () => "unused",
      readReactions: async () => ({ shipIt: false, abort: true, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("S3", brief);
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "user_abort_reaction");
    const row = state.db.prepare(`SELECT status FROM sessions WHERE id = 'S3'`).get();
    assert.equal(row.status, "aborted");
  });

test("loop: budget exhaustion aborts unless budget_bump",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S4", 0.01);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [
      { seq:1, title:"a", intent:"a", filesLikelyTouched:[], successCriteria:["a"], estimatedTokens:100 },
      { seq:2, title:"b", intent:"b", filesLikelyTouched:[], successCriteria:["a"], estimatedTokens:100 },
    ], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    let workerCalls = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => { workerCalls++; return { status: "completed", filesChanged: [], costUsd: 0.10, tokensIn:1, tokensOut:1, reason: "end_turn" }; },
      runAdversary: async () => ({ verdict:"pass", findings:[], summary:"", costUsd:0.01, tokensIn:1, tokensOut:1 }),
      pushBranchAndOpenPr: async () => "unused",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("S4", brief);
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "budget_exhausted");
    // Should have run the first sub-task, then noticed budget over on the second check
    assert.equal(workerCalls, 1);
  });

test("loop: adversary block ends immediately as failed",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S5");
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [{ seq:1, title:"a", intent:"a", filesLikelyTouched:[], successCriteria:["a"], estimatedTokens:100 }], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.01, tokensIn:1, tokensOut:1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "block", findings: [{ dimension:"security", severity:"critical", title:"leaked pat", detail:"…" }], summary:"nope", costUsd: 0.02, tokensIn:1, tokensOut:1 }),
      pushBranchAndOpenPr: async () => { throw new Error("should not push"); },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("S5", brief);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "adversary_block");
  });

test("loop: threads the session requester into runLead/runWorker/pushBranchAndOpenPr (multi-user)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S_MU"); // requester = 'U1'
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/mu",
      subTasks: [{ seq: 1, title: "impl", intent: "x", filesLikelyTouched: ["a"], successCriteria: ["ok"], estimatedTokens: 100 }],
      reviewChecklist: ["ok"], riskLevel: "low", approxCostUsd: 0.1,
    };
    const seen = { lead: null, worker: null, push: null };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async (_brief, ctx) => { seen.lead = ctx?.requester; return plan; },
      runWorker: async (p) => { seen.worker = p.requester; return { status: "completed", filesChanged: ["a"], commitSha: "s", sdkSessionId: "w", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }; },
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", sdkSessionId: "a", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async (p) => { seen.push = p.requester; return "https://github.com/o/r/pull/9"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("S_MU", brief);
    assert.equal(outcome.status, "shipped");
    assert.equal(seen.lead, "U1", "runLead should receive the session requester");
    assert.equal(seen.worker, "U1", "runWorker should receive the session requester");
    assert.equal(seen.push, "U1", "pushBranchAndOpenPr should receive the session requester");
  });

// --- beta.7 fix #1: verification failure marks sub-task failed ---

test("loop: SDK 'completed' but verification-failed sub-task does NOT ship (beta.7 fix #1)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SV1", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [{ seq:1, title:"push", intent:"push", filesLikelyTouched:[], successCriteria:["pushed"], estimatedTokens:100, verify:[{kind:"branch_pushed"}] }], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    let adversaryCalled = false, prCalled = false;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      // Worker reports success from SDK but verification proved the push
      // never happened -> status forced to failed, wastedSpend flagged.
      runWorker: async () => ({ status: "failed", filesChanged: [], costUsd: 0.90, tokensIn: 1, tokensOut: 1, reason: "verification_failed: branch_pushed (HTTP 404)", verification: { ok: false, results: [{kind:"branch_pushed",passed:false,detail:"HTTP 404"}], summary: "branch_pushed (HTTP 404)" }, wastedSpend: true }),
      runAdversary: async () => { adversaryCalled = true; return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }; },
      pushBranchAndOpenPr: async () => { prCalled = true; return "https://x/pr/1"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("SV1", brief);
    assert.equal(outcome.status, "failed", "must not ship a confabulated success");
    assert.equal(prCalled, false, "must not open a PR when a sub-task failed verification");
    assert.equal(adversaryCalled, false, "cycle halts before review on sub-task failure");
    // Wasted spend was audited.
    const wasted = state.audits.find((a) => a.event === "loop.subtask_verification");
    assert.ok(wasted, "verification outcome should be audited");
    assert.equal(wasted.payload.ok, false);
  });

// --- beta.7 fix #2: projected-cost gating before a sub-task ---

test("loop: projected-cost gating aborts BEFORE starting an unaffordable sub-task (beta.7 fix #2)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SB1", 0.15); // tiny budget
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    // Two sub-tasks; first is cheap, second should be gated out before running.
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [
      { seq:1, title:"a", intent:"a", filesLikelyTouched:[], successCriteria:["a"], estimatedTokens:100 },
      { seq:2, title:"b", intent:"b", filesLikelyTouched:[], successCriteria:["b"], estimatedTokens:100, dependsOn:[1] },
    ], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    const workerSeqs = [];
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async ({ subTask }) => { workerSeqs.push(subTask.seq); return { status: "completed", filesChanged: ["a"], commitSha: "s", costUsd: 0.10, tokensIn: 1, tokensOut: 1, reason: "end_turn" }; },
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("SB1", brief);
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "budget_exhausted");
    // Sub-task 1 ran (0.10), sub-task 2 was projected 0.10 more -> 0.20 > 0.15 -> gated before running.
    assert.deepEqual(workerSeqs, [1], "second sub-task must be gated out before execution");
    const gate = state.audits.find((a) => a.event === "loop.budget_projection_abort");
    assert.ok(gate, "projection abort should be audited");
  });

// --- beta.7 fix #2: hard cap before review ---

test("loop: review is skipped + cycle aborts when remaining budget < review estimate (beta.7 fix #2)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SB2", 0.55);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [{ seq:1, title:"a", intent:"a", filesLikelyTouched:[], successCriteria:["a"], estimatedTokens:100 }], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    let adversaryCalled = false;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      // Sub-task costs 0.50; review estimate = max observed (0.50) with 0.5 floor.
      // remaining after sub-task = 0.05, < 0.50 -> review must not run.
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "s", costUsd: 0.50, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => { adversaryCalled = true; return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.50, tokensIn: 1, tokensOut: 1 }; },
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });
    const outcome = await loop.run("SB2", brief);
    assert.equal(outcome.status, "aborted");
    assert.equal(outcome.reason, "budget_exhausted");
    assert.equal(adversaryCalled, false, "adversary must not run when we cannot afford it");
    const gate = state.audits.find((a) => a.event === "loop.review_budget_abort");
    assert.ok(gate, "review budget abort should be audited");
  });
