// beta.126 — driving the whole ladder, because the rungs were never the problem.
//
// b81 added "retry once on prose drift". b97 added "if it was truncated, retry
// with a compaction instruction instead, because re-asserting the contract
// re-truncates identically". b99 added "if both attempts were cut off, salvage
// the well-formed prefix rather than losing the run". Three releases of careful
// work, each rung correct in isolation.
//
// On b125 all three were live and the run died in planning anyway, because the
// thing that chooses between rungs -- `truncated` -- was false for a reply that
// had plainly been cut off. The SDK never said `max_tokens` (it was capping a
// model id it did not recognise, at a ceiling nobody had configured), and that
// was the only evidence the ladder would accept. So it took the prose rung and
// re-truncated at the same invisible wall, exactly as b97's comment warned.
//
// No test could see that, because nothing below runLeadSdk was reachable
// without a real subprocess. These drive the ladder against a fake SDK and
// assert which rung ran.
import test from "node:test";
import assert from "node:assert/strict";

let runLeadSdk, __setSdkForTests;
try {
  ({ runLeadSdk, __setSdkForTests } = await import("../dist/adapters/claude-code.js"));
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

// The b125 shape: the contract, opened and cut mid-write.
const CUT_PLAN = '{"repo":"o/r","branch":"harness/x","riskLevel":"high","subTasks":[{"seq":1,"title":"probe","changeSpec":"read src/';

/**
 * A fake SDK that replays one scripted reply per call.
 *
 * `stopReason: null` is the b125 condition -- the SDK capped the output and
 * said nothing about why, which is what a model id newer than the pinned SDK
 * produces.
 */
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
          yield { type: "assistant", message: { content: [{ type: "text", text: reply.text }], stop_reason: reply.assistantStop ?? null } };
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
  try { return await fn(f); } finally { restore(); }
}

// ---------------------------------------------------------------------------
// 1. The b125 regression, driven end to end.
// ---------------------------------------------------------------------------

test("a cut-off reply with NO stop_reason takes the COMPACTION rung, not the anti-prose rung", { skip }, async () => {
  await withSdk(
    [{ text: CUT_PLAN, stopReason: null }, { text: COMPLETE_PLAN, stopReason: null }],
    async (f) => {
      const plan = await runLeadSdk({ ...base });
      assert.equal(f.calls.length, 2, "it should retry exactly once");
      const retryPrompt = f.calls[1].prompt;
      assert.match(retryPrompt, /YOUR PREVIOUS REPLY WAS TRUNCATED/, "this is the whole of b126");
      assert.match(retryPrompt, /OMIT `codeExcerpts` ENTIRELY/, "the mechanical size reduction, not a plea");
      assert.doesNotMatch(
        retryPrompt,
        /YOUR PREVIOUS REPLY WAS NOT VALID JSON/,
        "the anti-prose rung is what b125 took, and it re-truncated at the same wall",
      );
      assert.equal(plan.repo, "o/r", "and the retry's plan is returned");
    },
  );
});

test("a genuine prose reply still takes the ANTI-PROSE rung", { skip }, async () => {
  await withSdk(
    [{ text: "I think we should discuss the approach first." }, { text: COMPLETE_PLAN }],
    async (f) => {
      await runLeadSdk({ ...base });
      assert.match(f.calls[1].prompt, /YOUR PREVIOUS REPLY WAS NOT VALID JSON/);
      assert.doesNotMatch(f.calls[1].prompt, /WAS TRUNCATED/, "b81's failure mode is real and keeps its own rung");
    },
  );
});

test("an explicit max_tokens stop_reason still takes the compaction rung, as b97 intended", { skip }, async () => {
  await withSdk(
    [{ text: CUT_PLAN, stopReason: "max_tokens" }, { text: COMPLETE_PLAN }],
    async (f) => {
      await runLeadSdk({ ...base });
      assert.match(f.calls[1].prompt, /YOUR PREVIOUS REPLY WAS TRUNCATED/);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. The ceiling reaches the subprocess.
// ---------------------------------------------------------------------------

test("maxOutputTokens is exported to the SDK subprocess", { skip }, async () => {
  await withSdk([{ text: COMPLETE_PLAN }], async (f) => {
    await runLeadSdk({ ...base, maxOutputTokens: 64000 });
    assert.equal(
      f.calls[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
      "64000",
      "without this the SDK picks a ceiling from its own model table, which has no entry for claude-opus-5",
    );
  });
});

test("an unset ceiling still reaches the subprocess via buildSdkEnv's own fallback", { skip }, async () => {
  // This is the fact that corrected the b125 diagnosis. The missing DEFAULTS
  // entry looked like it left the subprocess uncapped; it never did, because
  // buildSdkEnv substitutes DEFAULT_SDK_MAX_OUTPUT_TOKENS. Pinned so nobody
  // reaches for that explanation again.
  const { DEFAULT_SDK_MAX_OUTPUT_TOKENS } = await import("../dist/adapters/claude-code.js");
  await withSdk([{ text: COMPLETE_PLAN }], async (f) => {
    await runLeadSdk({ ...base });
    assert.equal(f.calls[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(DEFAULT_SDK_MAX_OUTPUT_TOKENS));
  });
});

test("an explicit 0 genuinely leaves the subprocess uncapped", { skip }, async () => {
  await withSdk([{ text: COMPLETE_PLAN }], async (f) => {
    await runLeadSdk({ ...base, maxOutputTokens: 0 });
    assert.ok(!f.calls[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "0 is the documented escape hatch and must still work");
  });
});

// ---------------------------------------------------------------------------
// 3. Salvage, and paying for what was spent.
// ---------------------------------------------------------------------------

test("two cut-off attempts SALVAGE the prefix rather than losing the run", { skip }, async () => {
  const twoTasks =
    '{"repo":"o/r","branch":"b","riskLevel":"high","reviewChecklist":["c"],"subTasks":[' +
    '{"seq":1,"title":"complete one","intent":"done"},' +
    '{"seq":2,"title":"cut off here","intent":"nev';
  await withSdk([{ text: twoTasks }, { text: twoTasks }], async () => {
    const plan = await runLeadSdk({ ...base });
    assert.equal(plan.subTasks.length, 1, "the half-written sub-task is dropped whole");
    assert.equal(plan.subTasks[0].title, "complete one");
  });
});

test("the cost of BOTH attempts is reported, not just the last", { skip }, async () => {
  await withSdk(
    [{ text: CUT_PLAN, costUsd: 3 }, { text: COMPLETE_PLAN, costUsd: 4 }],
    async () => {
      const plan = await runLeadSdk({ ...base });
      assert.equal(plan.costUsd, 7, "attempt 1 burned real tokens whether or not it parsed");
    },
  );
});

test("a salvaged plan is not a free plan", { skip }, async () => {
  const cut = '{"repo":"o/r","branch":"b","riskLevel":"high","reviewChecklist":[],"subTasks":[{"seq":1,"title":"one"},{"seq":2,"ti';
  await withSdk([{ text: cut, costUsd: 2 }, { text: cut, costUsd: 5 }], async () => {
    const plan = await runLeadSdk({ ...base });
    assert.ok(plan.costUsd >= 7, `both attempts must be billed, got ${plan.costUsd}`);
  });
});

test("a failed plan still carries its cost out on the error", { skip }, async () => {
  // Nothing salvageable: prose twice. The session must still be able to charge
  // for it -- b125 spent six minutes of Opus and recorded $0.00.
  await withSdk([{ text: "no.", costUsd: 2 }, { text: "still no.", costUsd: 3 }], async () => {
    await assert.rejects(
      runLeadSdk({ ...base }),
      (err) => {
        assert.equal(err.costUsd, 5, "the caller cannot charge for what it is never told");
        return true;
      },
    );
  });
});

test("the raw reply is carried on the error so an operator can see what came back", { skip }, async () => {
  await withSdk([{ text: "I would rather discuss this." }, { text: "Still would rather discuss it." }], async () => {
    await assert.rejects(runLeadSdk({ ...base }), (err) => {
      assert.equal(err.rawText, "Still would rather discuss it.");
      return true;
    });
  });
});

test("a truncated first attempt is salvaged even when the RETRY comes back as prose", { skip }, async () => {
  // The b99 fallback: salvage attempt 2's error first, then attempt 1's. A
  // prose retry has nothing to recover, so the cut-off first plan is the last
  // usable thing the run produced and must not be thrown away with it.
  const cut = '{"repo":"o/r","branch":"b","riskLevel":"high","reviewChecklist":[],"subTasks":[{"seq":1,"title":"kept"},{"seq":2,"ti';
  await withSdk([{ text: cut }, { text: "I would rather discuss this." }], async () => {
    const plan = await runLeadSdk({ ...base });
    assert.equal(plan.subTasks.length, 1);
    assert.equal(plan.subTasks[0].title, "kept");
  });
});
