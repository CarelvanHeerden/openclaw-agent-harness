// rc.6 -- the run that overspent its cap and was then refused for overspending it.
//
// #1184 (compliance-calendar) finished at $53.81 against a $50 session budget,
// hit a four-job CI failure, and declined the repair cycle with
// `reason: "budget"`. Both halves were behaving as written. beta.78 made the
// session budget SOFT for ordinary work -- it warns and continues, and the hard
// admission boundary is the per-user daily cap. beta.120 then made the
// EXTENSION gate measure hard against that same number, because the harness
// electing to buy itself another cycle with unauthorised money is a different
// act from a worker running long.
//
// Read together they hand the whole budget to whoever spends first and refuse
// the only consumer that is measured against it. The run overspends AND ships
// red, which is the worst available combination and precisely what the
// operator paid to avoid.
//
// So the approved figure is divided up front. Implementation is sized against a
// target it may still cross; repair holds a reserve and measures its OWN spend
// against it, never the run's total. And when the money genuinely does run out,
// the loop asks the person paying instead of deciding for them -- the same
// authority `:moneybag:` has always carried, pulled at the moment it matters
// rather than pushed by somebody who happened to be watching.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const S = (rel) => readFileSync(join(here, "..", rel), "utf8");

const policy = await import("../dist/orchestrator/budget-policy.js");
const ext = await import("../dist/orchestrator/budget-extension.js");

const loadScenario = async () => {
  const mod = await import("./helpers/scenario.mjs");
  return (await mod.scenarioAvailable()) ? mod : null;
};

// ---------------------------------------------------------------------------
// The partition.
// ---------------------------------------------------------------------------

test("rc.6: the approved figure is divided before anything spends it", () => {
  const p = policy.resolveBudgetPolicy({ authorizedMaximumUsd: 50, repairReserveRatio: 0.3 });
  assert.equal(p.authorizedMaximumUsd, 50);
  assert.equal(p.repairReserveUsd, 15);
  assert.equal(p.implementationTargetUsd, 35);
  assert.equal(
    p.implementationTargetUsd + p.repairReserveUsd,
    p.authorizedMaximumUsd,
    "the division must account for the whole figure -- money that belongs to neither side is money nobody can spend",
  );
});

test("rc.6: a reserve may not swallow the run", () => {
  // Ordinary work declining extensions from the first cycle is a worse failure
  // than the one the reserve exists to fix.
  const p = policy.resolveBudgetPolicy({ authorizedMaximumUsd: 100, repairReserveRatio: 0.95 });
  assert.equal(p.repairReserveUsd, 50, "clamped to half");
  assert.equal(p.implementationTargetUsd, 50);

  const negative = policy.resolveBudgetPolicy({ authorizedMaximumUsd: 100, repairReserveRatio: -1 });
  assert.equal(negative.repairReserveUsd, 0);
  assert.equal(negative.implementationTargetUsd, 100, "no reserve is the pre-rc.6 shape, not a broken one");
});

test("rc.6: an unset ratio still reserves something", () => {
  const p = policy.resolveBudgetPolicy({ authorizedMaximumUsd: 60 });
  assert.equal(p.repairReserveUsd, 18, "the default must not be zero, or the whole mechanism is opt-in");
});

test("rc.6: no budget means no reserve, and nothing pretends otherwise", () => {
  for (const v of [0, null, undefined, Number.NaN, -5]) {
    const p = policy.resolveBudgetPolicy({ authorizedMaximumUsd: v });
    assert.equal(p.authorizedMaximumUsd, 0, `${String(v)}`);
    assert.equal(p.repairReserveUsd, 0);
  }
});

// ---------------------------------------------------------------------------
// Repair funding -- the #1184 arithmetic.
// ---------------------------------------------------------------------------

test("rc.6: #1184's numbers -- overspending implementation no longer refuses the repair", () => {
  const p = policy.resolveBudgetPolicy({ authorizedMaximumUsd: 50, repairReserveRatio: 0.3 });

  // The run as it happened: $53.81 spent, all of it implementation, CI red.
  // The old gate asked "does 53.81 plus a projected cycle fit inside 50?" and
  // there is no reserve ratio that makes that true. The new one does not ask
  // it: repair has spent nothing, so repair can spend.
  const funding = policy.assessRepairFunding({
    policy: p,
    repairSpentUsd: 0,
    repairCyclesGranted: 0,
    projectedRepairCostUsd: 0,
  });
  assert.equal(funding.funded, true);
  assert.equal(funding.basis, "first_repair");
});

test("rc.6: the first repair is funded without being priced as an implementation cycle", () => {
  // The heart of it. A repair fixes a handful of named CI findings on a branch
  // that is already built and reviewed; the old projection charged it for
  // another round of building the feature. Any reserve an operator would
  // plausibly set loses that comparison, so projecting the first repair would
  // reproduce the refusal.
  const p = policy.resolveBudgetPolicy({ authorizedMaximumUsd: 50, repairReserveRatio: 0.3 });
  const funding = policy.assessRepairFunding({
    policy: p,
    repairSpentUsd: 0,
    repairCyclesGranted: 0,
    projectedRepairCostUsd: 22.42, // an implementation cycle, dwarfing the $15 reserve
  });
  assert.equal(funding.funded, true, "a projection must not decide the first repair");
});

test("rc.6: a SECOND repair is held to what the first one actually cost", () => {
  const p = policy.resolveBudgetPolicy({ authorizedMaximumUsd: 50, repairReserveRatio: 0.3 });
  const affordable = policy.assessRepairFunding({
    policy: p,
    repairSpentUsd: 4,
    repairCyclesGranted: 1,
    projectedRepairCostUsd: 5,
  });
  assert.equal(affordable.funded, true);
  assert.equal(affordable.basis, "reserve_covers_projection");

  const exhausted = policy.assessRepairFunding({
    policy: p,
    repairSpentUsd: 13,
    repairCyclesGranted: 1,
    projectedRepairCostUsd: 6,
  });
  assert.equal(exhausted.funded, false);
  assert.equal(exhausted.basis, "reserve_exhausted");
  assert.equal(exhausted.shortfallUsd, 4, "and it must say how far short, or the ask has nothing to ask for");
});

test("rc.6: no reserve is reported as no reserve, not as an exhausted one", () => {
  // The two need different answers from an operator: one is a configuration
  // choice, the other is a run that has used what it was given.
  const none = policy.assessRepairFunding({
    policy: policy.resolveBudgetPolicy({ authorizedMaximumUsd: 50, repairReserveRatio: 0 }),
    repairSpentUsd: 0,
    repairCyclesGranted: 0,
    projectedRepairCostUsd: 0,
  });
  assert.equal(none.funded, false);
  assert.equal(none.basis, "no_reserve");
});

test("rc.6: the projection is measured, and nothing measured is not free", () => {
  assert.equal(policy.projectCycleCostUsd(40, 2), 25);
  assert.equal(policy.projectCycleCostUsd(0, 4), 0);
  assert.equal(policy.projectCycleCostUsd(12, 0), 0);
});

// ---------------------------------------------------------------------------
// The reply.
// ---------------------------------------------------------------------------

const parse = (a, o = {}) => ext.parseBudgetExtensionReply(a, { defaultUsd: 10, maxUsd: 60, ...o });

test("rc.6: an amount is read however it is written", () => {
  for (const [reply, usd] of [
    ["$20", 20],
    ["20", 20],
    ["50 more", 50],
    ["add $12.50", 12.5],
    ["yes, 30 dollars", 30],
    ["sure, 15 usd", 15],
  ]) {
    const r = parse(reply);
    assert.equal(r.approved, true, reply);
    assert.equal(r.usd, usd, reply);
    assert.equal(r.interpretation, "explicit_amount", reply);
  }
});

test("rc.6: a bare yes buys the default", () => {
  for (const reply of ["yes", "yep", "ok", "go on", "approved", "please do", "yes (:moneybag:)"]) {
    const r = parse(reply);
    assert.equal(r.approved, true, reply);
    assert.equal(r.usd, 10, reply);
    assert.equal(r.interpretation, "approved_default", reply);
  }
});

test("rc.6: 'no more than $20' is an approval that begins with the letters n-o", () => {
  // beta.129's lesson on the clock side, and it costs exactly as much to get
  // wrong here: reading this as a refusal throws away the extension the
  // operator just granted.
  const r = parse("no more than $20");
  assert.equal(r.approved, true);
  assert.equal(r.usd, 20);
});

test("rc.6: a refusal is a refusal", () => {
  for (const reply of ["no", "nope", "stop", "ship it", "ship", "land what you have", "abort"]) {
    const r = parse(reply);
    assert.equal(r.approved, false, reply);
    assert.equal(r.usd, 0, reply);
    assert.equal(r.interpretation, "declined", reply);
  }
});

test("rc.6: an unreadable reply lands the work rather than guessing 'keep spending'", () => {
  for (const reply of ["", "   ", "what?", "hmm, depends"]) {
    const r = parse(reply);
    assert.equal(r.approved, false, JSON.stringify(reply));
    assert.equal(r.interpretation, "unrecognised", JSON.stringify(reply));
  }
});

test("rc.6: one grant may not more than double the run, and says when it clamped", () => {
  const r = parse("yes, 6000", { maxUsd: ext.maxExtensionUsd(50) });
  assert.equal(r.approved, true);
  assert.equal(r.usd, 50, "a typo costs a clamp and an audit line, not the month's budget");
  assert.equal(r.clamped, true);

  assert.equal(ext.maxExtensionUsd(200), 200);
  assert.equal(ext.maxExtensionUsd(5), 50, "small budgets get a floor, or doubling buys nothing");
  assert.equal(ext.maxExtensionUsd(0), 50);
});

// ---------------------------------------------------------------------------
// The question.
// ---------------------------------------------------------------------------

const ask = (over = {}) =>
  ext.renderBudgetExtensionQuestion({
    trigger: "ci_repair",
    cycle: 3,
    spentUsd: 53.81,
    authorizedMaximumUsd: 50,
    shortfallUsd: 4,
    defaultUsd: 18,
    waitSeconds: 300,
    ...over,
  });

test("rc.6: the question says what is wrong, what a yes costs, and what silence does", () => {
  const q = ask({ ciSummary: "4 failing jobs" });
  assert.match(q, /CI came back red/);
  assert.match(q, /4 failing jobs/);
  assert.match(q, /\$53\.81 of \$50\.00 spent/, "the operator must see the real numbers, not a verdict");
  assert.match(q, /\$18\.00/, "a bare yes must have a stated price");
  assert.match(q, /5 min/, "and the window must be stated");
  assert.match(q, /cannot strand the work/, "silence must be visibly safe");
});

test("rc.6: the question distinguishes this run's budget from the daily cap", () => {
  // They cost the operator different things: one is money already scoped to
  // this task, the other is the rest of the day's work.
  const own = ask({ trigger: "cycle_extension" });
  assert.doesNotMatch(own, /DAILY cap/);

  const daily = ask({ trigger: "review", dailyCapUsd: 200 });
  assert.match(daily, /DAILY cap of \$200\.00/);
});

test("rc.6: every trigger produces a question that names its own situation", () => {
  const seen = new Set();
  for (const trigger of ["ci_repair", "cycle_extension", "review", "sub_task", "daily_cap"]) {
    const q = ask({ trigger });
    assert.ok(q.length > 80, trigger);
    assert.match(q, /Reply with an amount to add/, trigger);
    seen.add(q.split(".")[0]);
  }
  assert.equal(seen.size, 5, "a shared opening line would tell the operator nothing about what they are buying");
});

// ---------------------------------------------------------------------------
// Wiring. Pinned by meaning, because these are the joins that made #1184.
// ---------------------------------------------------------------------------

test("rc.6: the repair gate never reads the run's total spend", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("const repairFunding = assessRepairFunding({");
  assert.ok(i > 0, "repair must be funded through the named policy");
  const block = src.slice(i, src.indexOf("const wantsRepair", i));
  assert.match(
    block,
    /repairSpentUsd: Math\.max\(0, totalCost - repairSpendBaselineUsd\)/,
    "repair must be charged for its OWN spend; measuring it against totalCost is the #1184 bug exactly",
  );
  assert.doesNotMatch(
    block,
    /hasBudgetHeadroomForAnotherCycle/,
    "the extension gate is what refused the repair -- it must not be what funds it either",
  );
});

test("rc.6: an extension may not spend the repair reserve", () => {
  const src = S("src/orchestrator/loop.ts");
  const calls = src.match(/hasBudgetHeadroomForAnotherCycle\(row\.requester[^)]*\)/g) ?? [];
  assert.ok(calls.length >= 2, "the extension gates must still exist");
  for (const call of calls) {
    assert.match(
      call,
      /budgetPolicy\.implementationTargetUsd/,
      "b120's rule aimed at the whole budget let implementation eat the money repair needed",
    );
  }
});

test("rc.6: the baseline is stamped once, so a second repair is still measured from where repair began", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /if \(ciRepairCyclesGranted === 0\) repairSpendBaselineUsd = totalCost;/);
});

test("rc.6: all five money stops ask before they refuse", () => {
  const src = S("src/orchestrator/loop.ts");
  const triggers = (src.match(/trigger: "(ci_repair|cycle_extension|review|sub_task|daily_cap)"/g) ?? [])
    .map((m) => m.split('"')[1]);
  // `ci_repair` appears twice: the clock ask uses the same name.
  for (const t of ["ci_repair", "review", "sub_task"]) {
    assert.ok(triggers.includes(t), `${t} must be able to ask`);
  }
  assert.match(src, /dailyBlocked \? "daily_cap" : "cycle_extension"/, "the review boundary covers the other two");
  assert.equal(
    (src.match(/await this\.askForBudgetExtension\(\{/g) ?? []).length,
    4,
    "four call sites: the sub-task gate, the review gate, the review boundary (which covers both cycle_extension and daily_cap), and CI repair",
  );
});

test("rc.6: whether money was the only thing missing is asked of `advance`, not restated", () => {
  // A copy of advance's conditions in the loop would drift the first time
  // somebody edited one of them, and the failure would be silent: the ask
  // simply stops firing.
  const src = S("src/orchestrator/loop.ts");
  assert.match(
    src,
    /OrchestratorLoop\.advance\(\{ \.\.\.advanceInput, budgetHeadroomOk: true, budgetExhausted: false \}\)/,
  );
});

test("rc.6: a granted extension is persisted, not just believed", () => {
  // beta.130 persisted an extended deadline for this reason: a resume that
  // reverted to the original figure would stop the run a second time for a
  // reason the operator has already overruled.
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("private applyBudgetGrant(");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("\n  /**", i));
  assert.match(body, /UPDATE sessions SET budget_usd = \?/);
  assert.match(body, /resolveBudgetPolicy\(/, "the reserve must move with the raised figure");
});

test("rc.6: the monthly cap is the one wall nothing in the loop may ask past", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("private hardCapsAllow(");
  const body = src.slice(i, src.indexOf("private hasBudgetHeadroomForAnotherCycle", i));
  assert.doesNotMatch(body, /monthly/i, "the monthly cap is admission-time, and deliberately not negotiable here");
  // And it is still genuinely enforced where it lives.
  assert.match(S("src/budgets/enforcer.ts"), /Monthly budget exhausted/);
});

test("rc.6: the receipt stops calling a target a cap", () => {
  const src = S("src/tools/brief-confirmation.ts");
  assert.doesNotMatch(src, /A run that hits either stops/, "true of the clock, false of the money");
  assert.match(src, /the budget is a target/);
  assert.match(src, /held back for CI repair/);
});

// ---------------------------------------------------------------------------
// End to end: the #1184 shape, on a real loop.
// ---------------------------------------------------------------------------

/** Writes different bytes each call so a repair cycle is a real diff. */
function countingWorker() {
  let n = 0;
  return async (params, { world }) => {
    n += 1;
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

const PASSES = async () => ({
  verdict: "pass",
  findings: [],
  summary: "looks right",
  costUsd: 0.02,
  tokensIn: 1,
  tokensOut: 1,
});

function ciEdge(states) {
  const seen = [];
  return {
    seen,
    ciSnapshot: async ({ sha }) => {
      const state = states[Math.min(seen.length, states.length - 1)];
      seen.push({ sha, state });
      return { state, checkTotal: 1, checksReadable: true, statusReadable: true, reason: `test says ${state}`, checksSource: "check_runs" };
    },
    ciFailingLogs: async () => "FAIL src/thing.test.ts\n  ● it works\n    Expected: 2\n    Received: 3",
  };
}

/**
 * The run is deliberately given a budget it will overspend on implementation
 * alone -- $0.02 against a cycle that costs about $0.03. That is #1184's shape
 * in miniature, and before rc.6 it was the whole of the refusal.
 *
 * The clock is generous: this test is about money, and racing a stopwatch here
 * would only make it flaky about the wrong thing.
 */
const LOOSE = {
  max_cycles: 1,
  session_hard_timeout_seconds: 600,
  time_extension_ask_enabled: false,
  budget_extension_ask_enabled: false,
};

test("rc.6: a run that overspent its budget still gets its repair cycle", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const bundle = await scenario.makeState();
  const ci = ciEdge(["failure", "success"]);
  const r = await scenario.runScenario({
    stateBundle: bundle,
    budgetUsd: 0.02,
    configOver: {
      loop: { ...LOOSE, repair_reserve_ratio: 0.3 },
      ci: { max_repair_cycles: 1, poll_interval_seconds: 1 },
    },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1184",
    deps: ci,
  });

  const session = r.session();
  assert.ok(
    session.cost_usd > 0.02,
    `the premise: implementation must have overspent the budget (spent ${session.cost_usd})`,
  );
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1, "and the repair must be granted anyway");
  assert.equal(session.cycles_ran, 2, "granted is not enough -- the repair cycle must RUN");
  assert.equal(ci.seen.length, 2, "CI must be re-checked on the repaired commit");
  assert.equal(session.merge_recommendation, "merge", "a green re-check must clear the do-not-merge");
});

test("rc.6: with no reserve configured, the same run is refused -- and says the reserve is why", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  // The control for the test above. Same run, same overspend, reserve set to
  // zero: the repair goes back to being refused, which is what shows the
  // reserve is doing the work rather than some incidental slack.
  const bundle = await scenario.makeState();
  const r = await scenario.runScenario({
    stateBundle: bundle,
    budgetUsd: 0.02,
    configOver: {
      loop: { ...LOOSE, repair_reserve_ratio: 0 },
      ci: { max_repair_cycles: 1, poll_interval_seconds: 1 },
    },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1184",
    deps: ciEdge(["failure"]),
  });

  const declined = r.events("loop.ci_repair_declined");
  assert.equal(declined.length, 1);
  assert.equal(declined[0].payload.reason, "budget");
  assert.equal(
    declined[0].payload.repairFunding,
    "no_reserve",
    "'budget' alone is what made #1184 read as 'too expensive' when the truth was 'somebody else spent it'",
  );
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 0);
});

test("rc.6: an operator who answers the money question buys the repair", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const bundle = await scenario.makeState();
  const ci = ciEdge(["failure", "success"]);
  // Answers the budget question the moment it is posted. -4 is the budget
  // pause's sentinel seq, as -3 is the wall clock's.
  const answerer = setInterval(() => {
    try {
      const row = bundle.db.prepare(`SELECT clarification_seq FROM sessions WHERE id = 'S1'`).get();
      if (row?.clarification_seq === -4) {
        bundle.db.prepare(`UPDATE sessions SET clarification_answer = '$5' WHERE id = 'S1'`).run();
      }
    } catch {
      /* the row is not there yet */
    }
  }, 25);

  let r;
  try {
    r = await scenario.runScenario({
      stateBundle: bundle,
      budgetUsd: 0.02,
      configOver: {
        // No reserve, so the repair is refused on money -- and then asked about.
        loop: { ...LOOSE, repair_reserve_ratio: 0, budget_extension_ask_enabled: true, budget_extension_wait_seconds: 20 },
        ci: { max_repair_cycles: 1, poll_interval_seconds: 1 },
      },
      worker: countingWorker(),
      runAdversary: PASSES,
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1184",
      deps: ci,
    });
  } finally {
    clearInterval(answerer);
  }

  const asked = r.events("loop.budget_extension_requested");
  assert.equal(asked.length, 1, "the operator must be asked before a red build is shipped over");
  assert.equal(asked[0].payload.trigger, "ci_repair", "and the ask must know why it is asking");
  assert.equal(r.events("loop.budget_extension_granted").length, 1);

  const applied = r.events("loop.budget_extension_applied");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].payload.grantedUsd, 5);
  assert.ok(r.session().budget_usd >= 5, "the grant must reach the row, or a resume undoes it");

  // b124's lesson: a granted anything proves nothing until a worker runs.
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1, "the granted money must buy the repair");
  assert.equal(r.session().cycles_ran, 2, "and the repair cycle must actually RUN");
  assert.equal(r.session().merge_recommendation, "merge");
});
