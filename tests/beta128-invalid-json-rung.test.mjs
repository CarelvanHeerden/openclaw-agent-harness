// beta.128 — the rung for a plan that is whole and still will not parse.
//
// Session f75f7db6 is the reason this file exists. Attempt 1 hit the output
// ceiling. b127's classifier called that correctly and took the mechanical
// size-reduction rung -- the fix working exactly as designed. Attempt 2 came
// back COMPLETE, 24,475 characters, comfortably under the ceiling, carrying
// one token that JSON has no word for:
//
//     ..."subTasks":[...,{"seq":2,...,"seq_note":undefined}]...
//
// Every rung we had was the wrong shape for it. The compaction rung answers a
// reply that was cut off; this one was not. Salvage repairs a document that
// stops mid-write; this one closed cleanly. And the anti-prose rung would have
// told a model that emitted 24k characters of correct JSON that it "returned
// prose or an incomplete object" -- a correction describing neither the fault
// nor the document, which gives the model no move to make.
//
// So the run died holding a plan that was one token from usable, and the
// ledger recorded $0.00 for ten minutes of Opus.
//
// The rung asked for here does not GUESS what the token meant. Nobody but the
// model knows whether `seq_note` should have held a value or been absent. It
// quotes the parser's complaint and the text either side of it, and asks once.
import test from "node:test";
import assert from "node:assert/strict";

let runLeadSdk, __setSdkForTests, describeJsonSyntaxFault;
try {
  ({ runLeadSdk, __setSdkForTests, describeJsonSyntaxFault } = await import("../dist/adapters/claude-code.js"));
} catch {
  runLeadSdk = null;
}
const skip = runLeadSdk === null ? "build not present (npm run build)" : false;

const COMPLETE_PLAN = JSON.stringify({
  repo: "o/r",
  branch: "harness/x",
  riskLevel: "low",
  subTasks: [{ seq: 1, title: "one", intent: "do it" }],
  reviewChecklist: ["check it"],
});

// The b125/b127 shape: the contract, opened and cut mid-write.
const CUT_PLAN =
  '{"repo":"o/r","branch":"harness/x","riskLevel":"high","subTasks":[{"seq":1,"title":"probe","changeSpec":"read src/';

// The f75f7db6 shape: complete, balanced, and carrying a JavaScript literal.
const INVALID_PLAN =
  '{"repo":"o/r","branch":"harness/x","riskLevel":"high",' +
  '"subTasks":[{"seq":1,"title":"one","intent":"do it"},' +
  '{"seq":2,"title":"two","intent":"do that","seq_note":undefined}],' +
  '"reviewChecklist":["check it"]}';

function fakeSdk(replies) {
  const calls = [];
  return {
    calls,
    sdk: {
      query({ prompt, options }) {
        const reply = replies[calls.length] ?? replies[replies.length - 1];
        calls.push({ prompt, env: options?.env });
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: `s${calls.length}` };
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: reply.text }], stop_reason: reply.assistantStop ?? null },
          };
          yield {
            type: "result",
            total_cost_usd: reply.costUsd ?? 0,
            usage: { input_tokens: 10, output_tokens: 20 },
            stop_reason: reply.stopReason ?? null,
          };
        })();
      },
    },
  };
}

const base = {
  model: "claude-opus-5",
  brief: { title: "t", motivation: "m", acceptanceCriteria: ["a"] },
  reposAllowed: ["o/r"],
  timeoutSeconds: 30,
  apiKey: "k",
};

async function withSdk(replies, fn) {
  const f = fakeSdk(replies);
  const restore = __setSdkForTests(f.sdk);
  try {
    return await fn(f);
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// 1. Session f75f7db6, replayed.
// ---------------------------------------------------------------------------

test("a COMPLETE plan that will not parse buys one re-ask, and the run survives", { skip }, async () => {
  await withSdk(
    [
      { text: CUT_PLAN, stopReason: null },
      { text: INVALID_PLAN, stopReason: null },
      { text: COMPLETE_PLAN, stopReason: null },
    ],
    async (f) => {
      const plan = await runLeadSdk({ ...base });
      assert.equal(f.calls.length, 3, "truncation rung, then the syntax rung: this run died at two");
      assert.equal(plan.repo, "o/r", "and the corrected plan is what comes back");
    },
  );
});

test("the re-ask quotes the parser, names the token, and points at the spot", { skip }, async () => {
  await withSdk(
    [
      { text: CUT_PLAN, stopReason: null },
      { text: INVALID_PLAN, stopReason: null },
      { text: COMPLETE_PLAN, stopReason: null },
    ],
    async (f) => {
      await runLeadSdk({ ...base });
      const p = f.calls[2].prompt;
      assert.match(p, /STILL NOT VALID JSON/, "the model must be told which failure this is");
      assert.match(p, /SyntaxError/, "quote the parser rather than paraphrasing it");
      assert.match(p, /`undefined` is a JavaScript literal, not a JSON value/, "name the exact fault");
      assert.match(p, />>>HERE>>>/, "and show it where, because the plan is 24k characters long");
      assert.match(p, /seq_note/, "the window has to actually contain the offending field");
    },
  );
});

test("the re-ask keeps the size constraints of the rung it follows", { skip }, async () => {
  // The reply that failed to parse had already been shrunk to fit under the
  // ceiling. Asking for it again WITHOUT that constraint invites the
  // truncation we just escaped -- trading one failure for the other.
  await withSdk(
    [
      { text: CUT_PLAN, stopReason: null },
      { text: INVALID_PLAN, stopReason: null },
      { text: COMPLETE_PLAN, stopReason: null },
    ],
    async (f) => {
      await runLeadSdk({ ...base });
      assert.match(f.calls[2].prompt, /OMIT `codeExcerpts` ENTIRELY/, "a reply that fit must go on fitting");
    },
  );
});

test("an invalid plan on the FIRST attempt is corrected, not accused of prose", { skip }, async () => {
  await withSdk([{ text: INVALID_PLAN, stopReason: null }, { text: COMPLETE_PLAN }], async (f) => {
    await runLeadSdk({ ...base });
    assert.equal(f.calls.length, 2);
    const p = f.calls[1].prompt;
    assert.match(p, /SyntaxError/, "the fault is knowable on attempt 1 too");
    assert.doesNotMatch(
      p,
      /you returned prose or an incomplete object/,
      "it returned neither, and telling a model it did leaves it nothing to fix",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The rung is bounded. Each one costs an Opus call.
// ---------------------------------------------------------------------------

test("the re-ask fires ONCE; a second invalid reply ends the run", { skip }, async () => {
  await withSdk([{ text: INVALID_PLAN }, { text: INVALID_PLAN }, { text: INVALID_PLAN }], async (f) => {
    await assert.rejects(() => runLeadSdk({ ...base }), /JSON\.parse failed/);
    assert.equal(f.calls.length, 3, "attempt, contract rung, syntax rung -- and then it stops");
  });
});

test("leadSyntaxRetryEnabled:false hard-fails instead of paying for the call", { skip }, async () => {
  await withSdk([{ text: INVALID_PLAN }, { text: INVALID_PLAN }], async (f) => {
    await assert.rejects(() => runLeadSdk({ ...base, leadSyntaxRetryEnabled: false }));
    assert.equal(f.calls.length, 2, "the operator turned it off; it must not fire anyway");
  });
});

test("a cut stream over a CLOSED document still gets the re-ask", { skip }, async () => {
  // The model finished the JSON and was cut writing prose after it, so the
  // stop reason says max_tokens while the document itself is whole. Salvage
  // has nothing to do here -- closing a document that is already closed does
  // nothing about a bad token inside it -- and the re-ask is the only rung
  // that can help. Gating on the truncation flag would have blocked it.
  await withSdk(
    [
      { text: `${INVALID_PLAN}\n\nI should also note that`, stopReason: "max_tokens" },
      { text: COMPLETE_PLAN },
      { text: COMPLETE_PLAN },
    ],
    async (f) => {
      const plan = await runLeadSdk({ ...base });
      assert.equal(plan.repo, "o/r");
      assert.ok(
        f.calls.some((c) => /STILL NOT VALID JSON|SyntaxError/.test(c.prompt)),
        "the fault is describable, so it must be described whatever the stop reason said",
      );
    },
  );
});

test("a TRUNCATED second reply goes to salvage, not to the syntax rung", { skip }, async () => {
  // Salvage is the right answer for a cut-off document and the syntax rung is
  // not. Firing both would pay for a call that cannot help.
  await withSdk([{ text: CUT_PLAN }, { text: CUT_PLAN }], async (f) => {
    const plan = await runLeadSdk({ ...base });
    assert.equal(f.calls.length, 2, "a cut-off reply is salvage's job");
    assert.equal(plan.repo, "o/r", "and salvage still recovers the prefix");
  });
});

// ---------------------------------------------------------------------------
// 3. Every attempt is billed and reported.
// ---------------------------------------------------------------------------

test("all three attempts are billed, including the two that failed", { skip }, async () => {
  await withSdk(
    [
      { text: CUT_PLAN, costUsd: 0.5 },
      { text: INVALID_PLAN, costUsd: 0.75 },
      { text: COMPLETE_PLAN, costUsd: 0.25 },
    ],
    async () => {
      const plan = await runLeadSdk({ ...base });
      assert.ok(
        Math.abs(plan.costUsd - 1.5) < 1e-9,
        `a plan that took three goes is billed for three goes; got ${plan.costUsd}`,
      );
    },
  );
});

test("onAttempt reports the ladder, including the rungs that were survived", { skip }, async () => {
  const seen = [];
  await withSdk(
    [
      { text: CUT_PLAN, costUsd: 0.5 },
      { text: INVALID_PLAN, costUsd: 0.75 },
      { text: COMPLETE_PLAN, costUsd: 0.25 },
    ],
    async () => {
      await runLeadSdk({ ...base, onAttempt: (i) => seen.push(i) });
    },
  );
  assert.equal(seen.length, 3, "one report per attempt, win or lose");
  assert.deepEqual(
    seen.map((s) => [s.attempt, s.outcome, s.rung ?? null]),
    [
      [1, "truncated", null],
      [2, "invalid_json", "mechanical_size_reduction"],
      [3, "ok", "syntax_repair"],
    ],
    "this is the trail the smoke report reads; without it a recovered truncation is invisible",
  );
  assert.ok(seen[0].outputChars > 0, "the size is the number that tells a ceiling from a stall");
});

test("a failed attempt still reports what it cost", { skip }, async () => {
  const seen = [];
  await withSdk([{ text: CUT_PLAN, costUsd: 0.5 }, { text: COMPLETE_PLAN, costUsd: 0.25 }], async () => {
    await runLeadSdk({ ...base, onAttempt: (i) => seen.push(i) });
  });
  assert.equal(seen[0].costUsd, 0.5, "the attempt that failed is exactly the spend nobody could see");
});

test("an onAttempt that throws does not cost us the plan", { skip }, async () => {
  await withSdk([{ text: COMPLETE_PLAN }], async () => {
    const plan = await runLeadSdk({
      ...base,
      onAttempt: () => {
        throw new Error("audit sink is down");
      },
    });
    assert.equal(plan.repo, "o/r", "bookkeeping must never be able to kill a run");
  });
});

// ---------------------------------------------------------------------------
// 4. describeJsonSyntaxFault on its own.
// ---------------------------------------------------------------------------

test("the fault description is string-aware", { skip }, async () => {
  // A plan whose prose legitimately discusses the word must not be told that
  // its prose is the bug. This is the difference between a correction the
  // model can act on and one that sends it chasing a healthy field.
  const err = new Error('[lead] JSON.parse failed: SyntaxError: Unexpected token }\n--- extracted ---\nx\n--- raw ---\ny');
  err.extractedText = '{"note":"the value is undefined","subTasks":[],}';
  const fault = describeJsonSyntaxFault(err);
  assert.ok(fault, "a trailing comma is still a describable fault");
  assert.doesNotMatch(
    fault,
    /is a JavaScript literal/,
    "the only `undefined` here is inside a string, and strings are allowed to say anything",
  );
});

test("the fault description finds the literal when the parser gives no position", { skip }, async () => {
  const err = new Error("[lead] JSON.parse failed: SyntaxError: Unexpected token 'u'");
  err.extractedText = INVALID_PLAN;
  const fault = describeJsonSyntaxFault(err);
  assert.match(fault, /`undefined` is a JavaScript literal/);
  assert.match(fault, /OMIT the key entirely or write null/, "tell it both legal ways out");
});

test("the fault description reads the document out of the message when it has to", { skip }, async () => {
  // Some errors cross a boundary that keeps the message and drops properties.
  const err = new Error(
    `[lead] JSON.parse failed: SyntaxError: Unexpected token 'u'\n--- extracted ---\n${INVALID_PLAN}\n--- raw ---\nraw`,
  );
  assert.match(describeJsonSyntaxFault(err), /`undefined` is a JavaScript literal/);
});

test("a non-parse failure is not described as a syntax fault", { skip }, async () => {
  assert.equal(
    describeJsonSyntaxFault(new Error("[lead] extractJson failed: no JSON in output")),
    undefined,
    "prose drift has its own rung and must keep it",
  );
  assert.equal(describeJsonSyntaxFault(undefined), undefined);
});
