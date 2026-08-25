// beta.128 (#157, second half) — the bill for a plan that never arrived.
//
// b127 credited the planner at `loop.plan_ready`. Session f75f7db6 never got
// there: two Opus calls, ten minutes of wall clock, and a run that finalised
// `failed | cycles 0 | cost $0.00`. The operator reading that line has no way
// to know a re-run is not free.
//
// Reviewing it turned up a second omission in the same fix. b127 folded the
// lead into the in-memory `totalCost` -- which corrected the affordability
// arithmetic, the thing #157 was filed about -- but never wrote it to
// `sessions.cost_usd`. So every report that reads the ROW (the smoke script,
// `harness status`, the monthly rollup) still billed the most expensive model
// in the run at zero, even on runs that succeeded.
//
// Both paths are covered here: the plan that died, and the plan that landed.
import test from "node:test";
import assert from "node:assert/strict";
import { runScenario, scenarioAvailable, makeConfig, mutateSubTask } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

/** The error a planner throws once runLeadPlanner has attached its spend. */
function planFailure(costUsd) {
  const err = new Error(
    "[lead] JSON.parse failed: SyntaxError: Unexpected token 'u', ...\"seq_note\":undefined}... is not valid JSON",
  );
  err.costUsd = costUsd;
  return err;
}

test("a plan that FAILED is still billed to the session", { skip }, async () => {
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    runLead: async () => {
      throw planFailure(1.6);
    },
  });
  assert.equal(r.out.status, "failed");
  const row = r.session();
  assert.ok(
    Math.abs(row.cost_usd - 1.6) < 1e-9,
    `the row an operator reads must show the spend; got ${row.cost_usd}`,
  );
  assert.ok(r.out.totalCostUsd >= 1.6, "and so must the outcome the caller gets back");
});

test("the failed plan's cost is auditable on its own", { skip }, async () => {
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    runLead: async () => {
      throw planFailure(0.75);
    },
  });
  const ev = r.events("loop.plan_failed_cost").at(-1);
  assert.ok(ev, "the smoke report reads this to tell $0.00-because-free from $0.00-because-lost");
  assert.equal(ev.payload.costUsd, 0.75);
});

test("a planner that failed before spending anything records nothing", { skip }, async () => {
  // A wedge that never reached the model is genuinely free. Writing a zero-cost
  // row would be noise, and an audit event claiming spend would be a lie.
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    runLead: async () => {
      throw new Error("[stream_open_timeout] the subprocess never got going");
    },
  });
  assert.equal(r.out.status, "failed");
  assert.equal(r.events("loop.plan_failed_cost").length, 0);
  const row = r.session();
  assert.equal(row.cost_usd, 0);
});

test("a SUCCESSFUL plan's cost reaches the session row, not just the total", { skip }, async () => {
  // The half of #157 that b127 missed. `out.totalCostUsd` was already right;
  // the row every report actually reads was not.
  const r = await runScenario({
    config: makeConfig({ loop: { max_cycles: 1 } }),
    subTasks: [mutateSubTask({ seq: 1, path: "src/a.ts" })],
    leadCostUsd: 3,
  });
  const row = r.session();
  assert.ok(
    row.cost_usd >= 3,
    `the lead's 3.00 must be in sessions.cost_usd, which held only workers and reviews; got ${row.cost_usd}`,
  );
});

// ---------------------------------------------------------------------------
// The loop can only bank what the planner hands it. These drive the planner.
// ---------------------------------------------------------------------------

let runLeadPlanner;
try {
  ({ runLeadPlanner } = await import("../dist/orchestrator/lead.js"));
} catch {
  runLeadPlanner = null;
}
const skipPlanner = runLeadPlanner === null ? "dist/ not built" : false;

const BRIEF = () => ({
  title: "continuity exercises",
  motivation: "m",
  acceptanceCriteria: ["ship it"],
  filesLikelyTouched: [],
  outOfScope: [],
  riskLevel: "low",
  repoHint: "o/r",
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
    estimateCost: () => 0,
    ...over,
  };
}

test("the planner carries its spend out on the throw", { skip: skipPlanner }, async () => {
  const err = await runLeadPlanner(
    BRIEF(),
    leadDeps({
      callLeadModel: async () => {
        throw planFailure(0.9);
      },
    }),
  ).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "the plan must still fail");
  assert.equal(err.costUsd, 0.9, "without this the loop has nothing to bank");
});

test("the scout is billed even when planning dies after it", { skip: skipPlanner }, async () => {
  // The scout runs first and costs money whatever the lead does next. Asserted
  // as an exact total on purpose: the failing call already carries its own
  // 0.6, so a test that only checks `>= 0.6` passes even if the planner adds
  // nothing at all -- which is what the throw did before b128.
  const err = await runLeadPlanner(
    BRIEF(),
    leadDeps({
      config: {
        repos: { allowed: ["o/*"], default_base_branch: "main" },
        loop: { lead_repo_scout_enabled: true },
        models: { lead: "l" },
        budgets: {},
      },
      scoutRepo: async () => ({ report: "some findings", costUsd: 0.4 }),
      callLeadModel: async () => {
        throw planFailure(0.6);
      },
    }),
  ).then(
    () => null,
    (e) => e,
  );
  assert.ok(err);
  assert.ok(
    Math.abs(err.costUsd - 1) < 1e-9,
    `the scout's 0.4 and the lead's 0.6 both have to be on the error; got ${err.costUsd}`,
  );
});
