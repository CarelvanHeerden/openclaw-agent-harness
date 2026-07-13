/**
 * Unit tests for the Claude Agent SDK adapter helpers.
 *
 * Round-3 additions (2026-07-13):
 *   - `prepareAdversaryDiff` truncation banner (item #7)
 *   - `parseAndValidate` schema gate on extractJson (item #5)
 *   - `resolvePrice` config-driven pricing (item #6)
 *   - `detectCostDrift` warning generation (item #6)
 *
 * These do NOT hit the network. They exercise the pure helper functions
 * we added to the adapter so future refactors keep the invariants.
 */

import test from "node:test";
import assert from "node:assert/strict";

let mod, schemas;
try {
  mod = await import("../dist/adapters/claude-sdk.js");
  schemas = await import("../dist/adapters/sdk-schemas.js");
} catch {
  mod = null;
  schemas = null;
}

test("prepareAdversaryDiff: short diffs pass through unchanged",
  { skip: mod === null }, () => {
    const diff = "diff --git a/foo b/foo\n+hello\n";
    assert.equal(mod.prepareAdversaryDiff(diff), diff);
  });

test("prepareAdversaryDiff: long diffs get a truncation banner",
  { skip: mod === null }, () => {
    const cap = 1024;
    const big = "x".repeat(cap * 3);
    const out = mod.prepareAdversaryDiff(big, cap);
    assert.ok(out.startsWith("[TRUNCATED: showing first"), `banner missing: ${out.slice(0, 100)}`);
    assert.match(out, /1KB of 3KB diff/);
    assert.match(out, /reviewer must flag incomplete coverage/);
    assert.ok(out.length <= cap, `output must respect cap, got ${out.length}`);
  });

test("parseAndValidate: passes a well-shaped classifier result",
  { skip: schemas === null }, () => {
    const raw = '{"intent":"dev_task","reason":"user wants code edited"}';
    const parsed = schemas.parseAndValidate(raw, schemas.ClassifierResultSchema, raw, "classifier");
    assert.equal(parsed.intent, "dev_task");
    assert.equal(parsed.reason, "user wants code edited");
  });

test("parseAndValidate: throws with caller label + raw on schema mismatch",
  { skip: schemas === null }, () => {
    const raw = '{"intent":"unknown-intent","reason":"foo"}';
    assert.throws(
      () => schemas.parseAndValidate(raw, schemas.ClassifierResultSchema, raw, "classifier"),
      /\[classifier\].*failed schema validation.*Raw output/s,
    );
  });

test("parseAndValidate: throws on invalid JSON",
  { skip: schemas === null }, () => {
    const raw = "definitely not json";
    assert.throws(
      () => schemas.parseAndValidate("not json", schemas.ClassifierResultSchema, raw, "classifier"),
      /invalid JSON/,
    );
  });

test("LeadPlanSchema: enforces harness/ branch prefix and owner/repo",
  { skip: schemas === null }, () => {
    const good = {
      repo: "owner/repo",
      branch: "harness/foo-abc",
      subTasks: [{ seq: 1, title: "t", intent: "i", filesLikelyTouched: [], successCriteria: ["c"], estimatedTokens: 100 }],
      reviewChecklist: ["c"],
      riskLevel: "low",
    };
    assert.doesNotThrow(() => schemas.parseAndValidate(JSON.stringify(good), schemas.LeadPlanSchema, "", "lead"));

    const badBranch = { ...good, branch: "feat/foo" };
    assert.throws(() => schemas.parseAndValidate(JSON.stringify(badBranch), schemas.LeadPlanSchema, "", "lead"), /harness\//);

    const badRepo = { ...good, repo: "just-a-name" };
    assert.throws(() => schemas.parseAndValidate(JSON.stringify(badRepo), schemas.LeadPlanSchema, "", "lead"), /owner\/repo/);
  });

test("resolvePrice: config override beats defaults, falls back to sonnet",
  { skip: mod === null }, () => {
    const override = { "claude-sonnet-5": { input: 4, output: 16 }, "custom-model": { input: 100, output: 500 } };
    assert.deepEqual(mod.resolvePrice("claude-sonnet-5", { override }), { input: 4, output: 16 });
    assert.deepEqual(mod.resolvePrice("custom-model", { override }), { input: 100, output: 500 });
    // Unknown model + no override -> falls back to default sonnet
    const fallback = mod.resolvePrice("unknown-model-9000");
    assert.equal(typeof fallback.input, "number");
    assert.equal(typeof fallback.output, "number");
  });

test("detectCostDrift: within tolerance returns null",
  { skip: mod === null }, () => {
    assert.equal(mod.detectCostDrift(1.05, 1.0, 0.2), null);
    assert.equal(mod.detectCostDrift(0.9, 1.0, 0.2), null);
  });

test("detectCostDrift: outside tolerance returns a warning with direction",
  { skip: mod === null }, () => {
    const under = mod.detectCostDrift(2.0, 1.0, 0.2);
    assert.match(under, /UNDER/);
    assert.match(under, /drift=100/);
    const over = mod.detectCostDrift(0.5, 1.0, 0.2);
    assert.match(over, /OVER/);
    assert.match(over, /drift=50/);
  });

test("detectCostDrift: guards against zero / missing inputs",
  { skip: mod === null }, () => {
    assert.equal(mod.detectCostDrift(undefined, 1.0), null);
    assert.equal(mod.detectCostDrift(0, 1.0), null);
    assert.equal(mod.detectCostDrift(1.0, 0), null);
  });
