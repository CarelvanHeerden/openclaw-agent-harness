// beta.66 (warm-worker-context) — thread Fable's investigation into dev workers.
// THE harness founding goal (ClaudeDevs orchestrator-split): a smart lead hands
// a cheap worker everything it needs so the worker implements mechanically
// instead of re-scanning the repo (the token-burn + "shit code" root cause that
// forced workers onto opus).
//
// Asserts:
//   - renderWorkerContextBlock: renders rationale/changeSpec/relatedSymbols/
//     gotchas/codeExcerpts; returns "" when absent (cold); respects char budget.
//   - buildWorkerSystemPrompt: injects the context block (before ## Rules) when
//     workerContext present; unchanged cold prompt when absent (regression).
//   - LeadPlanSubTask: workerContext is optional/additive (parse both shapes).
//   - Lead prompt (claude-sdk.ts) instructs Fable to emit workerContext.
//   - HARD BOUNDARY: adversary (fable5-adversary.ts) never references
//     workerContext — warm context is dev-worker-only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let renderWorkerContextBlock, buildWorkerSystemPrompt;
try {
  ({ renderWorkerContextBlock, buildWorkerSystemPrompt } = await import("../dist/orchestrator/sonnet-worker.js"));
} catch {
  renderWorkerContextBlock = null;
}

const baseBrief = {
  title: "Populate taxonomy dropdown from the real source",
  motivation: "The risks dropdown shows generic labels.",
  acceptanceCriteria: ["Dropdown options match the taxonomy levels page"],
};

function subTask(extra = {}) {
  return {
    seq: 2,
    title: "Wire useTaxonomy into the dropdown",
    intent: "Replace the hardcoded label map",
    filesLikelyTouched: ["src/hooks/useTaxonomy.ts"],
    successCriteria: ["dropdown renders real options"],
    estimatedTokens: 5000,
    taskMode: "mutate",
    contractScope: "local",
    verify: [{ kind: "commit_made" }],
    ...extra,
  };
}

// ---- renderWorkerContextBlock ----
test("beta66: renders all workerContext fields", { skip: renderWorkerContextBlock === null }, () => {
  const block = renderWorkerContextBlock({
    rationale: "The label map is hardcoded and drifts from the taxonomy source.",
    changeSpec: "In useTaxonomy() at src/hooks/useTaxonomy.ts:41 call getTaxonomyOptions().",
    relatedSymbols: ["getTaxonomyOptions is exported from src/lib/taxonomy-options.ts:12"],
    gotchas: ["React 19.2.7 has no React.act; use renderToStaticMarkup for tests"],
    codeExcerpts: [
      { path: "src/hooks/useTaxonomy.ts", startLine: 41, snippet: "const LABELS = { L1: 'Level 1' };", note: "the hardcoded map" },
    ],
  });
  assert.match(block, /## Implementation context/);
  assert.match(block, /do NOT re-explore the repo/i);
  assert.match(block, /label map is hardcoded/);
  assert.match(block, /getTaxonomyOptions\(\)/);
  assert.match(block, /src\/lib\/taxonomy-options\.ts:12/);
  assert.match(block, /renderToStaticMarkup/);
  assert.match(block, /src\/hooks\/useTaxonomy\.ts:41/);
  assert.match(block, /the hardcoded map/);
  assert.match(block, /const LABELS/);
});

test("beta66: returns empty string when no context (cold)", { skip: renderWorkerContextBlock === null }, () => {
  assert.equal(renderWorkerContextBlock(undefined), "");
  assert.equal(renderWorkerContextBlock(), "");
});

test("beta66: rationale-only context still renders", { skip: renderWorkerContextBlock === null }, () => {
  const block = renderWorkerContextBlock({ rationale: "why only" });
  assert.match(block, /## Implementation context/);
  assert.match(block, /why only/);
  assert.doesNotMatch(block, /### Precise change/);
  assert.doesNotMatch(block, /### Code the lead already read/);
});

test("beta66: code-excerpt char budget is enforced", { skip: renderWorkerContextBlock === null }, () => {
  const huge = "x".repeat(20000);
  const block = renderWorkerContextBlock({
    rationale: "big",
    codeExcerpts: [{ path: "a.ts", snippet: huge }],
  });
  // single excerpt capped at WORKER_CONTEXT_EXCERPT_MAX_CHARS (4000)
  assert.match(block, /truncated, \d+ chars omitted/);
  // the rendered block must be far smaller than the raw 20k snippet
  assert.ok(block.length < 8000, `block too large: ${block.length}`);
});

test("beta66: multiple large excerpts trip the TOTAL budget", { skip: renderWorkerContextBlock === null }, () => {
  const chunk = "y".repeat(4000);
  const block = renderWorkerContextBlock({
    rationale: "big",
    codeExcerpts: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, snippet: chunk })),
  });
  assert.match(block, /char budget reached/);
});

// ---- buildWorkerSystemPrompt injection ----
test("beta66: warm sub-task prompt contains the context block before rules", { skip: buildWorkerSystemPrompt === null }, () => {
  const prompt = buildWorkerSystemPrompt(
    baseBrief,
    subTask({ workerContext: { rationale: "warm rationale here", changeSpec: "do the exact edit" } }),
  );
  assert.match(prompt, /## Implementation context/);
  assert.match(prompt, /warm rationale here/);
  assert.match(prompt, /do the exact edit/);
  // ordering: context block appears BEFORE the generic Rules section
  assert.ok(prompt.indexOf("## Implementation context") < prompt.indexOf("## Rules"),
    "implementation context must come before ## Rules");
  // ordering: context block appears AFTER the sub-task section
  assert.ok(prompt.indexOf("## Your sub-task") < prompt.indexOf("## Implementation context"),
    "implementation context must come after ## Your sub-task");
  // the trust-it rule is present
  assert.match(prompt, /do NOT re-explore the repo to re-derive/i);
});

test("beta66: cold sub-task prompt is unchanged (no context block)", { skip: buildWorkerSystemPrompt === null }, () => {
  const prompt = buildWorkerSystemPrompt(baseBrief, subTask());
  assert.doesNotMatch(prompt, /## Implementation context/);
  // still has the normal sub-task + rules sections
  assert.match(prompt, /## Your sub-task/);
  assert.match(prompt, /## Rules/);
});

// ---- source assertions: schema + lead prompt ----
test("beta66: LeadPlanSubTask carries optional workerContext + WorkerContext type", () => {
  const src = S("src/orchestrator/fable5-lead.ts");
  assert.match(src, /export interface WorkerContext/);
  assert.match(src, /workerContext\?: WorkerContext/);
  assert.match(src, /codeExcerpts\?:/);
  assert.match(src, /changeSpec\?:/);
});

test("beta66: lead prompt instructs Fable to emit workerContext (dev-worker only)", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /WARM WORKER CONTEXT/);
  assert.match(src, /workerContext\?: WorkerContext/);
  assert.match(src, /DEV WORKERS ONLY/);
});

// ---- HARD BOUNDARY: adversary stays cold ----
test("beta66: adversary NEVER references workerContext (cold + independent)", () => {
  const src = S("src/orchestrator/fable5-adversary.ts");
  assert.doesNotMatch(src, /workerContext/);
  assert.doesNotMatch(src, /WorkerContext/);
});
