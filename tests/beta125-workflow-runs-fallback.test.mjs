// beta.125 — the verdict was one endpoint away the whole time.
//
// b124 correctly noticed that a 403 on check-runs is a settled answer and
// stopped re-asking it 44 times. Then it told the operator to grant the
// fine-grained PAT a "Checks: read" repository permission, and the operator
// went looking, and it isn't there. It has never been there:
//
//   "there is no 'checks' permission in FG PATs at all. Not for read or
//    write. This has been causing confusion for a long time now."
//        -- GitHub, on github/rest-api-description#4290
//
// It is on GitHub's own published list of fine-grained limitations ("Using
// fine-grained personal access token to call the Checks API"). The REST
// reference still names the permission on every Checks endpoint because the
// docs are generated from a schema that is wrong. So b124 shipped an
// instruction that cannot be followed, and the run still ended blind.
//
// The token in the b123 smoke already held `Actions: read` -- a permission
// fine-grained PATs DO support -- and ProjectThanos runs its CI on GitHub
// Actions. `GET /actions/runs?head_sha=` would have answered the question
// every one of those 44 polls was asking.
//
// What the fallback must not become is a way to manufacture a green. It sees
// everything Actions ran; it cannot see a check run posted by a third-party
// GitHub App. b118 shipped a false green by trusting one narrow signal and
// calling it CI. So the rule here: use it, and say you used it.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let getCiSnapshot;
try {
  ({ getCiSnapshot } = await import("../dist/adapters/github.js"));
} catch {
  getCiSnapshot = null;
}
const skip = getCiSnapshot === null ? "build not present (npm run build)" : false;

function stubFetch(routes) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    for (const [pat, handler] of routes) if (String(url).includes(pat)) return handler(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { restore: () => { globalThis.fetch = orig; }, seen };
}
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
const httpErr = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "" });
const okStatus = () => json({ state: "success", total_count: 1 });
const noStatus = () => json({ state: "pending", total_count: 0 });
const wfRuns = (runs, total) => () => json({ total_count: total ?? runs.length, workflow_runs: runs });
const done = (conclusion) => ({ status: "completed", conclusion });

// ---------------------------------------------------------------------------
// 1. The corrected remedy. This is the part an operator reads at 2am.
// ---------------------------------------------------------------------------

test("the check-runs remedy no longer sends anyone hunting for a permission that does not exist", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", () => httpErr(403)],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "deadbeef", ghToken: "t" });
    assert.equal(snap.state, "unknown", "b119 still holds when BOTH endpoints are shut");
    assert.doesNotMatch(
      snap.permanentDenial,
      /needs the "Checks: read"/,
      'b124 told operators to grant "Checks: read". No such permission exists; that sentence must be gone.',
    );
    assert.match(snap.permanentDenial, /cannot call the Checks API at all/, "say the true thing");
    assert.match(snap.permanentDenial, /classic PAT|GitHub App/, "offer the routes that do work");
  } finally { restore(); }
});

test("the statuses remedy still names a permission that DOES exist", { skip }, async () => {
  const { restore } = stubFetch([["/status", () => httpErr(403)], ["/check-runs", () => json({ total_count: 0, check_runs: [] })]]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    // "Commit statuses" is a real fine-grained permission, unlike Checks.
    assert.match(snap.permanentDenial, /Commit statuses: read/);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// 2. The fallback answers the question b123 could not.
// ---------------------------------------------------------------------------

test("the exact b123 shape now produces a real verdict instead of 896 seconds of nothing", { skip }, async () => {
  const { restore, seen } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", wfRuns([done("success"), done("success"), done("skipped")])],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "Stitch-Vercel/ProjectThanos", sha: "02299b20", ghToken: "t" });
    assert.equal(snap.state, "success", "three green Actions runs and a green legacy status IS a green");
    assert.equal(snap.checksSource, "workflow_runs");
    assert.equal(snap.checkTotal, 3);
    assert.ok(seen.some((u) => u.includes("head_sha=02299b20")), "must ask about THIS commit, not the branch");
  } finally { restore(); }
});

test("a red workflow run is a red verdict, with no hedging", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", wfRuns([done("success"), done("failure")])],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "failure", "the fallback's job is to catch exactly this");
    assert.equal(snap.checkFailed, 1);
  } finally { restore(); }
});

test("a workflow run still going is pending, not a pass", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", wfRuns([done("success"), { status: "in_progress", conclusion: null }])],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "pending");
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// 3. The fallback must not become a hole in the b118/b119 floor.
// ---------------------------------------------------------------------------

test("a green from the fallback SAYS it came from the fallback", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", wfRuns([done("success")])],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "success");
    assert.match(snap.reason, /workflow-runs fallback/, "a reader must be able to tell which signal this green is from");
    assert.match(snap.reason, /third-party check run is unverified/, "name the blind spot explicitly");
    assert.doesNotMatch(snap.reason, /\d+ check run\(s\) passed/, "do not claim to have read check runs we never read");
  } finally { restore(); }
});

test("a truncated workflow-runs page is refused, exactly like a truncated check-runs page", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    // 100 read, 140 exist. The 40 unread could contain the failure.
    ["/actions/runs", wfRuns(Array.from({ length: 100 }, () => done("success")), 140)],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "unknown", "a partial list that looks complete is the b118 bug's shape");
    assert.match(snap.reason, /truncated/);
  } finally { restore(); }
});

test("when the fallback is denied too, the run is blind and says so", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", () => httpErr(403)],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "unknown");
    assert.equal(snap.checksSource, "", "no source, because nothing answered");
    assert.match(snap.reason, /workflow-runs API HTTP 403/);
  } finally { restore(); }
});

test("an unreadable STATUSES api is still fatal even when workflow runs are green", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", () => httpErr(403)],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", wfRuns([done("success")])],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "unknown", "the fallback replaces the CHECKS signal, not the whole gate");
  } finally { restore(); }
});

test("a red legacy status still beats a green workflow-runs read", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", () => json({ state: "failure", total_count: 1 })],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", wfRuns([done("success")])],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "failure", "Vercel going red is still red -- this is the b118 signal");
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// 4. Narrowness: only a permanent denial routes around the real endpoint.
// ---------------------------------------------------------------------------

test("a transient 5xx does NOT trigger the fallback -- it gets re-polled properly", { skip }, async () => {
  let askedActions = false;
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(503)],
    ["/actions/runs", () => { askedActions = true; return wfRuns([done("success")])(); }],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(askedActions, false, "a 503 means ask again in 20s, not ask somewhere else");
    assert.equal(snap.state, "unknown");
    assert.equal(snap.permanentDenial, "", "and it is not a permanent denial either");
  } finally { restore(); }
});

test("a readable check-runs list never consults the fallback", { skip }, async () => {
  let askedActions = false;
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => json({ total_count: 1, check_runs: [done("success")] })],
    ["/actions/runs", () => { askedActions = true; return wfRuns([])(); }],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(askedActions, false, "no extra API call on the happy path");
    assert.equal(snap.checksSource, "check_runs");
    assert.match(snap.reason, /check run\(s\) passed/);
  } finally { restore(); }
});

test("workflow_runs_fallback: false restores b124 behaviour exactly", { skip }, async () => {
  let askedActions = false;
  const { restore } = stubFetch([
    ["/status", okStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", () => { askedActions = true; return wfRuns([done("success")])(); }],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t", workflowRunsFallback: false });
    assert.equal(askedActions, false);
    assert.equal(snap.state, "unknown");
    assert.ok(snap.permanentDenial, "the denial is still reported, as in b124");
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// 5. A repo with genuinely no CI must not be dragged into a verdict.
// ---------------------------------------------------------------------------

test("no statuses and no workflow runs is 'none', not a green", { skip }, async () => {
  const { restore } = stubFetch([
    ["/status", noStatus],
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs", wfRuns([])],
  ]);
  try {
    const snap = await getCiSnapshot({ repoFullName: "o/r", sha: "s", ghToken: "t" });
    assert.equal(snap.state, "none", "an empty fallback means no CI ran, which is its own answer");
  } finally { restore(); }
});
