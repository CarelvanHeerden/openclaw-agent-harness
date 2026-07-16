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

// beta.8 fix #1 (THE beta.6/beta.7 confabulation repro, done as Carel specced).
//
// This is the test that Phase 2 of the beta.7 smoke should have failed on.
// The worker returns `end_turn: completed` with a confabulated success (as
// the real SDK did). The push NEVER happened (mock remote returns 404). The
// HARNESS must independently catch this via its own probes, mark the
// sub-task failed_verification, emit loop.push_verify_failed, and halt the
// cycle -- WITHOUT the worker or lead ever declaring a `verify` contract.
test("loop: worker confabulates 'completed' push but branch is NOT on remote -> failed_verification (beta.8 fix #1)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SV1", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    // NOTE: no `verify` field on the sub-task. The harness INFERS the
    // contract from the language ("Push branch to origin"), exactly like a
    // real lead-produced plan.
    const plan = { repo: "o/r", branch: "harness/smoke", worktreePath: "/wt", subTasks: [
      { seq:1, title:"Push branch to origin + verify remote SHA", intent:"git push the branch to origin", filesLikelyTouched:[], successCriteria:["branch exists on origin"], estimatedTokens:100 },
    ], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    let adversaryCalled = false, prCalled = false, probedBranch = false;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      // Worker LIES: reports SDK success, no error.
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.12, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => { adversaryCalled = true; return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }; },
      pushBranchAndOpenPr: async () => { prCalled = true; return "https://x/pr/1"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "basesha",
      // Mock remote: branch does NOT exist (the beta.6/7 ground truth: 404).
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => { probedBranch = true; return { exists: false, detail: "github ref lookup HTTP 404" }; },
        prUrlPresent: async () => ({ present: false, detail: "github PR count 0" }),
        fileWrittenSince: async () => ({ written: false, detail: "n/a" }),
        commitMadeSince: async () => ({ made: false, detail: "n/a" }),
      }),
    });
    const outcome = await loop.run("SV1", brief);
    assert.equal(outcome.status, "failed", "must not ship a confabulated success");
    assert.equal(probedBranch, true, "harness must independently probe the remote");
    assert.equal(prCalled, false, "must not open a PR when a sub-task failed verification");
    assert.equal(adversaryCalled, false, "cycle halts before review on verification failure");
    // Audit trail: generic verification event + specific push failure event.
    const verif = state.audits.find((a) => a.event === "loop.subtask_verification");
    assert.ok(verif, "verification outcome should be audited");
    assert.equal(verif.payload.ok, false);
    assert.ok(state.audits.find((a) => a.event === "loop.push_verify_failed"), "loop.push_verify_failed must be emitted");
    // Sub-task row reflects failed_verification.
    const row = state.db.prepare(`SELECT status FROM sub_tasks WHERE session_id = 'SV1' AND seq = 1`).get();
    assert.equal(row.status, "failed_verification");
  });

// beta.8 fix #1: the mirror case -- when the push REALLY happened, the same
// inferred-contract path must PASS and proceed to ship. Guards against a
// verifier that just always fails.
test("loop: real push (branch on remote) passes harness verification and ships (beta.8 fix #1)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SV2", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = { repo: "o/r", branch: "harness/smoke", worktreePath: "/wt", subTasks: [
      { seq:1, title:"Push branch to origin", intent:"git push the branch", filesLikelyTouched:[], successCriteria:["branch exists on origin"], estimatedTokens:100 },
    ], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.10, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "basesha",
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => ({ exists: true, detail: "github ref lookup HTTP 200" }),
        prUrlPresent: async () => ({ present: true, url: "https://x/pr/1", detail: "github PR count 1" }),
        fileWrittenSince: async () => ({ written: true, detail: "ok" }),
        commitMadeSince: async () => ({ made: true, detail: "ok" }),
      }),
    });
    const outcome = await loop.run("SV2", brief);
    assert.equal(outcome.status, "shipped");
    const verif = state.audits.find((a) => a.event === "loop.subtask_verification");
    assert.ok(verif && verif.payload.ok === true, "verification should pass for a real push");
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

// ============================================================
// beta.9: REGRESSION TEST for the untracked-file bug
// ============================================================

// THE BETA.8 BUG: sub-task s1 writes a file (untracked, not committed).
// beta.8 `file_written` used git diff -> excluded untracked -> falsely FAILED.
// beta.9 `file_written` uses fs.stat -> includes untracked -> must PASS.
test("loop: write-only sub-task passes file_written with fileExistsOnDisk probe (beta.9 regression fix)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S_REG1", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    // s1: "write docs/SMOKE.md" — file is UNTRACKED (not committed). Beta.8 fails here.
    const plan = {
      repo: "o/r", branch: "harness/smoke", worktreePath: "/wt",
      subTasks: [
        { seq: 1, title: "Create branch + write docs/SMOKE.md", intent: "write the file", filesLikelyTouched: ["docs/SMOKE.md"], successCriteria: ["file exists"], estimatedTokens: 100 },
      ],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    let adversaryCalled = false, prCalled = false, fileCheckedOnDisk = false;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      // Worker writes the file but does NOT commit (untracked = the failing scenario).
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.05, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => { adversaryCalled = true; return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }; },
      pushBranchAndOpenPr: async () => { prCalled = true; return "https://x/pr/1"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "basesha",
      buildVerifyProbes: () => ({
        // beta.8 probes (required)
        remoteBranchExists: async () => ({ exists: false, detail: "not pushed yet" }),
        prUrlPresent: async () => ({ present: false, detail: "no PR yet" }),
        fileWrittenSince: async () => ({ written: false, detail: "not in git diff (file is untracked)" }), // Would fail on beta.8!
        commitMadeSince: async () => ({ made: false, detail: "no commit yet" }),
        // beta.9 new probe: fs.stat says file is there
        fileExistsOnDisk: async (path) => { fileCheckedOnDisk = true; return { exists: true, nonEmpty: true, detail: `${path} stat OK 1234 bytes` }; },
      }),
    });
    const outcome = await loop.run("S_REG1", brief);
    // On beta.9 this must SHIP (file_written passes via fs.stat).
    assert.equal(outcome.status, "shipped", `expected shipped, got: ${outcome.status} reason: ${outcome.reason ?? ""}`);
    assert.equal(fileCheckedOnDisk, true, "harness must check file on disk (not git diff)");
    assert.equal(adversaryCalled, true, "adversary must run after verification passes");
    assert.equal(prCalled, true, "PR must open after successful session");
    // Audit: verification passed.
    const verif = state.audits.find((a) => a.event === "loop.subtask_verification");
    assert.ok(verif, "verification must be audited");
    assert.equal(verif.payload.ok, true, "verification must pass on beta.9");
  });

// ============================================================
// beta.9: 5-sub-task integration test (write, commit, push, open PR, verify)
// ============================================================

test("loop: 5-sub-task plan (write, commit, push, open PR, verify) all pass with beta.9 probes",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S_5ST", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const sha = "cafebabe12345678901234";
    const plan = {
      repo: "o/r", branch: "harness/smoke", worktreePath: "/wt",
      subTasks: [
        { seq: 1, title: "Create branch + write docs/SMOKE.md", intent: "write the file", filesLikelyTouched: ["docs/SMOKE.md"], successCriteria: ["file exists"], estimatedTokens: 100 },
        { seq: 2, title: "Commit the single-file change", intent: "git add + commit", filesLikelyTouched: ["docs/SMOKE.md"], successCriteria: ["commit exists"], estimatedTokens: 100, dependsOn: [1] },
        { seq: 3, title: "Push branch to origin + verify remote SHA", intent: "git push origin", filesLikelyTouched: [], successCriteria: ["branch on remote"], estimatedTokens: 100, dependsOn: [2] },
        { seq: 4, title: "Open draft PR + capture URL", intent: "POST /pulls draft:true", filesLikelyTouched: [], successCriteria: ["PR created"], estimatedTokens: 100, dependsOn: [3] },
        { seq: 5, title: "End-to-end verification of remote side effects", intent: "verify remote side effects for docs/SMOKE.md", filesLikelyTouched: ["docs/SMOKE.md"], successCriteria: ["all verified"], estimatedTokens: 100, dependsOn: [4] },
      ],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const workerSeqs = [];
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async ({ subTask }) => { workerSeqs.push(subTask.seq); return { status: "completed", filesChanged: [], costUsd: 0.05, tokensIn: 1, tokensOut: 1, reason: "end_turn" }; },
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => sha,
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => ({ exists: true, detail: "HTTP 200" }),
        prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "ok" }),
        fileWrittenSince: async () => ({ written: true, detail: "in diff" }),
        commitMadeSince: async () => ({ made: true, detail: "HEAD changed" }),
        fileExistsOnDisk: async (path) => ({ exists: true, nonEmpty: true, detail: `${path} stat OK` }),
        fileCommittedSince: async (path) => ({ committed: true, detail: `${path} in git log` }),
        remoteBranchSha: async () => ({ sha, detail: `tip: ${sha}` }),
        remoteFileExists: async (path) => ({ exists: true, detail: `${path} HTTP 200` }),
        prForBranch: async () => ({ count: 1, prs: [{ number: 1, state: "open", draft: true, url: "https://github.com/o/r/pull/1" }], detail: "1 draft PR" }),
        localHeadSha: async () => ({ sha, detail: `local: ${sha}` }),
        prFiles: async () => ({ files: [{ filename: "docs/SMOKE.md" }], detail: "1 file" }),
      }),
    });
    const outcome = await loop.run("S_5ST", brief);
    assert.equal(outcome.status, "shipped", `expected shipped, got: ${outcome.status} ${outcome.reason ?? ""}`);
    assert.deepEqual(workerSeqs, [1, 2, 3, 4, 5], "all 5 sub-tasks must run in order");
    // All 5 verification events should have passed.
    const verifEvents = state.audits.filter((a) => a.event === "loop.subtask_verification");
    assert.equal(verifEvents.length, 5, "one verification per sub-task");
    for (const ev of verifEvents) {
      assert.equal(ev.payload.ok, true, `sub-task ${ev.payload.seq} verification should pass`);
    }
  });

// ============================================================
// beta.9: malicious-worker tests
// ============================================================

// Worker writes garbage content (empty file) and claims file_written success.
// Harness must catch it via fileExistsOnDisk returning nonEmpty=false.
test("loop: malicious worker writes empty file — harness catches via fileExistsOnDisk (beta.9)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S_MAL1", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r", branch: "harness/smoke", worktreePath: "/wt",
      subTasks: [
        { seq: 1, title: "Write docs/SMOKE.md with required content", intent: "write the spec file", filesLikelyTouched: ["docs/SMOKE.md"], successCriteria: ["file exists and is non-empty"], estimatedTokens: 100 },
      ],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      // Worker claims success but created an empty file (garbage content).
      runWorker: async () => ({ status: "completed", filesChanged: ["docs/SMOKE.md"], costUsd: 0.05, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "basesha",
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => ({ exists: false, detail: "not pushed" }),
        prUrlPresent: async () => ({ present: false, detail: "no PR" }),
        fileWrittenSince: async () => ({ written: false, detail: "no diff" }),
        commitMadeSince: async () => ({ made: false, detail: "no commit" }),
        // Empty file detected!
        fileExistsOnDisk: async () => ({ exists: true, nonEmpty: false, detail: "file exists but is empty (0 bytes)" }),
      }),
    });
    const outcome = await loop.run("S_MAL1", brief);
    assert.equal(outcome.status, "failed", "empty file must fail verification");
    // file_written_verify_failed must be emitted.
    const fwFail = state.audits.find((a) => a.event === "loop.file_written_verify_failed");
    assert.ok(fwFail, "loop.file_written_verify_failed must be emitted for empty file");
    // Old backward-compat event also fires.
    const oldFail = state.audits.find((a) => a.event === "loop.file_verify_failed");
    assert.ok(oldFail, "loop.file_verify_failed (old name) must also fire for backward compat");
    // Sub-task must be marked failed_verification.
    const row = state.db.prepare(`SELECT status FROM sub_tasks WHERE session_id = 'S_MAL1' AND seq = 1`).get();
    assert.equal(row.status, "failed_verification");
  });

// Worker claims file_written when the file was never written at all.
// Harness must catch this via fileExistsOnDisk returning exists=false.
test("loop: malicious worker claims file written but file absent — harness catches (beta.9)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S_MAL2", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r", branch: "harness/smoke", worktreePath: "/wt",
      subTasks: [
        { seq: 1, title: "Create docs/SMOKE.md", intent: "write the documentation file", filesLikelyTouched: ["docs/SMOKE.md"], successCriteria: ["file created"], estimatedTokens: 100 },
      ],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.05, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "basesha",
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => ({ exists: false, detail: "not pushed" }),
        prUrlPresent: async () => ({ present: false, detail: "no PR" }),
        fileWrittenSince: async () => ({ written: false, detail: "not in diff" }),
        commitMadeSince: async () => ({ made: false, detail: "no commit" }),
        // File never written!
        fileExistsOnDisk: async () => ({ exists: false, nonEmpty: false, detail: "file not found on disk" }),
      }),
    });
    const outcome = await loop.run("S_MAL2", brief);
    assert.equal(outcome.status, "failed", "missing file must fail verification");
    const fwFail = state.audits.find((a) => a.event === "loop.file_written_verify_failed");
    assert.ok(fwFail, "loop.file_written_verify_failed must be emitted");
    const row = state.db.prepare(`SELECT status FROM sub_tasks WHERE session_id = 'S_MAL2' AND seq = 1`).get();
    assert.equal(row.status, "failed_verification");
  });

// ============================================================
// beta.9: new audit event names fire alongside old ones
// ============================================================

test("loop: remote_branch_verify_failed fires alongside push_verify_failed for branch_pushed failures",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S_EVT1", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r", branch: "harness/smoke", worktreePath: "/wt",
      subTasks: [
        { seq: 1, title: "Push branch to origin", intent: "git push", filesLikelyTouched: [], successCriteria: ["branch on remote"], estimatedTokens: 100 },
      ],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.05, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "basesha",
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => ({ exists: false, detail: "HTTP 404" }),
        prUrlPresent: async () => ({ present: false, detail: "no PR" }),
        fileWrittenSince: async () => ({ written: false, detail: "n/a" }),
        commitMadeSince: async () => ({ made: false, detail: "n/a" }),
      }),
    });
    const outcome = await loop.run("S_EVT1", brief);
    assert.equal(outcome.status, "failed");
    // Both old and new audit events must fire.
    assert.ok(state.audits.find((a) => a.event === "loop.push_verify_failed"), "old loop.push_verify_failed must fire");
    assert.ok(state.audits.find((a) => a.event === "loop.remote_branch_verify_failed"), "new loop.remote_branch_verify_failed must fire");
  });

test("loop: file_written_verify_failed fires alongside file_verify_failed (backward compat + new name)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "S_EVT2", 50);
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r", branch: "harness/smoke", worktreePath: "/wt",
      subTasks: [
        { seq: 1, title: "Write docs/SMOKE.md", intent: "create the file", filesLikelyTouched: ["docs/SMOKE.md"], successCriteria: ["file exists"], estimatedTokens: 100 },
      ],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.05, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "basesha",
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => ({ exists: false, detail: "n/a" }),
        prUrlPresent: async () => ({ present: false, detail: "n/a" }),
        fileWrittenSince: async () => ({ written: false, detail: "not in diff" }),
        commitMadeSince: async () => ({ made: false, detail: "n/a" }),
        fileExistsOnDisk: async () => ({ exists: false, nonEmpty: false, detail: "file not found" }),
      }),
    });
    const outcome = await loop.run("S_EVT2", brief);
    assert.equal(outcome.status, "failed");
    assert.ok(state.audits.find((a) => a.event === "loop.file_verify_failed"), "old loop.file_verify_failed must fire (backward compat)");
    assert.ok(state.audits.find((a) => a.event === "loop.file_written_verify_failed"), "new loop.file_written_verify_failed must fire");
  });

