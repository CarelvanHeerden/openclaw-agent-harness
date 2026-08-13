// beta.123 — the recovery paths, judged by what the RUN does.
//
// b111's auto-resolve and b105's basename rescue both exist for the same
// reason: to settle a contract-path mismatch from evidence instead of stopping
// to ask a human. Both worked. Both then left the cycle's failure flag set, so
// the run they had just rescued died at the end of the cycle with
// `subtask_N_failed_verification` -- the b122 smoke kill, and a thing they had
// been doing since the day each shipped.
//
// Every test here asserts a terminal status. That is the whole difference
// between this file and the 33 green tests that watched b105 ship broken.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { runScenario, makeWorld, makeConfig, scenarioAvailable, mutateSubTask, IDENT } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

/** A worker that commits `writes` and reports them, ignoring the plan's paths. */
const commitWorker = (writes) => async ({ subTask, worktreePath, plan }, { world }) => {
  const wt = worktreePath ?? plan.worktreePath;
  const files = typeof writes === "function" ? writes(subTask) : writes;
  const changed = [];
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    writeFileSync(join(wt, rel), content);
    changed.push(rel);
  }
  const sha = await world.adapter.commit(wt, `feat(${subTask.seq}): ${subTask.title}`, IDENT);
  return {
    status: "completed", filesChanged: changed, commitSha: sha, commitShas: [sha],
    costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
  };
};

// ---------------------------------------------------------------------------
// b111 auto-resolve: the answer was already on the branch.
// ---------------------------------------------------------------------------

test("beta123: an auto-resolved contract lets the run finish", { skip }, async () => {
  // seq 1 writes alpha. seq 2's contract also names alpha -- but seq 2 commits
  // beta. The basename rescue cannot help (different basenames), so this lands
  // in the auto-resolve: alpha is already on the branch, so the branch as a
  // whole satisfies the contract.
  const s = await runScenario({
    subTasks: [
      mutateSubTask({ seq: 1, title: "write alpha", path: "src/alpha.ts" }),
      mutateSubTask({ seq: 2, title: "extend alpha", path: "src/alpha.ts" }),
    ],
    worker: async (params, ctx) => {
      const seq = params.subTask.seq;
      return commitWorker(
        seq === 1 ? { "src/alpha.ts": "export const a = 1;\n" } : { "src/beta.ts": "export const b = 2;\n" },
      )(params, ctx);
    },
  });

  assert.ok(s.sawEvent("loop.contract_auto_resolved"), "the auto-resolve must fire for this shape");
  assert.equal(
    s.out.status,
    "shipped",
    `the branch satisfies the contract, so the run must finish -- got ${s.out.status}: ${s.out.reason ?? ""}`,
  );
  const retracted = s.events("loop.subtask_failure_retracted");
  assert.equal(retracted.length, 1);
  assert.equal(retracted[0].payload.why, "contract_auto_resolved");
});

test("beta123: an UNCOVERED expected path still stops and asks", { skip }, async () => {
  // The same shape with the evidence removed: nothing on the branch ever
  // touched the expected path, so there is nothing to resolve from and the
  // harness must go back to pausing for a human rather than waving it through.
  const s = await runScenario({
    subTasks: [mutateSubTask({ seq: 1, title: "write alpha", path: "src/alpha.ts" })],
    worker: commitWorker({ "src/beta.ts": "export const b = 2;\n" }),
  });
  assert.notEqual(s.out.status, "shipped", "an unproven contract must never ship");
  assert.equal(s.calls.push, 0);
});

// ---------------------------------------------------------------------------
// The retraction is scoped to the sub-task that recorded the failure.
//
// `failed` is one slot shared by every sub-task in the cycle. Under b117
// parallelism a rescue on one seq must not erase a genuine failure on another,
// which a blanket `failed.err = null` would do -- turning a hard stop into a
// silent partial delivery. Interleaving here is forced with a gate rather than
// left to timing, so this is deterministic.
// ---------------------------------------------------------------------------

test("beta123: a rescue on one sub-task cannot bury another's real failure", { skip }, async () => {
  const world = await makeWorld({
    files: { "README.md": "# seed\n", "src/components/ui/button.tsx": "export const B = () => null;\n" },
  });

  let openGate;
  const gate = new Promise((r) => { openGate = r; });

  const s = await runScenario({
    world,
    configOver: { loop: { parallel_independent_subtasks: true, subtask_concurrency: 2 } },
    subTasks: [
      // Rescuable: plans a directory the repo does not have, commits the same
      // basename where it does. Waits so that its verification runs AFTER seq 2
      // has already recorded a genuine failure.
      mutateSubTask({ seq: 1, title: "sidebar", path: "src/components/layout/sidebar.tsx" }),
      // Genuinely broken: claims success, commits nothing.
      mutateSubTask({ seq: 2, title: "does nothing", path: "src/never.ts" }),
    ],
    worker: async ({ subTask, worktreePath, plan }, { world: w }) => {
      const wt = worktreePath ?? plan.worktreePath;
      if (subTask.seq === 2) {
        openGate();
        return {
          status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1,
          reason: "end_turn", finalMessage: "All done.",
        };
      }
      const rel = "src/components/ui/sidebar.tsx";
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), "export const Sidebar = () => null;\n");
      const sha = await w.adapter.commit(wt, "feat: sidebar", IDENT);
      await gate;
      return {
        status: "completed", filesChanged: [rel], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
      };
    },
  });

  assert.notEqual(s.out.status, "shipped", "seq 2 did nothing; a rescue elsewhere must not let this ship");
  assert.equal(s.calls.push, 0, "no PR may be opened over an unfixed failure");
});
