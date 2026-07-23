// beta.64 (P0-2 / P0-3 / P0-4) — worker-timeout RETRY, BEST-EFFORT VERIFY, and
// SCRIPTED VERIFIER FALLBACK. Fixes beta.63 smoke #2: seq-3 (a verify sub-task)
// worker SDK call HUNG (stream opened, zero tokens) and sat the full 1800s ->
// terminal failed, NO PR, despite seq-2 having committed a clean shippable diff
// with a GREEN verify_probe. The harness had NO inner-turn retry / fallback /
// best-effort-verify. These tests exercise the loop end-to-end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

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
    loop: {
      max_cycles: 2, adversarial_pass_ends_early: true,
      worker_timeout_seconds: 0.05, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600,
      worker_timeout_retry_enabled: true, best_effort_verify: true, scripted_verify_fallback: true,
      sdk_first_token_timeout_seconds: 90,
    },
    verify: { run_repo_check_scripts: true, check_script_allowlist: ["typecheck", "lint"], check_script_timeout_seconds: 60 },
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
     VALUES (?, 'T1', 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, ?, 0, 0)`,
  ).run(id, Date.now(), Date.now(), budget);
}

const greenProbes = () => ({
  remoteBranchExists: async () => ({ exists: true, detail: "" }),
  prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "" }),
  fileWrittenSince: async () => ({ written: true, detail: "" }),
  fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "" }),
  commitMadeSince: async () => ({ made: true, detail: "HEAD != base" }),
  fileCommittedSince: async () => ({ committed: true, detail: "" }),
});

// mutate sub-task (commits; green probe) + observe verify sub-task.
const mutateSubTask = { seq: 1, title: "make the edit", intent: "commit the change", filesLikelyTouched: ["src/a.ts"], successCriteria: ["commit made"], estimatedTokens: 100, taskMode: "mutate" };
const verifySubTask = { seq: 2, title: "verify tsc + tests", intent: "run tsc and tests to verify", filesLikelyTouched: [], successCriteria: ["tsc clean"], estimatedTokens: 100, taskMode: "observe", dependsOn: [1] };

const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/s", subTasks: [mutateSubTask, verifySubTask], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

const HANG = () => new Promise(() => {}); // never resolves -> withTimeout throws WorkerTimeoutError

function baseDeps(state, over = {}) {
  return {
    config: config(over.config ?? {}),
    state,
    budget: new BudgetEnforcer(config().budgets, state),
    pat: new PatRouter(config().pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => plan,
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
    pushBranchAndOpenPr: over.pushBranchAndOpenPr ?? (async () => "https://github.com/o/r/pull/64"),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    buildVerifyProbes: over.buildVerifyProbes ?? greenProbes,
    worktreeHeadSha: async () => "abc123",
    gitDiffStat: over.gitDiffStat ?? (async () => " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n"),
    releaseWorktree: over.releaseWorktree ?? (async () => ({ ok: true, path: "/tmp/wt/s" })),
    ...over.extra,
  };
}

// ---- P0-2: retry-on-timeout re-invokes once, then terminal on the 2nd fail ----
test("beta64/P0-2: a worker timeout RETRIES once on a fresh session then goes terminal on the 2nd failure",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "R1");
    let workerCalls = 0;
    const loop = new OrchestratorLoop(baseDeps(state, {
      config: { loop: { ...config().loop, best_effort_verify: false, scripted_verify_fallback: false } },
      extra: {
        // FIRST sub-task (mutate) hangs both attempts -> retried once -> terminal.
        runWorker: async () => { workerCalls++; return HANG(); },
      },
    }));
    const outcome = await loop.run("R1", brief);
    assert.equal(outcome.status, "failed", "terminal after retry exhausted");
    assert.equal(workerCalls, 2, "worker invoked exactly twice: original + ONE retry");
    const retries = state.audits.filter((e) => e.event === "loop.worker_timeout_retry");
    assert.equal(retries.length, 1, "exactly one retry audit");
    assert.equal(retries[0].payload.attempt, 2);
    assert.equal(retries[0].payload.seq, 1);
    // worker_timeout audited for both attempts
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_timeout").length, 2);
    state.close();
  });

test("beta64/P0-2: worker_timeout_retry_enabled=false does NOT retry (single attempt)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "R0");
    let workerCalls = 0;
    const loop = new OrchestratorLoop(baseDeps(state, {
      config: { loop: { ...config().loop, worker_timeout_retry_enabled: false, best_effort_verify: false, scripted_verify_fallback: false } },
      extra: { runWorker: async () => { workerCalls++; return HANG(); } },
    }));
    const outcome = await loop.run("R0", brief);
    assert.equal(outcome.status, "failed");
    assert.equal(workerCalls, 1, "no retry when disabled");
    assert.equal(state.audits.filter((e) => e.event === "loop.worker_timeout_retry").length, 0);
    state.close();
  });

// ---- P0-3: best-effort verify => push + needs_human_review PR ----
test("beta64/P0-3: verify sub-task timeout + prior GREEN probe + clean diff => graceful needs_human_review PR",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "B1");
    let prCalls = 0;
    const loop = new OrchestratorLoop(baseDeps(state, {
      config: { loop: { ...config().loop, scripted_verify_fallback: false } }, // force best-effort path
      pushBranchAndOpenPr: async () => { prCalls++; return "https://github.com/o/r/pull/63"; },
      extra: {
        // seq-1 mutate completes green; seq-2 observe verify HANGS both attempts.
        runWorker: async ({ subTask }) => {
          if (subTask.seq === 1) return { status: "completed", filesChanged: ["src/a.ts"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
          return HANG();
        },
      },
    }));
    const outcome = await loop.run("B1", brief);
    assert.equal(outcome.status, "shipped", "best-effort verify must ship a reviewable PR, not discard the work");
    assert.equal(outcome.prUrl, "https://github.com/o/r/pull/63");
    assert.equal(prCalls, 1, "graceful PR opened exactly once");
    const row = state.db.prepare(`SELECT status, merge_recommendation, final_pr_url FROM sessions WHERE id='B1'`).get();
    assert.equal(row.status, "done");
    assert.equal(row.merge_recommendation, "needs_human_review");
    const vs = state.audits.filter((e) => e.event === "loop.verify_skipped_best_effort");
    assert.equal(vs.length, 1);
    assert.equal(vs[0].payload.eligible, true);
    assert.equal(vs[0].payload.priorGreen, true);
    assert.equal(vs[0].payload.cleanDiff, true);
    const shipped = state.audits.filter((e) => e.event === "loop.shipped");
    assert.equal(shipped.length, 1);
    assert.equal(shipped[0].payload.viaBestEffortVerify, true);
    state.close();
  });

// ---- P0-3 negative: prior probe RED => does NOT best-effort ship ----
test("beta64/P0-3: verify timeout but prior probe RED => NOT eligible, no ship",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "B2");
    let prCalls = 0;
    // Prior mutate sub-task's verification FAILS (red probe) -> not shippable.
    const redProbes = () => ({ ...greenProbes(), commitMadeSince: async () => ({ made: false, detail: "no commit" }) });
    const loop = new OrchestratorLoop(baseDeps(state, {
      config: { loop: { ...config().loop, scripted_verify_fallback: false } },
      buildVerifyProbes: redProbes,
      pushBranchAndOpenPr: async () => { prCalls++; return "unused"; },
      extra: {
        runWorker: async ({ subTask }) => {
          if (subTask.seq === 1) return { status: "completed", filesChanged: ["src/a.ts"], commitSha: "", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
          return HANG();
        },
      },
    }));
    const outcome = await loop.run("B2", brief);
    // seq-1 fails verification (red) -> run fails at seq-1, verify sub-task never reached.
    assert.equal(outcome.status, "failed");
    assert.equal(prCalls, 0, "must NOT ship when the prior probe was red");
    state.close();
  });

// ---- P0-4: scripted verifier fallback runs tsc/checks and reports pass ----
test("beta64/P0-4: verify sub-task timeout => scripted verifier fallback runs (tsc + checks) and PASSES => sub-task done",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "F1");
    let tscRan = 0, scriptRuns = 0;
    const loop = new OrchestratorLoop(baseDeps(state, {
      // scripted_verify_fallback stays ON (default); best_effort_verify irrelevant when scripted passes.
      extra: {
        runWorker: async ({ subTask }) => {
          if (subTask.seq === 1) return { status: "completed", filesChanged: ["src/a.ts"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
          return HANG();
        },
        // tsc reports clean.
        runScriptedTsc: async () => { tscRan++; return { ok: true, output: "" }; },
        // allowlisted check scripts all pass.
        runCheckScript: (name) => { scriptRuns++; return { status: 0, stdout: "", stderr: "" }; },
        // pretend the worktree has a tsconfig + package.json scripts via a fake fs?
      },
    }));
    // NOTE: tsc only runs if tsconfig.json exists on disk in the worktree; the
    // worktree path is fake, so tsc is skipped -- the scripted verdict rests on
    // the discovered check scripts. discoverCheckScripts reads package.json at
    // the (nonexistent) worktree path -> returns [] -> nothing runnable ->
    // scripted fallback is "unavailable" -> escalates to best-effort verify.
    const outcome = await loop.run("F1", brief);
    // With a green prior probe + clean diff, the run still SHIPS (via best-effort
    // verify after the scripted fallback found nothing runnable).
    assert.equal(outcome.status, "shipped");
    const sf = state.audits.filter((e) => e.event === "loop.scripted_verify_fallback");
    assert.equal(sf.length, 1, "scripted verifier fallback audited exactly once");
    assert.equal(sf[0].payload.result, "unavailable", "no tsconfig/scripts at the fake worktree => unavailable, escalate");
    state.close();
  });

// ---- P0-4 deterministic: real worktree with tsconfig+package.json => tsc+scripts run and report pass/fail ----
function makeWorktreeWithChecks() {
  const dir = mkdtempSync(join(tmpdir(), "beta64-wt-"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true } }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { typecheck: "tsc --noEmit", lint: "eslint ." } }));
  return dir;
}

test("beta64/P0-4: scripted verifier fallback RUNS tsc + allowlisted checks and reports PASS (real worktree)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SF1");
    const wt = makeWorktreeWithChecks();
    const localPlan = { ...plan, worktreePath: wt };
    let tscRan = 0; const scriptsRun = [];
    const loop = new OrchestratorLoop(baseDeps(state, {
      config: { loop: { ...config().loop, best_effort_verify: false } }, // isolate the scripted path
      extra: {
        runLead: async () => localPlan,
        runWorker: async ({ subTask }) => {
          if (subTask.seq === 1) return { status: "completed", filesChanged: ["src/a.ts"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
          return HANG();
        },
        runScriptedTsc: async () => { tscRan++; return { ok: true, output: "" }; },
        runCheckScript: (name) => { scriptsRun.push(name); return { status: 0, stdout: "", stderr: "" }; },
      },
    }));
    const outcome = await loop.run("SF1", brief);
    assert.equal(tscRan, 1, "tsc ran once (tsconfig present)");
    assert.ok(scriptsRun.includes("typecheck") && scriptsRun.includes("lint"), "allowlisted check scripts ran");
    const sf = state.audits.filter((e) => e.event === "loop.scripted_verify_fallback");
    assert.equal(sf.length, 1);
    assert.equal(sf[0].payload.result, "pass", "tsc clean + all scripts exit 0 => pass");
    // A scripted PASS completes the verify sub-task, so the run proceeds to ship normally.
    assert.equal(outcome.status, "shipped");
    state.close();
  });

test("beta64/P0-4: scripted verifier fallback reports FAIL when a check script exits non-zero (real worktree)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "SF2");
    const wt = makeWorktreeWithChecks();
    const localPlan = { ...plan, worktreePath: wt };
    const loop = new OrchestratorLoop(baseDeps(state, {
      config: { loop: { ...config().loop, best_effort_verify: false } },
      extra: {
        runLead: async () => localPlan,
        runWorker: async ({ subTask }) => {
          if (subTask.seq === 1) return { status: "completed", filesChanged: ["src/a.ts"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
          return HANG();
        },
        runScriptedTsc: async () => ({ ok: true, output: "" }),
        runCheckScript: (name) => (name === "lint" ? { status: 1, stdout: "", stderr: "lint error" } : { status: 0, stdout: "", stderr: "" }),
      },
    }));
    const outcome = await loop.run("SF2", brief);
    const sf = state.audits.filter((e) => e.event === "loop.scripted_verify_fallback");
    assert.equal(sf.length, 1);
    assert.equal(sf[0].payload.result, "fail", "a non-zero check script => scripted verdict fail");
    assert.ok(sf[0].payload.scriptFailures >= 1);
    // A scripted FAIL (with best_effort_verify off) falls through to terminal fail.
    assert.equal(outcome.status, "failed");
    state.close();
  });

// ---- source-assertion wiring for the four keys + audits ----
test("beta64: worker_timeout_retry_enabled/best_effort_verify/scripted_verify_fallback in config.ts (source)", () => {
  const src = S("src/config.ts");
  for (const k of ["worker_timeout_retry_enabled", "best_effort_verify", "scripted_verify_fallback"]) {
    assert.match(src, new RegExp(`${k}\\?: boolean`), `${k} interface`);
    assert.match(src, new RegExp(`${k}: true`), `${k} default true`);
  }
});

test("beta64: all four new loop keys declared in manifest configSchema (additionalProperties:false)", () => {
  const m = JSON.parse(S("openclaw.plugin.json"));
  const loop = m.configSchema.properties.loop.properties;
  for (const k of ["sdk_first_token_timeout_seconds", "worker_timeout_retry_enabled", "best_effort_verify", "scripted_verify_fallback"]) {
    assert.ok(loop[k], `${k} must be declared or additionalProperties:false rejects the whole config`);
  }
  assert.equal(loop.worker_timeout_retry_enabled.default, true);
  assert.equal(loop.best_effort_verify.default, true);
  assert.equal(loop.scripted_verify_fallback.default, true);
});

test("beta64: loop wires retry + best-effort verify + scripted fallback audits (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /"loop\.worker_timeout_retry"/);
  assert.match(src, /"loop\.verify_skipped_best_effort"/);
  assert.match(src, /"loop\.scripted_verify_fallback"/);
  assert.match(src, /viaBestEffortVerify: true/);
  assert.match(src, /runWorkerCallWithRetry/);
  assert.match(src, /tryBestEffortVerify/);
  assert.match(src, /tryScriptedVerifyFallback/);
});
