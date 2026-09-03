// beta.123 — what does the RUN do?
//
// The question this file exists to ask, which 1808 existing test cases asked
// four times between them. Each test drives the real orchestrator over a real
// git repo with the real verification probes, and asserts a terminal status.
//
// The first test is the one whose absence let two rescues ship broken: a plain
// successful run. Everything after it is that run with one thing changed.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { runScenario, makeWorld, scenarioAvailable, git, IDENT, mutateSubTask } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

// ---------------------------------------------------------------------------
// The baseline. If this cannot pass, nothing below means anything.
// ---------------------------------------------------------------------------

test("beta123: a clean run ships, and says so", { skip }, async () => {
  const s = await runScenario();
  assert.equal(s.out.status, "shipped", `expected a shipped run, got ${s.out.status}: ${s.out.reason ?? ""}`);
  assert.match(String(s.out.prUrl ?? ""), /pull\/1/);
  assert.equal(s.calls.push, 1, "exactly one PR");
  const rows = s.subTaskRows();
  assert.ok(rows.length > 0, "the plan's sub-tasks must be recorded");
  assert.ok(rows.every((r) => r.status === "completed"), `every sub-task completes: ${JSON.stringify(rows)}`);
});

test("beta123: a worker that does nothing fails the run, and names the sub-task", { skip }, async () => {
  const s = await runScenario({
    worker: async () => ({
      status: "completed",
      filesChanged: [],
      costUsd: 0.01,
      tokensIn: 1,
      tokensOut: 1,
      reason: "end_turn",
      finalMessage: "I have completed the work.",
    }),
  });
  // Not `failed`: the b55 escalation turns an unprovable claim into a resumable
  // pause rather than killing the run, which is the better of the two. Pinned
  // explicitly so that if it ever silently becomes a ship, this says so.
  assert.equal(s.out.status, "awaiting_clarification", `expected a resumable pause, got ${s.out.status}`);
  assert.equal(s.calls.push, 0, "nothing is pushed");
  const rows = s.subTaskRows();
  assert.ok(rows.some((r) => r.status === "failed_verification"), "the sub-task itself is recorded as failed");
});

// ---------------------------------------------------------------------------
// b122's kill. The rescue paths heal a sub-task -- does the RUN survive?
//
// This is the assertion that did not exist. `proposeBasenameRescue` had seven
// unit tests and the wiring had twelve structural ones; between them they
// proved the rescue decides correctly and is called. Nobody asked what came
// out of the loop, and the answer for seventeen releases was: a failed run.
// ---------------------------------------------------------------------------

test("beta123: a basename rescue heals the sub-task AND the run", { skip }, async () => {
  // The plan names a directory the repo does not have; the worker writes the
  // same basename where the repo actually keeps it. The b103 seq-9 shape.
  const world = await makeWorld({
    files: {
      "README.md": "# seed\n",
      "src/components/ui/button.tsx": "export const Button = () => null;\n",
    },
  });
  const s = await runScenario({
    world,
    subTasks: [mutateSubTask({ title: "add the sidebar", path: "src/components/layout/sidebar.tsx" })],
    worker: async ({ worktreePath, plan }, { world: w }) => {
      const wt = worktreePath ?? plan.worktreePath;
      const rel = "src/components/ui/sidebar.tsx";
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), "export const Sidebar = () => null;\n");
      const sha = await w.adapter.commit(wt, "feat: sidebar", IDENT);
      return {
        status: "completed", filesChanged: [rel], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
      };
    },
  });

  assert.ok(s.sawEvent("loop.contract_path_basename_rescued"), "the rescue must actually fire");
  assert.equal(
    s.out.status,
    "shipped",
    `a rescued contract must not kill the run -- got ${s.out.status}: ${s.out.reason ?? ""}`,
  );
  assert.ok(s.sawEvent("loop.subtask_failure_retracted"), "and the retraction must be on the record");
});

test("beta123: the retraction is recorded against the seq that recorded the failure", { skip }, async () => {
  const world = await makeWorld({
    files: { "README.md": "# seed\n", "src/components/ui/button.tsx": "export const B = () => null;\n" },
  });
  const s = await runScenario({
    world,
    subTasks: [mutateSubTask({ title: "sidebar", path: "src/components/layout/sidebar.tsx" })],
    worker: async ({ worktreePath, plan }, { world: w }) => {
      const wt = worktreePath ?? plan.worktreePath;
      const rel = "src/components/ui/sidebar.tsx";
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), "export const Sidebar = () => null;\n");
      const sha = await w.adapter.commit(wt, "feat: sidebar", IDENT);
      return {
        status: "completed", filesChanged: [rel], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
      };
    },
  });
  const r = s.events("loop.subtask_failure_retracted");
  assert.equal(r.length, 1, "one retraction, for the one healed sub-task");
  assert.equal(r[0].payload.seq, 1);
  assert.match(String(r[0].payload.why), /basename_rescue/);
  assert.match(String(r[0].payload.retracted), /subtask_1_failed_verification/,
    "the record must say WHAT was retracted, or the audit trail cannot be read back");
});

// ---------------------------------------------------------------------------
// b122's root cause: a pure rename is zero changed lines.
// ---------------------------------------------------------------------------

test("beta123: a git mv onto the contract path satisfies file_committed", { skip }, async () => {
  // Cycle-2 seq-10 of session 215c1bf3, reduced: the file exists on the branch
  // from an earlier commit, the adversary asks for it to be renamed, the worker
  // renames it. Before b123 the diff for the OLD path is empty and the verifier
  // reads that as "the commit did not modify this file".
  const world = await makeWorld({
    files: { "README.md": "# seed\n", "src/__tests__/api/continuity-exercises.test.ts": "test('x', () => {});\n" },
  });
  const s = await runScenario({
    world,
    subTasks: [mutateSubTask({
      title: "rename the test to match its contents",
      path: "src/__tests__/api/continuity-exercises.test.ts",
    })],
    worker: async ({ worktreePath, plan }, { world: w }) => {
      const wt = worktreePath ?? plan.worktreePath;
      const from = "src/__tests__/api/continuity-exercises.test.ts";
      const to = "src/__tests__/api/continuity-exercises-download.test.ts";
      git(["mv", from, to], wt);
      const sha = await w.adapter.commit(wt, "test: rename to match contents", IDENT);
      return {
        status: "completed", filesChanged: [to], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "renamed",
      };
    },
  });

  assert.equal(
    s.out.status,
    "shipped",
    `a rename the review ASKED for must not fail verification -- got ${s.out.status}: ${s.out.reason ?? ""}`,
  );
  // Shipping is not enough to prove the PROBE understood the rename: if
  // file_committed still failed, the rescue paths downstream would very likely
  // heal the mismatch and the run would ship anyway, leaving this test green
  // over a broken probe. So require that no recovery was needed at all.
  assert.equal(s.sawEvent("loop.contract_path_mismatch_escalated"), false, "no mismatch should ever be raised");
  assert.equal(s.sawEvent("loop.contract_path_basename_rescued"), false, "the probe must pass on its own");
  assert.equal(s.sawEvent("loop.contract_auto_resolved"), false, "the probe must pass on its own");
  assert.equal(s.sawEvent("loop.subtask_failure_retracted"), false, "there is no failure here to retract");
});

test("beta123: a file that merely EXISTS and was never touched still fails", { skip }, async () => {
  // The other side of the rename fix. Zero changed lines with no rename behind
  // it is still "you did not do the work", or the b84 gate has been given away.
  const world = await makeWorld({
    files: { "README.md": "# seed\n", "src/untouched.ts": "export const a = 1;\n" },
  });
  const s = await runScenario({
    world,
    subTasks: [mutateSubTask({ title: "touch nothing", path: "src/untouched.ts" })],
    worker: async ({ worktreePath, plan }, { world: w }) => {
      const wt = worktreePath ?? plan.worktreePath;
      writeFileSync(join(wt, "src/unrelated.ts"), "export const b = 2;\n");
      const sha = await w.adapter.commit(wt, "chore: something else", IDENT);
      return {
        status: "completed", filesChanged: ["src/unrelated.ts"], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
      };
    },
  });
  assert.notEqual(s.out.status, "shipped", "an untouched contract file must never pass");
});

// ---------------------------------------------------------------------------
// The terminal dispositions, each reached on purpose.
// ---------------------------------------------------------------------------

test("beta123: an abort reaction stops the run and does not push", { skip }, async () => {
  const s = await runScenario({
    readReactions: async () => ({ shipIt: false, abort: true, pause: false, budgetBump: false }),
  });
  assert.equal(s.out.status, "aborted", `expected aborted, got ${s.out.status}`);
  assert.equal(s.calls.push, 0);
});

test("beta123: a revise verdict runs a second cycle and then ships", { skip }, async () => {
  let cycle = 0;
  let turn = 0;
  const s = await runScenario({
    // The revise worker must genuinely change something. A cycle whose worker
    // no-ops takes the `cycle_no_change_early_exit` path; beta.135 refuses to
    // ship there while this blocking HIGH finding is still carried forward.
    // That failure path is covered by beta135-smoke-safety; this test is about
    // a genuine fix receiving a fresh passing review.
    worker: async ({ subTask, worktreePath, plan }, { world }) => {
      turn++;
      const wt = worktreePath ?? plan.worktreePath;
      const rel = subTask.filesLikelyTouched?.[0] ?? "src/thing.ts";
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), `export const v = ${turn};\n`);
      const sha = await world.adapter.commit(wt, `feat(${subTask.seq}): turn ${turn}`, IDENT);
      return {
        status: "completed", filesChanged: [rel], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
      };
    },
    runAdversary: async () => {
      cycle++;
      return cycle === 1
        ? {
            verdict: "revise",
            findings: [{ severity: "high", dimension: "spec", title: "needs work", detail: "d", file: "src/thing.ts" }],
            summary: "one blocking finding",
            costUsd: 0.01, tokensIn: 1, tokensOut: 1,
          }
        : { verdict: "pass", findings: [], summary: "good", costUsd: 0.01, tokensIn: 1, tokensOut: 1 };
    },
  });
  assert.equal(s.out.status, "shipped", `expected a ship after the revise, got ${s.out.status}: ${s.out.reason ?? ""}`);
  assert.ok(s.out.cycles >= 2, `the revise must actually cost a cycle, got ${s.out.cycles}`);
  assert.equal(cycle, 2, "the adversary must re-review after the revise");
});

test("beta123: a block verdict does not open a PR", { skip }, async () => {
  const s = await runScenario({
    runAdversary: async () => ({
      verdict: "block",
      findings: [{ severity: "high", dimension: "security", title: "no", detail: "d", file: "src/thing.ts" }],
      summary: "unsafe",
      costUsd: 0.01, tokensIn: 1, tokensOut: 1,
    }),
  });
  assert.notEqual(s.out.status, "shipped");
  assert.equal(s.calls.push, 0, "a block verdict must never reach the PR step");
});
