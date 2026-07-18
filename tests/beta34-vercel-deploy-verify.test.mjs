/**
 * beta.34: Vercel deploy verification by merge commit SHA.
 */
import test from "node:test";
import assert from "node:assert/strict";

let verifyDeploymentForSha;
try {
  ({ verifyDeploymentForSha } = await import("../dist/vercel/logs.js"));
} catch {
  verifyDeploymentForSha = null;
}

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}
const logger = { info() {}, warn() {} };
const j = (body) => ({ ok: true, status: 200, json: async () => body });

test("verifyDeploymentForSha: READY on matching deployment",
  { skip: verifyDeploymentForSha === null }, async () => {
    const restore = stubFetch(async (url) => {
      assert.match(url, /\/v6\/deployments/);
      return j({ deployments: [{ uid: "dpl_1", url: "app.vercel.app", state: "READY", meta: { githubCommitSha: "sha123" }, created: 1 }] });
    });
    try {
      const r = await verifyDeploymentForSha({ vercelToken: "t", projectId: "p", sha: "sha123", waitSeconds: 5, pollIntervalMs: 10, logger });
      assert.equal(r.status, "ready");
      assert.equal(r.deploymentUrl, "app.vercel.app");
    } finally { restore(); }
  });

test("verifyDeploymentForSha: ERROR pulls logs",
  { skip: verifyDeploymentForSha === null }, async () => {
    const restore = stubFetch(async (url) => {
      if (url.includes("/events")) return j([{ text: "build failed: type error" }, { text: "exit 1" }]);
      return j({ deployments: [{ uid: "dpl_2", url: "app2.vercel.app", state: "ERROR", meta: { githubCommitSha: "shaERR" }, created: 1 }] });
    });
    try {
      const r = await verifyDeploymentForSha({ vercelToken: "t", projectId: "p", sha: "shaERR", waitSeconds: 5, pollIntervalMs: 10, logger });
      assert.equal(r.status, "error");
      assert.match(r.logsExcerpt ?? "", /build failed/);
    } finally { restore(); }
  });

test("verifyDeploymentForSha: unavailable when no matching deployment in window",
  { skip: verifyDeploymentForSha === null }, async () => {
    const restore = stubFetch(async () => j({ deployments: [{ uid: "x", url: "u", state: "READY", meta: { githubCommitSha: "other" }, created: 1 }] }));
    try {
      const r = await verifyDeploymentForSha({ vercelToken: "t", projectId: "p", sha: "nomatch", waitSeconds: 0.05, pollIntervalMs: 10, logger });
      assert.equal(r.status, "unavailable");
    } finally { restore(); }
  });
