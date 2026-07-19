/**
 * beta.42: active stall-watchdog. beta.40's stuck-loop reclaim was PASSIVE --
 * it only re-evaluated staleness when something re-called run(). A loop that
 * wedged with no subsequent re-register was never re-checked (Staging beta.40
 * smoke: session 18a3f0a1 wedged ~5h30m; at skip time staleMs read 10 because
 * updated_at had just been written, and nothing ever re-called run()).
 *
 * Fix: when the guard SKIPS a re-entry, it arms a timer for
 * loop.stall_watchdog_seconds, then re-checks updated_at/last_checkpoint_at. If
 * no forward progress and the guard handle is still present, the stale handle
 * is force-deregistered (loop.wedge_detected) so recovery/next-run can reclaim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database, isSessionLoopRunning, clearStallWatchdog;
try {
  ({ OrchestratorLoop, isSessionLoopRunning, clearStallWatchdog } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function loopCfg(over = {}) {
  return { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, stuck_loop_seconds: 2700, teardown_drain_seconds: 3600, stall_watchdog_seconds: 90, ...over };
}
function config(over = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: loopCfg(over.loop),
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
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
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`).run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    audits,
    close() { db.close(); },
  };
}
function insertSession(db, id, status = "executing") {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, ?, 'C1', 'U1', 'u1', '', '', '', ?, ?, ?, 50, 0, 0)`,
  ).run(id, `agent:${id}`, status, Date.now(), Date.now());
}
const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/s", subTasks: [{ seq: 1, title: "a", intent: "a", filesLikelyTouched: [], successCriteria: ["a"], estimatedTokens: 100 }], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
function makeLoop(state, deps = {}) {
  return new OrchestratorLoop({
    config: deps.config ?? config(), state,
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

test("beta42: watchdog force-deregisters a STALLED skipped session and emits loop.wedge_detected", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  insertSession(state.db, "W1", "executing");
  // Park a real in-flight loop -> registers W1 in runningSessions.
  let release;
  const gate = new Promise((r) => { release = r; });
  const loop = makeLoop(state, { config: config({ loop: { stall_watchdog_seconds: 0.1 } }), runLead: async () => { await gate; return plan; } });
  const first = loop.run("W1", brief);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(isSessionLoopRunning("W1"), true, "first run registered the guard");

  // Freeze progress in the past so the watchdog sees no advance.
  const frozen = Date.now() - 5000;
  state.db.prepare(`UPDATE sessions SET last_checkpoint_at = ?, updated_at = ? WHERE id = ?`).run(frozen, frozen, "W1");

  // A re-entrant run() is skipped AND arms the 0.1s watchdog.
  const loop2 = makeLoop(state, { config: config({ loop: { stall_watchdog_seconds: 0.1 } }) });
  const out = await loop2.run("W1", brief);
  assert.equal(out.status, "skipped_already_running");

  // Wait for the watchdog (0.1s) to fire.
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(state.audits.some((a) => a.event === "loop.wedge_detected"), "watchdog must emit loop.wedge_detected");
  assert.equal(isSessionLoopRunning("W1"), false, "stale handle must be force-deregistered");

  release();
  await first.catch(() => undefined);
  clearStallWatchdog("W1");
});

test("beta42: watchdog does NOT fire when the skipped session keeps making progress", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  insertSession(state.db, "W2", "executing");
  let release;
  const gate = new Promise((r) => { release = r; });
  const loop = makeLoop(state, { config: config({ loop: { stall_watchdog_seconds: 0.15 } }), runLead: async () => { await gate; return plan; } });
  const first = loop.run("W2", brief);
  await new Promise((r) => setTimeout(r, 10));

  const loop2 = makeLoop(state, { config: config({ loop: { stall_watchdog_seconds: 0.15 } }) });
  const out = await loop2.run("W2", brief);
  assert.equal(out.status, "skipped_already_running");

  // Simulate forward progress AFTER the skip (updated_at advances).
  state.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(Date.now() + 10_000, "W2");

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!state.audits.some((a) => a.event === "loop.wedge_detected"), "a progressing loop must NOT be flagged as wedged");
  assert.equal(isSessionLoopRunning("W2"), true, "a healthy loop keeps its guard handle");

  release();
  await first.catch(() => undefined);
  clearStallWatchdog("W2");
});
