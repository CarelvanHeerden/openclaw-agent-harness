// beta.127 — "(no log excerpt available)".
//
// That string is what the b126 smoke wrote onto PR #1028 where the diagnosis
// should have been. The PR said "GitHub CI FAILED on 1dd2fcb1. Do NOT merge
// until CI is green. Failing check logs (excerpt): (no log excerpt available)".
//
// Two independent causes, and the second is the one that survives having the
// right token:
//
//   1. A fine-grained PAT cannot read the Checks API at all (the b125 finding),
//      so the request 403s and the excerpt is empty.
//   2. GitHub Actions check runs routinely carry no `output.title` or
//      `output.summary`. Verified against the real failing commit with a token
//      that CAN read check-runs: the entire excerpt came back as the 17
//      characters "- Tests [failure]" -- non-empty, so any fallback keyed on
//      emptiness would never fire, and worthless to the person told not to
//      merge.
//
// The same token's `Actions: read` can fetch the job log, which contains the
// failing assertion. That is the whole fix.
import test from "node:test";
import assert from "node:assert/strict";

let getFailingCheckLogs;
try {
  ({ getFailingCheckLogs } = await import("../dist/adapters/github.js"));
} catch {
  getFailingCheckLogs = null;
}
const skip = getFailingCheckLogs === null ? "build not present (npm run build)" : false;

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
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const httpErr = (status) => ({ ok: false, status, json: async () => ({}), text: async () => "" });
const textRes = (body) => ({
  ok: true, status: 200, headers: new Map([["content-length", String(body.length)]]),
  json: async () => ({}), text: async () => body, body: {},
});

const JOB_LOG =
  "2026-08-13T17:47:16.4189037Z Summary of all failing tests\n" +
  "2026-08-13T17:47:16.4190000Z FAIL src/__tests__/components/sidebar-nav-placement.test.ts\n" +
  "2026-08-13T17:47:16.4191000Z   ● InfoSec GRC ordering › groups the AI system register\n" +
  "2026-08-13T17:47:16.4192000Z     Expected: 2\n" +
  "2026-08-13T17:47:16.4193000Z     Received: 3\n";

const actionsRoutes = [
  ["/actions/runs?head_sha", () => json({ workflow_runs: [{ id: 7, name: "CI", conclusion: "failure" }] })],
  ["/actions/runs/7/jobs", () => json({ jobs: [{ id: 99, name: "Tests", conclusion: "failure" }] })],
  ["/actions/jobs/99/logs", () => textRes(JOB_LOG)],
];

test("cause 1: check-runs is denied, so the job log answers instead", { skip }, async () => {
  const { restore } = stubFetch([["/check-runs", () => httpErr(403)], ...actionsRoutes]);
  try {
    const out = await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" });
    assert.match(out, /sidebar-nav-placement/);
    assert.match(out, /Expected: 2/);
    assert.doesNotMatch(out, /2026-08-13T17/, "timestamps stripped on the way through");
  } finally { restore(); }
});

test("cause 2: check-runs ANSWERS but says nothing, and that must not block the fallback", { skip }, async () => {
  // The exact b126 shape. A naive `if (text) return text` ships "- Tests
  // [failure]" and never asks the endpoint that knows.
  const { restore } = stubFetch([
    ["/check-runs", () => json({ check_runs: [{ name: "Tests", conclusion: "failure" }] })],
    ...actionsRoutes,
  ]);
  try {
    const out = await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" });
    assert.match(out, /Expected: 2/, "a bare name is not a diagnosis; go and get one");
    assert.ok(out.length > 100, `expected a real excerpt, got ${out.length} chars`);
  } finally { restore(); }
});

test("a check run that DOES carry a summary is used as-is, with no extra API calls", { skip }, async () => {
  const { restore, seen } = stubFetch([
    ["/check-runs", () => json({
      check_runs: [{ name: "Tests", conclusion: "failure", output: { title: "2 failed", summary: "src/a.test.ts failed" } }],
    })],
    ...actionsRoutes,
  ]);
  try {
    const out = await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" });
    assert.match(out, /src\/a.test.ts failed/);
    assert.ok(!seen.some((u) => u.includes("/actions/")), "no point paying for three more round trips");
  } finally { restore(); }
});

test("a green commit produces no excerpt and no job-log fetching", { skip }, async () => {
  const { restore, seen } = stubFetch([
    ["/check-runs", () => json({ check_runs: [{ name: "Tests", conclusion: "success" }] })],
    ["/actions/runs?head_sha", () => json({ workflow_runs: [] })],
  ]);
  try {
    assert.equal(await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "");
  } finally { restore(); }
});

test("when both endpoints are shut the caller gets \"\", not a crash", { skip }, async () => {
  const { restore } = stubFetch([["/check-runs", () => httpErr(403)], ["/actions/runs", () => httpErr(403)]]);
  try {
    assert.equal(await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "");
  } finally { restore(); }
});

test("a network fault is swallowed -- a red PR must still get its recommendation", { skip }, async () => {
  const { restore } = stubFetch([["/check-runs", () => { throw new Error("ECONNRESET"); }]]);
  try {
    assert.equal(await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "");
  } finally { restore(); }
});

test("the bare check-run text is kept when the job log turns out to be unreadable", { skip }, async () => {
  // Worse than a diagnosis, better than nothing: at least name the red job.
  const { restore } = stubFetch([
    ["/check-runs", () => json({ check_runs: [{ name: "Tests", conclusion: "failure" }] })],
    ["/actions/runs?head_sha", () => httpErr(500)],
  ]);
  try {
    assert.equal(await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "- Tests [failure]");
  } finally { restore(); }
});

test("only FAILED jobs are read, and only a couple of them", { skip }, async () => {
  const { restore, seen } = stubFetch([
    ["/check-runs", () => httpErr(403)],
    ["/actions/runs?head_sha", () => json({
      workflow_runs: [{ id: 7, name: "CI", conclusion: "failure" }, { id: 8, name: "Nightly", conclusion: "success" }],
    })],
    ["/actions/runs/7/jobs", () => json({
      jobs: [
        { id: 99, name: "Tests", conclusion: "failure" },
        { id: 100, name: "Lint", conclusion: "success" },
        { id: 101, name: "Build", conclusion: "failure" },
        { id: 102, name: "E2E", conclusion: "failure" },
      ],
    })],
    ["/actions/jobs/", () => textRes(JOB_LOG)],
  ]);
  try {
    await getFailingCheckLogs({ repoFullName: "o/r", sha: "abc", ghToken: "t" });
    assert.ok(!seen.some((u) => u.includes("/runs/8/jobs")), "a green run has nothing to explain");
    assert.ok(!seen.some((u) => u.includes("/jobs/100/logs")), "nor does a green job");
    // Ten red jobs are one cause and nine consequences; a fixed-size excerpt
    // spread across all of them says nothing about any of them.
    const logFetches = seen.filter((u) => /\/actions\/jobs\/\d+\/logs/.test(u));
    assert.equal(logFetches.length, 2);
  } finally { restore(); }
});
