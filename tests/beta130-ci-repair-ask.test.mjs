// beta.130 -- refusing a repair is right; refusing it silently is not.
//
// The first local b129 run reached the ship gate having done everything
// correctly: two cycles, a passing review, a pushed branch, PR #1058, $9.84 of
// a $40 cap. Then CI came back red on ONE assertion out of 9,027 -- a sidebar
// ordering index that the run's own nav entry had shifted -- and b129's new
// clock guard correctly worked out that a repair cycle would not fit in the
// 15.6 minutes left. So it shipped a do-not-merge PR.
//
// That refusal was sound and the audit line said so: `budgetOk=true
// clockOk=false`. What it did not do was ask. Thirty dollars sat unspent while
// the harness decided on the operator's behalf that a green PR was not worth
// a question, and a human then had to finish by hand a job the harness could
// have finished for the price of one more cycle.
//
// b129 built the machinery to ask and wired it to the review boundary only.
// These tests pin it to the other end too, and pin the shape of the refusal:
// the ask fires when -- and ONLY when -- the clock is the single thing
// missing.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const loadScenario = async () => {
  const mod = await import("./helpers/scenario.mjs");
  return (await mod.scenarioAvailable()) ? mod : null;
};

const loadTimeExt = async () => {
  try {
    return await import("../dist/orchestrator/time-extension.js");
  } catch {
    return null;
  }
};

// The real failure, verbatim from the run that motivated this release.
const REAL_JEST_LOG = `Summary of all failing tests
FAIL src/__tests__/components/sidebar-nav-placement.test.ts
  ● InfoSec GRC ordering › groups the AI system register with the other inventories
    expect(received).toBe(expected) // Object.is equality
    Expected: 2
    Received: 3
      at Object.<anonymous> (src/__tests__/components/sidebar-nav-placement.test.ts:87:61)
Test Suites: 1 failed, 628 passed, 629 total`;

function ciEdge(states, logs = REAL_JEST_LOG) {
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

/** Writes different bytes each call so a repair cycle is a real diff. */
function countingWorker(hints = []) {
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
      ? await world.adapter.commit(wt, `feat(${subTask.seq}): pass ${n}`, { name: "t", email: "t@e.c" })
      : undefined;
    return {
      status: "completed",
      filesChanged: written,
      commitSha,
      commitShas: commitSha ? [commitSha] : [],
      costUsd: 0.01,
      tokensIn: 10,
      tokensOut: 10,
      reason: "end_turn",
      finalMessage: "done",
    };
  };
}

/**
 * Answers the time-extension question as soon as it is posted.
 *
 * A 5-second ceiling means the clock is provably blown by the time CI has been
 * polled, so `clockOk` is false without racing a stopwatch -- and because the
 * review returns `pass`, b129's "a verdict outranks the clock" rule carries the
 * run to the ship gate rather than aborting it. That is the exact live shape.
 */
function autoAnswer(db, reply) {
  return setInterval(() => {
    try {
      const row = db.prepare(`SELECT clarification_seq FROM sessions WHERE id = 'S1'`).get();
      if (row?.clarification_seq === -3) {
        db.prepare(`UPDATE sessions SET clarification_answer = ? WHERE id = 'S1'`).run(reply);
      }
    } catch {
      /* the row is not there yet */
    }
  }, 25);
}

/**
 * Multiplier for every wall-clock number in this file.
 *
 * These tests run a real loop, doing real git work, against a ceiling of a few
 * seconds -- that is how "the clock is blown" becomes true by the time the ship
 * gate is reached. It is a stopwatch race, and on a loaded machine the run
 * blows the ceiling EARLIER than intended and aborts before reaching the
 * decision the test is about. That shows up as a MISSING event rather than a
 * wrong one, which is why `lastPayload` below exists.
 *
 * Scaling every number by the same factor preserves the ratios the guard's
 * quarter/half clamps depend on, so a bigger scale buys tolerance without
 * changing what is being tested.
 *
 * The default is 2 because 1 was measurably not enough: the original numbers
 * failed one full suite run and passed the next, a coin flip on an unloaded
 * machine, purely because `npm test` runs this file alongside a hundred others.
 * Raise it further on anything more contended:
 *
 *   HARNESS_TEST_CLOCK_SCALE=4 node --test tests/beta130-ci-repair-ask.test.mjs
 *
 * It is a mitigation, not a cure. The cure is a clock the loop takes as a
 * dependency, which `loop.ts` does not yet have -- it reads `Date.now()`
 * directly in about thirty places.
 */
const CLOCK_SCALE = Math.max(1, Number(process.env.HARNESS_TEST_CLOCK_SCALE ?? 2) || 2);
/** Seconds and milliseconds, scaled together so the ratios survive. */
const s = (n) => n * CLOCK_SCALE;
const ms = (n) => n * CLOCK_SCALE;

/**
 * The last payload for an event, or a failure that says what the run did.
 *
 * `events(...).at(-1).payload` throws "Cannot read properties of undefined"
 * when the run never got that far, which names neither the event nor the
 * reason. Under a deliberately tiny ceiling that is the most likely way these
 * tests fail, and it is worth five seconds of reading rather than twenty
 * minutes of hunting a regression that is not there.
 */
function lastPayload(r, event) {
  const seen = r.events(event);
  if (seen.length > 0) return seen.at(-1).payload;
  const emitted = [...new Set(r.audits.map((a) => a.event))].join(", ");
  assert.fail(
    `no '${event}' event was emitted, so the run never reached that decision.\n` +
      `  Under this file's deliberately tiny wall clock that usually means the run was cut short\n` +
      `  before the ship gate -- a timing failure, not a behavioural one. Re-run with\n` +
      `  HARNESS_TEST_CLOCK_SCALE=3 to confirm before hunting a regression.\n` +
      `  events seen: ${emitted}`,
  );
}

/**
 * A ceiling the run gets inside but cannot fit a second cycle into.
 *
 * The guard clamps its reserve to a quarter of the ceiling and its cycle
 * allowance to a half, so once the measured cycle saturates that clamp the
 * question reduces to "is more than a quarter of the clock gone" -- which the
 * slow review below guarantees, without the test racing a stopwatch.
 */
const TIGHT_CLOCK = {
  max_cycles: 1,
  session_hard_timeout_seconds: s(3),
  time_extension_wait_seconds: s(5),
  time_extension_default_seconds: 1800,
};

/** Passes review, slowly -- which is what makes the cycle look expensive. */
const PASSES = async () => {
  await new Promise((res) => setTimeout(res, ms(1600)));
  return { verdict: "pass", findings: [], summary: "looks right", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
};

test("a red build with money in the bank asks for time instead of shipping red", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const bundle = await scenario.makeState();
  const ci = ciEdge(["failure", "success"]);
  const answerer = autoAnswer(bundle.db, "1 hour");
  let r;
  try {
    r = await scenario.runScenario({
      stateBundle: bundle,
      configOver: { loop: TIGHT_CLOCK, ci: { max_repair_cycles: 1, poll_interval_seconds: 1 } },
      worker: countingWorker(),
      runAdversary: PASSES,
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
      deps: ci,
    });
  } finally {
    clearInterval(answerer);
  }

  const asked = r.events("loop.time_extension_requested");
  assert.equal(asked.length, 1, "the operator must be asked before a red build is shipped over");
  assert.equal(asked[0].payload.trigger, "ci_repair", "and the ask must know why it is asking");
  assert.equal(r.events("loop.time_extension_granted").length, 1);

  // b124's lesson: a granted anything proves nothing until a worker runs.
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1, "the granted time must buy the repair");
  assert.equal(r.session().cycles_ran, 2, "and the repair cycle must actually RUN");
  assert.equal(ci.seen.length, 2, "CI must be re-checked on the repaired commit");
  assert.equal(r.session().merge_recommendation, "merge", "a green re-check must clear the do-not-merge");
});

test("granting time for a repair buys ONE cycle, not two", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const bundle = await scenario.makeState();
  const ci = ciEdge(["failure"]);
  const answerer = autoAnswer(bundle.db, "1 hour");

  // The repair grant raises the loop bound by one all by itself. Counting the
  // extension as well raises it by two -- but that second cycle is invisible
  // unless something still WANTS one, because the repair ceiling stops the
  // ship gate re-entering. So: pass first (to reach the ship gate at all),
  // then keep asking for revisions. A correct bound stops at two cycles; a
  // double-counted one runs a third that nobody granted.
  let reviews = 0;
  const passThenRevise = async () => {
    await new Promise((res) => setTimeout(res, ms(1600)));
    reviews += 1;
    if (reviews === 1) {
      return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
    }
    return {
      verdict: "revise",
      findings: [{ severity: "high", kind: "spec", file: "src/thing.ts", detail: "still not right" }],
      summary: "more to do",
      costUsd: 0.02,
      tokensIn: 1,
      tokensOut: 1,
    };
  };

  let r;
  try {
    r = await scenario.runScenario({
      stateBundle: bundle,
      configOver: { loop: TIGHT_CLOCK, ci: { max_repair_cycles: 1, poll_interval_seconds: 1 } },
      worker: countingWorker(),
      runAdversary: passThenRevise,
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
      deps: ci,
    });
  } finally {
    clearInterval(answerer);
  }

  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1, "the ask must have bought the repair");
  assert.equal(r.session().cycles_ran, 2, "one repair cycle, not two -- the grant must not be counted twice");
});

test("'ship' ships red -- and the audit records that the operator was asked", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const bundle = await scenario.makeState();
  const ci = ciEdge(["failure"]);
  const answerer = autoAnswer(bundle.db, "ship");
  let r;
  try {
    r = await scenario.runScenario({
      stateBundle: bundle,
      configOver: { loop: TIGHT_CLOCK, ci: { max_repair_cycles: 1, poll_interval_seconds: 1 } },
      worker: countingWorker(),
      runAdversary: PASSES,
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
      deps: ci,
    });
  } finally {
    clearInterval(answerer);
  }

  assert.equal(r.events("loop.time_extension_declined").length, 1);
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 0, "a refusal must not buy a cycle anyway");
  assert.equal(r.session().cycles_ran, 1);
  const declined = lastPayload(r, "loop.ci_repair_declined");
  assert.equal(declined.reason, "wall_clock");
  assert.equal(declined.askedForTime, true, "the report must be able to tell this from a silent decline");
  assert.equal(r.session().merge_recommendation, "needs_human_review");
});

test("no ask when the budget is short too -- more time would not help", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const ci = ciEdge(["failure"]);
  const r = await scenario.runScenario({
    configOver: { loop: TIGHT_CLOCK, ci: { max_repair_cycles: 1, poll_interval_seconds: 1 } },
    // Spent out: the worker's own cost exceeds the cap, so no cycle is
    // affordable regardless of how many seconds the operator donates.
    budgetUsd: 0.01,
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
    deps: ci,
  });

  assert.equal(r.events("loop.time_extension_requested").length, 0, "asking for time cannot fix an empty wallet");
  const declined = lastPayload(r, "loop.ci_repair_declined");
  assert.equal(declined.reason, "budget");
  assert.equal(declined.askedForTime, false);
});

test("no ask when repairs are switched off entirely", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const ci = ciEdge(["failure"]);
  const r = await scenario.runScenario({
    configOver: { loop: TIGHT_CLOCK, ci: { max_repair_cycles: 0, poll_interval_seconds: 1 } },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
    deps: ci,
  });

  assert.equal(r.events("loop.time_extension_requested").length, 0, "there is nothing to buy");
  assert.equal(lastPayload(r, "loop.ci_repair_declined").reason, "disabled");
});

test("the ask can be switched off, and then it ships exactly as b129 shipped", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const ci = ciEdge(["failure"]);
  const r = await scenario.runScenario({
    configOver: {
      loop: { ...TIGHT_CLOCK, time_extension_ask_enabled: false },
      ci: { max_repair_cycles: 1, poll_interval_seconds: 1 },
    },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
    deps: ci,
  });

  assert.equal(r.events("loop.time_extension_requested").length, 0);
  assert.equal(lastPayload(r, "loop.ci_repair_declined").reason, "wall_clock");
  assert.equal(r.session().merge_recommendation, "needs_human_review");
});

test("a clock already past its deadline cannot fund a repair either", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const ci = ciEdge(["failure", "success"]);
  const r = await scenario.runScenario({
    // The review takes longer than the whole ceiling, so the run reaches the
    // ship gate with the deadline behind it. b129 carried it here on the
    // strength of the pass; shouldReserveTimeToShip answers "no need to
    // reserve" once remaining goes negative, which would have read as a green
    // light to spend a cycle that does not exist.
    configOver: {
      loop: { ...TIGHT_CLOCK, session_hard_timeout_seconds: s(1), time_extension_ask_enabled: false },
      ci: { max_repair_cycles: 1, poll_interval_seconds: 1 },
    },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
    deps: ci,
  });

  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 0, "a dead clock must not buy a cycle");
  const declined = lastPayload(r, "loop.ci_repair_declined");
  assert.equal(declined.reason, "wall_clock");
  assert.ok(declined.remainingMs <= 0 || declined.clockOk === false);
  assert.equal(r.session().cycles_ran, 1);
});

// ---------------------------------------------------------------------------
// The question an operator actually reads
// ---------------------------------------------------------------------------

test("the CI question describes a red build, not 'blocking findings'", async (t) => {
  const m = await loadTimeExt();
  if (!m) return t.skip("dist/ not built");

  const q = m.renderTimeExtensionQuestion({
    cycle: 2,
    blockingFindings: 1,
    spentUsd: 9.84,
    budgetUsd: 40,
    remainingSeconds: 936,
    observedCycleSeconds: 730,
    defaultSeconds: 1800,
    waitSeconds: 300,
    trigger: "ci_repair",
    ciSummary: "1 failing test in sidebar-nav-placement.test.ts",
  });

  assert.match(q, /CI came back red/i, "the operator must know the branch is already pushed");
  assert.match(q, /sidebar-nav-placement/, "and what actually failed");
  assert.match(q, /\$9\.84 of \$40\.00 spent/, "the unspent money is the reason to say yes");
  assert.match(q, /do-not-merge/i, "and the cost of saying no must be stated");
  assert.doesNotMatch(q, /blocking finding/i, "that phrasing describes the review case, not this one");

  // The review wording must be untouched by the new branch.
  const review = m.renderTimeExtensionQuestion({
    cycle: 2,
    blockingFindings: 3,
    spentUsd: 9.84,
    budgetUsd: 40,
    remainingSeconds: 936,
    observedCycleSeconds: 730,
    defaultSeconds: 1800,
    waitSeconds: 300,
  });
  assert.match(review, /3 blocking findings still open/);
  assert.doesNotMatch(review, /CI came back red/i);
});

test("both questions accept the same answers", async (t) => {
  const m = await loadTimeExt();
  if (!m) return t.skip("dist/ not built");
  // The CI framing offers "ship" as the decline; it has to parse as one.
  assert.equal(m.parseTimeExtensionReply("ship", { defaultSeconds: 1800 }).approved, false);
  assert.equal(m.parseTimeExtensionReply("yes", { defaultSeconds: 1800 }).seconds, 1800);
  assert.equal(m.parseTimeExtensionReply("30 minutes", { defaultSeconds: 1800 }).seconds, 1800);
  assert.equal(m.parseTimeExtensionReply("1 hour", { defaultSeconds: 1800 }).seconds, 3600);
});

// ---------------------------------------------------------------------------
// The ship phase stops swallowing the whole run
// ---------------------------------------------------------------------------

test("the ship phase times shipping, not every cycle that preceded it", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const r = await scenario.runScenario({
    configOver: { loop: { max_cycles: 1 } },
    worker: countingWorker(),
    // A slow review makes the cycles expensive in wall-clock terms. If `ship`
    // were still anchored outside the cycle loop it would absorb this sleep,
    // which is how the live run reported 25 minutes of shipping for 6.
    runAdversary: async () => {
      await new Promise((res) => setTimeout(res, ms(1200)));
      return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
    },
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1058",
  });

  const timings = r.events("loop.phase_timing").map((e) => e.payload);
  const ship = timings.find((p) => p.phase === "ship");
  const review = timings.find((p) => p.phase === "review");
  assert.ok(ship, "the ship phase must still be reported");
  assert.ok(review.durationMs >= 1000, "the slow review should be visible in its own phase");
  assert.ok(
    ship.durationMs < review.durationMs,
    `ship (${ship.durationMs}ms) must not contain the review (${review.durationMs}ms) it followed`,
  );
  assert.ok(
    ship.sinceFirstShipAttemptMs >= ship.durationMs,
    "the cross-attempt span is still reported, just not as the phase duration",
  );

  // The property emitPhaseTiming documents for itself: the phases sum to
  // something that fits inside the run, rather than exceeding it.
  const summed = timings.reduce((a, p) => a + p.durationMs, 0);
  const wall = r.session().updated_at - r.session().created_at;
  assert.ok(summed <= wall + 2000, `phases sum to ${summed}ms of a ${wall}ms run`);
});
