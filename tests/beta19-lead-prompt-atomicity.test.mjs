/**
 * beta.19: lead system prompt contains the atomicity rule (regression guard).
 *
 * Staging's beta.17 smoke #2 exposed a lead-plan pathology: an acceptance
 * criterion phrased as "append line X and commit locally" was decomposed
 * into 3 sub-tasks (write / commit / verify) instead of one atomic
 * write-and-commit. s2's contract (`commit_made`, `file_committed`,
 * `file_written`) compared against s2's own worker-session-start SHA,
 * but the write already happened in s1, so s2's HEAD was unchanged from
 * its base -> verify correctly failed.
 *
 * beta.19 adds explicit atomicity guidance to the lead system prompt.
 * This test asserts the guidance is present so a future refactor cannot
 * silently drop it. The actual behaviour change is validated by Staging
 * smoke (real model output is not unit-testable here).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sdkSourcePath = resolve(here, "..", "src", "adapters", "claude-sdk.ts");

// Reading source directly rather than importing dist, because the system
// prompt lives inside a function's local array literal and isn't exported.
// Guard-testing the raw source string is deliberately brittle: any refactor
// that moves the guidance must update this test, which is exactly the point.
const source = readFileSync(sdkSourcePath, "utf8");

test("beta.19: lead prompt contains the ATOMICITY RULE for write+commit", () => {
  assert.ok(
    source.includes("ATOMICITY RULE"),
    "lead prompt must contain the atomicity rule header (keyword: ATOMICITY RULE)",
  );
  assert.ok(
    /WRITE action and its accompanying COMMIT belong in ONE mutate sub-task/.test(source),
    "atomicity rule must state that a write and its accompanying commit belong in one sub-task",
  );
});

test("beta.19: lead prompt explains WHY splitting write from commit fails verify", () => {
  // The corollary teaches the model the concrete failure mode -- more
  // durable than just saying "don't do X" without saying why.
  assert.ok(
    /commit sub-task's worker sees the file already present, has nothing new to do/.test(source),
    "prompt must explain that a split write+commit causes the commit sub-task to no-op",
  );
});

test("beta.19: lead prompt names the anti-pattern to AVOID (3 sub-tasks for one criterion)", () => {
  assert.ok(
    /Anti-pattern to AVOID: 3 sub-tasks \(write, commit, verify\) for a single write-and-commit criterion/.test(source),
    "prompt must explicitly name the 3-sub-task anti-pattern",
  );
});

test("beta.33: push/PR are no longer sub-tasks at all (superseded beta.19 push atomicity rule)", () => {
  // beta.19 originally said 'push branch and open a PR' is ONE mutate
  // sub-task. beta.33 changed the architecture: push + PR are done by the
  // harness endgame after review, NOT by any sub-task. Assert the old
  // (now-wrong) wording is gone and the new rule is present.
  assert.ok(
    !/'push branch and open a PR' is ONE mutate sub-task/.test(source),
    "the old 'push+PR is one mutate sub-task' rule must be removed (push/PR are not sub-tasks in beta.33)",
  );
  assert.match(source, /never plan a sub-task for it|DO NOT PLAN PUSH OR PR SUB-TASKS/);
});
