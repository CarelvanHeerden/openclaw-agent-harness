// beta.63 (Part A) — session-level STALL WATCHDOG. Fixes the b60 class where a
// run got ~7 sub-tasks deep, hit a live env-wait-retry, then the loop STOPPED
// EMITTING with the session still `executing` and no terminal event, for ~2
// days, until a container restart cleared it. beta.42 bound the re-entrancy
// guard, beta.60 bound the whole runOne; this binds the SESSION as a whole.
//
// Asserts:
//   - simulated stall (dead executor) => self-recovery re-tick when a brief exists
//   - unrecoverable stall + commits on branch => graceful push+PR flagged
//     needs_human_review (never evaporate a near-done deliverable)
//   - unrecoverable stall + NO commits => clean fail with PRESERVED worktree
//   - stall_auto_terminal=false => detection+logging only, no terminal transition
//   - session NOT stalled (fresh last_progress_at) is left alone
//   - config + manifest + schema + migration wiring
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}

const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(overrides = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, session_stall_seconds: 1800, stall_auto_terminal: true, stall_graceful_pr: true },
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
    isOpen: () => true,
  };
}

const brief = { title: "t", motivation: "motivation long enough", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/s", subTasks: [], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

// Insert a session in an active phase with a stale last_progress_at.
function insertStalled(db, id, { status = "executing", staleMs, withBrief = true, withPlan = true } = {}) {
  const now = Date.now();
  const lastProgress = now - (staleMs ?? 3_600_000); // default 1h stale
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, last_progress_at, budget_usd, cost_usd, cycles_ran,
       crystallised_prompt, lead_plan_json)
     VALUES (?, ?, 'C1', 'U1', 'u1', 'o/r', 'harness/x', '/tmp/wt/s', ?, ?, ?, ?, 50, 1, 1, ?, ?)`,
  ).run(id, `thread-${id}`, status, now, lastProgress, lastProgress,
    withBrief ? JSON.stringify(brief) : null,
    withPlan ? JSON.stringify(plan) : null);
}

function greenProbes() {
  return {
    remoteBranchExists: async () => ({ exists: true, detail: "" }),
    prUrlPresent: async () => ({ present: true, url: "", detail: "" }),
    fileWrittenSince: async () => ({ written: true, detail: "" }),
    fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "" }),
    commitMadeSince: async () => ({ made: true, detail: "HEAD != base" }),
    fileCommittedSince: async () => ({ committed: true, detail: "" }),
  };
}
function noCommitProbes() {
  return { ...greenProbes(), commitMadeSince: async () => ({ made: false, detail: "no new commit" }) };
}

function makeLoop(state, over = {}) {
  return new OrchestratorLoop({
    config: config(over.config ?? {}),
    state,
    budget: new BudgetEnforcer(config().budgets, state),
    pat: new PatRouter(config().pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => plan,
    runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0, tokensIn: 0, tokensOut: 0, reason: "end_turn" }),
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "", costUsd: 0, tokensIn: 0, tokensOut: 0 }),
    pushBranchAndOpenPr: over.pushBranchAndOpenPr ?? (async () => "https://github.com/o/r/pull/77"),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    worktreeHeadSha: async () => "abc123",
    buildVerifyProbes: over.buildVerifyProbes ?? greenProbes,
    releaseWorktree: over.releaseWorktree ?? (async () => ({ ok: true, path: "/tmp/wt/s" })),
  });
}

// ---- unrecoverable stall + commits => graceful PR needs_human_review ----
test("beta63: stalled session with commits opens a graceful PR flagged needs_human_review",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertStalled(state.db, "G1", { withBrief: false }); // no brief => cannot re-tick => terminal path
    let prCalls = 0;
    const loop = makeLoop(state, {
      buildVerifyProbes: greenProbes, // commitMadeSince made:true
      pushBranchAndOpenPr: async () => { prCalls++; return "https://github.com/o/r/pull/77"; },
    });
    const handled = await loop.checkStalls();
    assert.equal(handled.length, 1);
    assert.equal(handled[0].action, "graceful_pr");
    assert.equal(prCalls, 1, "graceful PR opened exactly once");

    const row = state.db.prepare(`SELECT status, merge_recommendation, final_pr_url FROM sessions WHERE id='G1'`).get();
    assert.equal(row.status, "done");
    assert.equal(row.merge_recommendation, "needs_human_review");
    assert.equal(row.final_pr_url, "https://github.com/o/r/pull/77");

    // Loud stall event fired.
    assert.equal(state.audits.filter((e) => e.event === "loop.session_stalled").length, 1);
    const stalled = state.audits.find((e) => e.event === "loop.session_stalled");
    assert.equal(stalled.payload.phase, "executing");
    assert.ok(stalled.payload.msSinceProgress > 1800 * 1000);
    assert.equal(state.audits.filter((e) => e.event === "loop.shipped").length, 1);
    assert.equal(state.audits.find((e) => e.event === "loop.shipped").payload.viaStallRecovery, true);
    state.close();
  });

// ---- unrecoverable stall + NO commits => fail + PRESERVE worktree ----
test("beta63: stalled session with NO commits fails but PRESERVES the worktree (never wedges)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertStalled(state.db, "P1", { withBrief: false });
    let releaseCalls = 0, prCalls = 0;
    const loop = makeLoop(state, {
      buildVerifyProbes: noCommitProbes,
      pushBranchAndOpenPr: async () => { prCalls++; return "unused"; },
      releaseWorktree: async () => { releaseCalls++; return { ok: true, path: "/tmp/wt/s" }; },
    });
    const handled = await loop.checkStalls();
    assert.equal(handled[0].action, "failed_preserved");
    assert.equal(prCalls, 0, "no PR without commits");
    assert.equal(releaseCalls, 0, "worktree PRESERVED (not released) on the non-graceful stall");

    const row = state.db.prepare(`SELECT status FROM sessions WHERE id='P1'`).get();
    assert.equal(row.status, "failed");
    assert.equal(state.audits.filter((e) => e.event === "loop.failed_worktree_preserved").length, 1);
    const preserved = state.audits.find((e) => e.event === "loop.failed_worktree_preserved");
    assert.equal(preserved.payload.reason, "stalled_no_progress");
    state.close();
  });

// ---- stall_auto_terminal=false => detection+logging only ----
test("beta63: stall_auto_terminal=false detects+logs but does NOT terminal-transition",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertStalled(state.db, "D1", { withBrief: false });
    const loop = makeLoop(state, { config: { loop: { ...config().loop, stall_auto_terminal: false } } });
    const handled = await loop.checkStalls();
    assert.equal(handled[0].action, "detected_only");

    const row = state.db.prepare(`SELECT status FROM sessions WHERE id='D1'`).get();
    assert.equal(row.status, "executing", "status unchanged: no auto-terminal transition");
    assert.equal(state.audits.filter((e) => e.event === "loop.session_stalled").length, 1, "still DETECTS + LOGS");
    assert.equal(state.audits.filter((e) => e.event === "loop.session_stall_no_auto_terminal").length, 1);
    // no terminal transition audits
    assert.equal(state.audits.filter((e) => e.event === "loop.failed_worktree_preserved").length, 0);
    assert.equal(state.audits.filter((e) => e.event === "loop.shipped").length, 0);
    state.close();
  });

// ---- self-recovery re-tick when a brief exists (dead executor) ----
test("beta63: stalled session WITH a brief and dead executor is re-ticked (self-recovery)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertStalled(state.db, "R1", { withBrief: true });
    const loop = makeLoop(state);
    const handled = await loop.checkStalls();
    assert.equal(handled[0].action, "re_ticked");
    assert.equal(state.audits.filter((e) => e.event === "loop.session_stall_recovery").length, 1);
    const rec = state.audits.find((e) => e.event === "loop.session_stall_recovery");
    assert.equal(rec.payload.action, "re_tick_loop_runner");
    // Let the fire-and-forget re-tick settle so it doesn't leak into other tests.
    await new Promise((r) => setTimeout(r, 20));
    state.close();
  });

// ---- NOT stalled (fresh progress) is left alone ----
test("beta63: a session with fresh last_progress_at is NOT flagged as stalled",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertStalled(state.db, "F1", { staleMs: 10_000 }); // 10s < 1800s window
    const loop = makeLoop(state);
    const handled = await loop.checkStalls();
    assert.equal(handled.length, 0, "fresh session not touched");
    assert.equal(state.audits.filter((e) => e.event === "loop.session_stalled").length, 0);
    state.close();
  });

// ---- awaiting_clarification (resting pause) is NEVER reaped ----
test("beta63: awaiting_clarification is never treated as a stall",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertStalled(state.db, "AC1", { status: "awaiting_clarification", staleMs: 10_000_000 });
    const loop = makeLoop(state);
    const handled = await loop.checkStalls();
    assert.equal(handled.length, 0, "resting pause must not be reaped");
    state.close();
  });

// ---- config + interface source wiring ----
test("beta63: session_stall_seconds/stall_auto_terminal/stall_graceful_pr in config.ts (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /session_stall_seconds\?: number/);
  assert.match(src, /stall_auto_terminal\?: boolean/);
  assert.match(src, /stall_graceful_pr\?: boolean/);
  assert.match(src, /session_stall_seconds: 1800/);
  assert.match(src, /stall_auto_terminal: true/);
  assert.match(src, /stall_graceful_pr: true/);
});

test("beta63: stall keys declared in manifest configSchema (additionalProperties:false)", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  const loop = m.configSchema.properties.loop.properties;
  assert.ok(loop.session_stall_seconds, "session_stall_seconds declared");
  assert.equal(loop.session_stall_seconds.default, 1800);
  assert.equal(loop.stall_auto_terminal.type, "boolean");
  assert.equal(loop.stall_auto_terminal.default, true);
  assert.equal(loop.stall_graceful_pr.default, true);
});

// ---- schema + additive migration wiring ----
test("beta63: last_progress_at in schema.sql CREATE + additive migration list (source)", () => {
  assert.match(S("src/state/schema.sql"), /last_progress_at\s+INTEGER/);
  assert.match(S("src/state/store.ts"), /column: "last_progress_at",\s*type: "INTEGER"/);
});

test("beta63: setStatus writes last_progress_at on EVERY transition (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /SET status = \?, updated_at = \?, last_progress_at = \? WHERE id = \?/);
});

test("beta63: harness_progress surfaces stalled + msSinceProgress (source)", () => {
  const prog = S("src/orchestrator/progress.ts");
  assert.match(prog, /msSinceProgress: number \| null/);
  assert.match(prog, /stalled: boolean/);
  const reg = S("src/tools/registration.ts");
  assert.match(reg, /stalled: snapshot\.stalled/);
});

test("beta63: harness_resume force covers stalled executing/reviewing (source)", () => {
  const reg = S("src/tools/registration.ts");
  assert.match(reg, /beta\.63 late-stage stall/);
});
