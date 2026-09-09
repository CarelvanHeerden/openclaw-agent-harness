/**
 * rc.4: the configured first-token deadline, and what a timed-out review is.
 *
 * The incident: the adversary reviewer died before its first token on all three
 * attempts, the ACP logs said `first_token_timeout after 30 seconds`, and the
 * review surfaced as `extractJson failed: no JSON in output`.
 *
 * Two separate faults, and they compound.
 *
 * The 30s was `runWorkerAcp`'s own default. `loop.sdk_first_token_timeout_seconds`
 * reached the WORKER roles through `runWorker` and reached the six structured
 * roles through nothing at all, so raising it changed nothing and the number in
 * the logs matched no configured value. An operator reading those logs is being
 * shown a deadline they cannot find in their own config file.
 *
 * Then, because a turn nobody waited for looks exactly like a turn that replied
 * with an empty string, the ladder ran its JSON machinery over the silence:
 * extract, fail, and re-ask with "your previous reply could not be parsed as
 * the required JSON" -- to a backend that had not emitted a byte. Three of
 * those, and then `isAdversaryFormatError` matched the exhaustion message and
 * bought three MORE on a format nudge. Six calls, no review, and an explanation
 * describing a formatting mistake that never happened.
 *
 * These tests use SHORT deadlines and a fixture that delays a real child
 * process, rather than 30-second waits. The property under test is never "30",
 * it is "the number that was configured, whatever it is".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-acp-agent.mjs");
const root = resolve(HERE, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let runWorkerAcp, runStructuredAcp, runStructuredLadder, isAdversaryFormatError, exhaustionVerdict;
try {
  ({ runWorkerAcp, runStructuredAcp } = await import("../dist/adapters/acp.js"));
  ({ runStructuredLadder, exhaustionVerdict } = await import("../dist/adapters/shared/structured.js"));
  ({ isAdversaryFormatError } = await import("../dist/orchestrator/adversary.js"));
} catch {
  runWorkerAcp = null;
}
const skip = { skip: runWorkerAcp === null };

const agent = (scenario, env = {}) => ({
  command: process.execPath,
  args: [FAKE],
  env: { FAKE_ACP_SCENARIO: scenario, ...env },
});

const REVIEW_KEYS = { requiredKeys: ["verdict", "findings", "summary"], label: "adversary" };

function structured(scenario, over = {}, env = {}) {
  return runStructuredAcp({
    agent: agent(scenario, env),
    role: "adversary",
    cwd: tmpdir(),
    systemPrompt: "sys",
    userMessage: "review this",
    model: "",
    timeoutSeconds: 10,
    streamOpenTimeoutSeconds: 5,
    validation: REVIEW_KEYS,
    ...over,
  });
}

// ===========================================================================
// 1. The configured deadline reaches the structured ACP worker
// ===========================================================================

test("rc4: a configured first-token timeout reaches the structured ACP worker", skip, async () => {
  // The fixture opens its stream and then thinks for 3s. With a 0.4s
  // first-token deadline the watchdog must fire, and it must report the
  // deadline it was GIVEN -- if the plumbing were still missing, the default
  // 30s would apply and this turn would simply succeed.
  const r = await structured(
    "slow-first-token",
    { firstTokenTimeoutSeconds: 0.4, skipParse: true },
    { FAKE_ACP_FIRST_TOKEN_DELAY_MS: "3000" },
  );
  assert.ok(r.timeout, "the turn must be reported as timed out, not as an empty reply");
  assert.equal(r.timeout.kind, "first_token");
  assert.equal(r.timeout.deadlineSeconds, 0.4, "the EFFECTIVE deadline must be the configured one, not the 30s default");
  assert.equal(r.raw, "", "no token ever arrived");
});

test("rc4: the structured path forwards the setting rather than declaring it and dropping it", skip, () => {
  // The exact shape of the original bug: `runWorkerAcp` accepted the option all
  // along. Nothing on this path passed one.
  const src = S("src/adapters/acp.ts");
  const body = src.slice(src.indexOf("export async function runStructuredAcp"));
  assert.match(
    body.slice(0, body.indexOf("runStructuredLadder")),
    /firstTokenTimeoutSeconds: params\.firstTokenTimeoutSeconds/,
    "runStructuredAcp must hand its first-token deadline to runWorkerAcp",
  );

  const router = S("src/adapters/backend-router.ts");
  assert.match(
    router.slice(router.indexOf("executorFor(role: RoleName)")),
    /firstTokenTimeoutSeconds: params\.firstTokenTimeoutSeconds/,
    "the backend router must forward it too",
  );

  // And something must actually SUPPLY it, or every hop above carries undefined.
  const index = S("src/index.ts");
  const chokepoint = index.slice(index.indexOf("const executorFor = (role: RoleName)"), index.indexOf("const anthropicApiKey"));
  assert.match(
    chokepoint,
    /firstTokenTimeoutSeconds: params\.firstTokenTimeoutSeconds \?\? config\.loop\.sdk_first_token_timeout_seconds/,
    "the configured value must be supplied at the one place every structured role passes through",
  );
});

// ===========================================================================
// 2. A slow-but-answering backend inside the configured deadline succeeds
// ===========================================================================

test("rc4: a reply that is slow to start but inside the configured deadline succeeds", skip, async () => {
  // The same fixture and the same delay as the failing case above; only the
  // deadline differs. This is the operator's remedy working: raise the setting,
  // and a reviewer that takes a while to warm up completes instead of dying.
  const r = await structured(
    "slow-first-token",
    { firstTokenTimeoutSeconds: 8, skipParse: true },
    { FAKE_ACP_FIRST_TOKEN_DELAY_MS: "1200" },
  );
  assert.equal(r.timeout, null, "a turn the model finished is not a timeout");
  assert.match(r.raw, /slow but answered/);
  assert.equal(r.stopReason, "end_turn");
});

test("rc4: the default is still 30s when nothing is configured", skip, () => {
  const src = S("src/adapters/acp.ts");
  assert.match(src, /firstTokenTimeoutSeconds = 30,/, "the existing default must be preserved for callers that pass nothing");
});

// ===========================================================================
// 3. The three deadlines stay distinct
// ===========================================================================

test("rc4: stream-open, first-token and overall timeouts are classified apart", skip, async () => {
  // Never emits anything at all: phase 1 never completes.
  const open = await runWorkerAcp({
    agent: agent("silent"),
    worktreePath: tmpdir(),
    systemPrompt: "s", userMessage: "u", model: "",
    timeoutSeconds: 30, streamOpenTimeoutSeconds: 0.5, firstTokenTimeoutSeconds: 20,
    acpGuard: async () => ({ allow: false }),
  });
  assert.equal(open.timeout.kind, "stream_open");
  assert.equal(open.timeout.deadlineSeconds, 0.5);

  // Opens the stream, then produces no assistant token: phase 2.
  const first = await runWorkerAcp({
    agent: agent("no-first-token"),
    worktreePath: tmpdir(),
    systemPrompt: "s", userMessage: "u", model: "",
    timeoutSeconds: 30, streamOpenTimeoutSeconds: 10, firstTokenTimeoutSeconds: 0.5,
    acpGuard: async () => ({ allow: false }),
  });
  assert.equal(first.timeout.kind, "first_token");
  assert.equal(first.timeout.deadlineSeconds, 0.5);

  // Emits a token (so both phase timers are satisfied) and then hangs: only
  // the overall budget can end this one.
  const overall = await runWorkerAcp({
    agent: agent("partial-then-hang"),
    worktreePath: tmpdir(),
    systemPrompt: "s", userMessage: "u", model: "",
    timeoutSeconds: 1, streamOpenTimeoutSeconds: 10, firstTokenTimeoutSeconds: 10,
    acpGuard: async () => ({ allow: false }),
  });
  assert.equal(overall.timeout.kind, "overall");
  assert.equal(overall.timeout.deadlineSeconds, 1);

  // All three still report the coarse stop reasons the loop's retry logic
  // keys on. Adding the precise classification must not have changed those.
  assert.equal(open.stopReason, "first_token_timeout");
  assert.equal(first.stopReason, "first_token_timeout");
  assert.equal(overall.stopReason, "timeout");
});

test("rc4: the overall budget is the hard limit and no phase timer can outlast it", skip, async () => {
  // Phase deadlines set far beyond the overall budget. The turn must still end
  // at the overall budget rather than waiting for either phase timer.
  const started = Date.now();
  const r = await runWorkerAcp({
    agent: agent("no-first-token"),
    worktreePath: tmpdir(),
    systemPrompt: "s", userMessage: "u", model: "",
    timeoutSeconds: 1, streamOpenTimeoutSeconds: 600, firstTokenTimeoutSeconds: 600,
    acpGuard: async () => ({ allow: false }),
  });
  assert.equal(r.timeout.kind, "overall");
  assert.ok(Date.now() - started < 15_000, "the overall budget must cap the turn");

  const src = S("src/adapters/acp.ts");
  const body = src.slice(src.indexOf("// Overall turn budget"), src.indexOf("const markActivity"));
  assert.match(body, /arm\(timeoutSeconds \* 1000/, "armed unconditionally at turn start");
  assert.doesNotMatch(body, /clearTimeout/, "and never disarmed by a phase timer");
});

// ===========================================================================
// 4. A timed-out turn never reaches JSON parsing or repair
// ===========================================================================

/** A ladder over a scripted sequence of attempt results. */
function ladderOver(results, over = {}) {
  const corrections = [];
  const calls = [];
  return {
    corrections,
    calls,
    run: () =>
      runStructuredLadder({
        role: "adversary",
        validation: REVIEW_KEYS,
        logger: { warn: () => {} },
        attempt: async (correction) => {
          corrections.push(correction);
          const r = results[calls.length] ?? results[results.length - 1];
          calls.push(r);
          if (r instanceof Error) throw r;
          return { costUsd: 0.01, tokensIn: 1, tokensOut: 1, sessionId: `s${calls.length}`, raw: "", ...r };
        },
        ...over,
      }),
  };
}

const timedOut = (kind = "first_token", deadlineSeconds = 30) => ({
  raw: "",
  timeout: { kind, deadlineSeconds, elapsedMs: deadlineSeconds * 1000 },
});

test("rc4: an empty timed-out reply is never described as malformed JSON", skip, async () => {
  const l = ladderOver([timedOut(), timedOut(), timedOut()]);
  const err = await l.run().then(() => null, (e) => e);
  assert.ok(err, "three timed-out attempts cannot produce a document");

  assert.equal(err.allTimedOut, true);
  assert.equal(err.timeout.kind, "first_token");
  assert.ok(err.attempts.every((a) => a.outcome === "timed_out"), "every attempt must be recorded as a timeout");

  // The message an operator reads must name the deadline, not the symptom.
  assert.match(err.message, /timed out after 30s/);
  assert.match(err.message, /produced no reviewable output/);
  assert.doesNotMatch(err.message, /extractJson failed/);
  assert.doesNotMatch(err.message, /no JSON in output/);

  // And the retries must not have accused the model of bad formatting.
  for (const c of l.corrections.slice(1)) {
    assert.doesNotMatch(c ?? "", /could not be parsed|JSON document only\.$/,
      "a backend that said nothing cannot be told its reply was unparseable");
    assert.match(c ?? "", /stopped before any reply arrived/);
  }
});

test("rc4: partial output from a timed-out turn is discarded, never repaired into a verdict", skip, async () => {
  // The dangerous shape. This fragment closes cleanly into a PASSING review,
  // so anything that runs the truncation-repair rung over it manufactures an
  // approval out of a turn that was cut short.
  const fragment = '{"verdict":"pass","findings":[],"summ';
  const l = ladderOver([
    { raw: fragment, timeout: { kind: "overall", deadlineSeconds: 900, elapsedMs: 900_000 } },
  ], { maxAttempts: 1 });

  const err = await l.run().then((r) => r, (e) => e);
  assert.ok(err instanceof Error, "a cut-off fragment must not become a result");
  assert.equal(err.allTimedOut, true);
  assert.equal(err.attempts[0].outcome, "timed_out");
  assert.match(err.attempts[0].detail, /chars of partial output discarded/);
  assert.notEqual(err.attempts[0].outcome, "repaired");
});

test("rc4: the timeout rung is checked before extraction, not after it fails", skip, () => {
  const src = S("src/adapters/shared/structured.ts");
  const body = src.slice(src.indexOf("for (let i = 0; i < maxAttempts"));
  const gate = body.indexOf("if (call.timeout)");
  const extract = body.indexOf("extractAndValidateJson");
  const repair = body.indexOf("repairTruncatedJson");
  assert.ok(gate > 0 && extract > 0 && repair > 0);
  assert.ok(gate < extract, "the timeout check must come BEFORE extraction");
  assert.ok(gate < repair, "and before repair");
});

// ===========================================================================
// 5. A real, completed malformed reply still climbs the existing ladder
// ===========================================================================

test("rc4: malformed output from a turn that COMPLETED still gets the JSON retries", skip, async () => {
  const l = ladderOver([
    { raw: "I think it looks fine!" },
    { raw: '{"verdict":"pass","findings":[],"summary":"fine"}' },
  ]);
  const r = await l.run();
  assert.equal(r.parsed.verdict, "pass");
  assert.equal(r.attempts[0].outcome, "invalid_json", "an actual reply that is not JSON is still a JSON fault");
  assert.match(l.corrections[1], /could not be parsed as the required JSON/,
    "and it still gets the correction that fits it");
});

test("rc4: a genuinely truncated reply is still repaired rather than treated as a timeout", skip, async () => {
  const l = ladderOver([
    { raw: '{"verdict":"revise","summary":"ok","findings":[{"title":"a real finding"}', truncated: true },
  ], { maxAttempts: 1 });
  const r = await l.run();
  assert.equal(r.repaired, true, "the max_tokens repair rung must be untouched");
  assert.equal(r.parsed.verdict, "revise");
});

// ===========================================================================
// 6. One retry owner: no nested attempts on a timeout
// ===========================================================================

test("rc4: a timed-out review is not re-run as a format error", skip, () => {
  // isAdversaryFormatError gates a SECOND full review. Its regex matched the
  // old timeout message, so three timed-out attempts bought three more.
  const timeoutErr = Object.assign(
    new Error("[adversary] every one of 3 attempt(s) timed out after 30s (the backend opened its stream but produced no token; waited 30s) -- the backend produced no reviewable output: #1 timed_out; #2 timed_out; #3 timed_out"),
    { allTimedOut: true, timeout: { kind: "first_token", deadlineSeconds: 30, elapsedMs: 30000 } },
  );
  assert.equal(isAdversaryFormatError(timeoutErr), false, "a silent backend must not be re-asked to fix its formatting");

  // Structural, not textual: the flag alone is enough even if the wording drifts.
  assert.equal(isAdversaryFormatError(Object.assign(new Error("anything at all"), { allTimedOut: true })), false);

  // The genuine format error it exists for still matches.
  assert.equal(isAdversaryFormatError(new Error("[adversary] extractJson failed: no JSON in output")), true);
  assert.equal(isAdversaryFormatError(new Error("JSON missing required keys: verdict")), true);
});

test("rc4: the adversary keeps skipParse and one bounded ladder", skip, () => {
  const cc = S("src/adapters/claude-code.ts");
  const review = cc.slice(cc.indexOf("async function reviewOnce"), cc.indexOf("export async function runAdversarySdk"));
  assert.match(review, /skipParse: true/, "the inner call must not parse; the outer ladder owns extraction");
  assert.match(review, /runStructuredLadder<ReviewDoc>/);
  assert.equal((review.match(/runStructuredLadder/g) ?? []).length, 1, "exactly one ladder");

  // And the ACP side must not climb a second one underneath it.
  const acp = S("src/adapters/acp.ts");
  const body = acp.slice(acp.indexOf("export async function runStructuredAcp"));
  const skipBranch = body.slice(body.indexOf("if (params.skipParse)"), body.indexOf("const r = await runStructuredLadder"));
  assert.doesNotMatch(skipBranch, /runStructuredLadder/, "skipParse must return the raw turn, not ladder over it");
});

test("rc4: each ladder rung is a fresh session", skip, () => {
  const acp = S("src/adapters/acp.ts");
  assert.match(acp, /Each ladder rung is a FRESH session/);
  // runTurn passes no resumeSessionId, so runWorkerAcp opens a new one per call.
  const body = acp.slice(acp.indexOf("const runTurn = async"), acp.indexOf("if (params.skipParse)"));
  assert.doesNotMatch(body, /resumeSessionId/, "a retry after a timeout must not resume the dead session");
});

// ===========================================================================
// 7. Exhaustion preserves the cause and cannot become an approval
// ===========================================================================

test("rc4: exhaustion reports the deadline, the role, the chunk and the session", skip, async () => {
  const l = ladderOver([timedOut("first_token", 45), timedOut("first_token", 45)], {
    maxAttempts: 2,
    validation: { requiredKeys: ["verdict", "findings", "summary"], label: "adversary-chunk-2/3" },
  });
  const err = await l.run().then(() => null, (e) => e);

  assert.match(err.message, /\[adversary\]/, "the role");
  assert.match(err.message, /adversary-chunk-2\/3/, "which chunk of a chunked review");
  assert.match(err.message, /session s1/, "and a session to go and read");
  assert.match(err.message, /timed out after 45s/, "the effective deadline, not a hard-coded 30");
  assert.match(err.message, /#1 timed_out:/, "the attempt trail");
  assert.match(err.message, /#2 timed_out:/, "every attempt, not just the last");
  assert.equal(err.role, "adversary");
});

test("rc4: a timed-out review preserves its spend rather than reporting a free failure", skip, async () => {
  const l = ladderOver([timedOut(), timedOut(), timedOut()]);
  const err = await l.run().then(() => null, (e) => e);
  // Three calls at 0.01 each. A run that burned tokens and produced nothing
  // must still say what it cost.
  assert.ok(Math.abs(err.costUsd - 0.03) < 1e-9, `expected the spend to survive, got ${err.costUsd}`);
  assert.equal(err.attempts.length, 3);
  assert.ok(err.attempts.every((a) => a.costUsd === 0.01));
});

test("rc4: no timeout, however classified, can produce a passing verdict", skip, () => {
  // The property the whole exhaustion design exists for. A review that did not
  // happen is not a review that passed.
  for (const role of ["adversary", "lead", "crystalliser", "classifier", "revise_spec", "worker_context", "unknown_role"]) {
    const v = exhaustionVerdict(role);
    assert.notEqual(v.verdict, "pass", `${role} must never exhaust to pass`);
    assert.match(v.why, /unreviewed, not as approved/);
  }

  // And the ladder throws rather than returning a degraded default, so there is
  // no value a caller can forget to check.
  const src = S("src/adapters/shared/structured.ts");
  assert.match(src.replace(/\s*\n\s*\*?\s*/g, " "), /no route from ladder exhaustion to `pass`, for any role/);
});

test("rc4: a timed-out adversary reaches the loop as a review crash, which fails closed", skip, () => {
  // The ladder throws; the loop's review-crash path preserves the worktree and
  // refuses the push. This asserts the two ends still meet.
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /loop\.review_failed/, "a throwing review is audited as a failure");
  const salvage = loop.slice(loop.indexOf("private refuseUnreviewedSalvage"));
  assert.match(salvage.slice(0, 600), /no adversary review has ever run/,
    "and an unreviewed session cannot be salvaged into a PR");
});
