import test from "node:test";
import assert from "node:assert/strict";

let extractJson, extractAndValidateJson;
try {
  ({ extractJson, extractAndValidateJson } = await import("../dist/adapters/claude-sdk.js"));
} catch {
  extractJson = null;
}

test("extractAndValidateJson: happy path returns parsed object",
  { skip: extractAndValidateJson === null }, () => {
    const raw = 'Sure! Here is your JSON:\n```json\n{"intent":"dev_task","reason":"user asked for code"}\n```';
    const r = extractAndValidateJson(raw, { requiredKeys: ["intent", "reason"], label: "test" });
    assert.equal(r.intent, "dev_task");
    assert.equal(r.reason, "user asked for code");
  });

test("extractAndValidateJson: missing required key throws with raw text in error",
  { skip: extractAndValidateJson === null }, () => {
    const raw = '{"intent":"dev_task"}';
    assert.throws(
      () => extractAndValidateJson(raw, { requiredKeys: ["intent", "reason"], label: "classifier" }),
      /classifier.*missing required keys.*reason/,
    );
  });

test("extractAndValidateJson: trailing JSON logs a warning without throwing",
  { skip: extractAndValidateJson === null }, () => {
    // Model returned two objects, we would silently take the first one
    const raw = '{"intent":"dev_task","reason":"ok"}\n\nHere is also {"other":42}';
    const warns = [];
    const r = extractAndValidateJson(raw, {
      requiredKeys: ["intent", "reason"],
      label: "classifier",
      logger: { warn(m, meta) { warns.push({ m, meta }); } },
    });
    assert.equal(r.intent, "dev_task");
    assert.equal(warns.length, 1, "should have warned about trailing JSON");
    assert.match(warns[0].m, /second JSON object we ignored/);
    assert.ok(warns[0].meta.tailPreview.includes('{"other":42}'));
  });

test("extractAndValidateJson: bad JSON preserves raw text in error",
  { skip: extractAndValidateJson === null }, () => {
    const raw = 'Definitely not JSON, sorry';
    assert.throws(
      () => extractAndValidateJson(raw, { requiredKeys: ["intent"], label: "test" }),
      /Definitely not JSON/,
    );
  });

test("extractAndValidateJson: typeCheck failure throws with label",
  { skip: extractAndValidateJson === null }, () => {
    const raw = '{"intent":"dev_task","reason":"ok"}';
    assert.throws(
      () => extractAndValidateJson(raw, {
        requiredKeys: ["intent"],
        label: "classifier",
        typeCheck: (o) => o.intent === "not_dev",
      }),
      /classifier.*failed typeCheck/,
    );
  });

test("extractJson: bracket depth counting handles nested + strings",
  { skip: extractJson === null }, () => {
    const raw = 'foo {"a":{"b":"} not the end"},"c":[1,2,3]} bar';
    const j = extractJson(raw);
    const parsed = JSON.parse(j);
    assert.equal(parsed.a.b, "} not the end");
    assert.deepEqual(parsed.c, [1, 2, 3]);
  });

test("extractJson: prose-only output throws a diagnostic 'model returned prose' error (beta.28)",
  { skip: extractJson === null }, () => {
    assert.throws(
      () => extractJson("I'll help you fix the Morning Briefings typo. First I'll explore the repo."),
      /model returned prose.*tools: \[\]/,
    );
  });

// beta.31: session 78237f43 — the lead model emitted its plan as if writing a
// file: a ```json fence whose CONTENT was a JSON-string-escaped payload
// (`\n{\n \"repo\": ...`). extractJson used to return that escaped text and
// JSON.parse choked on the leading `\`. Now it must unwrap -> parse.
test("extractJson: double-encoded (JSON-string-escaped) fenced JSON is unwrapped and parses (beta.31)",
  { skip: extractJson === null }, () => {
    // Reproduce the exact shape: the real JSON, JSON-string-encoded, inside a fence.
    const realPlan = { repo: "Stitch-Vercel/ProjectThanos", branch: "harness/x", subTasks: [] };
    const escaped = JSON.stringify(realPlan); // {"repo":"..."}
    // Now double-encode: put it as an escaped string (as the Write content would be)
    const doubleEncoded = JSON.stringify("```json\n" + JSON.stringify(realPlan, null, 1) + "\n```").slice(1, -1);
    const raw = "```json\n" + doubleEncoded + "\n```";
    const j = extractJson(raw);
    const parsed = JSON.parse(j);
    assert.equal(parsed.repo, "Stitch-Vercel/ProjectThanos");
    assert.equal(parsed.branch, "harness/x");
    assert.ok(Array.isArray(parsed.subTasks));
    void escaped;
  });

test("extractJson: the literal 78237f43 escaped-newline payload no longer throws (beta.31)",
  { skip: extractJson === null }, () => {
    // The error was: Unexpected token '\', "\n{\n \"r\"..."
    // i.e. the extracted content began with an escaped newline + escaped quotes.
    const inner = '\\n{\\n \\"repo\\": \\"Stitch-Vercel/ProjectThanos\\", \\"branch\\": \\"harness/x\\", \\"subTasks\\": []\\n}';
    const raw = "```json\n" + inner + "\n```";
    const j = extractJson(raw);
    // must not throw, and must produce parseable JSON with the right repo
    const parsed = JSON.parse(j);
    assert.equal(parsed.repo, "Stitch-Vercel/ProjectThanos");
  });

test("extractJson: plain raw JSON (no fence) still works (beta.31 regression)",
  { skip: extractJson === null }, () => {
    const parsed = JSON.parse(extractJson('{"repo":"o/r","subTasks":[1,2]}'));
    assert.equal(parsed.repo, "o/r");
  });

test("extractJson: prefers the FIRST parseable candidate (fence over balanced) (beta.31)",
  { skip: extractJson === null }, () => {
    const raw = 'Here is the plan:\n```json\n{"repo":"a/b","n":1}\n```\nand some trailing {"junk":true}';
    const parsed = JSON.parse(extractJson(raw));
    assert.equal(parsed.repo, "a/b");
    assert.equal(parsed.n, 1);
  });
