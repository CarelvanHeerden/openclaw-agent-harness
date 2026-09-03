// beta.94 — kill the idle-prone LLM "final verification of scope boundaries"
// sub-task (the b93 seq-12 stall) and add a narrow idle-no-work abort channel.
//
// Feature 1 (deterministic final scope check):
//   1a: the lead planner sometimes emits a TRAILING pure-observe
//       ("taskMode: observe", read-only, no mutate verify) "final verification
//       of scope boundaries" sub-task. It has nothing to write, so a worker can
//       go idle on it indefinitely (b93 seq-12) while adding ZERO signal. Elide
//       it from the worker plan and audit loop.final_verify_subtask_elided.
//   1b: after the last mutate sub-task, a HARNESS-SIDE deterministic scope check
//       diffs the files committed in <base>..HEAD against the UNION of every
//       sub-task's declared file scope. A committed file OUTSIDE the union folds
//       into the review as a fit/medium ReviewFinding (never a hard fail).
//
// Feature 2 (loop.worker_idle_no_work audit event + narrow abort):
//   Track CONSECUTIVE worker_stream_slow ticks with tokensOut===0. When
//   (>= threshold consecutive) AND (tokensOut===0) AND (elapsed > 15min floor)
//   AND (no worktree writes) -> emit loop.worker_idle_no_work (LOG-ONLY by
//   default). With loop.worker_idle_abort_enabled=true it ALSO aborts the
//   sub-task via the existing WorkerTimeoutError timeout-class path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// Unit: F1a elision + F1b declared-scope union (pure, dist)
// ---------------------------------------------------------------------------
const {
  isElidableFinalScopeSubTask,
  elideFinalScopeSubTask,
} = await import("../dist/orchestrator/lead.js");
const { collectDeclaredScopeFiles } = await import("../dist/orchestrator/loop.js");

const observeScopeSubTask = (seq, extra = {}) => ({
  seq,
  title: "Final verification of scope boundaries",
  intent: "verify nothing outside the declared scope was touched",
  filesLikelyTouched: [],
  successCriteria: ["scope boundaries confirmed"],
  estimatedTokens: 50,
  taskMode: "observe",
  ...extra,
});

const mutateSubTask = (seq, files) => ({
  seq,
  title: `implement ${seq}`,
  intent: "write the change",
  filesLikelyTouched: files,
  successCriteria: ["file written"],
  estimatedTokens: 100,
  taskMode: "mutate",
  verify: files.map((path) => ({ kind: "file_committed", path })),
});

test("beta94 F1a: a trailing pure-observe scope-verify sub-task is elidable", () => {
  assert.equal(isElidableFinalScopeSubTask(observeScopeSubTask(3)), true);
  // "final verification"/"boundaries"/"nothing outside" all trip the heuristic.
  assert.equal(isElidableFinalScopeSubTask(observeScopeSubTask(3, { title: "Confirm scope boundaries", intent: "read-only" })), true);
});

test("beta94 F1a: a mutate sub-task or a non-scope observe sub-task is NOT elidable", () => {
  // Mutate mode never elides.
  assert.equal(isElidableFinalScopeSubTask(mutateSubTask(3, ["a.ts"])), false);
  // Observe but not scope-related (override title/intent AND successCriteria).
  assert.equal(isElidableFinalScopeSubTask(observeScopeSubTask(3, { title: "run the tests", intent: "execute the suite", successCriteria: ["suite green"] })), false);
  // Observe + scope wording BUT carries a mutate verify kind => real work => keep.
  assert.equal(
    isElidableFinalScopeSubTask(observeScopeSubTask(3, { verify: [{ kind: "file_committed", path: "x.ts" }] })),
    false,
  );
});

test("beta94 F1a: elideFinalScopeSubTask drops only the trailing scope-observe sub-task", () => {
  const plan = { subTasks: [mutateSubTask(1, ["a.ts"]), mutateSubTask(2, ["b.ts"]), observeScopeSubTask(3)] };
  const elided = elideFinalScopeSubTask(plan);
  assert.ok(elided, "trailing scope-observe sub-task must be elided");
  assert.equal(elided.seq, 3);
  assert.equal(plan.subTasks.length, 2, "the two mutate sub-tasks remain");
  assert.deepEqual(plan.subTasks.map((s) => s.seq), [1, 2]);
});

test("beta94 F1a: elision is skipped when the scope sub-task is NOT last, is the only one, or is depended on", () => {
  // Not last.
  const midScope = { subTasks: [observeScopeSubTask(1), mutateSubTask(2, ["a.ts"])] };
  assert.equal(elideFinalScopeSubTask(midScope), undefined);
  assert.equal(midScope.subTasks.length, 2);

  // Only sub-task -> never elide (would empty the plan).
  const only = { subTasks: [observeScopeSubTask(1)] };
  assert.equal(elideFinalScopeSubTask(only), undefined);
  assert.equal(only.subTasks.length, 1);

  // Depended on by another sub-task -> keep (topo integrity).
  const depended = { subTasks: [mutateSubTask(1, ["a.ts"]), { ...observeScopeSubTask(2), }, { ...mutateSubTask(3, ["c.ts"]), dependsOn: [2] }] };
  // reorder so scope-observe is last but still depended on
  const dependedLast = { subTasks: [mutateSubTask(1, ["a.ts"]), { ...mutateSubTask(3, ["c.ts"]), dependsOn: [2] }, observeScopeSubTask(2)] };
  assert.equal(elideFinalScopeSubTask(dependedLast), undefined, "must not elide a depended-on sub-task");
  void depended;
});

test("beta94 F1b: collectDeclaredScopeFiles unions filesLikelyTouched + verify paths", () => {
  const plan = {
    subTasks: [
      mutateSubTask(1, ["src/a.ts"]),
      { ...mutateSubTask(2, ["src/b.ts"]), verify: [{ kind: "file_committed", path: "src/b.ts" }, { kind: "file_written", path: "src/extra.ts" }] },
    ],
  };
  const declared = collectDeclaredScopeFiles(plan).sort();
  assert.deepEqual(declared, ["src/a.ts", "src/b.ts", "src/extra.ts"]);
});

// ---------------------------------------------------------------------------
// Loop integration harness (mirrors beta90/beta93 test doubles)
// ---------------------------------------------------------------------------
let OrchestratorLoop, WorkerTimeoutError, BudgetEnforcer, PatRouter, Database;
try {
  ({ OrchestratorLoop, WorkerTimeoutError } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}

const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(loopOverrides = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: {
      max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60,
      adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, graceful_pr_on_review_crash: true,
      deterministic_final_scope_check: true,
      worker_idle_abort_enabled: false, worker_idle_consecutive_slow: 3, worker_idle_min_elapsed_seconds: 900,
      ...loopOverrides,
    },
    verify: { run_repo_check_scripts: false },
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
    close() { db.close(); },
  };
}

function insertSession(db, id, budget = 50) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, 'T1', 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, ?, 0, 0)`,
  ).run(id, Date.now(), Date.now(), budget);
}

const greenProbes = () => ({
  remoteBranchExists: async () => ({ exists: true, detail: "" }),
  prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "" }),
  fileWrittenSince: async () => ({ written: true, detail: "" }),
  fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "" }),
  commitMadeSince: async () => ({ made: true, detail: "" }),
  fileCommittedSince: async () => ({ committed: true, detail: "" }),
});

const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };

// ---------------------------------------------------------------------------
// F1a: elision happens through the loop, audited, persisted
// ---------------------------------------------------------------------------
test("beta94 F1a (loop): trailing scope-observe sub-task is elided at plan_ready + audited",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "E1");
    const planWithScope = {
      repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/E1",
      subTasks: [mutateSubTask(1, ["src/a.ts"]), observeScopeSubTask(2)],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => JSON.parse(JSON.stringify(planWithScope)),
      runWorker: async () => ({ status: "completed", filesChanged: ["src/a.ts"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "approve", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/94",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => ({ ok: true, path: "/tmp/wt/E1" }),
      worktreeHeadSha: async () => "basesha",
      worktreeMergeBase: async () => "basesha",
      // No committed-files probe => the F1b scope check is a no-op here.
    });

    await loop.run("E1", brief);
    const elided = state.audits.filter((e) => e.event === "loop.final_verify_subtask_elided");
    assert.equal(elided.length, 1, "the trailing scope-observe sub-task is elided once");
    assert.equal(elided[0].payload.seq, 2);
    // The persisted plan reflects the elision (only the mutate sub-task remains).
    const row = state.db.prepare(`SELECT lead_plan_json FROM sessions WHERE id='E1'`).get();
    const persisted = JSON.parse(row.lead_plan_json);
    assert.equal(persisted.subTasks.length, 1);
    assert.equal(persisted.subTasks[0].seq, 1);
    state.close();
  });

test("beta94 F1a (loop): elision is SKIPPED when deterministic_final_scope_check=false",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "E2");
    const planWithScope = {
      repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/E2",
      subTasks: [mutateSubTask(1, ["src/a.ts"]), observeScopeSubTask(2)],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config({ deterministic_final_scope_check: false }),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => JSON.parse(JSON.stringify(planWithScope)),
      runWorker: async () => ({ status: "completed", filesChanged: ["src/a.ts"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "approve", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/94",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => ({ ok: true, path: "/tmp/wt/E2" }),
      worktreeHeadSha: async () => "basesha",
      worktreeMergeBase: async () => "basesha",
    });
    await loop.run("E2", brief);
    assert.equal(state.audits.filter((e) => e.event === "loop.final_verify_subtask_elided").length, 0);
    state.close();
  });

// ---------------------------------------------------------------------------
// F1b: deterministic scope check flags an out-of-scope commit (private method)
// ---------------------------------------------------------------------------
test("beta94 F1b: runFinalScopeCheck flags a committed file outside the declared union",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SC1");
    // Persist a plan_base_sha so the scope check has a base to diff against.
    state.db.prepare(`UPDATE sessions SET plan_base_sha='base0' WHERE id='SC1'`).run();
    const plan = {
      repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/SC1",
      subTasks: [mutateSubTask(1, ["src/a.ts"])],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed" }),
      runAdversary: async () => ({ verdict: "approve", findings: [], summary: "ok", costUsd: 0 }),
      pushBranchAndOpenPr: async () => "u",
      readReactions: async () => ({}),
      // committed files include an UNDECLARED path.
      worktreeCommittedFiles: async () => ["src/a.ts", "src/secret-sneaky.ts"],
    });
    const findings = await loop.runFinalScopeCheck("SC1", plan, 1);
    assert.equal(findings.length, 1, "one out-of-scope finding");
    assert.equal(findings[0].dimension, "fit");
    assert.equal(findings[0].severity, "medium");
    assert.match(findings[0].title, /out-of-scope/i);
    assert.match(findings[0].detail, /src\/secret-sneaky\.ts/);
    // Audit trail.
    assert.equal(state.audits.filter((e) => e.event === "loop.final_scope_check_ran").length, 1);
    const oos = state.audits.filter((e) => e.event === "loop.final_scope_check_out_of_scope");
    assert.equal(oos.length, 1);
    assert.deepEqual(oos[0].payload.outOfScope, ["src/secret-sneaky.ts"]);
    state.close();
  });

test("beta94 F1b: all-in-scope commits produce NO finding (and no out-of-scope audit)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SC2");
    state.db.prepare(`UPDATE sessions SET plan_base_sha='base0' WHERE id='SC2'`).run();
    const plan = {
      repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/SC2",
      subTasks: [mutateSubTask(1, ["src/a.ts"]), mutateSubTask(2, ["src/b.ts"])],
      reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
    };
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan, runWorker: async () => ({}), runAdversary: async () => ({}),
      pushBranchAndOpenPr: async () => "u", readReactions: async () => ({}),
      worktreeCommittedFiles: async () => ["src/a.ts", "src/b.ts"],
    });
    const findings = await loop.runFinalScopeCheck("SC2", plan, 1);
    assert.equal(findings.length, 0);
    assert.equal(state.audits.filter((e) => e.event === "loop.final_scope_check_ran").length, 1);
    assert.equal(state.audits.filter((e) => e.event === "loop.final_scope_check_out_of_scope").length, 0);
    state.close();
  });

test("beta94 F1b: scope check is a no-op when disabled or no base sha",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SC3"); // no plan_base_sha set
    const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/SC3", subTasks: [mutateSubTask(1, ["src/a.ts"])], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    const base = {
      config: config(), state,
      budget: new BudgetEnforcer(config().budgets, state), pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan, runWorker: async () => ({}), runAdversary: async () => ({}),
      pushBranchAndOpenPr: async () => "u", readReactions: async () => ({}),
      worktreeCommittedFiles: async () => ["src/x.ts"],
    };
    // No base sha => skip (no finding), even though src/x.ts is undeclared.
    const loop1 = new OrchestratorLoop(base);
    assert.deepEqual(await loop1.runFinalScopeCheck("SC3", plan, 1), []);
    // Disabled => skip even with a base sha.
    state.db.prepare(`UPDATE sessions SET plan_base_sha='base0' WHERE id='SC3'`).run();
    const loop2 = new OrchestratorLoop({ ...base, config: config({ deterministic_final_scope_check: false }) });
    assert.deepEqual(await loop2.runFinalScopeCheck("SC3", plan, 1), []);
    state.close();
  });

// ---------------------------------------------------------------------------
// F2: idle-no-work conjunction via the stream-slow callback (private method)
// ---------------------------------------------------------------------------

// Drive N ticks through the callback returned by makeStreamSlowCallback. The
// per-tick shape matches worker's onStreamSlow contract.
async function driveTicks(loop, cb, { count, tokensOut, elapsedMs }) {
  for (let i = 0; i < count; i++) {
    cb({ idleMs: 90_000, elapsedMs, tokensOut, label: "worker" });
  }
  // Allow the fire-and-forget async no-writes probe to settle.
  await new Promise((r) => setTimeout(r, 20));
}

function idleLoop(state, extraDeps = {}, loopOverrides = {}) {
  return new OrchestratorLoop({
    config: config(loopOverrides), state,
    budget: new BudgetEnforcer(config().budgets, state), pat: new PatRouter(config().pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => ({}), runWorker: async () => ({}), runAdversary: async () => ({}),
    pushBranchAndOpenPr: async () => "u", readReactions: async () => ({}),
    // Default: no writes (empty committed + empty diff-stat).
    worktreeCommittedFiles: async () => [],
    gitDiffStat: async () => "",
    ...extraDeps,
  });
}

const idlePlan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/I", subTasks: [], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

test("beta94 F2: 3 consecutive tokensOut=0 slow ticks past 15min with no writes emits loop.worker_idle_no_work (log-only default)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "IDLE1");
    let aborted = false;
    const loop = idleLoop(state);
    const cb = loop.makeStreamSlowCallback("IDLE1", 12, 1, {
      plan: idlePlan, baseSha: "b0", onIdleAbort: () => { aborted = true; },
    });
    await driveTicks(loop, cb, { count: 3, tokensOut: 0, elapsedMs: 16 * 60 * 1000 });

    const idle = state.audits.filter((e) => e.event === "loop.worker_idle_no_work");
    assert.equal(idle.length, 1, "the conjunction emits the event once");
    assert.equal(idle[0].payload.seq, 12);
    assert.equal(idle[0].payload.consecutiveSlow, 3);
    assert.equal(idle[0].payload.abortEnabled, false);
    // LOG-ONLY: no abort by default.
    assert.equal(aborted, false, "default flag off => no abort");
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_idle_abort").length, 0);
    state.close();
  });

test("beta94 F2: with worker_idle_abort_enabled=true the conjunction ALSO aborts (timeout-class)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "IDLE2");
    let abortErr = null;
    const loop = idleLoop(state, {}, { worker_idle_abort_enabled: true });
    const cb = loop.makeStreamSlowCallback("IDLE2", 12, 1, {
      plan: idlePlan, baseSha: "b0", onIdleAbort: () => { abortErr = new WorkerTimeoutError(60); },
    });
    await driveTicks(loop, cb, { count: 3, tokensOut: 0, elapsedMs: 16 * 60 * 1000 });

    assert.equal(state.audits.filter((e) => e.event === "loop.worker_idle_no_work").length, 1);
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_idle_abort").length, 1, "abort audited when flag on");
    assert.ok(abortErr instanceof WorkerTimeoutError, "abort routes through the WorkerTimeoutError timeout-class path");
    state.close();
  });

test("beta94 F2: NO event when tokens are flowing, under the elapsed floor, or writes exist",
  { skip: OrchestratorLoop === null }, async () => {
    // (a) tokens flowing (tokensOut>0) => consecutive counter resets => no event.
    let state = makeStore();
    insertSession(state.db, "IDLE3");
    let loop = idleLoop(state);
    let cb = loop.makeStreamSlowCallback("IDLE3", 5, 1, { plan: idlePlan, baseSha: "b0" });
    await driveTicks(loop, cb, { count: 5, tokensOut: 7, elapsedMs: 16 * 60 * 1000 });
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_idle_no_work").length, 0, "tokens flowing => no idle event");
    state.close();

    // (b) under the 15min elapsed floor => no event.
    state = makeStore();
    insertSession(state.db, "IDLE4");
    loop = idleLoop(state);
    cb = loop.makeStreamSlowCallback("IDLE4", 5, 1, { plan: idlePlan, baseSha: "b0" });
    await driveTicks(loop, cb, { count: 5, tokensOut: 0, elapsedMs: 5 * 60 * 1000 });
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_idle_no_work").length, 0, "under floor => no idle event");
    state.close();

    // (c) worktree WROTE files during the sub-task => not idle => no event.
    state = makeStore();
    insertSession(state.db, "IDLE5");
    loop = idleLoop(state, { worktreeCommittedFiles: async () => ["src/written.ts"] });
    cb = loop.makeStreamSlowCallback("IDLE5", 5, 1, { plan: idlePlan, baseSha: "b0" });
    await driveTicks(loop, cb, { count: 3, tokensOut: 0, elapsedMs: 16 * 60 * 1000 });
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_idle_no_work").length, 0, "writes exist => not idle => no event");
    state.close();
  });

test("beta94 F2: without the idle wiring the callback stays pure beta.90 observability (stream_slow only)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "OBS1");
    const loop = idleLoop(state);
    // No idle arg => beta.90 behaviour: emits worker_stream_slow, never idle_no_work.
    const cb = loop.makeStreamSlowCallback("OBS1", 5, 1);
    await driveTicks(loop, cb, { count: 5, tokensOut: 0, elapsedMs: 16 * 60 * 1000 });
    assert.ok(state.audits.filter((e) => e.event === "loop.worker_stream_slow").length >= 5, "stream_slow still fires");
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_idle_no_work").length, 0, "no idle detection without the wiring");
    state.close();
  });

// ---------------------------------------------------------------------------
// Config defaults + clamps
// ---------------------------------------------------------------------------
let parseHarnessConfig;
try {
  ({ parseHarnessConfig } = await import("../dist/config.js"));
} catch {
  parseHarnessConfig = null;
}
const minimalOk = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["example-org/*"], default_base_branch: "main" },
};

test("beta94: config defaults — final scope check ON, idle abort OFF, thresholds 3/900", { skip: parseHarnessConfig === null }, () => {
  const cfg = parseHarnessConfig(minimalOk);
  assert.equal(cfg.loop.deterministic_final_scope_check, true);
  assert.equal(cfg.loop.worker_idle_abort_enabled, false);
  assert.equal(cfg.loop.worker_idle_consecutive_slow, 3);
  assert.equal(cfg.loop.worker_idle_min_elapsed_seconds, 900);
});

test("beta94: config clamps — consecutive-slow [2,20], min-elapsed [60,3600]", { skip: parseHarnessConfig === null }, () => {
  const low = parseHarnessConfig({ ...minimalOk, harness: undefined, loop: { worker_idle_consecutive_slow: 1, worker_idle_min_elapsed_seconds: 5 } });
  assert.equal(low.loop.worker_idle_consecutive_slow, 2, "consecutive-slow floors at 2");
  assert.equal(low.loop.worker_idle_min_elapsed_seconds, 60, "min-elapsed floors at 60");
  const high = parseHarnessConfig({ ...minimalOk, loop: { worker_idle_consecutive_slow: 999, worker_idle_min_elapsed_seconds: 999999 } });
  assert.equal(high.loop.worker_idle_consecutive_slow, 20, "consecutive-slow ceils at 20");
  assert.equal(high.loop.worker_idle_min_elapsed_seconds, 3600, "min-elapsed ceils at 3600");
});

// ---------------------------------------------------------------------------
// Source-wiring assertions
// ---------------------------------------------------------------------------
test("beta94 F1: source wiring — lead exports the elision, loop imports + audits it", () => {
  const lead = S("src/orchestrator/lead.ts");
  assert.match(lead, /export function isElidableFinalScopeSubTask/);
  assert.match(lead, /export function elideFinalScopeSubTask/);
  assert.match(lead, /scope\|boundar\|final/);
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /import \{ elideFinalScopeSubTask \} from ".\/lead.js"/);
  assert.match(loop, /loop\.final_verify_subtask_elided/);
  assert.match(loop, /runFinalScopeCheck/);
  assert.match(loop, /loop\.final_scope_check_ran/);
  assert.match(loop, /loop\.final_scope_check_out_of_scope/);
  assert.match(loop, /export function collectDeclaredScopeFiles/);
});

test("beta94 F2: source wiring — idle-no-work event, threshold config, abort via WorkerTimeoutError", () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /loop\.worker_idle_no_work/);
  assert.match(loop, /handleWorkerIdleNoWork/);
  assert.match(loop, /worker_idle_consecutive_slow/);
  assert.match(loop, /worker_idle_min_elapsed_seconds/);
  // The abort reuses the existing WorkerTimeoutError timeout-class path.
  assert.match(loop, /idleAbortReject\?\.\(new WorkerTimeoutError/);
  assert.match(loop, /onIdleAbort/);
  const cfg = S("src/config.ts");
  assert.match(cfg, /deterministic_final_scope_check\?: boolean/);
  assert.match(cfg, /worker_idle_abort_enabled\?: boolean/);
  assert.match(cfg, /worker_idle_consecutive_slow\?: number/);
  assert.match(cfg, /worker_idle_min_elapsed_seconds\?: number/);
});
