/**
 * beta.21: OKF end-to-end plumbing tests.
 *
 * Context: the OKF plugin is installed on OpenClaw and enriches an agent
 * turn's context with "Relevant Knowledge" blocks. That enrichment stops
 * at the OpenClaw agent boundary -- the harness-internal SDK calls (lead
 * planner, worker) are separate Claude SDK invocations with their own
 * system prompts, so OKF context does NOT propagate without explicit
 * plumbing.
 *
 * Beta.21 threads an optional `relevantConcepts` array through:
 *   `harness_run` tool -> crystallise() -> CrystallisedBrief ->
 *   lead system prompt -> worker system prompt.
 *
 * These tests exercise the plumbing in isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";

let crystallisePrompt, buildWorkerSystemPrompt, pickConceptsForSubTask, formatConceptBlockForCrystalliser;
try {
  ({ crystallisePrompt } = await import("../dist/crystallise/prompt-refiner.js"));
  ({ buildWorkerSystemPrompt, pickConceptsForSubTask } = await import("../dist/orchestrator/sonnet-worker.js"));
  ({ formatConceptBlockForCrystalliser } = await import("../dist/adapters/claude-sdk.js"));
} catch {
  crystallisePrompt = null;
}

const skipAll = { skip: crystallisePrompt === null };

// ============================================================
// crystallisePrompt: concepts propagate from arg -> brief
// ============================================================

test(
  "beta.21: crystallisePrompt forwards concepts to the callCrystalliser dep",
  skipAll,
  async () => {
    let seenConcepts = null;
    const deps = {
      config: {},
      logger: { info() {}, warn() {} },
      callClassifier: async () => ({ intent: "dev_task", reason: "" }),
      callCrystalliser: async (_userText, _cls, concepts) => {
        seenConcepts = concepts;
        return {
          title: "test task title",
          motivation: "some motivation string",
          acceptanceCriteria: ["a"],
          filesLikelyTouched: [],
          outOfScope: [],
          riskLevel: "low",
        };
      },
    };
    const concepts = [{ id: "services/retry", path: "src/retry.ts", summary: "retry logic" }];
    const result = await crystallisePrompt("Add feature X", deps, concepts);
    assert.equal(result.kind, "brief");
    assert.deepEqual(seenConcepts, concepts, "callCrystalliser must receive concepts as 3rd arg");
  },
);

test(
  "beta.21: crystallisePrompt backfills brief.relevantConcepts when SDK drops the field",
  skipAll,
  async () => {
    // Pre-beta.21 SDK models (or a poorly-obedient one) may ignore the new
    // relevantConcepts output field. The orchestration layer authoritatively
    // backfills so the concepts still reach the lead + worker.
    const deps = {
      config: {},
      logger: { info() {}, warn() {} },
      callClassifier: async () => ({ intent: "dev_task", reason: "" }),
      callCrystalliser: async () => ({
        title: "test task title",
        motivation: "some motivation string",
        acceptanceCriteria: ["a"],
        filesLikelyTouched: [],
        outOfScope: [],
        riskLevel: "low",
        // deliberately NO relevantConcepts field
      }),
    };
    const concepts = [{ id: "services/retry" }];
    const result = await crystallisePrompt("Add feature X", deps, concepts);
    assert.equal(result.kind, "brief");
    assert.ok(result.brief.relevantConcepts, "backfilled brief must carry concepts");
    assert.equal(result.brief.relevantConcepts.length, 1);
    assert.equal(result.brief.relevantConcepts[0].id, "services/retry");
  },
);

test(
  "beta.21: crystallisePrompt preserves SDK-supplied relevantConcepts over backfill",
  skipAll,
  async () => {
    // If the SDK DID enrich the concepts (e.g. added summaries/tags), that
    // richer form wins. The backfill is only for the empty-array case.
    const enrichedFromSdk = [{ id: "services/retry", path: "src/retry.ts", summary: "enriched by sdk" }];
    const deps = {
      config: {},
      logger: { info() {}, warn() {} },
      callClassifier: async () => ({ intent: "dev_task", reason: "" }),
      callCrystalliser: async () => ({
        title: "test task title",
        motivation: "some motivation string",
        acceptanceCriteria: ["a"],
        filesLikelyTouched: [],
        outOfScope: [],
        riskLevel: "low",
        relevantConcepts: enrichedFromSdk,
      }),
    };
    const bareInput = [{ id: "services/retry" }];
    const result = await crystallisePrompt("Add feature X", deps, bareInput);
    assert.equal(result.kind, "brief");
    assert.equal(result.brief.relevantConcepts[0].summary, "enriched by sdk");
  },
);

test(
  "beta.21: crystallisePrompt with no concepts leaves the brief unchanged (back-compat)",
  skipAll,
  async () => {
    const deps = {
      config: {},
      logger: { info() {}, warn() {} },
      callClassifier: async () => ({ intent: "dev_task", reason: "" }),
      callCrystalliser: async () => ({
        title: "test task title",
        motivation: "some motivation string",
        acceptanceCriteria: ["a"],
        filesLikelyTouched: [],
        outOfScope: [],
        riskLevel: "low",
      }),
    };
    const result = await crystallisePrompt("Add feature X", deps);
    assert.equal(result.kind, "brief");
    assert.equal(result.brief.relevantConcepts, undefined, "no concepts in, none out");
  },
);

// ============================================================
// crystalliser SDK prompt: OKF block rendering
// ============================================================

test(
  "beta.21: formatConceptBlockForCrystalliser renders each concept's id/summary/path/tags",
  { skip: formatConceptBlockForCrystalliser === undefined },
  () => {
    const rendered = formatConceptBlockForCrystalliser([
      { id: "services/retry", path: "src/retry.ts", summary: "retry logic", tags: ["service"] },
      { id: "infrastructure/n8n" },
    ]);
    assert.match(rendered, /RELEVANT KNOWLEDGE/);
    assert.match(rendered, /id: services\/retry/);
    assert.match(rendered, /path: src\/retry\.ts/);
    assert.match(rendered, /tags: \[service\]/);
    assert.match(rendered, /id: infrastructure\/n8n/);
  },
);

test(
  "beta.21: formatConceptBlockForCrystalliser returns empty string when no concepts",
  { skip: formatConceptBlockForCrystalliser === undefined },
  () => {
    assert.equal(formatConceptBlockForCrystalliser(undefined), "");
    assert.equal(formatConceptBlockForCrystalliser([]), "");
  },
);

// ============================================================
// Worker system prompt: concept filtering + injection
// ============================================================

test(
  "beta.21: worker prompt includes concepts whose path matches the sub-task",
  { skip: buildWorkerSystemPrompt === undefined },
  () => {
    const brief = {
      title: "test task title",
      motivation: "m",
      acceptanceCriteria: ["a"],
      relevantConcepts: [
        { id: "services/retry", path: "src/retry.ts", summary: "retry logic", content: "The retry service uses exponential backoff." },
        { id: "infrastructure/nginx", path: "conf/nginx.conf", summary: "reverse proxy" }, // NOT in files
      ],
    };
    const subTask = {
      seq: 1,
      title: "Fix retry",
      intent: "Fix a bug",
      filesLikelyTouched: ["src/retry.ts", "tests/retry.test.ts"],
      successCriteria: [],
      estimatedTokens: 100,
    };
    const prompt = buildWorkerSystemPrompt(brief, subTask);
    assert.match(prompt, /Relevant knowledge \(OKF concepts\)/);
    assert.match(prompt, /services\/retry/);
    assert.match(prompt, /retry logic/);
    assert.match(prompt, /exponential backoff/);
    // Non-matching concept must be excluded
    assert.doesNotMatch(prompt, /infrastructure\/nginx/, "unrelated concept must be filtered out");
    assert.doesNotMatch(prompt, /reverse proxy/);
  },
);

test(
  "beta.21: worker prompt includes concepts WITHOUT a path (general-brief-scoped)",
  { skip: buildWorkerSystemPrompt === undefined },
  () => {
    // Concepts without a `path` are treated as broadly applicable to the
    // whole brief. Common case: external-knowledge concepts like a design
    // doc or protocol spec that lives outside the repo.
    const brief = {
      title: "test task title",
      motivation: "m",
      acceptanceCriteria: ["a"],
      relevantConcepts: [
        { id: "playbooks/incident-response", summary: "on-call runbook" },
      ],
    };
    const subTask = {
      seq: 1,
      title: "Something",
      intent: "Do it",
      filesLikelyTouched: ["src/foo.ts"],
      successCriteria: [],
      estimatedTokens: 100,
    };
    const prompt = buildWorkerSystemPrompt(brief, subTask);
    assert.match(prompt, /playbooks\/incident-response/);
    assert.match(prompt, /on-call runbook/);
  },
);

test(
  "beta.21: worker prompt with no relevantConcepts is unchanged (back-compat)",
  { skip: buildWorkerSystemPrompt === undefined },
  () => {
    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["a"] };
    const subTask = {
      seq: 1,
      title: "Something",
      intent: "Do it",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    };
    const prompt = buildWorkerSystemPrompt(brief, subTask);
    assert.doesNotMatch(prompt, /Relevant knowledge/);
    assert.doesNotMatch(prompt, /OKF/);
  },
);

test(
  "beta.21: worker prompt truncates oversized concept content",
  { skip: buildWorkerSystemPrompt === undefined },
  () => {
    const bigContent = "X".repeat(20_000); // above the 4000-char per-concept cap
    const brief = {
      title: "test task title",
      motivation: "m",
      acceptanceCriteria: ["a"],
      relevantConcepts: [
        { id: "big/doc", path: "src/foo.ts", content: bigContent },
      ],
    };
    const subTask = {
      seq: 1,
      title: "Something",
      intent: "Do it",
      filesLikelyTouched: ["src/foo.ts"],
      successCriteria: [],
      estimatedTokens: 100,
    };
    const prompt = buildWorkerSystemPrompt(brief, subTask);
    assert.match(prompt, /truncated,/, "oversized content should render a truncation marker");
    // Prompt should not carry the full 20k of Xs.
    assert.ok(prompt.length < 20_000, `prompt should be truncated, got ${prompt.length} chars`);
  },
);

// ============================================================
// pickConceptsForSubTask: filtering logic
// ============================================================

test(
  "beta.21: pickConceptsForSubTask matches directory-prefix paths",
  { skip: pickConceptsForSubTask === undefined },
  () => {
    const concepts = [
      { id: "a", path: "src/lib/retry" }, // dir prefix of the file
      { id: "b", path: "src/lib/retry/client.ts" }, // exact match
      { id: "c", path: "src/http" }, // unrelated
    ];
    const subTask = {
      seq: 1,
      title: "test task title",
      intent: "i",
      filesLikelyTouched: ["src/lib/retry/client.ts"],
      successCriteria: [],
      estimatedTokens: 100,
    };
    const picked = pickConceptsForSubTask(concepts, subTask).map((c) => c.id);
    assert.ok(picked.includes("a"), "dir-prefix concept must be picked");
    assert.ok(picked.includes("b"), "exact-match concept must be picked");
    assert.ok(!picked.includes("c"), "unrelated concept must be excluded");
  },
);

test(
  "beta.21: pickConceptsForSubTask always includes path-less concepts (broadly applicable)",
  { skip: pickConceptsForSubTask === undefined },
  () => {
    const concepts = [{ id: "playbooks/foo" }, { id: "playbooks/bar" }];
    const subTask = {
      seq: 1,
      title: "test task title",
      intent: "i",
      filesLikelyTouched: ["src/other.ts"],
      successCriteria: [],
      estimatedTokens: 100,
    };
    const picked = pickConceptsForSubTask(concepts, subTask).map((c) => c.id);
    assert.deepEqual(picked.sort(), ["playbooks/bar", "playbooks/foo"]);
  },
);
