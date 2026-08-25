// v2.0.0 M4 — the backend contract.
//
// Two things are under test here, and only the second one is really about
// OpenCode.
//
// The first is the capability floor: a backend declares what it can do, a role
// declares what it needs, and a mismatch is refused with a sentence naming
// both. The failure this prevents is specific — a backend that cannot gate tool
// calls looks EXACTLY like a backend whose every request was approved, so a
// worker would run to completion with bash-guard, the path deny-list and the
// no-push rule all silently inert.
//
// The second is what happens when a structured role cannot produce valid JSON.
// v1 answered that twice: the lead grew a three-attempt ladder across beta.97
// to beta.128, and the adversary grew nothing and threw on the first bad reply.
// v2 makes it one ladder, and fixes the direction it fails in. A review that
// did not happen must never be readable as a review that passed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(resolve(root, p), "utf8");

const backend = await import("../dist/adapters/backend.js");
const structured = await import("../dist/adapters/shared/structured.js");

const FULL = {
  id: "test-backend",
  toolUse: true,
  toolPermissionCallback: true,
  disableAllTools: true,
  resumeSession: true,
  reportsCostUsd: true,
};

// ---------------------------------------------------------------------------
// Roles and shapes
// ---------------------------------------------------------------------------

test("all eight roles are declared, in exactly two shapes", () => {
  assert.equal(backend.ROLE_NAMES.length, 8);
  const shapes = backend.ROLE_NAMES.map((r) => backend.ROLE_SHAPES[r]);
  assert.equal(shapes.filter((s) => s === undefined).length, 0, "every role needs a shape");
  assert.deepEqual([...new Set(shapes)].sort(), ["agentic", "structured"]);
  // Two tool-using roles, six tool-less. The six are the ones M5 has to give a
  // structured-JSON path over ACP.
  assert.equal(shapes.filter((s) => s === "agentic").length, 2);
  assert.equal(shapes.filter((s) => s === "structured").length, 6);
  assert.equal(backend.ROLE_SHAPES.worker, "agentic");
  assert.equal(backend.ROLE_SHAPES.scout, "agentic");
  assert.equal(backend.ROLE_SHAPES.adversary, "structured");
});

test("every role has a declared floor", () => {
  for (const r of backend.ROLE_NAMES) {
    assert.ok(backend.ROLE_MIN_TIER[r] !== undefined, `${r} has no minimum tier`);
  }
});

// ---------------------------------------------------------------------------
// The capability floor
// ---------------------------------------------------------------------------

test("a fully capable backend satisfies every role", () => {
  for (const r of backend.ROLE_NAMES) {
    assert.equal(backend.checkCapabilityFloor(r, FULL, "frontier"), null, `${r} should pass`);
  }
});

test("a backend that cannot gate tool calls may not run an agentic role", () => {
  // The one that matters. A worker is untrusted model output pointed at a real
  // filesystem; the permission callback is the only thing between it and the
  // repo.
  const caps = { ...FULL, toolPermissionCallback: false };
  for (const r of ["worker", "scout"]) {
    const why = backend.checkCapabilityFloor(r, caps, "frontier");
    assert.ok(why, `${r} must be refused`);
    assert.match(why, /cannot gate tool calls/);
    assert.match(why, /bash-guard/, "the message must name what stops working");
    assert.match(why, /test-backend/, "the message must name the backend");
    assert.match(why, new RegExp(r), "the message must name the role");
  }
  // Structured roles are unaffected: they have no tools to gate.
  assert.equal(backend.checkCapabilityFloor("adversary", caps, "frontier"), null);
});

test("a backend that cannot disable tools may not run a structured role", () => {
  const caps = { ...FULL, disableAllTools: false };
  for (const r of ["lead", "adversary", "classifier", "crystalliser", "revise_spec", "worker_context"]) {
    const why = backend.checkCapabilityFloor(r, caps, "frontier");
    assert.ok(why, `${r} must be refused`);
    assert.match(why, /tools disabled/);
    assert.match(why, /beta\.28|beta\.40/, "the message must cite why this is not cosmetic");
  }
  assert.equal(backend.checkCapabilityFloor("worker", caps, "frontier"), null);
});

test("a backend with no tool use at all may still run the structured six", () => {
  // This is the shape a cheap JSON-only endpoint would declare, and it is a
  // perfectly good classifier.
  const caps = { ...FULL, toolUse: false, toolPermissionCallback: false };
  assert.match(backend.checkCapabilityFloor("worker", caps, "frontier"), /needs tool use/);
  assert.equal(backend.checkCapabilityFloor("classifier", caps, "basic"), null);
});

test("the three judgement roles refuse a model declared 'basic'", () => {
  // A weak worker fails loudly -- the code does not compile. A weak adversary
  // fails silently, by returning a well-formed pass. That asymmetry is the
  // entire reason the floor is set where it is.
  for (const r of ["lead", "adversary", "crystalliser"]) {
    const why = backend.checkCapabilityFloor(r, FULL, "basic");
    assert.ok(why, `${r} must refuse a basic model`);
    assert.match(why, /at least 'strong'/);
    assert.match(why, /fails quietly rather than loudly/);
    assert.equal(backend.checkCapabilityFloor(r, FULL, "strong"), null, `${r} accepts strong`);
    assert.equal(backend.checkCapabilityFloor(r, FULL, "frontier"), null, `${r} accepts frontier`);
  }
  // The other five are fine on a basic model.
  for (const r of ["worker", "scout", "classifier", "revise_spec", "worker_context"]) {
    assert.equal(backend.checkCapabilityFloor(r, FULL, "basic"), null, `${r} should accept basic`);
  }
});

test("tier ordering", () => {
  assert.equal(backend.tierAtLeast("frontier", "strong"), true);
  assert.equal(backend.tierAtLeast("strong", "strong"), true);
  assert.equal(backend.tierAtLeast("basic", "strong"), false);
  assert.equal(backend.tierAtLeast("basic", "basic"), true);
});

test("the Claude backend declares its capabilities and satisfies every role", async () => {
  const { CLAUDE_CODE_CAPABILITIES } = await import("../dist/adapters/claude-code.js");
  assert.equal(CLAUDE_CODE_CAPABILITIES.id, "claude-code");
  for (const r of backend.ROLE_NAMES) {
    assert.equal(backend.checkCapabilityFloor(r, CLAUDE_CODE_CAPABILITIES, "frontier"), null,
      `the v1 backend must still satisfy ${r}; it is the baseline the others are measured against`);
  }
});

// ---------------------------------------------------------------------------
// The sizing instruction that replaced the brand name
// ---------------------------------------------------------------------------

test("the lead's sizing instruction is calibrated by tier, not by brand", () => {
  const src = S("src/adapters/claude-code.ts");
  assert.doesNotMatch(src, /a Sonnet worker can complete in one turn/,
    "the planner prompt must not name a model brand: in v2 the worker may be any model");
  assert.match(src, /subTaskSizingInstruction\(params\.workerTier \?\? "strong"\)/);

  // The sentence still does its job: it must tell the planner how finely to cut.
  for (const tier of ["frontier", "strong", "basic"]) {
    const s = backend.subTaskSizingInstruction(tier);
    assert.match(s, /sub-task/i, `${tier} must still talk about sub-tasks`);
    assert.match(s, /verifiab/i, `${tier} must still require independent verifiability`);
  }
  // A weaker worker must be told to cut FINER, which is the whole calibration.
  assert.match(backend.subTaskSizingInstruction("basic"), /prefer more\s+sub-tasks|SMALL/);
  assert.match(backend.subTaskSizingInstruction("frontier"), /several related files/);
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/** A scripted backend: hands back the given replies in order. */
function scripted(replies) {
  let i = 0;
  const corrections = [];
  const fn = async (correction) => {
    corrections.push(correction);
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { raw: r.raw ?? r, costUsd: r.costUsd ?? 0.01, tokensIn: 10, tokensOut: 20, sessionId: "s1", truncated: r.truncated };
  };
  fn.corrections = corrections;
  fn.count = () => i;
  return fn;
}

const REVIEW = { requiredKeys: ["verdict", "findings", "summary"], label: "adversary" };

test("rung 1-2: a valid document on the first try costs one call", async () => {
  const attempt = scripted(['{"verdict":"pass","findings":[],"summary":"fine"}']);
  const r = await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt });
  assert.equal(r.parsed.verdict, "pass");
  assert.equal(attempt.count(), 1);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ["ok"]);
  assert.equal(r.repaired, false);
  assert.equal(attempt.corrections[0], null, "the first attempt carries no correction");
});

test("rung 1: JSON is dug out of prose and fences", async () => {
  const attempt = scripted(['Sure!\n```json\n{"verdict":"revise","findings":[],"summary":"x"}\n```\nHope that helps.']);
  const r = await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt });
  assert.equal(r.parsed.verdict, "revise");
  assert.equal(attempt.count(), 1, "extraction is free; it must not cost a retry");
});

test("rung 3: a truncated document is REPAIRED rather than re-asked", async () => {
  // b98's ladder was three calls, three identical truncations, twelve minutes
  // and no plan: re-asking a model that hit its output ceiling reproduces the
  // truncation. Repair is free and happens first.
  const cut = '{"verdict":"revise","summary":"x","findings":[{"a":1},{"b":';
  const attempt = scripted([{ raw: cut, truncated: true }]);
  const r = await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt });
  assert.equal(attempt.count(), 1, "repair must not spend a model call");
  assert.equal(r.repaired, true, "the caller must be told the document is incomplete");
  assert.equal(r.parsed.findings.length, 1, "the half-written element is dropped whole");
  assert.deepEqual(r.attempts.map((a) => a.outcome), ["repaired"]);
});

test("rung 3: repair is not applied to a document that was never cut off", async () => {
  // Repairing well-formed-but-wrong output would paper over a real contract
  // violation. `{"verdict":"pass"}` is closed and complete; it is just missing
  // required keys, and that must be re-asked, not "fixed".
  const attempt = scripted(['{"verdict":"pass"}', '{"verdict":"pass","findings":[],"summary":"ok"}']);
  const r = await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt });
  assert.equal(attempt.count(), 2);
  assert.deepEqual(r.attempts.map((a) => a.outcome), ["invalid_json", "ok"]);
});

test("rung 4: the retry is TOLD what went wrong, and told differently for truncation", async () => {
  const prose = scripted(["I think this looks fine to me.", '{"verdict":"pass","findings":[],"summary":"ok"}']);
  await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt: prose });
  assert.match(prose.corrections[1], /could not be parsed/);
  assert.match(prose.corrections[1], /no prose, no code fence/);

  // A truncation needs LESS output, not a restated contract.
  const cut = scripted([
    { raw: '{"verdict":"revise","findings":[{"a":', truncated: true },
    '{"verdict":"revise","findings":[],"summary":"ok"}',
  ]);
  await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt: cut });
  assert.match(cut.corrections[1], /cut off at the output limit/);
  assert.match(cut.corrections[1], /concisely/);
  assert.doesNotMatch(cut.corrections[1], /no prose, no code fence/,
    "re-asserting the contract on a truncation re-truncates identically (b98)");
});

test("a call that throws is still billed, and still retried", async () => {
  // b126: two Opus calls recorded as $0.00. A call that fails burned tokens.
  const boom = Object.assign(new Error("upstream 529"), { costUsd: 0.4 });
  const attempt = scripted([boom, '{"verdict":"pass","findings":[],"summary":"ok"}']);
  const r = await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt });
  assert.equal(r.attempts[0].outcome, "call_failed");
  assert.ok(r.costUsd >= 0.4, `the failed attempt must be billed; got ${r.costUsd}`);
});

test("every attempt is on the record, including the recovered ones", async () => {
  // b128: a recovered truncation that left no trace is a mechanism nobody can
  // tell is working. A run that ends OK must still carry the failed rungs.
  const attempt = scripted([
    "prose",
    { raw: '{"verdict":"revise","summary":"s","findings":[{"a":1},{"b":', truncated: true },
  ]);
  const r = await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt });
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].outcome, "invalid_json");
  assert.ok(r.attempts[0].detail, "a failed attempt must say what was wrong");
  assert.equal(r.attempts[1].outcome, "repaired");
  assert.equal(r.repaired, true);
});

test("a repair that still fails the contract is re-asked, not accepted", async () => {
  // The document was cut off BEFORE `summary` was written, so closing it
  // yields valid JSON that is missing a required key. Accepting that would
  // hand the caller a review with no summary and call it recovered.
  const attempt = scripted([
    { raw: '{"verdict":"revise","findings":[{"a":1},{"b":', truncated: true },
    '{"verdict":"revise","findings":[],"summary":"ok"}',
  ]);
  const r = await structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt });
  assert.equal(attempt.count(), 2, "the failed repair must fall through to a retry");
  assert.equal(r.attempts[0].outcome, "truncated");
  assert.equal(r.repaired, false);
  assert.equal(r.parsed.summary, "ok");
});

// ---------------------------------------------------------------------------
// Exhaustion — the part that matters
// ---------------------------------------------------------------------------

test("exhaustion THROWS; it never returns a pass-shaped default", async () => {
  const attempt = scripted(["nope", "still nope", "nope again"]);
  await assert.rejects(
    () => structured.runStructuredLadder({ role: "adversary", validation: REVIEW, attempt }),
    (err) => {
      assert.equal(attempt.count(), 3, "the default ladder is three calls");
      assert.equal(err.role, "adversary");
      assert.equal(err.attempts.length, 3);
      assert.ok(err.costUsd > 0, "an exhausted ladder still reports what it spent");
      assert.match(err.message, /could not obtain a valid JSON document after 3 attempt/);
      assert.match(err.message, /#1 .*#2 .*#3/s, "the trail must name each attempt");
      return true;
    },
  );
});

test("no role, under any policy, fails toward a pass", () => {
  // The property, stated directly. `pass` is unreachable from exhaustion --
  // not for the adversary, and not for anything else either.
  const roles = [...backend.ROLE_NAMES, "something_unregistered"];
  for (const r of roles) {
    const v = structured.exhaustionVerdict(r);
    assert.notEqual(v.verdict, "pass", `${r} must never fail toward pass`);
    assert.ok(["revise", "block"].includes(v.verdict));
    assert.ok(["review", "fail_run"].includes(v.policy));
    assert.match(v.why, /not as approved/);
  }
  // An unknown role gets the SAFE default, not a permissive one.
  assert.equal(structured.exhaustionVerdict("something_unregistered").policy, "review");
});

test("the exhaustion policy per role", () => {
  const P = structured.ROLE_EXHAUSTION_POLICY;
  // A review that did not happen is not an approval; the run continues but
  // nothing may merge unreviewed.
  assert.equal(P.adversary, "review");
  // No plan and no brief mean there is nothing to execute.
  assert.equal(P.lead, "fail_run");
  assert.equal(P.crystalliser, "fail_run");
});

test("the adversary now climbs the shared ladder", () => {
  // v1's asymmetry: the lead had a three-attempt ladder and the reviewer threw
  // on the first malformed reply. Both call the same kind of model.
  const src = S("src/adapters/claude-code.ts");
  assert.match(src, /runStructuredLadder<ReviewDoc>/);
  assert.match(src, /role: "adversary"/);
  // And it must hand the ladder the RAW text -- parsing in the call would
  // destroy the very reply the ladder needs to repair.
  assert.match(src, /skipParse: true/);
});

test("skipParse really does skip parsing", async () => {
  // If structuredCall still parsed, a prose reply would throw inside the call
  // and the ladder would never see the text. Asserted on the source of the
  // branch because exercising it needs a live SDK.
  const src = S("src/adapters/claude-code.ts");
  assert.match(src, /if \(params\.skipParse\) \{\s*\n\s*parsed = undefined as unknown as T;/);
});

// ---------------------------------------------------------------------------
// The interface is not backend-specific
// ---------------------------------------------------------------------------

test("backend.ts and shared/structured.ts name no vendor", () => {
  for (const f of ["src/adapters/backend.ts", "src/adapters/shared/structured.ts"]) {
    assert.doesNotMatch(S(f), /claude-agent-sdk/, `${f} must not depend on one backend`);
  }
  // backend.ts may NAME claude-code as an example id in prose, but must not
  // import it: the dependency runs the other way.
  assert.doesNotMatch(S("src/adapters/backend.ts"), /from "\.\/claude-code\.js"/);
});
