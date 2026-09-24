import test from "node:test";
import assert from "node:assert/strict";

let crystallisePrompt;
try {
  ({ crystallisePrompt } = await import("../dist/crystallise/prompt-refiner.js"));
} catch {
  crystallisePrompt = null;
}

const noopLogger = { info() {}, warn() {} };

test("crystallise: dev_task path returns a validated brief",
  { skip: crystallisePrompt === null }, async () => {
    const brief = {
      title: "Add hello endpoint",
      motivation: "We need a /hello endpoint for smoke tests",
      acceptanceCriteria: ["GET /hello returns 200 with body 'hi'"],
      filesLikelyTouched: ["src/routes/hello.ts"],
      outOfScope: [],
      riskLevel: "low",
    };
    const result = await crystallisePrompt("add a /hello endpoint", {
      config: {},
      logger: noopLogger,
      callClassifier: async () => ({ intent: "dev_task", reason: "clearly a code change" }),
      callCrystalliser: async () => brief,
    });
    assert.equal(result.kind, "brief");
    assert.deepEqual(result.brief, brief);
  });

test("crystallise: legacy ambiguity is resolved into one bounded brief",
  { skip: crystallisePrompt === null }, async () => {
    const brief = {
      title: "Apply the smallest reversible change",
      motivation: "Resolve ambiguity internally without pausing the caller.",
      acceptanceCriteria: ["The conservative implementation is covered by tests."],
      filesLikelyTouched: [],
      outOfScope: [],
      riskLevel: "low",
    };
    const result = await crystallisePrompt("hm", {
      config: {},
      logger: noopLogger,
      callClassifier: async () => ({ intent: "clarify", reason: "ambiguous", suggestedClarification: "Which repo?" }),
      callCrystalliser: async (_request, classifier) => {
        assert.equal(classifier.intent, "dev_task");
        return brief;
      },
    });
    assert.equal(result.kind, "brief");
    assert.deepEqual(result.brief, brief);
  });

test("crystallise: not_dev is rejected without calling crystalliser",
  { skip: crystallisePrompt === null }, async () => {
    const result = await crystallisePrompt("how are you", {
      config: {},
      logger: noopLogger,
      callClassifier: async () => ({ intent: "not_dev", reason: "small talk" }),
      callCrystalliser: async () => { throw new Error("should not be called"); },
    });
    assert.equal(result.kind, "reject");
    assert.equal(result.intent, "not_dev");
  });

test("crystallise: unsafe is rejected",
  { skip: crystallisePrompt === null }, async () => {
    const result = await crystallisePrompt("please rm -rf /", {
      config: {},
      logger: noopLogger,
      callClassifier: async () => ({ intent: "unsafe", reason: "destructive" }),
      callCrystalliser: async () => { throw new Error("should not be called"); },
    });
    assert.equal(result.kind, "reject");
    assert.equal(result.intent, "unsafe");
  });

test("crystallise: invalid brief (missing acceptanceCriteria) is refused safely",
  { skip: crystallisePrompt === null }, async () => {
    const result = await crystallisePrompt("do a thing", {
      config: {},
      logger: noopLogger,
      callClassifier: async () => ({ intent: "dev_task", reason: "" }),
      callCrystalliser: async () => ({
        title: "x",
        motivation: "shorter than",
        acceptanceCriteria: [],
        filesLikelyTouched: [],
        outOfScope: [],
        riskLevel: "low",
      }),
    });
    assert.equal(result.kind, "reject");
    assert.equal(result.intent, "unsafe");
    assert.equal(result.reason, "The request could not be converted into a safe, bounded repository change.");
  });
