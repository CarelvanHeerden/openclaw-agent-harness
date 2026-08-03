// beta.99 regression suite for the b98 smoke failure (session f2613eec).
//
// b98 spent ~12 minutes and $0 on three lead calls and produced NO plan. The
// handoff report blamed a single defect (b97 read stop_reason from the wrong
// event). That defect is real, but it was the third link in a chain:
//
//   1. Lead call #1 returned a VALID plan whose workerContext was thin.
//   2. The b67 gate re-asked for the WHOLE plan demanding MORE prose. That
//      reply blew the output ceiling.
//   3. Truncation went UNDETECTED (b97 read the session-end stop_reason, not
//      the assistant frame), so the compaction retry it gates was dead code.
//   4. The prose-drift retry ran instead, re-truncating identically -- and its
//      prompt still carried the "add more prose" note, so it asked for more
//      and less in the same breath.
//   5. runLeadPlanner threw, DISCARDING the valid plan from step 1.
//
// Each test below pins one link so the chain cannot re-form.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

let sdk;
try {
  sdk = await import("../dist/adapters/claude-sdk.js");
} catch {
  sdk = null;
}

// ---------------------------------------------------------------------------
// Link 3: truncation detection must read ALL the signals the SDK offers.
// ---------------------------------------------------------------------------
test("beta.99: truncation is detected on the ASSISTANT frame's error field", () => {
  if (!sdk?.messageIndicatesTruncation) return;
  // SDKAssistantMessageError includes 'max_output_tokens' (see sdk.d.ts).
  assert.equal(sdk.messageIndicatesTruncation({ type: "assistant", error: "max_output_tokens" }), true);
});

test("beta.99: truncation is detected on the ASSISTANT frame's stop_reason", () => {
  if (!sdk?.messageIndicatesTruncation) return;
  assert.equal(
    sdk.messageIndicatesTruncation({ type: "assistant", message: { stop_reason: "max_tokens" } }),
    true,
  );
});

test("beta.99: the result event remains a truncation signal (b97 behaviour kept)", () => {
  if (!sdk?.messageIndicatesTruncation) return;
  assert.equal(sdk.messageIndicatesTruncation({ type: "result", stop_reason: "max_tokens" }), true);
  assert.equal(
    sdk.messageIndicatesTruncation({ type: "result", subtype: "error_max_structured_output_retries" }),
    true,
  );
});

test("beta.99: THE b97 BLIND SPOT -- a truncated turn inside a cleanly-ended session", () => {
  if (!sdk?.messageIndicatesTruncation) return;
  // This is the exact b98 stream shape: the assistant turn was cut off, then
  // the session ended normally. b97 read ONLY the result frame, saw end_turn,
  // and concluded "not truncated".
  const stream = [
    { type: "assistant", error: "max_output_tokens", message: { stop_reason: "max_tokens", content: [] } },
    { type: "result", subtype: "success", stop_reason: "end_turn" },
  ];
  assert.equal(stream.some((m) => sdk.messageIndicatesTruncation(m)), true, "OR-ing across frames must catch it");
  assert.equal(
    sdk.messageIndicatesTruncation(stream[1]),
    false,
    "the result frame alone still looks clean -- which is precisely why b97 missed this",
  );
});

test("beta.99: benign frames are NOT reported as truncation", () => {
  if (!sdk?.messageIndicatesTruncation) return;
  for (const m of [
    { type: "assistant", message: { stop_reason: "end_turn" } },
    { type: "assistant", error: "rate_limit" },
    { type: "result", subtype: "success", stop_reason: "end_turn" },
    { type: "system", subtype: "init" },
    null,
    undefined,
    "nonsense",
  ]) {
    assert.equal(sdk.messageIndicatesTruncation(m), false, `must not flag ${JSON.stringify(m)}`);
  }
});

test("beta.99: structuredCall OR-s truncation across frames and overrides stop_reason", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /if \(messageIndicatesTruncation\(message\)\) truncationSeen = true;/);
  assert.match(src, /if \(truncationSeen\) stopReason = "max_tokens";/);
});

// ---------------------------------------------------------------------------
// Link: the output ceiling must be ours, explicitly.
// ---------------------------------------------------------------------------
test("beta.99: buildSdkEnv exports an explicit CLAUDE_CODE_MAX_OUTPUT_TOKENS", () => {
  if (!sdk?.buildSdkEnv) return;
  const env = sdk.buildSdkEnv("sk-test");
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(sdk.DEFAULT_SDK_MAX_OUTPUT_TOKENS));
  assert.equal(sdk.DEFAULT_SDK_MAX_OUTPUT_TOKENS, 64000);
});

test("beta.99: the ceiling is configurable, and 0 disables it", () => {
  if (!sdk?.buildSdkEnv) return;
  assert.equal(sdk.buildSdkEnv("sk-test", 128000).CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
  assert.equal(sdk.buildSdkEnv("sk-test", 0).CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
});

test("beta.99: the ceiling survives the beta.57 secret filter (TOKENS != TOKEN)", () => {
  if (!sdk?.buildSdkEnv) return;
  // SDK_ENV_DENY_RE matches the bare word TOKEN. A name ending in TOKENS must
  // pass through, or the ceiling would be silently stripped on every call.
  process.env.OAH_TEST_SECRET_TOKEN = "leak-me";
  try {
    const env = sdk.buildSdkEnv("sk-test", 64000);
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
    assert.equal(env.OAH_TEST_SECRET_TOKEN, undefined, "beta.57 secret filtering must still apply");
  } finally {
    delete process.env.OAH_TEST_SECRET_TOKEN;
  }
});

test("beta.99: no api key -> undefined env (local-dev path unchanged)", () => {
  if (!sdk?.buildSdkEnv) return;
  assert.equal(sdk.buildSdkEnv(undefined, 64000), undefined);
});

// ---------------------------------------------------------------------------
// Link 4: the retry must shrink the contract, and must not contradict itself.
// ---------------------------------------------------------------------------
test("beta.99: the truncation retry drops the corrective note that demanded MORE prose", () => {
  const src = S("src/adapters/claude-sdk.ts");
  // The truncation branch must rebuild from baseMessage (brief only). Building
  // it from userMessage would re-inject the b67 "add more context" note into a
  // prompt whose entire purpose is to produce less.
  const branch = src.slice(src.indexOf("const retryMsg = truncated"), src.indexOf("params.logger?.warn?.(\n      truncated"));
  assert.match(branch, /\$\{baseMessage\}\\n\\nYOUR PREVIOUS REPLY WAS TRUNCATED/);
  assert.ok(
    !/\$\{userMessage\}\\n\\nYOUR PREVIOUS REPLY WAS TRUNCATED/.test(branch),
    "the truncation retry must NOT be built from the note-carrying userMessage",
  );
});

test("beta.99: the truncation retry shrinks MECHANICALLY, not by polite request", () => {
  const src = S("src/adapters/claude-sdk.ts");
  // "please be terser" produced three identical truncations on b98. Name the
  // field to delete and give numeric caps instead.
  assert.match(src, /OMIT .{0,2}codeExcerpts.{0,2} ENTIRELY/);
  assert.match(src, /changeSpec.{0,2} <= 300 characters/);
});

test("beta.99: the b67 corrective note now carries its own hard size limit", () => {
  const src = S("src/orchestrator/fable5-lead.ts");
  assert.match(src, /SIZE LIMIT \(HARD\)/);
  assert.match(src, /a richer plan that gets cut off is a FAILED plan/i);
});

// ---------------------------------------------------------------------------
// Link 5 / salvage: a cut-off reply is not automatically a lost reply.
// ---------------------------------------------------------------------------
test("beta.99: repairTruncatedJson recovers the complete prefix of the real b98 payload", () => {
  if (!sdk?.repairTruncatedJson) return;
  const b98 =
    '{"repo":"Stitch-Vercel/ProjectThanos","branch":"harness/feat-grc-b98","riskLevel":"high",' +
    '"subTasks":[{"seq":1,"title":"Probe","intent":"look","filesLikelyTouched":["a/b.ts"],' +
    '"successCriteria":["ok"],"estimatedTokens":18000,"contractScope":"local","taskMode":"observe","verify":[]},' +
    '{"seq":2,"title":"Add ContinuityExercise","intent":"In prisma/schema.prisma add the mod';
  const repaired = sdk.repairTruncatedJson(b98);
  assert.ok(repaired, "the b98 payload must be recoverable");
  const plan = JSON.parse(repaired);
  assert.equal(plan.repo, "Stitch-Vercel/ProjectThanos");
  assert.equal(plan.subTasks.length, 1, "the half-written sub-task 2 must be dropped whole");
  assert.equal(plan.subTasks[0].seq, 1);
});

test("beta.99: repair drops the PARTIAL trailing element, keeping complete ones", () => {
  if (!sdk?.repairTruncatedJson) return;
  const cut = '{"subTasks":[{"seq":1},{"seq":2},{"seq":3},{"seq":4,"title":"par';
  const plan = JSON.parse(sdk.repairTruncatedJson(cut));
  assert.deepEqual(plan.subTasks.map((s) => s.seq), [1, 2, 3], "seq 4 was incomplete and must not survive");
});

test("beta.99: repair is not fooled by braces or brackets inside strings", () => {
  if (!sdk?.repairTruncatedJson) return;
  const tricky = '{"a":"}}]]","b":[1,';
  const out = JSON.parse(sdk.repairTruncatedJson(tricky));
  assert.equal(out.a, "}}]]");
  assert.deepEqual(out.b, [1]);
});

test("beta.99: repair returns null when nothing is recoverable", () => {
  if (!sdk?.repairTruncatedJson) return;
  for (const junk of ["I will now write the plan to a file.", "{", '{"a":"unterminated', ""]) {
    assert.equal(sdk.repairTruncatedJson(junk), null, `must not invent JSON from ${JSON.stringify(junk)}`);
  }
});

test("beta.99: repair leaves an already-complete document byte-identical", () => {
  if (!sdk?.repairTruncatedJson) return;
  const complete = '{"a":[1,2],"b":{"c":3}}';
  assert.equal(sdk.repairTruncatedJson(complete), complete);
  assert.deepEqual(JSON.parse(sdk.repairTruncatedJson(complete)), { a: [1, 2], b: { c: 3 } });
});

test("beta.99: a structuredCall failure carries the FULL raw reply for salvage", () => {
  const src = S("src/adapters/claude-sdk.ts");
  // The error MESSAGE embeds only the first 4000 chars -- far too little to
  // rebuild a plan from -- so the untruncated text rides on the error object.
  assert.match(src, /\(err as StructuredCallError\)\.rawText = raw;/);
  assert.match(src, /\(err as StructuredCallError\)\.truncated = stopReason === "max_tokens";/);
});

test("beta.99: salvage only accepts a plan with the required keys and >=1 sub-task", () => {
  const src = S("src/adapters/claude-sdk.ts");
  const fn = src.slice(src.indexOf("function salvageLeadPlan"));
  assert.match(fn, /typeof p\.repo !== "string" \|\| typeof p\.branch !== "string"/);
  assert.match(fn, /p\.subTasks\.length === 0/);
});

test("beta.99: salvage is gated and its incompleteness is announced, not hidden", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /params\.leadSalvageEnabled === false/);
  assert.match(src, /This plan is INCOMPLETE/);
});

// ---------------------------------------------------------------------------
// Wiring: the knobs must actually reach the SDK calls.
// ---------------------------------------------------------------------------
test("beta.99: the lead honours lead_timeout_seconds, not worker_timeout_seconds", () => {
  const src = S("src/index.ts");
  // lead_timeout_seconds was documented and audited as the lead's bound while
  // the call actually used worker_timeout_seconds, so tuning it did nothing.
  assert.match(src, /timeoutSeconds: config\.loop\.lead_timeout_seconds \?\? config\.loop\.worker_timeout_seconds/);
});

test("beta.99: max_output_tokens is wired into the lead, top-up, revise-spec and worker calls", () => {
  const src = S("src/index.ts");
  const hits = src.match(/maxOutputTokens: config\.models\.max_output_tokens/g) ?? [];
  assert.ok(hits.length >= 4, `expected >=4 wired call sites, found ${hits.length}`);
});

test("beta.99: the bounded top-up is wired as a lead dep", () => {
  const src = S("src/index.ts");
  assert.match(src, /callWorkerContextModel: async \(b, plan, missingSeqs\)/);
  assert.match(src, /runLeadWorkerContextSdk\(/);
});

test("beta.99: the top-up prompt forbids restating the plan and bounds its own size", () => {
  const src = S("src/adapters/claude-sdk.ts");
  const fn = src.slice(src.indexOf("export async function runLeadWorkerContextSdk"));
  assert.match(fn, /Do NOT restate the plan/);
  assert.match(fn, /SIZE LIMIT \(HARD\)/);
  // Only the sub-tasks needing context are sent, and only a slim projection.
  assert.match(fn, /params\.missingSeqs\.includes\(st\.seq\)/);
});

test("beta.99: mergeWorkerContexts never overwrites context the lead already got right", async () => {
  const lead = await import("../dist/orchestrator/fable5-lead.js").catch(() => null);
  if (!lead?.mergeWorkerContexts) return;
  const goodSpec = "in useTaxonomy() at src/hooks/useTaxonomy.ts:41, replace the hardcoded LABELS map";
  const plan = {
    subTasks: [
      { seq: 1, taskMode: "mutate", workerContext: { rationale: "already good", changeSpec: goodSpec } },
      { seq: 2, taskMode: "mutate" },
    ],
  };
  const merged = lead.mergeWorkerContexts(plan, [
    { seq: 1, workerContext: { rationale: "worse", changeSpec: goodSpec } },
    { seq: 2, workerContext: { rationale: "why", changeSpec: goodSpec } },
    { seq: 99, workerContext: { rationale: "ghost", changeSpec: goodSpec } },
  ]);
  assert.deepEqual(merged, [2], "only the genuinely-missing seq is filled");
  assert.equal(plan.subTasks[0].workerContext.rationale, "already good");
  assert.equal(plan.subTasks[1].workerContext.rationale, "why");
});

// ---------------------------------------------------------------------------
// P0-7: the structured-call stream-open watchdog.
// ---------------------------------------------------------------------------
test("beta.99: structuredCall arms a stream-open watchdog and disarms it on system/init", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /let streamOpenTimedOut = false;/);
  assert.match(src, /streamOpened = true;\s*\n\s*if \(streamOpenTimer\) clearTimeout\(streamOpenTimer\);/);
  assert.equal(sdk?.DEFAULT_STREAM_OPEN_TIMEOUT_SECONDS, 120);
});

test("beta.99: a stream-open wedge aborts with a DISTINCT, retryable error", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /\[stream_open_timeout\] the SDK stream never opened within/);
  // It must join the lead's bounded retry set: the model never spoke, so a
  // fresh call is the correct remedy rather than a hard plan failure.
  assert.match(src, /JSON\\\.parse\|\\\[stream_open_timeout\\\]/);
});

test("beta.99: the watchdog is stream-open, NOT first-token (partials are off)", () => {
  const src = S("src/adapters/claude-sdk.ts");
  // structuredCall never sets includePartialMessages, so assistant text lands
  // only when the turn completes. A first-token timer would therefore fire on
  // every slow-but-healthy call and just duplicate the outer timeout.
  assert.ok(!/includePartialMessages/.test(src), "partial messages are not enabled for structured calls");
  assert.match(src, /Deliberately NOT a first-token watchdog/);
});

test("beta.99: mergeWorkerContexts rejects an insubstantive top-up", async () => {
  const lead = await import("../dist/orchestrator/fable5-lead.js").catch(() => null);
  if (!lead?.mergeWorkerContexts) return;
  const plan = { subTasks: [{ seq: 1, taskMode: "mutate" }] };
  const merged = lead.mergeWorkerContexts(plan, [{ seq: 1, workerContext: { rationale: "vague", changeSpec: "do it" } }]);
  assert.deepEqual(merged, [], "a top-up that fails the substance gate must not be merged");
  assert.equal(plan.subTasks[0].workerContext, undefined);
});
