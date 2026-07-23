// beta.68 — adaptive decomposition.
//
// PROBLEM: the lead planner prompt had a flat "Prefer 3-8 sub-tasks" rule, so
// even a trivial single-file change was decomposed into ~3 sub-tasks
// (observe-probe -> mutate-implement -> observe-verify). Each sub-task is a
// separate COLD worker SDK call, so a one-line edit paid 3 cold round-trips +
// their pre-stream latency (smoke #4: a 30-line single-file change = 3
// sub-tasks). That is a big part of why the harness is ~10x slower than a
// human-in-Cursor on small changes.
//
// FIX: replace the flat rule with complexity-tiered guidance in the lead
// prompt (src/adapters/claude-sdk.ts): TRIVIAL single-file -> exactly ONE
// mutate sub-task (no ceremony probe/verify); MODERATE -> 2-4; LARGE -> 3-8,
// hard cap 20. Bias toward fewer.
//
// These are source-assertions against the lead system prompt text (the prompt
// is assembled inline in runLeadSdk, same approach as beta66's lead-prompt
// tests).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const sdk = S("src/adapters/claude-sdk.ts");

test("beta.68: the flat 'Prefer 3-8 sub-tasks' rule is GONE from the lead prompt", () => {
  assert.equal(
    sdk.includes('"- Prefer 3-8 sub-tasks. Hard cap 20."'),
    false,
    "the flat prefer-3-8 rule should have been replaced by adaptive tiering",
  );
});

test("beta.68: lead prompt carries an ADAPTIVE DECOMPOSITION rule", () => {
  assert.ok(
    sdk.includes("ADAPTIVE DECOMPOSITION"),
    "lead prompt must instruct adaptive decomposition",
  );
});

test("beta.68: TRIVIAL single-file change maps to EXACTLY ONE mutate sub-task", () => {
  assert.ok(
    /TRIVIAL[\s\S]*?EXACTLY ONE `mutate` sub-task/.test(sdk),
    "trivial changes must collapse to exactly one mutate sub-task",
  );
  // and explicitly discourage the ceremony probe + verify sub-tasks
  assert.ok(
    /Do NOT add a separate observe\/probe sub-task/i.test(sdk),
    "must tell Fable not to add a redundant probe sub-task on trivial changes",
  );
  assert.ok(
    /do NOT add a separate observe\/verify sub-task/i.test(sdk),
    "must tell Fable not to add a redundant verify sub-task on trivial changes",
  );
});

test("beta.68: MODERATE and LARGE tiers preserve fan-out + the hard cap 20", () => {
  assert.ok(/MODERATE[\s\S]*?2-4 sub-tasks/.test(sdk), "moderate tier = 2-4 sub-tasks");
  assert.ok(/LARGE[\s\S]*?3-8 sub-tasks/.test(sdk), "large tier keeps 3-8 sub-tasks");
  assert.ok(/Hard cap 20/.test(sdk), "the hard cap of 20 must be preserved");
});

test("beta.68: prompt biases toward FEWER sub-tasks (tie-break to 1 on small changes)", () => {
  assert.ok(
    /Bias toward FEWER sub-tasks/.test(sdk),
    "must bias toward fewer sub-tasks",
  );
  assert.ok(
    /When in doubt between 1 and 3 for a small change, choose 1/.test(sdk),
    "must give an explicit tie-break to a single sub-task for small changes",
  );
});

test("beta.68: 'independently reviewable' invariant retained", () => {
  assert.ok(
    sdk.includes('"- Each sub-task must be independently reviewable."'),
    "the independently-reviewable rule must remain",
  );
});
