// beta.124 — a denial is an answer. Stop asking.
//
// The b123 OpenClaw smoke opened PR #1022 and then polled the check-runs API
// 44 times over 896 seconds. Every single call returned HTTP 403. That is 12%
// of the run's wall clock spent re-reading a settled answer, and the run
// finished on "Could NOT determine CI state for 02299b20 after 896s of polling
// (check-runs API HTTP 403)" -- true, and useless. Nothing in that sentence
// tells the operator that a fine-grained PAT is missing "Checks: read", which
// is what a 403 on check-runs alongside a readable statuses API means.
//
// b119 made this gate fail CLOSED, and that part was right: an unreadable
// signal is never a pass. b124 only changes how long we take to say so, and
// what we say.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let getCiSnapshot, OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ getCiSnapshot } = await import("../dist/adapters/github.js"));
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  getCiSnapshot = null;
}
const skip = getCiSnapshot === null ? "build not present (npm run build)" : false;
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function stubFetch(routes) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    for (const [pat, handler] of routes) if (url.includes(pat)) return handler(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return () => { globalThis.fetch = orig; };
}
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
const httpErr = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "" });
const okStatus = () => json({ state: "success", total_count: 1 });
const okChecks = () => json({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] });

// ---------------------------------------------------------------------------
// 1. The snapshot tells permanent from transient.
// ---------------------------------------------------------------------------

test("the exact b123 shape: readable statuses, 403 check-runs, names the missing permission", { skip }, async () => {
  const restore = stubFetch([["/status", okStatus], ["/check-runs", () => httpErr(403)]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "Stitch-Vercel/ProjectThanos", sha: "02299b20", ghToken: "t" });
    assert.equal(snap.state, "unknown", "b119 still holds: unreadable is never a pass");
    assert.ok(snap.permanentDenial, "a 403 is a denial, not a delay");
    assert.match(snap.permanentDenial, /Checks: read/, "name the permission the operator has to grant");
    assert.match(snap.permanentDenial, /check-runs/);
    assert.match(snap.permanentDenial, /Waiting will not change this/);
  } finally { restore(); }
});

test("a 403 on the STATUSES api names the other permission", { skip }, async () => {
  const restore = stubFetch([["/status", () => httpErr(403)], ["/check-runs", okChecks]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.match(snap.permanentDenial, /Commit statuses: read/);
    assert.doesNotMatch(snap.permanentDenial, /Checks: read/, "do not send someone after the wrong permission");
  } finally { restore(); }
});

test("a 401 is reported as credentials, not as a permission to grant", { skip }, async () => {
  const restore = stubFetch([["/status", () => httpErr(401)], ["/check-runs", () => httpErr(401)]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.match(snap.permanentDenial, /bad or expired credentials/);
    assert.doesNotMatch(snap.permanentDenial, /repository permission/);
  } finally { restore(); }
});

test("a 404 is reported as 'the token cannot see this repo'", { skip }, async () => {
  const restore = stubFetch([["/status", okStatus], ["/check-runs", () => httpErr(404)]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.match(snap.permanentDenial, /cannot see this repository/);
  } finally { restore(); }
});

test("a 5xx is NOT permanent — that one really is worth waiting out", { skip }, async () => {
  const restore = stubFetch([["/status", okStatus], ["/check-runs", () => httpErr(502)]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "unknown");
    assert.equal(snap.permanentDenial, "", "a bad gateway is exactly what re-polling is for");
  } finally { restore(); }
});

test("a rate limit is NOT permanent", { skip }, async () => {
  const restore = stubFetch([["/status", okStatus], ["/check-runs", () => httpErr(429)]]);
  try {
    assert.equal((await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" })).permanentDenial, "");
  } finally { restore(); }
});

test("a readable, healthy commit carries no denial at all", { skip }, async () => {
  const restore = stubFetch([["/status", okStatus], ["/check-runs", okChecks]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "success");
    assert.equal(snap.permanentDenial, "");
  } finally { restore(); }
});

test("both APIs denied reports BOTH remedies", { skip }, async () => {
  const restore = stubFetch([["/status", () => httpErr(403)], ["/check-runs", () => httpErr(403)]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.match(snap.permanentDenial, /Commit statuses: read/);
    assert.match(snap.permanentDenial, /Checks: read/);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// 2. The poller acts on it.
// ---------------------------------------------------------------------------

function config(over = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, daily_max_usd: 500, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: { max_cycles: 1, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, worker_timeout_seconds: 60, subtask_deadline_seconds: 60 },
    verify: { run_repo_check_scripts: false, check_script_allowlist: [], check_script_timeout_seconds: 60 },
    ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 45, permanent_denial_polls: 2 },
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
  const cfg = config(deps.config ? { ci: { ...config().ci, ...deps.config.ci } } : {});
  return new OrchestratorLoop({
    config: cfg, state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat: new PatRouter(cfg.pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => ({}), runWorker: async () => ({}), runAdversary: async () => ({}),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    ...deps,
  });
}
const noSleep = async () => {};

/**
 * A virtual clock for pollCiStatus.
 *
 * Every test here stubs `sleep` out, so with the real clock the poller spins
 * at full speed until `wait_timeout_seconds` of WALL time has passed -- 900s
 * by default. That is invisible while the early-stop works and the poller
 * only takes two turns, and it is exactly what a mutation removing the
 * early-stop restores: the suite stops failing and starts hanging, which
 * teaches nobody anything and costs fifteen minutes to discover. Advancing a
 * fake clock keeps the budget-exhausted path bounded and fast.
 */
function virtualClock(stepMs = 20_000) {
  let t = 0;
  return { sleep: async () => { t += stepMs; }, now: () => t };
}

const denied = (denial = 'the token cannot read the check-runs API (HTTP 403). A fine-grained PAT needs the "Checks: read" repository permission.') => ({
  state: "unknown", checkTotal: 0, checksReadable: false, statusReadable: true,
  reason: "check-runs API HTTP 403", permanentDenial: denial,
});

test("the poller gives up after the configured number of denials, not after the wait budget", { skip }, async () => {
  const state = makeStore();
  let polls = 0;
  const loop = loopWith(state, { ciSnapshot: async () => { polls++; return denied(); } });

  const r = await loop.pollCiStatus({
    sessionId: "S", repoFullName: "o/r", sha: "02299b20", requester: "U1", ...virtualClock(),
  });

  assert.equal(r.outcome, "indeterminate", "still indeterminate — b119's fail-closed is untouched");
  assert.equal(polls, 2, "two consecutive denials is the whole conversation; b123 had forty-four");
  assert.match(r.reason, /Checks: read/, "the outcome carries the remedy, not the elapsed seconds");
  const ev = state.audits.find((a) => a.event === "loop.ci_permanently_denied");
  assert.ok(ev, "the abandonment should be on the record");
  assert.equal(ev.payload.polls, 2);
  assert.match(ev.payload.denial, /Checks: read/);
  state.close();
});

test("one denial alone does not abandon the poll", { skip }, async () => {
  // A single 403 can be a secondary rate limit or a token being rotated. The
  // run must not throw away a readable CI signal over one bad read.
  const state = makeStore();
  const seq = [
    denied(),
    { state: "pending", checkTotal: 3, checksReadable: true, statusReadable: true, reason: "" },
    { state: "success", checkTotal: 3, checksReadable: true, statusReadable: true, reason: "" },
  ];
  let i = 0;
  const loop = loopWith(state, { ciSnapshot: async () => seq[Math.min(i++, seq.length - 1)] });

  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep: noSleep });

  assert.equal(r.outcome, "success", "the recovered signal should be used");
  assert.equal(state.audits.filter((a) => a.event === "loop.ci_permanently_denied").length, 0);
});

test("the denial counter resets, so alternating denials still ride out the budget", { skip }, async () => {
  // denial, ok, denial, ok, ... never reaches two IN A ROW. This must behave
  // like the pre-b124 poller and wait, not trip on a running total.
  const state = makeStore();
  let i = 0;
  const loop = loopWith(state, {
    ciSnapshot: async () => {
      i++;
      if (i >= 9) return { state: "failure", checkTotal: 1, checksReadable: true, statusReadable: true, reason: "" };
      return i % 2 === 1
        ? denied()
        : { state: "pending", checkTotal: 1, checksReadable: true, statusReadable: true, reason: "" };
    },
    ciFailingLogs: async () => "Lint: 1 error",
  });

  const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep: noSleep });

  assert.equal(r.outcome, "failure");
  assert.equal(state.audits.filter((a) => a.event === "loop.ci_permanently_denied").length, 0,
    "four denials that were never consecutive are four transients, not a configuration fact");
});

test("permanent_denial_polls is honoured, and cannot be set below one", { skip }, async () => {
  for (const [configured, expected] of [[1, 1], [3, 3], [0, 1]]) {
    const state = makeStore();
    let polls = 0;
    const loop = loopWith(state, {
      config: { ci: { permanent_denial_polls: configured } },
      ciSnapshot: async () => { polls++; return denied(); },
    });
    await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", ...virtualClock() });
    assert.equal(polls, expected, `permanent_denial_polls ${configured} should poll ${expected}x`);
    state.close();
  }
});

test("a snapshot source with no permanentDenial field behaves exactly as it did before", { skip }, async () => {
  // The field is optional on the dep type. An older or hand-rolled snapshot
  // source must not start terminating early because a property is missing.
  const state = makeStore();
  let polls = 0;
  const loop = loopWith(state, {
    config: { ci: { wait_timeout_seconds: 60, poll_interval_seconds: 20 } },
    ciSnapshot: async () => {
      polls++;
      return { state: "unknown", checkTotal: 0, checksReadable: false, statusReadable: true, reason: "unclassified" };
    },
  });

  const r = await loop.pollCiStatus({
    sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", ...virtualClock(),
  });

  assert.equal(r.outcome, "indeterminate");
  assert.ok(polls > 2, `should have ridden out the wait budget, polled only ${polls}x`);
  assert.equal(state.audits.filter((a) => a.event === "loop.ci_permanently_denied").length, 0);
  state.close();
});
