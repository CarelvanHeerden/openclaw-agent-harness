/**
 * Tests for the LIVE PR-creation path: `createPullRequest` in
 * src/adapters/github.ts. (The old src/adapters/github-pr.ts was dead code —
 * never imported by the loop — and was removed in beta.32.)
 *
 * beta.32 behaviour under test:
 *   - non-draft PR posts draft:false
 *   - a draft PR that 422s with a "draft"-mentioning body is retried as
 *     non-draft (so the run doesn't die at the final step on repos that
 *     don't support draft PRs)
 *   - a genuine non-draft 422 still throws
 */
import test from "node:test";
import assert from "node:assert/strict";

let createPullRequest;
try {
  ({ createPullRequest } = await import("../dist/adapters/github.js"));
} catch {
  createPullRequest = null;
}

const base = {
  repoFullName: "CarelvanHeerden/openclaw-agent-harness",
  head: "harness/foo",
  base: "main",
  title: "harness: Add /hello endpoint",
  body: "## Motivation\nsmoke",
  ghToken: "ghp_test",
};

function stubFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

test("createPullRequest: non-draft posts draft:false and returns html_url",
  { skip: createPullRequest === null }, async () => {
    const seen = [];
    const restore = stubFetch(async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      assert.match(init.headers.Authorization, /^Bearer ghp_test/);
      return { ok: true, status: 201, text: async () => "", json: async () => ({ html_url: "https://github.com/x/y/pull/9", number: 9, node_id: "n1" }) };
    });
    try {
      const out = await createPullRequest({ ...base, draft: false });
      assert.equal(out.htmlUrl, "https://github.com/x/y/pull/9");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].body.draft, false);
    } finally { restore(); }
  });

test("createPullRequest: draft 422 (draft not supported) retries as non-draft (beta.32)",
  { skip: createPullRequest === null }, async () => {
    let call = 0;
    const bodies = [];
    const restore = stubFetch(async (url, init) => {
      call++;
      bodies.push(JSON.parse(init.body).draft);
      if (call === 1) {
        // first attempt: draft:true -> 422 mentioning draft
        return { ok: false, status: 422, clone() { return { text: async () => JSON.stringify({ message: "Draft pull requests are not supported in this repository." }) }; }, text: async () => "should not read this on retry path" };
      }
      // retry: draft:false -> success
      return { ok: true, status: 201, text: async () => "", json: async () => ({ html_url: "https://github.com/x/y/pull/10", number: 10, node_id: "n2" }) };
    });
    try {
      const out = await createPullRequest({ ...base, draft: true });
      assert.equal(out.number, 10);
      assert.equal(call, 2, "must retry exactly once");
      assert.deepEqual(bodies, [true, false], "first draft:true then retry draft:false");
    } finally { restore(); }
  });

test("createPullRequest: genuine non-draft 422 still throws (beta.32)",
  { skip: createPullRequest === null }, async () => {
    const restore = stubFetch(async () => ({
      ok: false, status: 422,
      clone() { return { text: async () => JSON.stringify({ message: "Validation Failed: head sha not found" }) }; },
      text: async () => JSON.stringify({ message: "Validation Failed: head sha not found" }),
    }));
    try {
      await assert.rejects(createPullRequest({ ...base, draft: false }), /422/);
    } finally { restore(); }
  });

test("createPullRequest: draft 422 NOT about draft is not retried, throws (beta.32)",
  { skip: createPullRequest === null }, async () => {
    let call = 0;
    const restore = stubFetch(async () => {
      call++;
      return {
        ok: false, status: 422,
        clone() { return { text: async () => JSON.stringify({ message: "head sha not found" }) }; },
        text: async () => JSON.stringify({ message: "head sha not found" }),
      };
    });
    try {
      await assert.rejects(createPullRequest({ ...base, draft: true }), /422/);
      assert.equal(call, 1, "must NOT retry when the 422 is unrelated to draft");
    } finally { restore(); }
  });
