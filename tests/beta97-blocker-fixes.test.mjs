// beta.97 — the three go-live blockers surfaced by the b96 smoke on PR #893.
//
// Fix #8 (plan-JSON truncation): the revise a8ba76d5 + b95 smokes died at
//   `plan_failed: extractJson failed: no JSON in output` where the raw payload
//   STARTED with valid `{"repo":...` but was cut off before it closed. The
//   beta.81 terse re-assertion only fixes prose-drift; a truncated plan
//   re-truncates identically. structuredCall now annotates the failure with
//   `[truncated:max_tokens]` when stop_reason=="max_tokens" and runLeadSdk
//   retries with a COMPACTION instruction.
//
// Fix #4 (terminal-post transport retry): the terminal Slack post was a single
//   fire-and-forget best-effort POST — a transient 429/5xx/network blip dropped
//   the one message a run must not lose (zero-feedback death via transport).
//   SlackProgressPoster.postTerminal() adds bounded retry + Retry-After.
//
// Fix #7 (converging-vs-diverging max-cycles): shipping do_not_merge on a
//   13 → 8 → 12 arc hid real convergence. isConvergingFindingTrend() +
//   advance()'s `shipped_max_cycles_revise_converging` reason surface an
//   ask-to-extend note instead of a bare do_not_merge.
import test from "node:test";
import assert from "node:assert/strict";
import { SlackProgressPoster } from "../dist/slack/progress-poster.js";
import { OrchestratorLoop, isConvergingFindingTrend } from "../dist/orchestrator/loop.js";
import { extractJson } from "../dist/adapters/claude-sdk.js";

// ---- Fix #8: plan-JSON truncation is the `no JSON in output` root cause ------

test("extractJson: a TRUNCATED plan (valid head, missing tail) throws `no JSON in output`", () => {
  // This is the exact shape that killed revise a8ba76d5 + the b95 smoke: the
  // payload starts with a well-formed object but the closing braces never
  // arrived (output hit the token ceiling mid-JSON). scanBalanced never returns
  // to depth 0 → zero candidates → the `no JSON in output` throw. Confirms our
  // diagnosis that the cause is truncation, NOT a missing `tools: []`.
  const truncated =
    '{"repo":"Stitch-Vercel/ProjectThanos","branch":"harness/feat","riskLevel":"high","subTasks":[{"seq":1,"title":"probe","intent":"look';
  assert.throws(() => extractJson(truncated), /no JSON in output/);
});

test("extractJson: a COMPLETE plan (closed braces) parses fine", () => {
  const complete = '{"repo":"a/b","branch":"x","riskLevel":"low","subTasks":[{"seq":1,"title":"t"}]}';
  const out = extractJson(complete);
  assert.deepEqual(JSON.parse(out).repo, "a/b");
});

// ---- Fix #7: convergence trend ----------------------------------------------

test("isConvergingFindingTrend: net downward arc converges (incl. a late bump)", () => {
  // The exact #893 arc: 13 → 8 → 12. Ended below start (12 < 13) → converging,
  // because the cycle-3 bump was new review surface from cycle-3 fixes.
  assert.equal(isConvergingFindingTrend([13, 8, 12]), true);
  assert.equal(isConvergingFindingTrend([13, 8, 4]), true);
  assert.equal(isConvergingFindingTrend([20, 10]), true);
});

test("isConvergingFindingTrend: flat or net-rising arc does NOT converge", () => {
  assert.equal(isConvergingFindingTrend([8, 9, 11]), false); // rising
  assert.equal(isConvergingFindingTrend([10, 10, 10]), false); // flat
  assert.equal(isConvergingFindingTrend([5, 5]), false); // no net drop
  assert.equal(isConvergingFindingTrend([8, 12, 13]), false); // diverging
});

test("isConvergingFindingTrend: insufficient/degenerate signal is not converging", () => {
  assert.equal(isConvergingFindingTrend(undefined), false);
  assert.equal(isConvergingFindingTrend([]), false);
  assert.equal(isConvergingFindingTrend([7]), false); // single cycle
  assert.equal(isConvergingFindingTrend([0, 0]), false); // nothing to converge from
});

test("advance(): max-cycles revise emits the converging reason on a downward arc", () => {
  const base = {
    currentStatus: "reviewing",
    verdict: "revise",
    cyclesRan: 3,
    maxCycles: 3,
    reactions: { shipIt: false, abort: false, pause: false },
    budgetExhausted: false,
    hardTimeout: false,
  };
  // Converging arc → distinct reason (surfaces ask-to-extend).
  assert.deepEqual(OrchestratorLoop.advance({ ...base, findingCountsByCycle: [13, 8, 12] }), {
    nextStatus: "done",
    reason: "shipped_max_cycles_revise_converging",
  });
  // Diverging arc → plain do_not_merge ship.
  assert.deepEqual(OrchestratorLoop.advance({ ...base, findingCountsByCycle: [8, 9, 11] }), {
    nextStatus: "done",
    reason: "shipped_max_cycles_revise",
  });
  // No trend data → plain reason (back-compat: undefined findingCountsByCycle).
  assert.deepEqual(OrchestratorLoop.advance({ ...base }), {
    nextStatus: "done",
    reason: "shipped_max_cycles_revise",
  });
});

test("advance(): a pass/block verdict is unaffected by the convergence branch", () => {
  const base = {
    currentStatus: "reviewing",
    cyclesRan: 3,
    maxCycles: 3,
    findingCountsByCycle: [13, 8, 12],
    reactions: { shipIt: false, abort: false, pause: false },
    budgetExhausted: false,
    hardTimeout: false,
  };
  assert.equal(OrchestratorLoop.advance({ ...base, verdict: "pass" }).reason, "adversary_pass");
  assert.equal(OrchestratorLoop.advance({ ...base, verdict: "block" }).reason, "adversary_block");
});

// ---- Fix #4: terminal-post bounded retry ------------------------------------

function makeFetchSeq(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
}

function jsonRes({ status = 200, body = { ok: true, ts: "1.1" }, retryAfter } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
    json: async () => body,
  };
}

const noSleep = async () => {};
const logger = { info() {}, warn() {} };

test("postTerminal: succeeds first try, one attempt", async () => {
  const poster = new SlackProgressPoster({
    slackToken: "xoxb-t",
    logger,
    fetchImpl: makeFetchSeq([jsonRes({ body: { ok: true, ts: "9.9" } })]),
  });
  const r = await poster.postTerminal("C123", "1785.1", "hi", { sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.ts, "9.9");
});

test("postTerminal: retries a 429 then succeeds", async () => {
  const poster = new SlackProgressPoster({
    slackToken: "xoxb-t",
    logger,
    fetchImpl: makeFetchSeq([
      jsonRes({ status: 429, retryAfter: "1" }),
      jsonRes({ body: { ok: true, ts: "2.2" } }),
    ]),
  });
  const r = await poster.postTerminal("C123", "1785.1", "hi", { sleepImpl: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test("postTerminal: retries transient 5xx/network then gives up after maxAttempts", async () => {
  const poster = new SlackProgressPoster({
    slackToken: "xoxb-t",
    logger,
    fetchImpl: makeFetchSeq([
      jsonRes({ status: 503, ok: false }),
      new Error("fetch failed"),
      jsonRes({ status: 500, ok: false }),
      jsonRes({ status: 502, ok: false }),
    ]),
  });
  const r = await poster.postTerminal("C123", "1785.1", "hi", { maxAttempts: 3, sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3); // stopped at the cap, not the 4th response
});

test("postTerminal: a non-retryable Slack error (bad channel) stops immediately", async () => {
  const poster = new SlackProgressPoster({
    slackToken: "xoxb-t",
    logger,
    fetchImpl: makeFetchSeq([jsonRes({ body: { ok: false, error: "channel_not_found" } })]),
  });
  const r = await poster.postTerminal("Cbad", "1785.1", "hi", { sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1); // did NOT retry a structural failure
  assert.equal(r.error, "channel_not_found");
});

test("postTerminal: no real binding fails fast without a fetch", async () => {
  let called = 0;
  const poster = new SlackProgressPoster({
    slackToken: "xoxb-t",
    logger,
    fetchImpl: async () => {
      called += 1;
      return jsonRes();
    },
  });
  const r = await poster.postTerminal("C123", "agent:uuid", "hi", { sleepImpl: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_real_binding");
  assert.equal(r.attempts, 1);
  assert.equal(called, 0); // gate short-circuits before any HTTP
});
