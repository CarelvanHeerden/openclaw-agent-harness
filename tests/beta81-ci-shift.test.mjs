// beta.81 Track B — CI verification shift.
//   B1: worker prompt no longer runs the suite/build/lint to green (CI does).
//   B2: post-push CI poll — success/failure/timeout paths via a fake
//       getCombinedStatus (pending N times then success; failure feeds a logs
//       fetch; pending-forever => timeout surfaces a resumable soft checkpoint).
//   B3: authors a .github/workflows/*.yml when a repo has no CI.
//   B4: the local check-script runner is no longer the verify spine (CI-only).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
let detectCheckScripts, hasExistingWorkflow, renderCiWorkflowYaml, authorCiWorkflow;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ detectCheckScripts, hasExistingWorkflow, renderCiWorkflowYaml, authorCiWorkflow } = await import("../dist/adapters/ci-workflow.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(over = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, daily_max_usd: 500, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: { max_cycles: 1, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, worker_timeout_seconds: 60, subtask_deadline_seconds: 60 },
    verify: { run_repo_check_scripts: false, check_script_allowlist: [], check_script_timeout_seconds: 60 },
    ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20 },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt" },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "g" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: [], bash_denylist_tokens: [], path_denylist: [] },
    ...over,
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
    audits, close() { db.close(); },
  };
}
function loopWith(state, deps = {}) {
  return new OrchestratorLoop({
    config: config(deps.config),
    state,
    budget: new BudgetEnforcer(config().budgets, state),
    pat: new PatRouter(config().pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => ({}), runWorker: async () => ({}), runAdversary: async () => ({}),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    ...deps,
  });
}
const noSleep = async () => {};

// ---- B1: worker prompt ----
test("beta81/B1: worker prompt shifts verification to CI (no run-suite-to-green)", () => {
  const src = S("src/orchestrator/sonnet-worker.ts");
  assert.match(src, /DO NOT run the test suite, a build, or lint "to green"/);
  assert.match(src, /GitHub CI runs the repo's declared checks AFTER the/);
  // does NOT tell the worker to run tests to green anymore.
  assert.doesNotMatch(src, /To RUN TESTS, a BUILD, or LINT: execute the command yourself/);
  // hard-stop + no-async guards preserved.
  assert.match(src, /HARD STOP RULE/);
  assert.match(src, /async test runner \/ background watcher/);
});

// ---- B2: CI poll success ----
test("beta81/B2: pollCiStatus returns success after N pending polls", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  let calls = 0;
  const loop = loopWith(state, {
    ciCombinedStatus: async () => (++calls < 3 ? "pending" : "success"),
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "sha1", requester: "U1", sleep: noSleep });
  assert.deepEqual(r, { outcome: "success" });
  assert.equal(calls, 3);
  assert.ok(state.audits.some((a) => a.event === "loop.ci_success"));
  state.close();
});

// ---- B2: CI poll failure feeds logs ----
test("beta81/B2: pollCiStatus failure fetches failing logs as the revise source", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  const loop = loopWith(state, {
    ciCombinedStatus: async () => "failure",
    ciFailingLogs: async () => "- typecheck [failure]: TS2345 bad type",
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "sha1", requester: "U1", sleep: noSleep });
  assert.equal(r.outcome, "failure");
  assert.match(r.logs, /TS2345 bad type/);
  assert.ok(state.audits.some((a) => a.event === "loop.ci_failure"));
  state.close();
});

// ---- B2: CI poll timeout surfaces a resumable soft checkpoint ----
test("beta81/B2: pollCiStatus that stays pending forever TIMES OUT (soft, resumable -- not a hard fail)", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  // a controllable fake clock so the loop hits the wait timeout deterministically.
  let t = 0;
  const now = () => t;
  const sleep = async (ms) => { t += ms; };
  const loop = loopWith(state, {
    config: { ...config().ci ? {} : {}, ci: { wait_timeout_seconds: 60, poll_interval_seconds: 20 } },
    ciCombinedStatus: async () => "pending",
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "shaX", requester: "U1", sleep, now });
  assert.equal(r.outcome, "timeout");
  assert.equal(r.sha, "shaX");
  assert.ok(r.waitedSeconds >= 60);
  assert.ok(state.audits.some((a) => a.event === "loop.ci_wait_timeout"));
  state.close();
});

// ---- beta.91 F4: authored-workflow grace window ----
test("beta91/F4: authored workflow + none-then-success within grace -> success (does NOT terminate on poll 1)", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
  let calls = 0;
  // none on polls 1-2 (GitHub not registered yet), success on poll 3.
  const loop = loopWith(state, {
    config: { ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 45 } },
    ciCombinedStatus: async () => (++calls < 3 ? "none" : "success"),
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "sha1", requester: "U1", workflowAuthoredThisSession: true, sleep, now });
  assert.equal(r.outcome, "success", "grace window must keep polling past a not-yet-registered none");
  assert.equal(calls, 3);
  assert.ok(state.audits.some((a) => a.event === "loop.ci_none_grace_wait"));
  state.close();
});

test("beta91/F4: authored workflow + none for the whole grace -> authored_workflow_never_registered (NON-blocking)", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
  const loop = loopWith(state, {
    config: { ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 45 } },
    ciCombinedStatus: async () => "none",
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "shaZ", requester: "U1", workflowAuthoredThisSession: true, sleep, now });
  assert.equal(r.outcome, "authored_workflow_never_registered");
  assert.equal(r.sha, "shaZ");
  assert.ok(r.waitedSeconds >= 45);
  state.close();
});

// beta.103 SUPERSEDES the b91 "none terminates immediately when nothing was
// authored" behaviour. That gate is exactly what shipped PR #906 blocked: the
// PR opened at 10:30:44, GitHub registered its first check run at 10:30:49, and
// the immediate first poll landed in that hole, read `none`, and concluded the
// repo had no CI. Lint went red at 10:33:11 against an untouched 900s budget.
// The grace now applies to EVERY repo; only the terminal outcome still
// distinguishes the authored case.
test("beta103: NO workflow authored + none-then-failure within grace -> failure (the b102 PR #906 race)", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
  let calls = 0;
  const loop = loopWith(state, {
    config: { ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 45 } },
    // Poll 1 lands before GitHub registered anything; the checks then report red.
    ciCombinedStatus: async () => (++calls < 2 ? "none" : "failure"),
    ciFailingLogs: async () => "- Lint [failure]: react/no-unescaped-entities",
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", workflowAuthoredThisSession: false, sleep, now });
  assert.equal(r.outcome, "failure", "a pre-existing-CI repo must not terminate on a not-yet-registered none");
  assert.match(r.logs, /no-unescaped-entities/);
  assert.ok(state.audits.some((a) => a.event === "loop.ci_none_grace_wait"));
  state.close();
});

test("beta103: NO workflow authored + none for the whole grace -> plain none (a real no-CI repo still resolves)", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
  const loop = loopWith(state, {
    config: { ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 45 } },
    ciCombinedStatus: async () => "none",
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", workflowAuthoredThisSession: false, sleep, now });
  assert.equal(r.outcome, "none", "no workflow authored => plain none, never authored_workflow_never_registered");
  state.close();
});

test("beta103: none_grace_seconds:0 still terminates on poll 1 for an unauthored repo (opt-out preserved)", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  let calls = 0;
  const loop = loopWith(state, {
    config: { ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 0 } },
    ciCombinedStatus: async () => { calls++; return "none"; },
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", workflowAuthoredThisSession: false, sleep: noSleep });
  assert.equal(r.outcome, "none");
  assert.equal(calls, 1);
  state.close();
});

test("beta91/F4: none_grace_seconds:0 disables the grace window even when authored", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  let calls = 0;
  const loop = loopWith(state, {
    config: { ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 0 } },
    ciCombinedStatus: async () => { calls++; return "none"; },
  });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", workflowAuthoredThisSession: true, sleep: noSleep });
  assert.equal(r.outcome, "none");
  assert.equal(calls, 1);
  state.close();
});

// ---- B2: skipped when no dep ----
test("beta81/B2: pollCiStatus is SKIPPED when ciCombinedStatus dep is absent", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  const loop = loopWith(state); // no ciCombinedStatus
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep: noSleep });
  assert.deepEqual(r, { outcome: "skipped" });
  state.close();
});

// ---- B2: 'none' outcome (no CI) ----
test("beta81/B2: pollCiStatus reports 'none' when the repo has no CI", { skip: OrchestratorLoop === null }, async () => {
  const state = makeStore();
  // beta.103: a fake clock, because `none` now grace-polls before resolving.
  let t = 0; const now = () => t; const sleep = async (ms) => { t += ms; };
  const loop = loopWith(state, { ciCombinedStatus: async () => "none" });
  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep, now });
  assert.deepEqual(r, { outcome: "none" });
  assert.ok(state.audits.some((a) => a.event === "loop.ci_none"));
  state.close();
});

// ---- B3: workflow authoring ----
test("beta81/B3: detectCheckScripts picks the canonical scripts a repo declares", { skip: detectCheckScripts === undefined }, () => {
  const dir = mkdtempSync(join(tmpdir(), "b81-ci-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest", lint: "eslint .", other: "x" } }));
  assert.deepEqual(detectCheckScripts(dir), ["typecheck", "lint", "test"]);
  // no package.json -> [].
  const empty = mkdtempSync(join(tmpdir(), "b81-ci-empty-"));
  assert.deepEqual(detectCheckScripts(empty), []);
});

test("beta81/B3: authorCiWorkflow writes + commits a workflow when a no-CI repo has scripts", { skip: authorCiWorkflow === undefined }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "b81-ci-auth-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest" } }));
  let committed = null;
  const res = await authorCiWorkflow({ worktreePath: dir, gitCommit: async (_wt, msg) => { committed = msg; return "sha"; } });
  assert.ok(res);
  assert.equal(res.path, ".github/workflows/harness-ci.yml");
  assert.deepEqual(res.scripts, ["typecheck", "test"]);
  assert.ok(existsSync(join(dir, ".github/workflows/harness-ci.yml")));
  assert.match(committed, /harness-authored GitHub Actions workflow/);
  const yaml = readFileSync(join(dir, ".github/workflows/harness-ci.yml"), "utf8");
  assert.match(yaml, /npm ci/);
  assert.match(yaml, /npm run typecheck --if-present/);
  assert.match(yaml, /npm run test --if-present/);
});

test("beta81/B3: authorCiWorkflow authors NOTHING when a workflow already exists", { skip: authorCiWorkflow === undefined }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "b81-ci-exist-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/existing.yml"), "name: existing\n");
  assert.equal(hasExistingWorkflow(dir), true);
  const res = await authorCiWorkflow({ worktreePath: dir, gitCommit: async () => "sha" });
  assert.equal(res, null);
});

test("beta81/B3: loop authors a workflow before push + polls CI after (wired in finalize)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /this\.deps\.ciAuthorWorkflow/);
  assert.match(src, /loop\.ci_workflow_authored/);
  // authored BEFORE pushBranchAndOpenPr so it lands in the PR.
  const authorIdx = src.indexOf("this.deps.ciAuthorWorkflow({ worktreePath: plan.worktreePath })");
  const pushIdx = src.indexOf("prUrl = await this.deps.pushBranchAndOpenPr({ plan, brief, reviewReport: lastReview");
  assert.ok(authorIdx > 0 && pushIdx > 0 && authorIdx < pushIdx, "workflow authored before push");
  // CI failure/timeout OVERRIDES the merge rec to needs_human_review.
  assert.match(src, /ciOverride/);
  assert.match(src, /const finalRecommendation = ciOverride\?\.recommendation \?\? rec\.recommendation/);
});

// ---- B4: local runner off the verify spine ----
test("beta81/B4: the local check-script runner is retired from the verify spine (CI-only)", () => {
  const src = S("src/orchestrator/loop.ts");
  // runFinalVerifyChecks still exists (kept for the scripted-verify fallback)
  // but is gated off by default and explicitly documented as NOT the spine.
  assert.match(src, /the beta\.63 LOCAL check-script runner is RETIRED/);
  assert.match(src, /is CI-only now/);
  // default is off.
  const cfg = S("src/config.ts");
  assert.match(cfg, /run_repo_check_scripts:\s*false/);
});
