/**
 * beta.23: OKF auto-forward (Option B, deterministic plugin-side hook).
 *
 * Beta.22 shipped the prompt-side instruction (model-reliant). Beta.23
 * adds a deterministic plugin-side hook pair:
 *   - before_prompt_build: parse `## Relevant Knowledge (OKF)` from
 *     context, cache under session key
 *   - before_tool_call filtered to harness_run/harness_start_session:
 *     rewrite params with cached concepts
 *
 * These tests cover the pure decision + parsing logic and the cache
 * semantics. The live hook wiring lives in src/index.ts and is exercised
 * only end-to-end.
 */
import test from "node:test";
import assert from "node:assert/strict";

let parseOkfBlocksFromContext, OkfConceptCache, decideAutoForward, buildRewrittenParams, cacheKeyForCtx;
try {
  ({
    parseOkfBlocksFromContext,
    OkfConceptCache,
    decideAutoForward,
    buildRewrittenParams,
    cacheKeyForCtx,
  } = await import("../dist/hooks/okf-auto-forward.js"));
} catch {
  parseOkfBlocksFromContext = null;
}

const skipAll = { skip: parseOkfBlocksFromContext === null };

// ============================================================
// parseOkfBlocksFromContext
// ============================================================

test(
  "beta.23: parseOkfBlocksFromContext extracts id + summary + tags from OKF section",
  skipAll,
  () => {
    // Verbatim shape of an OKF block Carel forwarded from Slack.
    const text = [
      "Some unrelated preamble.",
      "",
      "## Relevant Knowledge (OKF)",
      "",
      "### Google Workspace OAuth (Credential)",
      "OAuth credentials for Carel's Google Workspace calendar (destination)",
      "Tags: credential, oauth, google-workspace, google, calendar",
      "Links to: workflows/health-check, workflows/gmail-sync, workflows/mailcow-sync",
      "ID: `credentials/workspace-oauth`",
      "",
      "### Calendar Health Check (N8N Workflow)",
      "Daily authentication testing for Gmail and Workspace OAuth credentials",
      "Tags: workflow, n8n, monitoring, health-check, auth",
      "Links to: MEMORY, credentials/gmail-oauth, credentials/workspace-oauth",
      "ID: `workflows/health-check`",
      "",
      "## Some Other Section",
      "This should NOT be parsed as a concept.",
    ].join("\n");

    const concepts = parseOkfBlocksFromContext(text);
    assert.equal(concepts.length, 2, `expected 2 concepts, got ${JSON.stringify(concepts)}`);

    const [a, b] = concepts;
    assert.equal(a.id, "credentials/workspace-oauth");
    assert.equal(a.summary, "OAuth credentials for Carel's Google Workspace calendar (destination)");
    assert.deepEqual(a.tags, ["credential", "oauth", "google-workspace", "google", "calendar"]);

    assert.equal(b.id, "workflows/health-check");
    assert.equal(b.summary, "Daily authentication testing for Gmail and Workspace OAuth credentials");
    assert.ok(b.tags.includes("workflow"));
  },
);

test(
  "beta.23: parseOkfBlocksFromContext returns empty when no OKF section",
  skipAll,
  () => {
    assert.deepEqual(parseOkfBlocksFromContext("just plain text"), []);
    assert.deepEqual(parseOkfBlocksFromContext(""), []);
    assert.deepEqual(parseOkfBlocksFromContext(undefined), []);
  },
);

test(
  "beta.23: parseOkfBlocksFromContext falls back to H3 title as summary when body has no summary line",
  skipAll,
  () => {
    const text = [
      "## Relevant Knowledge (OKF)",
      "",
      "### Some Concept Title",
      "ID: `some/concept`",
    ].join("\n");
    const concepts = parseOkfBlocksFromContext(text);
    assert.equal(concepts.length, 1);
    assert.equal(concepts[0].summary, "Some Concept Title");
  },
);

test(
  "beta.23: parseOkfBlocksFromContext skips blocks that lack an ID: line",
  skipAll,
  () => {
    const text = [
      "## Relevant Knowledge (OKF)",
      "",
      "### No ID Here",
      "This block has no id, must be skipped.",
      "Tags: nope",
      "",
      "### Valid Block",
      "Description line.",
      "Tags: real",
      "ID: `foo/bar`",
    ].join("\n");
    const concepts = parseOkfBlocksFromContext(text);
    assert.equal(concepts.length, 1);
    assert.equal(concepts[0].id, "foo/bar");
  },
);

test(
  "beta.23: parseOkfBlocksFromContext accepts variant heading `## Relevant Knowledge` (no OKF suffix)",
  skipAll,
  () => {
    const text = [
      "## Relevant Knowledge",
      "",
      "### Something",
      "Description",
      "ID: `x/y`",
    ].join("\n");
    const concepts = parseOkfBlocksFromContext(text);
    assert.equal(concepts.length, 1);
    assert.equal(concepts[0].id, "x/y");
  },
);

// ============================================================
// OkfConceptCache
// ============================================================

test(
  "beta.23: OkfConceptCache set/get round-trips concepts",
  skipAll,
  () => {
    const cache = new OkfConceptCache();
    cache.set("session-1", [{ id: "a" }, { id: "b" }]);
    const got = cache.get("session-1");
    assert.deepEqual(got, [{ id: "a" }, { id: "b" }]);
  },
);

test(
  "beta.23: OkfConceptCache TTL expires stale entries",
  skipAll,
  () => {
    let now = 1_000_000;
    const cache = new OkfConceptCache({ ttlMs: 1000, now: () => now });
    cache.set("s", [{ id: "a" }]);
    now += 500;
    assert.deepEqual(cache.get("s"), [{ id: "a" }], "within TTL");
    now += 1000; // past TTL
    assert.equal(cache.get("s"), undefined, "past TTL must expire");
  },
);

test(
  "beta.23: OkfConceptCache LRU-evicts when over cap",
  skipAll,
  () => {
    const cache = new OkfConceptCache({ maxSessions: 2 });
    cache.set("a", [{ id: "1" }]);
    cache.set("b", [{ id: "2" }]);
    cache.set("c", [{ id: "3" }]); // should evict "a"
    assert.equal(cache.get("a"), undefined);
    assert.deepEqual(cache.get("b"), [{ id: "2" }]);
    assert.deepEqual(cache.get("c"), [{ id: "3" }]);
    assert.equal(cache.size(), 2);
  },
);

test(
  "beta.23: OkfConceptCache read refreshes LRU position",
  skipAll,
  () => {
    const cache = new OkfConceptCache({ maxSessions: 2 });
    cache.set("a", [{ id: "1" }]);
    cache.set("b", [{ id: "2" }]);
    cache.get("a"); // bumps "a" to most-recent
    cache.set("c", [{ id: "3" }]); // should now evict "b", not "a"
    assert.deepEqual(cache.get("a"), [{ id: "1" }]);
    assert.equal(cache.get("b"), undefined);
    assert.deepEqual(cache.get("c"), [{ id: "3" }]);
  },
);

test(
  "beta.23: OkfConceptCache set/get with empty sessionKey no-ops",
  skipAll,
  () => {
    const cache = new OkfConceptCache();
    cache.set("", [{ id: "a" }]);
    assert.equal(cache.size(), 0);
    assert.equal(cache.get(""), undefined);
  },
);

// ============================================================
// decideAutoForward
// ============================================================

test(
  "beta.23: decideAutoForward injects when tool is harness_run and cache has concepts",
  skipAll,
  () => {
    const decision = decideAutoForward({
      toolName: "harness_run",
      params: { request: "do X" },
      cached: [{ id: "services/retry" }],
    });
    assert.equal(decision.inject, true);
    assert.equal(decision.injectionSite, "root");
    assert.equal(decision.concepts.length, 1);
  },
);

test(
  "beta.23: decideAutoForward injects for harness_start_session under brief.relevantConcepts",
  skipAll,
  () => {
    const decision = decideAutoForward({
      toolName: "harness_start_session",
      params: { brief: { title: "t", motivation: "m", acceptanceCriteria: ["c"] } },
      cached: [{ id: "services/retry" }],
    });
    assert.equal(decision.inject, true);
    assert.equal(decision.injectionSite, "brief");
  },
);

test(
  "beta.23: decideAutoForward respects caller-supplied relevantConcepts (harness_run)",
  skipAll,
  () => {
    const decision = decideAutoForward({
      toolName: "harness_run",
      params: { request: "do X", relevantConcepts: [{ id: "caller/one" }] },
      cached: [{ id: "services/retry" }],
    });
    assert.equal(decision.inject, false, "must not overwrite caller-supplied concepts");
  },
);

test(
  "beta.23: decideAutoForward respects caller-supplied brief.relevantConcepts (harness_start_session)",
  skipAll,
  () => {
    const decision = decideAutoForward({
      toolName: "harness_start_session",
      params: {
        brief: {
          title: "t",
          motivation: "m",
          acceptanceCriteria: ["c"],
          relevantConcepts: [{ id: "caller/one" }],
        },
      },
      cached: [{ id: "services/retry" }],
    });
    assert.equal(decision.inject, false);
  },
);

test(
  "beta.23: decideAutoForward no-ops for other tools",
  skipAll,
  () => {
    for (const toolName of ["harness_status", "harness_health", "web_search", "random"]) {
      assert.equal(
        decideAutoForward({ toolName, params: {}, cached: [{ id: "x" }] }).inject,
        false,
        `must not touch ${toolName}`,
      );
    }
  },
);

test(
  "beta.23: decideAutoForward no-ops when cache is empty",
  skipAll,
  () => {
    assert.equal(
      decideAutoForward({ toolName: "harness_run", params: {}, cached: undefined }).inject,
      false,
    );
    assert.equal(
      decideAutoForward({ toolName: "harness_run", params: {}, cached: [] }).inject,
      false,
    );
  },
);

// ============================================================
// buildRewrittenParams
// ============================================================

test(
  "beta.23: buildRewrittenParams for harness_run adds relevantConcepts at root",
  skipAll,
  () => {
    const rewritten = buildRewrittenParams(
      "harness_run",
      { requester: "U1", request: "do X" },
      [{ id: "a" }],
    );
    assert.equal(rewritten.requester, "U1", "existing params preserved");
    assert.deepEqual(rewritten.relevantConcepts, [{ id: "a" }]);
  },
);

test(
  "beta.23: buildRewrittenParams for harness_start_session adds under brief",
  skipAll,
  () => {
    const rewritten = buildRewrittenParams(
      "harness_start_session",
      {
        requester: "U1",
        brief: { title: "t", motivation: "m", acceptanceCriteria: ["c"] },
      },
      [{ id: "a" }],
    );
    assert.equal(rewritten.requester, "U1");
    assert.equal(rewritten.brief.title, "t", "existing brief fields preserved");
    assert.deepEqual(rewritten.brief.relevantConcepts, [{ id: "a" }]);
  },
);

test(
  "beta.23: buildRewrittenParams does NOT mutate the input params",
  skipAll,
  () => {
    const input = { requester: "U1", request: "do X" };
    const rewritten = buildRewrittenParams("harness_run", input, [{ id: "a" }]);
    assert.equal(input.relevantConcepts, undefined, "input must not be mutated");
    assert.notEqual(rewritten, input, "rewritten must be a new object");
  },
);

// ============================================================
// cacheKeyForCtx
// ============================================================

test(
  "beta.23: cacheKeyForCtx prefers sessionKey over sessionId",
  skipAll,
  () => {
    assert.equal(cacheKeyForCtx({ sessionKey: "k1", sessionId: "s1" }), "k1");
    assert.equal(cacheKeyForCtx({ sessionId: "s1" }), "s1");
    assert.equal(cacheKeyForCtx({}), "");
    assert.equal(cacheKeyForCtx(undefined), "");
  },
);
