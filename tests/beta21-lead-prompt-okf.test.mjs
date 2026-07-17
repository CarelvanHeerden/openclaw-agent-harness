/**
 * beta.21: lead system prompt teaches OKF concept awareness.
 *
 * Regression guard on the source string. If a refactor drops the
 * `relevantConcepts` guidance from the lead planner prompt, concept
 * propagation from crystalliser to worker still happens, but the lead
 * planner no longer uses concept paths/tags to bias the plan.
 * Symptom would be "concepts show up in worker prompts but plans still
 * wander into out-of-scope subsystems".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sdkSourcePath = resolve(here, "..", "src", "adapters", "claude-sdk.ts");
const source = readFileSync(sdkSourcePath, "utf8");

test("beta.21: lead prompt teaches the model about relevantConcepts", () => {
  assert.ok(
    source.includes("`relevantConcepts`"),
    "lead prompt must reference the `relevantConcepts` field",
  );
});

test("beta.21: lead prompt says to use concept path for filesLikelyTouched", () => {
  assert.ok(
    /prefer that path in the affected sub-task's `filesLikelyTouched`/.test(source),
    "prompt must say to prefer concept paths for filesLikelyTouched",
  );
});

test("beta.21: lead prompt says concept tags can imply out-of-scope", () => {
  assert.ok(
    /treat it as an implicit out-of-scope hint/.test(source),
    "prompt must teach the tag-based out-of-scope heuristic",
  );
});

test("beta.21: lead prompt forbids inventing concept ids", () => {
  assert.ok(
    /Do NOT invent concepts or reference ids that were not supplied/.test(source),
    "prompt must forbid inventing concepts (avoid hallucinated ids)",
  );
});

test("beta.21: crystalliser prompt teaches relevantConcepts pass-through", () => {
  assert.ok(
    /relevantConcepts: pass-through of any RELEVANT KNOWLEDGE concepts the caller supplied/.test(source),
    "crystalliser prompt must teach concept pass-through",
  );
});
