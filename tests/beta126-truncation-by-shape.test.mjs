// beta.126 — the document is better evidence than the metadata.
//
// The b125 planning run failed like this:
//
//   13:41:15  loop.start
//   13:44:20  [lead] plan JSON parse/validation failed; retrying ONCE with a
//             terse output-contract re-assertion (beta.81 anti-prose-drift)
//   13:47:30  loop.plan_failed — extractJson failed: no JSON in output
//             (model returned prose, not the JSON contract)
//
// The reply was not prose. It began:
//
//   {"repo":"Stitch-Vercel/ProjectThanos","branch":"harness/feat/grc-...
//
// It was the contract, cut off mid-write. But the only evidence of truncation
// the harness would accept was `stop_reason === "max_tokens"` from the SDK, and
// no stop reason arrived, because no output ceiling was configured and the SDK
// was capping a model id it did not recognise. So `truncated` was false, the
// b97 compaction rung was skipped, and the b81 anti-prose rung ran instead --
// telling a model that was being cut at a fixed length to "begin your reply
// with '{'". It began with '{' and was cut at the same fixed length. Six
// minutes, two Opus calls, no plan, $0.00 recorded.
//
// A reply that opens a JSON container and never closes it was cut off. There is
// no other way to produce one. That fact is available without the SDK's help.
import test from "node:test";
import assert from "node:assert/strict";

let extractJson;
try {
  ({ extractJson } = await import("../dist/adapters/claude-code.js"));
} catch {
  extractJson = null;
}
const skip = extractJson === null ? "build not present (npm run build)" : false;

// The real b125 opening, cut where the ceiling cut it.
const CUT_PLAN =
  '{"repo":"Stitch-Vercel/ProjectThanos","branch":"harness/feat/grc-continuity-resilience",' +
  '"riskLevel":"high","subTasks":[{"seq":1,"title":"Probe: capture the exact patterns this ' +
  'feature must mirror","intent":"Read the existing GRC modules and record the conventions",' +
  '"changeSpec":"Study src/app/(grc)/** and note the drawer';

test("a plan cut off mid-write is reported as TRUNCATED, not as prose", { skip }, () => {
  assert.throws(
    () => extractJson(CUT_PLAN),
    (err) => {
      assert.match(err.message, /truncated JSON in output/, "name the actual failure");
      assert.match(err.message, /opened a JSON container and never closed it/);
      assert.doesNotMatch(err.message, /returned prose/, "this is the sentence that cost 40 minutes");
      assert.doesNotMatch(err.message, /tools: \[\]/, "and this is the subsystem it sent us to debug, which was fine");
      return true;
    },
  );
});

test("the truncation error shows the TAIL, because that is where the cut is", { skip }, () => {
  // The prose error slices the first 200 chars. On a truncated document the
  // first 200 chars are the part that worked.
  try {
    extractJson(CUT_PLAN);
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /note the drawer/, "the end of the document is the diagnostic");
    assert.match(err.message, new RegExp(`${CUT_PLAN.length} chars`), "size tells you where the ceiling is");
  }
});

test("genuine prose is still reported as prose", { skip }, () => {
  assert.throws(
    () => extractJson("I'm sorry, I can't help with that request."),
    (err) => {
      assert.match(err.message, /model returned prose/, "the b81 failure mode is real and still needs its own message");
      assert.doesNotMatch(err.message, /truncated/);
      return true;
    },
  );
});

test("prose that merely mentions a brace is not mistaken for truncation", { skip }, () => {
  // `{name}` balances, so it is a candidate and extractJson hands it back
  // unchanged -- the caller's JSON.parse produces the real diagnostic. That is
  // pre-existing behaviour and it is fine. What must NOT happen is this being
  // read as a cut-off document, which would send the retry down the compaction
  // rung and ask a model to be terser about prose it should not have written.
  assert.equal(extractJson("Use a template like {name} in the field."), "{name}");
});

test("prose with an UNCLOSED brace is treated as truncation, and that is correct", { skip }, () => {
  // A reply that opens a container and stops was cut off, whatever the words
  // around it were. There is no reading of this that is a complete answer.
  assert.throws(
    () => extractJson("Sure, here is the plan:\n{\"repo\":\"o/r\",\"subTasks\":[{\"seq\":1"),
    (err) => {
      assert.match(err.message, /truncated JSON in output/);
      return true;
    },
  );
});

test("a complete plan is not touched by any of this", { skip }, () => {
  const good = '{"repo":"o/r","branch":"b","riskLevel":"low","subTasks":[{"seq":1}]}';
  assert.equal(extractJson(good), good);
});

test("prose wrapped around a COMPLETE object still extracts, as before", { skip }, () => {
  const wrapped = 'Here is the plan you asked for:\n{"repo":"o/r","subTasks":[]}\nLet me know.';
  assert.equal(extractJson(wrapped), '{"repo":"o/r","subTasks":[]}');
});

test("a truncated ARRAY is caught too, not just an object", { skip }, () => {
  assert.throws(
    () => extractJson('[{"seq":1,"title":"one"},{"seq":2,"title":"tw'),
    (err) => {
      assert.match(err.message, /truncated JSON in output/);
      return true;
    },
  );
});

test("a brace inside a string does not fake a truncation", { skip }, () => {
  // The scanner must respect string state, or `"{"` reads as an open container.
  const good = '{"repo":"o/r","note":"use {placeholder} here","subTasks":[]}';
  assert.equal(extractJson(good), good);
});

test("an escaped quote does not desynchronise the scanner", { skip }, () => {
  const good = '{"repo":"o/r","note":"he said \\"hi\\" loudly","subTasks":[]}';
  assert.equal(extractJson(good), good);
});

test("empty output is neither prose nor truncation-with-a-tail", { skip }, () => {
  assert.throws(
    () => extractJson(""),
    (err) => {
      assert.match(err.message, /no JSON in output/, "nothing at all is the prose branch, and must not claim a cut");
      return true;
    },
  );
});
