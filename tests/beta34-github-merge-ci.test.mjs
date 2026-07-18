/**
 * beta.34: github adapter — combined CI status + PR merge.
 */
import test from "node:test";
import assert from "node:assert/strict";

let getCombinedStatus, mergePullRequest, getPullRequest;
try {
  ({ getCombinedStatus, mergePullRequest, getPullRequest } = await import("../dist/adapters/github.js"));
} catch {
  getCombinedStatus = null;
}

function stubFetch(routes) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    for (const [pat, handler] of routes) {
      if (url.includes(pat)) return handler(url, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return () => { globalThis.fetch = orig; };
}
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

test("getCombinedStatus: pending when a check run is still running",
  { skip: getCombinedStatus === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 1 })],
      ["/check-runs", () => json({ check_runs: [{ status: "in_progress", conclusion: null }] })],
    ]);
    try {
      assert.equal(await getCombinedStatus({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "pending");
    } finally { restore(); }
  });

test("getCombinedStatus: failure when a check concluded failure",
  { skip: getCombinedStatus === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 0 })],
      ["/check-runs", () => json({ check_runs: [{ status: "completed", conclusion: "failure" }] })],
    ]);
    try {
      assert.equal(await getCombinedStatus({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "failure");
    } finally { restore(); }
  });

test("getCombinedStatus: none when nothing configured",
  { skip: getCombinedStatus === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "pending", total_count: 0 })],
      ["/check-runs", () => json({ check_runs: [] })],
    ]);
    try {
      assert.equal(await getCombinedStatus({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "none");
    } finally { restore(); }
  });

test("getCombinedStatus: success when statuses+checks pass",
  { skip: getCombinedStatus === null }, async () => {
    const restore = stubFetch([
      ["/status", () => json({ state: "success", total_count: 2 })],
      ["/check-runs", () => json({ check_runs: [{ status: "completed", conclusion: "success" }] })],
    ]);
    try {
      assert.equal(await getCombinedStatus({ repoFullName: "o/r", sha: "abc", ghToken: "t" }), "success");
    } finally { restore(); }
  });

test("mergePullRequest: squash merge returns sha",
  { skip: getCombinedStatus === null }, async () => {
    let body;
    const restore = stubFetch([
      ["/merge", (_u, init) => { body = JSON.parse(init.body); return json({ merged: true, sha: "deadbeef", message: "Pull Request successfully merged" }); }],
    ]);
    try {
      const r = await mergePullRequest({ repoFullName: "o/r", prNumber: 846, ghToken: "t" });
      assert.equal(r.merged, true);
      assert.equal(r.sha, "deadbeef");
      assert.equal(body.merge_method, "squash");
    } finally { restore(); }
  });

test("mergePullRequest: throws on 405 (not mergeable)",
  { skip: getCombinedStatus === null }, async () => {
    const restore = stubFetch([
      ["/merge", () => json({ message: "Pull Request is not mergeable" }, false, 405)],
    ]);
    try {
      await assert.rejects(mergePullRequest({ repoFullName: "o/r", prNumber: 1, ghToken: "t" }), /405|not mergeable/);
    } finally { restore(); }
  });

test("getPullRequest: returns head sha + merged state",
  { skip: getCombinedStatus === null }, async () => {
    const restore = stubFetch([
      ["/pulls/846", () => json({ head: { sha: "h1" }, state: "open", merged: false, mergeable: true, base: { ref: "main" } })],
    ]);
    try {
      const pr = await getPullRequest({ repoFullName: "o/r", prNumber: 846, ghToken: "t" });
      assert.equal(pr.headSha, "h1");
      assert.equal(pr.merged, false);
      assert.equal(pr.baseBranch, "main");
    } finally { restore(); }
  });
