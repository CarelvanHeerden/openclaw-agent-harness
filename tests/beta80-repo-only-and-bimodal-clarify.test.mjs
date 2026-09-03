// beta.80: repo-only invariant (F1) + planning-time bimodality clarify (F2).
//
// Origin: the beta.77 DR/BCP smoke. The prompt "build a section that receives
// DR/BCP evidence uploads" was BIMODAL (build-the-receiver vs run-a-one-off-
// migration vs write-docs); the crystalliser guessed docs and never asked.
// Carel: "Why am I never asked to clarify? Not once, in 77 betas" +
// "hard pause-and-wait ... assumptions cause delays" + repo-only principle.
//
// F1: crystalliser reframes live-API-side-effect ACs into repo code + tests.
// F2: crystalliser self-reports competing readings; >=2 -> hard clarify
//     (pause-and-wait, no session started). No best-guess, no stop-window.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const S = (p) => readFileSync(join(ROOT, p), "utf8");

let refiner;
try {
  ({ crystallisePrompt: refiner } = await import("../dist/crystallise/prompt-refiner.js"));
} catch {
  refiner = null;
}

const noopLogger = { info() {}, warn() {} };
const devCls = async () => ({ intent: "dev_task", reason: "dev-shaped" });

function normalBrief(extra = {}) {
  return {
    title: "Add DR/BCP evidence upload section",
    motivation: "Users need a section to upload DR and BCP evidence in the GRC module",
    acceptanceCriteria: ["Add the upload route handler in src/routes/evidence.ts", "Add a test for the handler"],
    filesLikelyTouched: ["src/routes/evidence.ts"],
    outOfScope: [],
    riskLevel: "medium",
    ...extra,
  };
}

// ---- F2: bimodality routing ----

test("beta80: crystallisePrompt PAUSES (clarify) when the crystalliser emits clarificationNeeded", { skip: refiner === null }, async () => {
  const brief = normalBrief({
    clarificationNeeded: {
      question: "Do you want the upload-receiver feature or a one-off migration?",
      options: ["Build the upload-receiver section", "Run the one-off migration for GD-STITCH-04"],
    },
  });
  const result = await refiner("build a section that receives DR/BCP evidence uploads", {
    config: { brief: { bimodal_clarify: true } },
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "clarify");
  assert.match(result.question, /upload-receiver feature or a one-off migration/i);
  assert.match(result.question, /\(a\).*\(b\)/is);
});

test("beta80: clarify when >=2 interpretations even without explicit clarificationNeeded", { skip: refiner === null }, async () => {
  const brief = normalBrief({
    interpretations: [
      { reading: "Build the upload-receiver section", whatDiffers: "adds a route + UI" },
      { reading: "Run the one-off migration", whatDiffers: "no repo change, live API calls" },
    ],
  });
  const result = await refiner("build/upload DR evidence", {
    config: { brief: { bimodal_clarify: true } },
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "clarify");
  assert.match(result.question, /more than one valid interpretation/i);
  assert.match(result.question, /upload-receiver/i);
});

test("beta80: PROCEEDS (brief) when single reading, no clarificationNeeded", { skip: refiner === null }, async () => {
  const result = await refiner("add the upload endpoint", {
    config: { brief: { bimodal_clarify: true } },
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => normalBrief(),
  });
  assert.equal(result.kind, "brief");
});

test("beta80: PROCEEDS when exactly 1 interpretation", { skip: refiner === null }, async () => {
  const brief = normalBrief({ interpretations: [{ reading: "Build the section", whatDiffers: "" }] });
  const result = await refiner("x", {
    config: { brief: { bimodal_clarify: true } },
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "brief");
});

test("beta80: bimodal_clarify:false -> proceeds even with 2 interpretations (escape hatch)", { skip: refiner === null }, async () => {
  const brief = normalBrief({
    interpretations: [
      { reading: "A", whatDiffers: "x" },
      { reading: "B", whatDiffers: "y" },
    ],
  });
  const result = await refiner("x", {
    config: { brief: { bimodal_clarify: false } },
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "brief");
});

test("beta80: bimodal_min_interpretations:3 -> 2 readings no longer trips", { skip: refiner === null }, async () => {
  const brief = normalBrief({
    interpretations: [
      { reading: "A", whatDiffers: "x" },
      { reading: "B", whatDiffers: "y" },
    ],
  });
  const result = await refiner("x", {
    config: { brief: { bimodal_clarify: true, bimodal_min_interpretations: 3 } },
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "brief");
});

test("beta80: partial config (no brief block) -> defaults on, does not throw, pauses on bimodal", { skip: refiner === null }, async () => {
  const brief = normalBrief({
    clarificationNeeded: { question: "Which one?", options: ["Feature", "Migration"] },
  });
  const result = await refiner("x", {
    config: {},
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "clarify");
});

test("beta80: the exact DR/BCP fork surfaces as a multi-option clarify", { skip: refiner === null }, async () => {
  const brief = normalBrief({
    clarificationNeeded: {
      question: "This can be read three ways -- which do you want?",
      options: [
        "Build the DR/BCP evidence upload section (repo feature)",
        "Run the one-off GD-STITCH-04 migration against the live system",
        "Write a runbook documenting the procedure",
      ],
    },
  });
  const result = await refiner("build a section ... upload DR/BCP evidence", {
    config: {},
    logger: noopLogger,
    callClassifier: devCls,
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "clarify");
  assert.match(result.question, /\(a\).*\(b\).*\(c\)/is);
  assert.match(result.question, /runbook/i);
});

test("beta80: classifier clarify still returns a question (unchanged path)", { skip: refiner === null }, async () => {
  const result = await refiner("hm", {
    config: {},
    logger: noopLogger,
    callClassifier: async () => ({ intent: "clarify", reason: "ambiguous", suggestedClarification: "Which repo?" }),
    callCrystalliser: async () => { throw new Error("should not be called"); },
  });
  assert.equal(result.kind, "clarify");
  assert.match(result.question, /Which repo/);
});

// ---- source assertions: prompts ----

test("beta80: crystalliser prompt carries the REPO-ONLY reframe rule", () => {
  const src = S("src/adapters/claude-code.ts");
  assert.match(src, /REPO-ONLY INVARIANT/);
  assert.match(src, /never as the acceptance criterion itself/i);
  assert.match(src, /Do NOT satisfy such a request by writing MARKDOWN docs/i);
});

test("beta80: crystalliser prompt carries the BIMODALITY self-report instruction", () => {
  const src = S("src/adapters/claude-code.ts");
  assert.match(src, /BIMODALITY SELF-REPORT/);
  assert.match(src, /interpretations/);
  assert.match(src, /clarificationNeeded/);
  assert.match(src, /a wrong guess wastes a whole run/i);
});

test("beta80: classifier prompt no longer suppresses clarify + makes it first-class", () => {
  const src = S("src/adapters/claude-code.ts");
  assert.doesNotMatch(src, /clarify is the exception for a real, action-changing ambiguity, not the default/);
  assert.match(src, /clarify is a normal, expected outcome, not a last resort/i);
  assert.match(src, /BIMODAL -- it has >= 2 valid readings/);
});

test("beta80: crystalliser SDK params thread repoOnlyInvariant + bimodalClarify", () => {
  const sdk = S("src/adapters/claude-code.ts");
  assert.match(sdk, /repoOnlyInvariant\?: boolean/);
  assert.match(sdk, /bimodalClarify\?: boolean/);
  const idx = S("src/index.ts");
  assert.match(idx, /repoOnlyInvariant: config\.brief\.repo_only_invariant/);
  assert.match(idx, /bimodalClarify: config\.brief\.bimodal_clarify/);
});

test("beta80: prompt-refiner routes bimodality before validateBrief", () => {
  const src = S("src/crystallise/prompt-refiner.ts");
  assert.match(src, /bimodal_clarify !== false/);
  assert.match(src, /renderBimodalClarification/);
  const gateIdx = src.indexOf("bimodal_clarify !== false");
  const valIdx = src.indexOf("validateBrief(brief)");
  assert.ok(gateIdx > 0 && valIdx > 0 && gateIdx < valIdx, "bimodality gate must precede validateBrief");
});

// ---- config + manifest + version ----

test("beta80: config defaults declare the three brief keys", () => {
  const src = S("src/config.ts");
  assert.match(src, /repo_only_invariant: true/);
  assert.match(src, /bimodal_clarify: true/);
  assert.match(src, /bimodal_min_interpretations: 2/);
});

test("beta80: manifest declares the three brief keys", () => {
  const json = S("openclaw.plugin.json");
  assert.match(json, /"repo_only_invariant"/);
  assert.match(json, /"bimodal_clarify"/);
  assert.match(json, /"bimodal_min_interpretations"/);
});

test("beta80: version.ts pluginVersion matches package.json", () => {
  const ver = S("src/version.ts");
  const pkg = JSON.parse(S("package.json"));
  assert.match(ver, new RegExp(`pluginVersion: "${pkg.version.replace(/\./g, "\\.")}"`));
});
