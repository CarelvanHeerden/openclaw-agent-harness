// beta.124 — the cycle the harness granted itself and never took.
//
// b119 shipped an extension: when the adversary's BLOCKING findings are
// trending down and the budget has room, buy one more cycle instead of
// shipping on the ceiling. `advance()` implemented it correctly and six unit
// tests proved it. A seventh grepped loop.ts for `cycleExtensionsGranted += 1`
// and found it.
//
// The feature never ran once. The driver's bound was `while (cycle <
// max_cycles)`, and the grant is made ON the cycle that exhausts the ceiling,
// so the loop always terminated before the extra cycle it had just authorised.
// The b123 OpenClaw smoke audited `loop.max_cycles_extended {granted:1,
// blockingArc:[4,4,3], spentUsd:18.97}` against a $40 budget and then shipped
// three cycles with three blocking findings still open.
//
// Nothing that asks `advance()` a question can see this. The only test that
// can is one that counts the cycles a real run actually executed.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runScenario, mutateSubTask, scenarioAvailable, makeConfig, IDENT } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "build not present (npm run build)";

const PATH = "src/thing.ts";

/**
 * A worker that writes something DIFFERENT every call.
 *
 * The default scenario worker writes fixed content, so a second cycle commits
 * nothing and the loop early-exits as a no-change cycle (b108) before the
 * review that would decide anything. Any multi-cycle scenario needs a worker
 * that keeps moving, or it silently tests one cycle and a shortcut.
 */
function changingWorker(passes) {
  return async ({ worktreePath, plan }, { world }) => {
    const wt = worktreePath ?? plan.worktreePath;
    passes.push(wt);
    const abs = join(wt, PATH);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `export const n = ${passes.length};\n`);
    const commitSha = await world.adapter.commit(wt, `feat: pass ${passes.length}`, IDENT);
    return {
      status: "completed",
      filesChanged: [PATH],
      commitSha,
      commitShas: [commitSha],
      costUsd: 0.01,
      tokensIn: 1,
      tokensOut: 1,
      reason: "end_turn",
      finalMessage: "done",
    };
  };
}

/**
 * An adversary whose blocking-finding count follows `arc`, one entry per
 * cycle, and which never returns "pass". The last entry repeats if a run goes
 * longer than the arc, so an overshoot fails an assertion rather than the
 * fixture running out of data.
 */
function adversaryWithBlockingArc(arc) {
  let cycle = 0;
  return async () => {
    const n = arc[Math.min(cycle, arc.length - 1)];
    cycle += 1;
    return {
      verdict: "revise",
      findings: Array.from({ length: n }, (_, i) => ({
        severity: "high",
        dimension: "security",
        file: PATH,
        title: `blocking finding ${i + 1} seen on cycle ${cycle}`,
        detail: "d",
      })),
      summary: `cycle ${cycle}: ${n} blocking`,
      costUsd: 0.01,
      tokensIn: 1,
      tokensOut: 1,
    };
  };
}

/** max_cycles 2 by default so the ceiling arrives quickly; one extension. */
function scenario({ arc, extensions = 1, passes = [], maxCycles = 2 }) {
  return runScenario({
    configOver: { loop: { ...makeConfig().loop, max_cycles: maxCycles, max_cycle_extensions: extensions } },
    subTasks: [mutateSubTask({ seq: 1, title: "add a thing", path: PATH })],
    runAdversary: adversaryWithBlockingArc(arc),
    worker: changingWorker(passes),
  });
}

test("a converging run at the ceiling actually RUNS the cycle it granted itself", { skip }, async () => {
  const passes = [];
  const r = await scenario({ arc: [2, 1, 1], passes });

  // The grant. This much was already true before b124 -- the bug was never in
  // the decision.
  assert.equal(r.events("loop.max_cycles_extended").length, 1, "the extension should be granted once");

  // And this is the part that was false for four releases: the cycle ran.
  assert.equal(r.session().cycles_ran, 3, "max_cycles 2 + 1 granted extension = 3 cycles executed");
  assert.equal(
    r.events("loop.blocking_findings").length,
    3,
    "three review phases, so the extra cycle really executed rather than just being counted",
  );
  assert.equal(passes.length, 3, "the worker ran in the extra cycle, so it was real work and not a bookkeeping lap");
});

test("an extended run still terminates, and ships", { skip }, async () => {
  const r = await scenario({ arc: [2, 1, 1] });
  assert.equal(r.out.status, "shipped", `expected a ship after the extension, got ${r.out.status}: ${r.out.reason ?? ""}`);
  assert.equal(r.calls.push, 1);
});

test("the extension is spent once, not compounded into an unbounded run", { skip }, async () => {
  // Blocking findings keep falling, so the trend qualifies at every ceiling.
  // Only `max_cycle_extensions` stops this, and it must.
  const r = await scenario({ arc: [5, 4, 3, 2, 1] });
  assert.equal(r.session().cycles_ran, 3, "one extension means exactly one extra cycle, however good the trend");
  assert.equal(r.events("loop.max_cycles_extended").length, 1);
});

test("max_cycle_extensions 0 restores the hard ceiling", { skip }, async () => {
  const r = await scenario({ arc: [2, 1, 1], extensions: 0 });
  assert.equal(r.session().cycles_ran, 2, "the opt-out must still opt out");
  assert.equal(r.events("loop.max_cycles_extended").length, 0);
});

test("a run whose blocking findings go FLAT does not buy a cycle", { skip }, async () => {
  // The guard exists so a stuck run stops on time. Flat is stuck.
  const r = await scenario({ arc: [3, 3, 3] });
  assert.equal(r.session().cycles_ran, 2, "no net progress across the run means no extension");
  assert.equal(r.events("loop.max_cycles_extended").length, 0);
});

test("a run whose blocking findings REGRESS in the last cycle does not buy a cycle", { skip }, async () => {
  // Needs three cycles before the ceiling, because the "did not regress"
  // clause (`last <= prev`) only says anything a two-point arc has not already
  // said via `last < first`. 5 -> 2 -> 4 is net progress AND a regression, so
  // it isolates that clause: the trend improved overall but the most recent
  // cycle went backwards, which is not evidence another cycle will land.
  const r = await scenario({ arc: [5, 2, 4], maxCycles: 3 });
  assert.equal(r.session().cycles_ran, 3, "a regression in the most recent cycle disqualifies the trend");
  assert.equal(r.events("loop.max_cycles_extended").length, 0);
});

test("the ship note quotes the ceiling the run actually hit, not the configured one", { skip }, async () => {
  // An operator who watched three cycles must not read "hit the 2-cycle
  // ceiling". The old string interpolated config.max_cycles unconditionally.
  const r = await scenario({ arc: [2, 1, 1] });

  const suggested = r.events("loop.max_cycles_extend_suggested");
  assert.equal(suggested.length, 1, "a converging run that ships on the extended ceiling still asks to extend");
  assert.equal(suggested[0].payload.effectiveCeiling, 3);
  assert.equal(suggested[0].payload.cycleExtensionsGranted, 1);
  assert.equal(suggested[0].payload.maxCycles, 2);

  // The note lands on the session row and in the shipped event, which is what
  // the operator and the PR body read.
  const reason = String(r.session().merge_recommendation_reason ?? "");
  assert.match(reason, /3-cycle ceiling/);
  assert.doesNotMatch(reason, /2-cycle ceiling/);
  assert.match(reason, /\+1 granted for converging findings/);
});
