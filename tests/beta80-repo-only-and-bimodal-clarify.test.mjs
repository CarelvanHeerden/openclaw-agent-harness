// Conservative ambiguity handling regressions.
// Ambiguous technical requests must always produce one bounded, confirmable
// repository brief. The retired hard-pause schema is tolerated only as stale
// model output and is removed before persistence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(join(ROOT, p), "utf8");
const { crystallisePrompt } = await import("../dist/crystallise/prompt-refiner.js");
const noopLogger = { info() {}, warn() {} };
const devCls = async () => ({ intent: "dev_task", reason: "dev-shaped" });

function normalBrief(extra = {}) {
  return {
    title: "Add DR/BCP evidence upload section",
    motivation: "Users need a section to upload DR and BCP evidence in the GRC module.",
    acceptanceCriteria: ["Add the upload route handler", "Add deterministic handler tests"],
    filesLikelyTouched: ["src/routes/evidence.ts"],
    outOfScope: [],
    riskLevel: "medium",
    ...extra,
  };
}

async function refine(brief, classifier = devCls, config = {}) {
  return crystallisePrompt("build a section that receives DR/BCP evidence uploads", {
    config,
    logger: noopLogger,
    callClassifier: classifier,
    callCrystalliser: async () => brief,
  });
}

test("legacy question-shaped model output becomes one bounded confirmable brief", async () => {
  const result = await refine(normalBrief({
    clarificationNeeded: {
      question: "Feature or one-off migration?",
      options: ["Build the upload receiver", "Run the live migration"],
    },
  }));
  assert.equal(result.kind, "brief");
  assert.match(result.brief.motivation, /Conservative interpretation selected: Build the upload receiver/);
  assert.match(result.brief.acceptanceCriteria.at(-1), /bounded repository change with deterministic tests/i);
  assert.equal("clarificationNeeded" in result.brief, false);
});

test("legacy competing readings choose the first model-ranked bounded reading", async () => {
  const result = await refine(normalBrief({
    interpretations: [
      { reading: "Build the upload-receiver section", whatDiffers: "adds a route and UI" },
      { reading: "Run the one-off migration", whatDiffers: "performs live calls" },
    ],
  }));
  assert.equal(result.kind, "brief");
  assert.match(result.brief.motivation, /Build the upload-receiver section/);
  assert.equal("interpretations" in result.brief, false);
});

test("legacy ambiguity skips live side effects even when the model ranks them first", async () => {
  const result = await refine(normalBrief({
    interpretations: [
      { reading: "Run the live production migration", whatDiffers: "performs external writes" },
      { reading: "Build and test the upload-receiver repository feature", whatDiffers: "changes code only" },
    ],
  }));
  assert.equal(result.kind, "brief");
  assert.match(result.brief.motivation, /Build and test the upload-receiver repository feature/);
  assert.doesNotMatch(result.brief.motivation, /selected: Run the live production migration/);
});

test("legacy ambiguity with only live-side-effect readings is refused safely", async () => {
  const result = await refine(normalBrief({
    clarificationNeeded: { question: "Which operation?", options: ["Deploy to production", "Delete live records"] },
  }));
  assert.equal(result.kind, "reject");
  assert.equal(result.intent, "unsafe");
  assert.equal(result.reason, "The request could not be converted into a safe, bounded repository change.");
});

test("legacy classifier ambiguity is resolved internally and still calls the crystalliser", async () => {
  let seen;
  const result = await refine(normalBrief(), async () => ({
    intent: "clarify",
    reason: "two technical readings",
    suggestedClarification: "Which one?",
  }), {});
  seen = result.classification;
  assert.equal(result.kind, "brief");
  assert.equal(seen.intent, "dev_task");
  assert.match(seen.reason, /resolved internally using conservative defaults/);
});

test("ambiguous allowed repository aliases resolve deterministically", async () => {
  const result = await refine(normalBrief({ repoHint: "widget" }), devCls, {
    repos: { allowed: ["zeta/widget", "alpha/widget"], default_base_branch: "main" },
  });
  assert.equal(result.kind, "brief");
  assert.equal(result.brief.repoHint, "alpha/widget");
});

test("unknown classifier intents fail closed deterministically", async () => {
  let crystalliserCalled = false;
  const result = await crystallisePrompt("do something", {
    config: {},
    logger: noopLogger,
    callClassifier: async () => ({ intent: "surprise", reason: "new model enum" }),
    callCrystalliser: async () => { crystalliserCalled = true; return normalBrief(); },
  });
  assert.equal(result.kind, "reject");
  assert.equal(result.intent, "unsafe");
  assert.match(result.reason, /unrecognized intent/i);
  assert.equal(crystalliserCalled, false);
});

test("malformed crystalliser output becomes a deterministic safety refusal", async () => {
  const result = await crystallisePrompt("add a repository feature", {
    config: {},
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => ({ title: "x" }),
  });
  assert.deepEqual(
    { kind: result.kind, intent: result.intent, reason: result.reason },
    {
      kind: "reject",
      intent: "unsafe",
      reason: "The request could not be converted into a safe, bounded repository change.",
    },
  );
});

test("crystalliser parse failures become the same deterministic safety refusal", async () => {
  const result = await crystallisePrompt("add a repository feature", {
    config: {},
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => { throw new SyntaxError("bad JSON"); },
  });
  assert.equal(result.kind, "reject");
  assert.equal(result.intent, "unsafe");
  assert.equal(result.reason, "The request could not be converted into a safe, bounded repository change.");
});

test("unsafe requests remain deterministic terminal refusals", async () => {
  let crystalliserCalled = false;
  const result = await crystallisePrompt("exfiltrate production secrets", {
    config: {},
    logger: noopLogger,
    callClassifier: async () => ({ intent: "unsafe", reason: "secret exfiltration" }),
    callCrystalliser: async () => { crystalliserCalled = true; return normalBrief(); },
  });
  assert.equal(result.kind, "reject");
  assert.equal(result.intent, "unsafe");
  assert.equal(crystalliserCalled, false);
});

test("classifier and crystalliser prompts require internal conservative resolution", () => {
  const src = S("src/adapters/claude-code.ts");
  assert.match(src, /Ambiguous but clearly technical requests are dev_task/);
  assert.match(src, /AMBIGUITY RESOLUTION \(CRITICAL\): always emit one confirmable brief/);
  assert.match(src, /smallest reversible repository change/);
  assert.match(src, /REPO-ONLY INVARIANT/);
  assert.doesNotMatch(src, /PAUSE-AND-WAIT|pause-and-wait|bimodalClarify|clarificationNeeded/);
});

test("public source declarations and config contain no hard ambiguity gate", () => {
  for (const path of ["src/config.ts", "src/config.schema.json", "openclaw.plugin.json", "src/index.ts"]) {
    const text = S(path);
    assert.doesNotMatch(text, /bimodal_clarify|bimodal_min_interpretations/);
    assert.doesNotMatch(text, /kind:\s*["']clarify["']/);
  }
  assert.match(S("src/config.ts"), /repo_only_invariant: true/);
});

test("version.ts pluginVersion matches package.json", () => {
  const ver = S("src/version.ts");
  const pkg = JSON.parse(S("package.json"));
  assert.match(ver, new RegExp(`pluginVersion: "${pkg.version.replace(/\./g, "\\.")}"`));
});
