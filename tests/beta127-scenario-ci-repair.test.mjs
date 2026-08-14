// beta.127 — a red build buys a cycle, and the cycle runs.
//
// The b126 smoke: 33 sub-tasks, zero verification failures, four cycles
// including one granted for converging findings, 107 minutes, $18.78, and a PR
// failing 2 tests out of 8836. Both one-liners. Neither was visible to any
// cycle, because the only thing that runs the repo's suite is CI and CI ran
// after the last cycle had ended. The loop spent four cycles optimising against
// the adversary's opinion while the gate that actually blocks a merge was
// somewhere it could not see.
//
// These tests drive the real orchestrator with a faked CI edge and assert the
// thing b124 taught us to assert: not that a cycle was GRANTED -- the counter
// and the audit event were both correct on b119 through b123 while the bound
// discarded the grant every time -- but that a worker did work afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runScenario, scenarioAvailable, makeConfig, mutateSubTask, IDENT } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

/** A CI edge that answers from a script, one entry per poll. */
function ciEdge(states, logs) {
  const seen = [];
  return {
    seen,
    ciSnapshot: async ({ sha }) => {
      const state = states[Math.min(seen.length, states.length - 1)];
      seen.push({ sha, state });
      return {
        state,
        checkTotal: 1,
        checksReadable: true,
        statusReadable: true,
        reason: `test says ${state}`,
        checksSource: "check_runs",
      };
    },
    ciFailingLogs: async () => logs,
  };
}

// The real b126 failure, as GitHub returned it once b127 could read the job log.
const REAL_JEST_LOG = `Summary of all failing tests
FAIL src/__tests__/components/sidebar-nav-placement.test.ts
  ● InfoSec GRC ordering › groups the AI system register with the other inventories
    expect(received).toBe(expected) // Object.is equality
    Expected: 2
    Received: 3
      at Object.<anonymous> (src/__tests__/components/sidebar-nav-placement.test.ts:87:61)
Test Suites: 1 failed, 623 passed, 624 total`;

/**
 * The default worker, but writing different content each call so a repair
 * cycle produces a real diff rather than a no-change short-circuit. Also
 * records the dispatch hint each worker was given, which is how we check the
 * CI failure actually reached the thing that has to fix it.
 */
function recordingWorker(hints) {
  let n = 0;
  return async (params, { world }) => {
    n += 1;
    hints.push(params.dispatchHint ?? "");
    const { subTask, worktreePath, plan } = params;
    const wt = worktreePath ?? plan.worktreePath;
    const written = [];
    for (const rel of subTask.filesLikelyTouched ?? []) {
      const abs = join(wt, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `// ${subTask.title}\nexport const x${subTask.seq} = ${n};\n`);
      written.push(rel);
    }
    const commitSha = written.length
      ? await world.adapter.commit(wt, `feat(${subTask.seq}): pass ${n}`, IDENT)
      : undefined;
    return {
      status: "completed",
      filesChanged: written,
      commitSha,
      commitShas: commitSha ? [commitSha] : [],
      costUsd: 0.01, tokensIn: 10, tokensOut: 10,
      reason: "end_turn", finalMessage: "done",
    };
  };
}

test("a RED ci at the ship gate buys a cycle, and a worker runs in it", { skip }, async () => {
  const ci = ciEdge(["failure", "success"], REAL_JEST_LOG);
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 }, ci: { max_repair_cycles: 1, poll_interval_seconds: 5 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    worker: recordingWorker([]),
    deps: ci,
  });

  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1, "the grant must fire on a red build");
  // b124's lesson, in one assertion. The counter being right proved nothing:
  // b119 through b123 all incremented it correctly and ran no extra cycle.
  assert.equal(r.session().cycles_ran, 2, "the granted cycle must actually RUN");
  // And a row in cycle 2 is not enough either -- a revise-scope skip writes
  // `completed_no_change` without ever calling a worker, which would look
  // identical from the sub_tasks table.
  assert.equal(r.calls.worker, 2, "a worker must actually be dispatched in the repair cycle");
  const cycle2 = r.subTaskRows().filter((s) => s.cycle === 2);
  assert.ok(cycle2.length > 0 && cycle2.some((s) => s.status !== "completed_no_change"));
  assert.equal(ci.seen.length, 2, "and CI must be re-checked on the repaired commit");
  assert.equal(r.out.status, "shipped");
});

test("the repair cycle is driven by the CI failure, routed to the file that failed", { skip }, async () => {
  const seenHints = [];
  const ci = ciEdge(["failure", "success"], REAL_JEST_LOG);
  await runScenario({
    // The failing test must already exist, as it did on the b126 smoke: the run
    // did not write sidebar-nav-placement.test.ts, it BROKE it by inserting a
    // nav entry into a group the test asserts is contiguous.
    seedFiles: {
      "README.md": "# seed\n",
      "src/__tests__/components/sidebar-nav-placement.test.ts": "// pre-existing\n",
    },
    config: makeConfig({ loop: { max_cycles: 1 }, ci: { max_repair_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/__tests__/components/sidebar-nav-placement.test.ts" })],
    worker: recordingWorker(seenHints),
    deps: ci,
  });

  const hint = seenHints.join("\n");
  assert.match(hint, /sidebar-nav-placement/, "the worker must be told which test failed");
  assert.match(hint, /Expected: 2/, "and be given the assertion, not a summary of it");
});

test("a GREEN ci ships without buying anything", { skip }, async () => {
  const ci = ciEdge(["success"], "");
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 }, ci: { max_repair_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    worker: recordingWorker([]),
    deps: ci,
  });
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 0);
  assert.equal(r.session().cycles_ran, 1);
  assert.equal(r.out.status, "shipped");
});

test("max_repair_cycles: 0 restores b126 -- red ships as needs_human_review", { skip }, async () => {
  const ci = ciEdge(["failure"], REAL_JEST_LOG);
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 }, ci: { max_repair_cycles: 0 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    worker: recordingWorker([]),
    deps: ci,
  });
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 0);
  assert.equal(r.session().cycles_ran, 1);
  assert.equal(r.session().merge_recommendation, "needs_human_review");
  const declined = r.events("loop.ci_repair_declined");
  assert.equal(declined.length, 1, "and it must say WHY it shipped over a red build");
  assert.equal(declined[0].payload.reason, "disabled");
});

test("the ceiling holds: a build that stays red does not buy cycles forever", { skip }, async () => {
  const ci = ciEdge(["failure"], REAL_JEST_LOG);
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 }, ci: { max_repair_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    worker: recordingWorker([]),
    deps: ci,
  });
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1, "exactly one, then it stops");
  assert.equal(r.session().cycles_ran, 2);
  assert.equal(r.session().merge_recommendation, "needs_human_review");
  assert.equal(r.events("loop.ci_repair_declined").at(-1).payload.reason, "ceiling");
});

test("a CI TIMEOUT does not buy a cycle -- we do not know what to fix", { skip }, async () => {
  // The narrowness is the point. A worker sent after an unknown failure spends
  // a cycle producing plausible noise, which is worse than shipping honestly
  // with "CI never reported".
  const ci = ciEdge(["pending"], "");
  const r = await runScenario({
    config: makeConfig({
      loop: { max_cycles: 1 },
      ci: { max_repair_cycles: 1, wait_timeout_seconds: 8, poll_interval_seconds: 4 },
    }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    worker: recordingWorker([]),
    deps: ci,
  });
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 0);
  assert.equal(r.session().cycles_ran, 1);
  assert.match(String(r.session().merge_recommendation_reason), /still running|not report/i);
});

test("a red build with an UNPARSEABLE log does not buy a cycle either", { skip }, async () => {
  const ci = ciEdge(["failure"], "");
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 }, ci: { max_repair_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    worker: recordingWorker([]),
    deps: ci,
  });
  assert.equal(
    r.events("loop.ci_repair_cycle_granted").length,
    0,
    "no findings means nothing to hand a worker; ship honestly instead of guessing",
  );
  assert.equal(r.session().merge_recommendation, "needs_human_review");
});

test("the repair cycle is granted ON TOP of max_cycles, not out of it", { skip }, async () => {
  // The b124 shape: a grant that the loop bound does not know about is not a
  // grant. Here the run has already used its whole cycle budget when CI comes
  // back red, which is the normal case -- the ship gate is by definition at
  // the end.
  const ci = ciEdge(["failure", "success"], REAL_JEST_LOG);
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 2, max_cycle_extensions: 0 }, ci: { max_repair_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    // Revise once so the run genuinely consumes both configured cycles first.
    runAdversary: (() => {
      let n = 0;
      return async () => {
        n += 1;
        return n === 1
          ? {
              verdict: "revise",
              findings: [{ dimension: "quality", severity: "high", title: "fix it", detail: "d", file: "src/a.ts" }],
              summary: "s", costUsd: 0.01, tokensIn: 1, tokensOut: 1,
            }
          : { verdict: "pass", findings: [], summary: "s", costUsd: 0.01, tokensIn: 1, tokensOut: 1 };
      };
    })(),
    worker: recordingWorker([]),
    deps: ci,
  });
  assert.equal(r.session().cycles_ran, 3, "2 configured + 1 bought by the red build");
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1);
});

test("a green second attempt does not inherit the first attempt's red verdict", { skip }, async () => {
  const ci = ciEdge(["failure", "success"], REAL_JEST_LOG);
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 }, ci: { max_repair_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    worker: recordingWorker([]),
    deps: ci,
  });
  const reason = String(r.session().merge_recommendation_reason ?? "");
  assert.doesNotMatch(reason, /Do NOT merge/, "the repaired ship must not carry the stale red reason");
  assert.notEqual(r.session().merge_recommendation, "needs_human_review");
});
