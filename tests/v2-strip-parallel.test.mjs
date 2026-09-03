// v2.0.0 — parallel sub-task dispatch removed.
//
// Parallelism shipped disabled for its entire life. b117 finally made it SAFE
// (a worktree pool, per-slot branches, serialised merge-back) and then measured
// what it bought: 41m38s at concurrency 2 against b116's 41m00s. It cost one
// `npm ci` per slot per cycle, a merge-back that could conflict, and a class of
// interleaving bug the harness had to keep reasoning about in every recovery
// path -- for no wall-clock saving.
//
// So the mechanism is gone rather than off. The session worktree IS the
// isolation boundary: one session, one checkout, one branch, workers committing
// to it one at a time, nothing to merge back.
//
// This file is the guard on the removal. It asserts three things:
//   1. the mechanism is really absent (not just unreachable),
//   2. an operator's existing config still boots -- accepted, ignored, warned,
//   3. the concurrency that MUST survive is untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { runScenario, scenarioAvailable, mutateSubTask, IDENT } from "./helpers/scenario.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const S = (p) => readFileSync(resolve(root, p), "utf8");
const loopSrc = S("src/orchestrator/loop.ts");
const skip = (await scenarioAvailable()) ? false : "dist/ not built";

const { parseHarnessConfig, declaresRemovedParallelKeys, REMOVED_LOOP_KEYS } = await import("../dist/config.js");

const MINIMAL = {
  slack: { authorised_users: ["U1"] },
  repos: { allowed: ["o/*"] },
};

// ---------------------------------------------------------------------------
// 1. The mechanism is gone
// ---------------------------------------------------------------------------

test("the three parallel-only modules no longer exist", () => {
  for (const f of [
    "src/orchestrator/parallel-safety.ts",
    "src/orchestrator/worktree-pool.ts",
    "src/orchestrator/merge-back.ts",
  ]) {
    assert.equal(existsSync(resolve(root, f)), false, `${f} must be deleted, not merely unused`);
  }
});

test("nothing imports the deleted modules", () => {
  for (const m of ["parallel-safety", "worktree-pool", "merge-back"]) {
    assert.ok(!new RegExp(`from "\\./${m}\\.js"`).test(loopSrc), `loop.ts must not import ${m}`);
  }
});

test("the dispatcher is a serial walk, not a concurrency pool", () => {
  // The specific shapes that made it concurrent. Their absence is the point:
  // an in-flight array with a race on it is the dispatcher; a for-of is not.
  for (const gone of [
    /const inFlight\s*:/,
    /inFlightSubTasks/,
    /Promise\.race\(inFlight\)/,
    /Promise\.allSettled\(inFlight\)/,
    /resolveEffectiveConcurrency/,
    /canDispatchConcurrently/,
    /new WorktreePool/,
    /mergeBackSlot/,
    /mergeBackMutex/,
  ]) {
    assert.ok(!gone.test(loopSrc), `loop.ts still carries ${gone}`);
  }
  // And what replaced it: one sub-task at a time, in the session worktree.
  assert.match(loopSrc, /for \(const st of ordered\)/, "sub-tasks are walked in topo order");
  assert.match(loopSrc, /runOneInner\(st, plan\.worktreePath\)/, "each runs in the session worktree");
});

test("the pooled-slot lifecycle is gone from the git adapter", () => {
  const gw = S("src/adapters/git-worktree.ts");
  for (const gone of ["allocatePooled", "resetPooled", "releasePooled", "async runIn("]) {
    assert.ok(!gw.includes(gone), `git-worktree.ts still carries ${gone}`);
  }
});

test("the parallel audit events are gone", () => {
  const index = S("src/index.ts");
  for (const ev of [
    "loop.parallel_enabled",
    "loop.parallel_slot_degraded",
    "loop.parallel_merge_back",
    "loop.parallel_merge_back_conflict",
    "loop.parallel_pool_drained",
    "harness.parallel_slot_created",
  ]) {
    assert.ok(!loopSrc.includes(ev) && !index.includes(ev), `${ev} must not survive the removal`);
  }
});

test("the orchestrator no longer asks its host for pooled worktrees", () => {
  for (const dep of ["allocatePooledWorktree", "resetPooledWorktree", "releasePooledWorktree", "gitRun"]) {
    assert.ok(!loopSrc.includes(dep), `OrchestratorDeps still declares ${dep}`);
    assert.ok(!S("src/index.ts").includes(dep), `index.ts still wires ${dep}`);
  }
});

// ---------------------------------------------------------------------------
// 2. The migration: accepted, ignored, warned
// ---------------------------------------------------------------------------

test("an existing config naming the removed keys still parses", () => {
  // This is the whole point of the migration. The gateway validates against
  // openclaw.plugin.json with additionalProperties:false, so a config carrying
  // these keys must still be VALID -- refusing it would take the plugin offline
  // over a setting that no longer does anything, which is the beta.34 / rc.1
  // outage shape.
  const c = parseHarnessConfig({
    ...MINIMAL,
    loop: { subtask_concurrency: 4, parallel_independent_subtasks: true },
  });
  assert.ok(c.loop, "config still parses");
});

test("the removed keys do not survive parse", () => {
  const c = parseHarnessConfig({
    ...MINIMAL,
    loop: { subtask_concurrency: 4, parallel_independent_subtasks: true },
  });
  for (const k of REMOVED_LOOP_KEYS) {
    assert.equal(c.loop[k], undefined, `${k} must be dropped, so nothing can read a setting nothing obeys`);
  }
});

test("the removed keys are still declared in the gateway manifest", () => {
  // Deleting them here is what would reject the operator's entire config, so
  // this assertion is the load-bearing half of the migration.
  const man = JSON.parse(S("openclaw.plugin.json"));
  const loopProps = man.configSchema.properties.loop.properties;
  assert.equal(man.configSchema.properties.loop.additionalProperties, false, "the manifest is strict; that is why the keys must stay");
  for (const k of REMOVED_LOOP_KEYS) {
    assert.ok(loopProps[k], `${k} must stay declared or an existing config is rejected outright`);
    assert.equal(loopProps[k].deprecated, true, `${k} must be marked deprecated`);
    assert.match(loopProps[k].description, /REMOVED in v2\.0\.0/, `${k} must say it is dead`);
    assert.equal(loopProps[k].default, undefined, `${k} must not advertise a default it will not apply`);
  }
});

test("the raw config is what answers, since the parsed one cannot", () => {
  assert.deepEqual(declaresRemovedParallelKeys({ loop: { subtask_concurrency: 2 } }), ["subtask_concurrency"]);
  assert.deepEqual(
    declaresRemovedParallelKeys({ loop: { subtask_concurrency: 2, parallel_independent_subtasks: false } }),
    ["subtask_concurrency", "parallel_independent_subtasks"],
  );
  // Present-but-false still counts: the operator wrote it and should be told.
  assert.deepEqual(declaresRemovedParallelKeys({ loop: { parallel_independent_subtasks: false } }), ["parallel_independent_subtasks"]);
  assert.deepEqual(declaresRemovedParallelKeys({ loop: {} }), []);
  assert.deepEqual(declaresRemovedParallelKeys({}), []);
  assert.deepEqual(declaresRemovedParallelKeys(null), []);
});

test("bootstrap warns when the removed keys are present", () => {
  const index = S("src/index.ts");
  assert.match(index, /declaresRemovedParallelKeys\(rawConfig\)/, "the warning reads the RAW config");
  const at = index.indexOf("declaresRemovedParallelKeys(rawConfig)");
  const after = index.slice(at, at + 900);
  assert.match(after, /logger\.warn/, "and it warns");
  assert.match(after, /removed in v2\.0\.0/i);
  assert.ok(!/throw/.test(after), "it must WARN, never refuse to start");
});

// ---------------------------------------------------------------------------
// 3. What must survive
// ---------------------------------------------------------------------------

test("session worktree isolation is untouched", () => {
  const gw = S("src/adapters/git-worktree.ts");
  assert.match(gw, /inFlightWorktrees/, "allocation still protects itself from the orphan reaper");
  assert.match(gw, /async allocate\(/, "the session worktree path survives");
  assert.match(loopSrc, /worktreePath/, "the loop still runs sub-tasks in a checkout");
});

test("the concurrency that is structurally necessary survives", () => {
  // These are not sub-task dispatch and removing them would break the harness:
  // a deadline needs a race, a stream watchdog needs a race, and a session
  // re-entrancy guard is what stops two loops sharing one worktree.
  assert.match(loopSrc, /Promise\.race\(\[/, "withTimeout / idle-abort still race");
  assert.match(loopSrc, /runningSessions/, "the b38 per-session re-entrancy guard survives");
  assert.match(loopSrc, /withTimeout\(/, "sub-tasks are still deadline-bounded");
});

test("topological ordering survives, because dependsOn still means something", () => {
  assert.match(loopSrc, /topoSortSubTasks\(plan\.subTasks\)/);
  assert.match(loopSrc, /dependsOn/);
  // A serial walk still has to refuse a plan whose dependencies cannot be met.
  assert.match(loopSrc, /has unresolved dependencies/);
});

test("a failed sub-task stops the cycle, so the rest are never dispatched", { skip }, async () => {
  // BEHAVIOURAL, on purpose. Everything else in this file reads source, which
  // proves the shape but not the effect -- and the effect is what costs money.
  //
  // A greedy dispatcher had to drain in-flight work before it could trust
  // `failed.err`, because a sibling could retract it mid-flight. Serial
  // execution makes the read unambiguous, but only if the walk actually stops:
  // without the break, every remaining sub-task in a doomed cycle still spawns
  // a worker, spends budget, and commits to a branch the run will never push.
  const ran = [];
  const s = await runScenario({
    subTasks: [
      // Claims success, commits nothing -> fails verification.
      mutateSubTask({ seq: 1, title: "does nothing", path: "src/never.ts" }),
      mutateSubTask({ seq: 2, title: "second", path: "src/second.ts" }),
      mutateSubTask({ seq: 3, title: "third", path: "src/third.ts" }),
    ],
    worker: async ({ subTask, worktreePath, plan }, { world }) => {
      ran.push(subTask.seq);
      if (subTask.seq === 1) {
        return {
          status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1,
          reason: "end_turn", finalMessage: "All done.",
        };
      }
      const wt = worktreePath ?? plan.worktreePath;
      const rel = subTask.seq === 2 ? "src/second.ts" : "src/third.ts";
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), "export const x = 1;\n");
      const sha = await world.adapter.commit(wt, `feat(${subTask.seq})`, IDENT);
      return {
        status: "completed", filesChanged: [rel], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
      };
    },
  });

  // Asserted as a SET, not a sequence: seq 1 is legitimately re-run by the
  // sub-task retry path, and that retry is not what this test is about.
  assert.deepEqual([...new Set(ran)], [1], `no sub-task after the failure may run; got ${JSON.stringify(ran)}`);
  assert.notEqual(s.out.status, "shipped", "an unfixed failure must not ship");
  assert.equal(s.calls.push, 0, "and must open no PR");
});

test("sub-tasks execute in topological order, one at a time", { skip }, async () => {
  // dependsOn still means something without a dispatcher to enforce it: the
  // walk consumes topoSortSubTasks' order, so a dependent may never observe a
  // tree its dependency has not written yet.
  const ran = [];
  const s = await runScenario({
    subTasks: [
      { ...mutateSubTask({ seq: 1, title: "first", path: "src/first.ts" }), dependsOn: [2] },
      mutateSubTask({ seq: 2, title: "second", path: "src/second.ts" }),
    ],
    worker: async ({ subTask, worktreePath, plan }, { world }) => {
      ran.push(subTask.seq);
      const wt = worktreePath ?? plan.worktreePath;
      const rel = subTask.seq === 1 ? "src/first.ts" : "src/second.ts";
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), "export const x = 1;\n");
      const sha = await world.adapter.commit(wt, `feat(${subTask.seq})`, IDENT);
      return {
        status: "completed", filesChanged: [rel], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done",
      };
    },
  });

  assert.deepEqual(ran, [2, 1], "seq 1 depends on seq 2, so seq 2 runs first");
  assert.ok(s.out, "the run completed");
});

test("the sub-task deadline still bounds the whole sub-task, not just the model call", () => {
  // b59/b60: the hang that stalled a run for 5h30m was in git/IO around the
  // worker, not in the worker. The bound has to wrap runOneInner.
  const at = loopSrc.indexOf("for (const st of ordered)");
  assert.ok(at > 0);
  const body = loopSrc.slice(at, at + 2500);
  assert.match(body, /withTimeout\(\s*runOneInner\(st, plan\.worktreePath\)/, "the deadline wraps the whole sub-task");
  assert.match(body, /subtask_deadline_seconds/);
});
