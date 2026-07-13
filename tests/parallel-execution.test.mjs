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
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  OrchestratorLoop = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(concurrency) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, subtask_concurrency: concurrency },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: false, prune_terminal_sessions_days: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: [], bash_denylist_tokens: [], path_denylist: [], allow_git_push: false, allow_network_commands: false },
  };
}

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return {
    db,
    audit(event, payload, sessionId) {
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    close() { db.close(); },
  };
}

function insertSession(db) {
  db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
    worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
    VALUES ('S1', 'T1', 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, 50, 0, 0)`)
    .run(Date.now(), Date.now());
}

test("parallel: concurrency=1 runs sequentially",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db);
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [
      { seq:1, title:"a", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
      { seq:2, title:"b", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
      { seq:3, title:"c", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
    ], reviewChecklist: [], riskLevel:"low", approxCostUsd: 0 };
    let concurrentMax = 0;
    let inFlight = 0;
    const loop = new OrchestratorLoop({
      config: config(1),
      state,
      budget: new BudgetEnforcer(config(1).budgets, state),
      pat: new PatRouter(config(1).pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => {
        inFlight++;
        concurrentMax = Math.max(concurrentMax, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { status:"completed", filesChanged:[], costUsd:0.01, tokensIn:1, tokensOut:1, reason:"end_turn" };
      },
      runAdversary: async () => ({ verdict:"pass", findings:[], summary:"", costUsd:0.01, tokensIn:1, tokensOut:1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt:false, abort:false, pause:false, budgetBump:false }),
    });
    const outcome = await loop.run("S1", { title:"t", motivation:"m", acceptanceCriteria:["c"], filesLikelyTouched:[], outOfScope:[], riskLevel:"low" });
    assert.equal(outcome.status, "shipped");
    assert.equal(concurrentMax, 1);
  });

test("parallel: concurrency=3 runs up to 3 in-flight",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db);
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [
      { seq:1, title:"a", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
      { seq:2, title:"b", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
      { seq:3, title:"c", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
      { seq:4, title:"d", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
    ], reviewChecklist: [], riskLevel:"low", approxCostUsd: 0 };
    let concurrentMax = 0;
    let inFlight = 0;
    const loop = new OrchestratorLoop({
      config: config(3),
      state,
      budget: new BudgetEnforcer(config(3).budgets, state),
      pat: new PatRouter(config(3).pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => {
        inFlight++;
        concurrentMax = Math.max(concurrentMax, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { status:"completed", filesChanged:[], costUsd:0.01, tokensIn:1, tokensOut:1, reason:"end_turn" };
      },
      runAdversary: async () => ({ verdict:"pass", findings:[], summary:"", costUsd:0.01, tokensIn:1, tokensOut:1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt:false, abort:false, pause:false, budgetBump:false }),
    });
    const outcome = await loop.run("S1", { title:"t", motivation:"m", acceptanceCriteria:["c"], filesLikelyTouched:[], outOfScope:[], riskLevel:"low" });
    assert.equal(outcome.status, "shipped");
    assert.equal(concurrentMax, 3);
  });

test("parallel: dependsOn respected -- dependent waits for parent",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db);
    const order = [];
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/wt", subTasks: [
      { seq:1, title:"a", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100 },
      { seq:2, title:"b", intent:"", filesLikelyTouched:[], successCriteria:[], estimatedTokens:100, dependsOn:[1] },
    ], reviewChecklist: [], riskLevel:"low", approxCostUsd: 0 };
    const loop = new OrchestratorLoop({
      config: config(4),
      state,
      budget: new BudgetEnforcer(config(4).budgets, state),
      pat: new PatRouter(config(4).pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async ({ subTask }) => {
        order.push(`start-${subTask.seq}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end-${subTask.seq}`);
        return { status:"completed", filesChanged:[], costUsd:0.01, tokensIn:1, tokensOut:1, reason:"end_turn" };
      },
      runAdversary: async () => ({ verdict:"pass", findings:[], summary:"", costUsd:0.01, tokensIn:1, tokensOut:1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt:false, abort:false, pause:false, budgetBump:false }),
    });
    await loop.run("S1", { title:"t", motivation:"m", acceptanceCriteria:["c"], filesLikelyTouched:[], outOfScope:[], riskLevel:"low" });
    // seq 1 must fully finish before seq 2 starts
    assert.equal(order.indexOf("end-1") < order.indexOf("start-2"), true);
  });
