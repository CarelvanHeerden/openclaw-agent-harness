// beta.127 (#157) — the planner's bill.
//
// From the b126 smoke's interaction log:
//
//   ts=... phase=plan model=claude-opus-5 finishReason=end_turn
//   outputChars=52025 costUsd=null durationMs=311497
//
// null, not zero. Every worker `sdk_response` in the same log carried a cost
// (worker seq-1 costUsd=0.5299) and every adversary one did too. Only the
// lead -- the most expensive model in the run, 311 seconds of Opus -- reported
// nothing, so the session's $18.78 was a lower bound by an unknown amount.
//
// Two independent omissions produced that:
//
//   1. `callLeadModel` was DECLARED as returning `Omit<LeadPlan, ...>`. The
//      implementation returned `costUsd` all along; the type erased it at the
//      assignment, so the value was discarded inside the planner.
//   2. `totalCost` accumulated worker, worker-retry and adversary costs and
//      never the lead's -- which matters beyond reporting, because that is the
//      number the budget ceiling is checked against and the number `advance()`
//      reads when deciding whether another cycle is affordable.
import test from "node:test";
import assert from "node:assert/strict";
import { runScenario, scenarioAvailable, makeConfig, mutateSubTask } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

test("the lead's spend reaches the session ledger", { skip }, async () => {
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    // A planner that bills like the b126 one did.
    leadCostUsd: 2.5,
  });
  const ready = r.events("loop.plan_ready").at(-1);
  assert.equal(ready.payload.leadCostUsd, 2.5, "the plan_ready event must name the planner's cost");
  // The worker and adversary defaults bill $0.01 each, so anything at or above
  // the lead's own 2.5 proves it was added rather than dropped.
  assert.ok(r.out.totalCostUsd >= 2.5, `expected the lead's 2.5 in the total, got ${r.out.totalCostUsd}`);
});

test("a plan that reports no cost does not become NaN in the ledger", { skip }, async () => {
  // The revise paths synthesise a plan without calling a model, and the tests
  // that predate this field return plans with no cost at all.
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
  });
  assert.equal(Number.isFinite(r.out.totalCostUsd), true);
  assert.equal(r.events("loop.plan_ready").at(-1).payload.leadCostUsd, 0);
});

test("the planner's cost counts against the budget, not just the report", { skip }, async () => {
  // The point of #157. A ceiling cannot bound spend it is not shown, and until
  // b127 a $40 session could spend the lead's share entirely outside the cap.
  const cheap = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    leadCostUsd: 0,
  });
  const dear = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    leadCostUsd: 7.25,
  });
  assert.ok(
    dear.out.totalCostUsd - cheap.out.totalCostUsd >= 7,
    `an expensive plan must cost more than a cheap one: ${cheap.out.totalCostUsd} vs ${dear.out.totalCostUsd}`,
  );
});

test("the scout's cost is counted too", { skip }, async () => {
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    leadCostUsd: 1,
    scoutCostUsd: 0.5,
  });
  assert.equal(r.events("loop.plan_ready").at(-1).payload.scoutCostUsd, 0.5);
  assert.equal(r.events("loop.plan_ready").at(-1).payload.leadCostUsd, 1.5, "planning + scout");
});

// ---------------------------------------------------------------------------
// The tests above drive the LOOP, which is handed a finished plan. They cannot
// see the accumulation inside the planner, and a mutation proved it: replacing
// `leadCallCostUsd += raw.costUsd ?? 0` with `+= 0` left all of them passing.
// These drive runLeadPlanner itself, where the discard actually happened.
// ---------------------------------------------------------------------------

let runLeadPlanner;
try {
  ({ runLeadPlanner } = await import("../dist/orchestrator/lead.js"));
} catch { runLeadPlanner = null; }
const skipPlanner = runLeadPlanner === null ? "dist/ not built" : false;

const BRIEF = () => ({
  title: "continuity exercises", motivation: "m", acceptanceCriteria: ["ship it"],
  filesLikelyTouched: [], outOfScope: [], riskLevel: "low", repoHint: "o/r",
});

const PLAN_REPLY = (costUsd) => ({
  repo: "o/r", branch: "harness/feat-x", riskLevel: "low", reviewChecklist: [],
  subTasks: [{
    seq: 1, title: "t", intent: "i", filesLikelyTouched: ["src/a.ts"],
    successCriteria: ["s"], estimatedTokens: 10, taskMode: "mutate",
    verify: [{ kind: "commit_made" }],
    workerContext: {
      rationale: "The implementation brief requires a concrete source change.",
      changeSpec: "Edit src/a.ts to implement the requested continuity behavior and commit it.",
    },
  }],
  costUsd,
});

function leadDeps(over = {}) {
  return {
    config: {
      repos: { allowed: ["o/*"], default_base_branch: "main" },
      loop: { lead_repo_scout_enabled: false },
      models: { lead: "l" },
      budgets: {},
    },
    logger: { info() {}, warn() {} },
    allocateWorktree: async () => "/tmp/wt-real",
    callLeadModel: async () => PLAN_REPLY(3.5),
    estimateCost: () => 0,
    ...over,
  };
}

test("the planner reports what the model actually charged", { skip: skipPlanner }, async () => {
  const plan = await runLeadPlanner(BRIEF(), leadDeps());
  assert.equal(plan.actualCostUsd, 3.5);
  // The field this was confused with. `approxCostUsd` is a forecast of what the
  // PLAN costs to execute; it is not, and never was, the planner's bill.
  assert.notEqual(plan.actualCostUsd, plan.approxCostUsd);
});

test("an all-observe implementation plan is rejected and re-planned with mutation work", { skip: skipPlanner }, async () => {
  let n = 0;
  const plan = await runLeadPlanner(BRIEF(), leadDeps({
    callLeadModel: async (_brief, _allowed, correctiveNote) => {
      n += 1;
      if (n === 1) {
        return {
          repo: "o/r", branch: "harness/feat-x", riskLevel: "low", reviewChecklist: [],
          subTasks: [{
            seq: 1, title: "inspect", intent: "inspect only", filesLikelyTouched: [],
            successCriteria: ["report"], estimatedTokens: 10, taskMode: "observe", verify: [],
          }],
          costUsd: 2,
        };
      }
      assert.match(correctiveNote, /at least one taskMode:'mutate'/);
      return PLAN_REPLY(3);
    },
  }));
  assert.equal(n, 2);
  assert.equal(plan.subTasks[0].taskMode, "mutate");
  assert.equal(plan.actualCostUsd, 5, "the rejected planning attempt is still billed");
});

test("rc1: mandatory repository conventions reach planning and require acknowledgement", { skip: skipPlanner }, async () => {
  let calls = 0;
  let briefSeen;
  const source = ".cursor/rules/help-section-updates.mdc";
  const plan = await runLeadPlanner(BRIEF(), leadDeps({
    config: {
      repos: { allowed: ["o/*"], default_base_branch: "main" },
      loop: { lead_repo_scout_enabled: false },
      brief: { ingest_repo_conventions: true, convention_char_budget: 10000 },
      models: { lead: "l" },
      budgets: {},
    },
    scoutRepo: async ({ runModel }) => {
      assert.equal(runModel, false, "convention loading must not require a billed scout turn");
      return {
        report: "",
        conventions: [{ source, text: "---\nalwaysApply: true\n---\nUpdate src/lib/help/help-content.ts when portal behavior changes." }],
      };
    },
    callLeadModel: async (brief, _allowed, correctiveNote) => {
      calls += 1;
      briefSeen = brief;
      const reply = PLAN_REPLY(0.1);
      if (calls === 2) {
        reply.acknowledgedConventions = [source];
        reply.reviewChecklist = ["Verify the mandatory help-section update convention"];
      }
      if (calls === 2) assert.match(correctiveNote, /INVALID CONVENTION COVERAGE/);
      return reply;
    },
  }));
  assert.equal(calls, 2, "an unacknowledged mandatory rule is re-planned once");
  assert.equal(briefSeen.repoConventions[0].source, source);
  assert.deepEqual(plan.acknowledgedConventions, [source]);
});

test("a plan the planner threw away was still paid for", { skip: skipPlanner }, async () => {
  // The b67 workerContext re-ask can double the planning bill. Reading the cost
  // off the winning attempt would bill for one call and charge for two.
  let n = 0;
  const plan = await runLeadPlanner(BRIEF(), leadDeps({
    config: {
      repos: { allowed: ["o/*"], default_base_branch: "main" },
      loop: { lead_repo_scout_enabled: false, lead_require_worker_context: true },
      models: { lead: "l" }, budgets: {},
    },
    callLeadModel: async () => {
      n += 1;
      // First reply omits workerContext on a mutate sub-task, forcing the re-ask.
      return n === 1
        ? {
            ...PLAN_REPLY(2),
            subTasks: [{
              seq: 1, title: "t", intent: "i", filesLikelyTouched: ["src/a.ts"],
              successCriteria: ["s"], estimatedTokens: 10, taskMode: "mutate",
              verify: [{ kind: "commit_made" }],
            }],
          }
        : PLAN_REPLY(1.25);
    },
  }));
  if (n > 1) {
    assert.equal(plan.actualCostUsd, 3.25, "both attempts, not just the one that worked");
  } else {
    // Enforcement is off in this build; the single call must still be billed.
    assert.equal(plan.actualCostUsd, 2);
  }
});

test("a planner reply with no cost does not poison the total", { skip: skipPlanner }, async () => {
  const plan = await runLeadPlanner(BRIEF(), leadDeps({ callLeadModel: async () => PLAN_REPLY(undefined) }));
  assert.equal(plan.actualCostUsd, 0);
  assert.equal(Number.isFinite(plan.actualCostUsd), true);
});

