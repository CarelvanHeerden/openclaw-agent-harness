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

test("extractJson: prose-only output throws a diagnostic 'model returned prose' error (beta.27)",
  { skip: extractJson === null }, () => {
    assert.throws(
      () => extractJson("I'll help you fix the Morning Briefings typo. First I'll explore the repo."),
      /model returned prose.*allowedTools/,
    );
  });
