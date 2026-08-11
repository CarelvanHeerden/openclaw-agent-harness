/**
 * beta.119 — the CI gate must FAIL CLOSED.
 *
 * Provenance. The b118 OpenClaw smoke shipped ProjectThanos PR #986 with
 * `ci_success` recorded at 21:10:45 UTC. On that exact commit, Lint had already
 * concluded FAILURE at 21:10:17 and Tests concluded FAILURE at 21:13:39. The
 * commit carried exactly one legacy status (Vercel, which went green at
 * 21:10:37) and ten GitHub Actions check runs.
 *
 * The old `getCombinedStatus` guarded its check-runs branch with a bare
 * `if (cRes.ok)` and no else, so an unreadable -- or transiently empty, which
 * the Check Runs API really does return under eventual consistency -- list was
 * indistinguishable from "this repo has no check runs". The "nothing
 * configured" guard needed BOTH sources empty, and Vercel made `statusCount` 1,
 * so the function fell through to `anySuccess` and called the commit green off
 * the deploy status alone. Its last line was also a bare `return "success"`.
 *
 * Every test below is a shape that used to return "success" and must not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let getCiSnapshot, getCombinedStatus, OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ getCiSnapshot, getCombinedStatus } = await import("../dist/adapters/github.js"));
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  getCiSnapshot = null;
}
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
const run = (status, conclusion) => ({ status, conclusion });

// ---------------------------------------------------------------------------
// 1. The exact b118 false-green shapes.
// ---------------------------------------------------------------------------

test("b118 REGRESSION: green Vercel status + UNREADABLE check-runs is not success",
  { skip: getCiSnapshot === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 1 })],
      ["/check-runs", () => httpErr(403)],
    ]);
    try {
      const snap = await getCiSnapshot({ repoFullName: "Stitch-Vercel/ProjectThanos", sha: "1ccad0be", ghToken: "t" });
      assert.equal(snap.state, "unknown", "an unreadable check-run list must never read as a pass");
      assert.equal(snap.checksReadable, false);
      assert.match(snap.reason, /403/);
    } finally { restore(); }
  });

test("b118 REGRESSION: green Vercel status + transiently EMPTY check-runs is not success",
  { skip: getCiSnapshot === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 1 })],
      ["/check-runs", () => json({ total_count: 0, check_runs: [] })],
    ]);
    try {
      // Read in isolation this is indistinguishable from a Vercel-only repo, so
      // the snapshot legitimately says success -- the high-water mark in
      // pollCiStatus is what separates the two. Pin the counts the loop needs.
      const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
      assert.equal(snap.checkTotal, 0);
      assert.equal(snap.checksReadable, true);
    } finally { restore(); }
  });

test("b118 REGRESSION: a failed check beats a green legacy status",
  { skip: getCiSnapshot === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 1 })],
      // The real PR #986 shape at 21:10:45: Lint already red, Tests still going.
      ["/check-runs", () => json({
        total_count: 4,
        check_runs: [
          run("completed", "success"), run("completed", "failure"),
          run("in_progress", null), run("queued", null),
        ],
      })],
    ]);
    try {
      const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
      assert.equal(snap.state, "failure");
      assert.equal(snap.checkFailed, 1);
    } finally { restore(); }
  });

test("b118 REGRESSION: still-running checks beat a green legacy status",
  { skip: getCiSnapshot === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 1 })],
      ["/check-runs", () => json({ total_count: 2, check_runs: [run("completed", "success"), run("in_progress", null)] })],
    ]);
    try {
      assert.equal((await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" })).state, "pending");
    } finally { restore(); }
  });

// ---------------------------------------------------------------------------
// 2. Fail-closed on everything unreadable or unclassifiable.
// ---------------------------------------------------------------------------

test("unreadable STATUSES api is unknown, not success", { skip: getCiSnapshot === null }, async () => {
  const restore = stubFetch([
    ["/status", () => httpErr(500)],
    ["/check-runs", () => json({ total_count: 1, check_runs: [run("completed", "success")] })],
  ]);
  try {
    assert.equal((await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" })).state, "unknown");
  } finally { restore(); }
});

test("both apis unreadable is unknown, not none", { skip: getCiSnapshot === null }, async () => {
  const restore = stubFetch([["/status", () => httpErr(401)], ["/check-runs", () => httpErr(401)]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "unknown");
    assert.notEqual(snap.state, "none", "a token that cannot read must not look like a repo without CI");
  } finally { restore(); }
});

test("a THROWN fetch is unknown, not success", { skip: getCiSnapshot === null }, async () => {
  const restore = stubFetch([
    ["/status", () => json({ state: "success", total_count: 1 })],
    ["/check-runs", () => { throw new Error("ECONNRESET"); }],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "unknown");
    assert.match(snap.reason, /ECONNRESET/);
  } finally { restore(); }
});

test("a TRUNCATED check-run list is unknown (more checks than one page)",
  { skip: getCiSnapshot === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 0 })],
      // total_count says 140, we can only see 2 -> refuse to judge.
      ["/check-runs", () => json({ total_count: 140, check_runs: [run("completed", "success"), run("completed", "success")] })],
    ]);
    try {
      const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
      assert.equal(snap.state, "unknown");
      assert.match(snap.reason, /truncated/);
    } finally { restore(); }
  });

test("an UNRECOGNISED conclusion is not counted as passing", { skip: getCiSnapshot === null }, async () => {
  const restore = stubFetch([
    ["/status", () => json({ state: "success", total_count: 0 })],
    ["/check-runs", () => json({ total_count: 2, check_runs: [run("completed", "success"), run("completed", "some_new_github_conclusion")] })],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "unknown");
    assert.equal(snap.checkPassed, 1);
    assert.equal(snap.checkTotal, 2);
  } finally { restore(); }
});

test("`stale` is treated as a failing conclusion", { skip: getCiSnapshot === null }, async () => {
  const restore = stubFetch([
    ["/status", () => json({ state: "success", total_count: 0 })],
    ["/check-runs", () => json({ total_count: 1, check_runs: [run("completed", "stale")] })],
  ]);
  try {
    assert.equal((await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" })).state, "failure");
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// 3. The genuine passes still pass (no false-negative regression).
// ---------------------------------------------------------------------------

test("all checks green + legacy green is still success", { skip: getCiSnapshot === null }, async () => {
  const restore = stubFetch([
    ["/status", () => json({ state: "success", total_count: 2 })],
    ["/check-runs", () => json({ total_count: 3, check_runs: [run("completed", "success"), run("completed", "neutral"), run("completed", "skipped")] })],
  ]);
  try {
    assert.equal((await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" })).state, "success");
  } finally { restore(); }
});

test("a repo with genuinely no CI still resolves to none", { skip: getCiSnapshot === null }, async () => {
  const restore = stubFetch([
    ["/status", () => json({ state: "pending", total_count: 0 })],
    ["/check-runs", () => json({ total_count: 0, check_runs: [] })],
  ]);
  try {
    assert.equal((await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" })).state, "none");
  } finally { restore(); }
});

test("getCombinedStatus still returns the bare state for legacy callers",
  { skip: getCombinedStatus === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 1 })],
      ["/check-runs", () => json({ total_count: 1, check_runs: [run("completed", "success")] })],
    ]);
    try {
      assert.equal(await getCombinedStatus({ repoFullName: "o/r", sha: "s", ghToken: "t" }), "success");
    } finally { restore(); }
  });

// ---------------------------------------------------------------------------
// 4. pollCiStatus: the check-count high-water mark + the indeterminate outcome.
// ---------------------------------------------------------------------------

function config(over = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, daily_max_usd: 500, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: { max_cycles: 1, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, worker_timeout_seconds: 60, subtask_deadline_seconds: 60 },
    verify: { run_repo_check_scripts: false, check_script_allowlist: [], check_script_timeout_seconds: 60 },
    ci: { wait_timeout_seconds: 900, poll_interval_seconds: 20, none_grace_seconds: 45 },
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
    config: config(deps.config), state,
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
const snap = (over) => ({ state: "pending", checkTotal: 0, checksReadable: true, statusReadable: true, reason: "", ...over });

test("HIGH-WATER MARK: a poll whose check list SHRANK cannot end the wait green",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    // The b118 arc: nothing registered yet, then ten checks appear and run,
    // then a stale read shows zero checks while the lone Vercel status is green
    // (which in isolation looks exactly like success), then the truth lands.
    const seq = [
      snap({ state: "none", checkTotal: 0 }),
      snap({ state: "pending", checkTotal: 10 }),
      snap({ state: "success", checkTotal: 0 }), // <- the false green
      snap({ state: "failure", checkTotal: 10 }),
    ];
    let i = 0;
    const loop = loopWith(state, {
      ciSnapshot: async () => seq[Math.min(i++, seq.length - 1)],
      ciFailingLogs: async () => "Lint: 1 error",
    });
    const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "1ccad0be", requester: "U1", sleep: noSleep });
    assert.equal(r.outcome, "failure", "the stale all-clear must not be allowed to ship");
    assert.ok(state.audits.some((a) => a.event === "loop.ci_check_count_regressed"),
      "the rejected stale read should be on the record");
    const reg = state.audits.find((a) => a.event === "loop.ci_check_count_regressed");
    assert.equal(reg.payload.checkTotal, 0);
    assert.equal(reg.payload.maxChecksSeen, 10);
    assert.equal(reg.payload.rejectedStatus, "success");
    state.close();
  });

test("HIGH-WATER MARK: a shrunken list cannot end the wait as `none` either",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    const seq = [snap({ state: "pending", checkTotal: 4 }), snap({ state: "none", checkTotal: 0 }), snap({ state: "success", checkTotal: 4 })];
    let i = 0;
    const loop = loopWith(state, { ciSnapshot: async () => seq[Math.min(i++, seq.length - 1)] });
    const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep: noSleep });
    assert.equal(r.outcome, "success");
    assert.ok(state.audits.some((a) => a.event === "loop.ci_check_count_regressed"));
    state.close();
  });

test("a growing check list is normal progress, never a regression",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    const seq = [snap({ state: "pending", checkTotal: 2 }), snap({ state: "pending", checkTotal: 7 }), snap({ state: "success", checkTotal: 10 })];
    let i = 0;
    const loop = loopWith(state, { ciSnapshot: async () => seq[Math.min(i++, seq.length - 1)] });
    const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep: noSleep });
    assert.equal(r.outcome, "success");
    assert.ok(!state.audits.some((a) => a.event === "loop.ci_check_count_regressed"));
    state.close();
  });

test("UNKNOWN is retried inside the budget and resolves when the read recovers",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    const seq = [
      snap({ state: "unknown", checksReadable: false, reason: "check-runs API HTTP 403" }),
      snap({ state: "unknown", checksReadable: false, reason: "check-runs API HTTP 403" }),
      snap({ state: "success", checkTotal: 3 }),
    ];
    let i = 0;
    const loop = loopWith(state, { ciSnapshot: async () => seq[Math.min(i++, seq.length - 1)] });
    const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep: noSleep });
    assert.equal(r.outcome, "success");
    assert.equal(state.audits.filter((a) => a.event === "loop.ci_unknown_retry").length, 2);
    state.close();
  });

test("UNKNOWN that never resolves ends INDETERMINATE, never success",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    const loop = loopWith(state, {
      config: { ci: { wait_timeout_seconds: 60, poll_interval_seconds: 20, none_grace_seconds: 0 } },
      ciSnapshot: async () => snap({ state: "unknown", checksReadable: false, reason: "check-runs API HTTP 403" }),
    });
    // Drive a fake clock forward one poll interval per read, so the wait budget
    // is spent in logic rather than in ten seconds of real spinning.
    let clock = 0;
    const r = await loop.pollCiStatus({
      sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1",
      sleep: async () => { clock += 20_000; }, now: () => clock,
    });
    assert.equal(r.outcome, "indeterminate");
    assert.match(r.reason, /403/);
    assert.equal(r.waitedSeconds, 60);
    assert.ok(state.audits.some((a) => a.event === "loop.ci_indeterminate"));
    state.close();
  });

test("the loop still works off the bare ciCombinedStatus dep when ciSnapshot is absent",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    let calls = 0;
    const loop = loopWith(state, { ciCombinedStatus: async () => (++calls < 2 ? "pending" : "success") });
    const r = await loop.pollCiStatus({ sessionId: "S", repoFullName: "o/r", sha: "s", requester: "U1", sleep: noSleep });
    assert.deepEqual(r, { outcome: "success" });
    state.close();
  });

// ---------------------------------------------------------------------------
// 5. Wiring: the blocking paths are actually connected.
// ---------------------------------------------------------------------------

test("an indeterminate CI overrides the merge recommendation to needs_human_review", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf('ci.outcome === "indeterminate"');
  assert.ok(i > 0, "the finalize path must handle the indeterminate outcome");
  const block = src.slice(i, i + 900);
  assert.match(block, /needs_human_review/);
  assert.match(block, /will not call an unverifiable commit green/);
});

test("the merge tool refuses on an indeterminate or still-running CI", () => {
  const src = S("src/index.ts");
  assert.match(src, /reason: "ci_indeterminate"/);
  assert.match(src, /reason: "ci_pending"/);
  assert.match(src, /could not determine CI state on the head commit/);
});

test("getCiSnapshot has no bare fall-through to success", () => {
  const src = S("src/adapters/github.ts");
  const start = src.indexOf("export async function getCiSnapshot");
  assert.ok(start > 0);
  // Bound on the function's own closing brace, so neither a new neighbour nor
  // its doc comment can widen the slice and hide the tail we care about.
  const rel = src.slice(start).indexOf("\n}\n");
  assert.ok(rel > 0, "could not find the end of getCiSnapshot");
  const body = src.slice(start, start + rel);
  // The pre-b119 bug was the function ENDING in `return "success"`. Every
  // success return must now be guarded by an explicit positive-evidence check.
  assert.doesNotMatch(body.slice(-400), /state = "success"/,
    "the tail of the function must not default to success");
  assert.match(body.slice(-400), /state = "unknown"/,
    "the unclassified fall-through must be unknown");
});

test("ciSnapshot is wired in production", () => {
  const src = S("src/index.ts");
  assert.match(src, /ciSnapshot: async \(\{ repoFullName, sha, requester \}\)/);
  assert.match(src, /getCiSnapshot\(\{ repoFullName, sha, ghToken, apiBase: resolution\.apiBase \}\)/);
});
