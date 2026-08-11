/**
 * beta.119 — three defects the b118 smoke and the CI-optimisation run exposed.
 *
 * FIX 3 (cycle ceiling). The b118 smoke went 16 -> 8 -> 9 findings and stopped
 * dead on `max_cycles: 3`, having spent $12.90 of a $30 budget. b97 already
 * detected that arc; all it did was write the operator a note asking them to
 * run `harness_revise` by hand -- the same cycle the harness could have run
 * itself while the worktree was still warm. Four blocking findings its own
 * report called "small and mechanical" shipped unfixed.
 *
 * FIX 4 (push failure destroys the work). The CI-optimisation run made a
 * correct one-line `.github/workflows/ci.yml` change and died at the push with
 * "refusing to allow an OAuth App to create or update workflow ... without
 * `workflow` scope". The loop routed that to `finaliseFailed`, which releases
 * the worktree -- deleting the only copy of the commit.
 *
 * FIX 5 (ask first). That answer was available before the first worker ran:
 * the plan named the file, and GitHub reports token scopes on any response
 * header.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let OrchestratorLoop, isConvergingBlockingTrend, isConvergingFindingTrend;
let diagnosePushFailure, describePreservedPushFailure;
let isWorkflowPath, planTouchesWorkflows, canPushWorkflows, describeMissingWorkflowScope;
try {
  ({ OrchestratorLoop, isConvergingBlockingTrend, isConvergingFindingTrend } = await import("../dist/orchestrator/loop.js"));
  ({ diagnosePushFailure, describePreservedPushFailure } = await import("../dist/orchestrator/push-failure.js"));
  ({ isWorkflowPath, planTouchesWorkflows, canPushWorkflows, describeMissingWorkflowScope } =
    await import("../dist/orchestrator/workflow-scope.js"));
} catch {
  OrchestratorLoop = null;
}
const skip = { skip: OrchestratorLoop === null };

// ---------------------------------------------------------------------------
// FIX 3: the cycle ceiling extends on a converging trend, and only then.
// ---------------------------------------------------------------------------

const reviewing = (over = {}) => ({
  currentStatus: "reviewing",
  verdict: "revise",
  blockingFindings: 4,
  shipWhenNoBlockingFindings: true,
  cyclesRan: 3,
  maxCycles: 3,
  // The real b118 arcs. Totals rose 8 -> 9 on the last cycle, because the
  // adversary emits `info` notes recording prior fixes; the BLOCKING counts
  // (1 high + 8 medium, then 5 medium, then 4 medium) fell the whole way.
  findingCountsByCycle: [16, 8, 9],
  blockingCountsByCycle: [9, 5, 4],
  reactions: { shipIt: false, abort: false, pause: false },
  budgetExhausted: false,
  hardTimeout: false,
  cycleExtensionsGranted: 0,
  maxCycleExtensions: 1,
  budgetHeadroomOk: true,
  ...over,
});

test("b118 REGRESSION: a converging run with budget left gets another cycle", skip, () => {
  const d = OrchestratorLoop.advance(reviewing());
  assert.equal(d.nextStatus, "executing");
  assert.equal(d.reason, "max_cycles_extended_converging");
});

test("the extension is decided on BLOCKING findings, not the noisy total", skip, () => {
  // Totals falling while blocking findings hold flat is not progress worth
  // buying: the run is closing `info` notes, not defects.
  const d = OrchestratorLoop.advance(reviewing({
    findingCountsByCycle: [20, 12, 6],
    blockingCountsByCycle: [4, 4, 4],
  }));
  assert.equal(d.nextStatus, "done");
});

test("the extension is granted at most `maxCycleExtensions` times", skip, () => {
  const d = OrchestratorLoop.advance(reviewing({ cyclesRan: 4, cycleExtensionsGranted: 1 }));
  assert.equal(d.nextStatus, "done");
  assert.equal(d.reason, "shipped_max_cycles_revise_converging");
});

test("the granted extension is actually SPENT, not re-offered every cycle", skip, () => {
  // The cycle the extension bought: cyclesRan has caught up with maxCycles but
  // the granted extension raises the ceiling, so this is an ordinary revise
  // cycle and must not re-enter the ceiling branch at all. If the ceiling
  // ignored the grant, the run would loop here forever re-granting the same
  // extension it never gets to use.
  const d = OrchestratorLoop.advance(reviewing({ cyclesRan: 3, cycleExtensionsGranted: 1 }));
  assert.equal(d.nextStatus, "executing");
  assert.equal(d.reason, "adversary_revise");
});

test("no extension without budget headroom", skip, () => {
  const d = OrchestratorLoop.advance(reviewing({ budgetHeadroomOk: false }));
  assert.equal(d.nextStatus, "done");
});

test("no extension for a STUCK run (blocking findings flat)", skip, () => {
  const d = OrchestratorLoop.advance(reviewing({ blockingCountsByCycle: [5, 5, 5] }));
  assert.equal(d.nextStatus, "done");
});

test("no extension when the LAST cycle went backwards", skip, () => {
  // b96's PR #893 shape: real early progress, then a regression. b97's advisory
  // predicate calls 13 -> 8 -> 12 converging on purpose; that is a fine thing
  // to say in a note and a bad thing to spend a cycle on.
  const d = OrchestratorLoop.advance(reviewing({ blockingCountsByCycle: [13, 8, 12] }));
  assert.equal(d.nextStatus, "done");
  assert.equal(d.reason, "shipped_max_cycles_revise_converging");
});

test("max_cycle_extensions: 0 restores the pre-b119 hard ceiling", skip, () => {
  const d = OrchestratorLoop.advance(reviewing({ maxCycleExtensions: 0 }));
  assert.equal(d.nextStatus, "done");
  assert.equal(d.reason, "shipped_max_cycles_revise_converging");
});

test("an extension never overrides abort, budget exhaustion or hard timeout", skip, () => {
  assert.equal(OrchestratorLoop.advance(reviewing({ budgetExhausted: true })).nextStatus, "aborted");
  assert.equal(OrchestratorLoop.advance(reviewing({ hardTimeout: true })).nextStatus, "aborted");
  assert.equal(
    OrchestratorLoop.advance(reviewing({ reactions: { shipIt: false, abort: true, pause: false } })).nextStatus,
    "aborted",
  );
});

test("a `block` verdict is never extended", skip, () => {
  const d = OrchestratorLoop.advance(reviewing({ verdict: "block" }));
  assert.equal(d.nextStatus, "failed");
});

test("callers that pass no extension fields behave exactly as pre-b119", skip, () => {
  const base = reviewing();
  delete base.cycleExtensionsGranted;
  delete base.maxCycleExtensions;
  delete base.budgetHeadroomOk;
  delete base.blockingCountsByCycle;
  const d = OrchestratorLoop.advance(base);
  assert.equal(d.nextStatus, "done", "an unwired caller must not silently gain extensions");
});

test("isConvergingBlockingTrend is stricter than the b97 advisory predicate", skip, () => {
  assert.equal(isConvergingBlockingTrend([9, 5, 4]), true, "the real b118 blocking arc");
  assert.equal(isConvergingBlockingTrend([13, 8, 12]), false, "a late regression is not worth buying");
  assert.equal(isConvergingBlockingTrend([5, 5, 5]), false, "flat is stuck");
  assert.equal(isConvergingBlockingTrend([4, 6]), false, "rising is worse than stuck");
  assert.equal(isConvergingBlockingTrend([9, 5, 0]), false, "nothing blocking -> the run ships anyway");
  assert.equal(isConvergingBlockingTrend([4]), false, "one cycle is not a trend");
  assert.equal(isConvergingBlockingTrend([]), false);
  assert.equal(isConvergingBlockingTrend(undefined), false);
  // b97's looser predicate disagrees on the regression case, by design.
  assert.equal(isConvergingFindingTrend([13, 8, 12]), true);
});

test("the loop counts grants and audits the extension", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /cycleExtensionsGranted \+= 1;/);
  assert.match(src, /"loop\.max_cycles_extended"/);
  assert.match(src, /hasBudgetHeadroomForAnotherCycle\(row\.requester, totalCost, cycle\)/);
  assert.match(src, /blockingCountsByCycle\.push\(blockingFindings\)/);
});

test("budget headroom is measured from this run's own per-cycle spend", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("private hasBudgetHeadroomForAnotherCycle");
  assert.ok(i > 0);
  const body = src.slice(i, i + 1400);
  assert.match(body, /spentUsd \/ cyclesRan/, "must project from real spend, not a guess");
  assert.match(body, /session_hard_ceiling_usd/);
  assert.match(body, /dailyMaxUsd\(\)/, "the daily cap can be the binding constraint");
  assert.match(body, /return false/, "must fail closed");
});

// ---------------------------------------------------------------------------
// FIX 4: a failed push preserves the work.
// ---------------------------------------------------------------------------

const WORKFLOW_SCOPE_ERROR =
  "! [remote rejected] HEAD -> harness/ci-build-parallel (refusing to allow an OAuth App to " +
  "create or update workflow `.github/workflows/ci.yml` without `workflow` scope)";

test("b119 REGRESSION: the real workflow-scope push error is classified", skip, () => {
  const d = diagnosePushFailure(new Error(WORKFLOW_SCOPE_ERROR));
  assert.equal(d.kind, "missing_workflow_scope");
  assert.equal(d.recoverable, true);
  assert.match(d.remedy, /workflow` scope/);
});

test("push failures are classified into actionable kinds", skip, () => {
  const cases = [
    ["fatal: Authentication failed for 'https://github.com/o/r'", "auth"],
    ["remote: error: GH006: Protected branch update failed", "protected_branch"],
    ["! [rejected] main -> main (non-fast-forward)", "non_fast_forward"],
    ["fatal: unable to access '...': Could not resolve host: github.com", "network"],
    ["something nobody has seen before", "unknown"],
  ];
  for (const [msg, kind] of cases) {
    assert.equal(diagnosePushFailure(new Error(msg)).kind, kind, msg);
  }
});

test("even an UNKNOWN push failure is treated as recoverable", skip, () => {
  // The commits are on disk either way; deleting them to reclaim a worktree is
  // never the right trade.
  assert.equal(diagnosePushFailure(new Error("???")).recoverable, true);
  assert.equal(diagnosePushFailure(undefined).recoverable, true);
});

test("the preserved-work message names the branch, the worktree and the command", skip, () => {
  const out = describePreservedPushFailure({
    diagnosis: diagnosePushFailure(new Error(WORKFLOW_SCOPE_ERROR)),
    branch: "harness/ci-build-parallel",
    worktreePath: "/tmp/wt/abc",
    error: WORKFLOW_SCOPE_ERROR,
  });
  assert.match(out, /Your work is NOT lost/);
  assert.match(out, /harness\/ci-build-parallel/);
  assert.match(out, /\/tmp\/wt\/abc/);
  assert.match(out, /git push -u origin harness\/ci-build-parallel/);
});

test("the PR-open failure path preserves the worktree instead of releasing it", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf('"loop.pr_open_failed"');
  assert.ok(i > 0);
  // The catch block must end in the PRESERVING finaliser, not the releasing one.
  const block = src.slice(i, i + 1600);
  assert.match(block, /finaliseFailedPreserveWorktree\(/);
  assert.doesNotMatch(block, /return this\.finaliseFailed\(/);
  assert.match(block, /worktreePreserved: true/);
});

// ---------------------------------------------------------------------------
// FIX 5: find out before doing the work.
// ---------------------------------------------------------------------------

test("workflow paths are recognised", skip, () => {
  assert.ok(isWorkflowPath(".github/workflows/ci.yml"));
  assert.ok(isWorkflowPath("./.github/workflows/release.yaml"));
  assert.ok(!isWorkflowPath("src/app/page.tsx"));
  assert.ok(!isWorkflowPath(".github/dependabot.yml"), "only workflows/ needs the scope");
  assert.ok(!isWorkflowPath(".github/workflows/README.md"));
});

test("planTouchesWorkflows finds the file the CI-optimisation run planned", skip, () => {
  const plan = [
    { seq: 1, filesLikelyTouched: ["src/lib/x.ts"] },
    { seq: 2, filesLikelyTouched: [".github/workflows/ci.yml"] },
  ];
  assert.deepEqual(planTouchesWorkflows(plan), [".github/workflows/ci.yml"]);
  assert.deepEqual(planTouchesWorkflows([{ seq: 1, filesLikelyTouched: ["src/a.ts"] }]), []);
  assert.deepEqual(planTouchesWorkflows([{ seq: 1 }]), []);
});

test("a token WITH the workflow scope can push", skip, () => {
  assert.equal(canPushWorkflows(["repo", "workflow", "read:org"]), true);
});

test("a classic token WITHOUT the workflow scope cannot", skip, () => {
  assert.equal(canPushWorkflows(["repo", "read:org"]), false);
});

test("an absent scope header is UNKNOWN, never a refusal", skip, () => {
  // Fine-grained PATs and GitHub App installation tokens report no scopes and
  // are perfectly capable. Treating that as "cannot push" would block every
  // such deployment from ever editing CI.
  assert.equal(canPushWorkflows(null), null);
  assert.equal(canPushWorkflows([]), null);
  assert.equal(canPushWorkflows(undefined), null);
});

test("the missing-scope message offers the web-editor route the operator used", skip, () => {
  const out = describeMissingWorkflowScope([".github/workflows/ci.yml"]);
  assert.match(out, /BEFORE running any sub-task/);
  assert.match(out, /web editor/);
  assert.match(out, /Repository permissions -> Workflows/);
});

test("the pre-check runs before any sub-task and only a definite false stops the run", () => {
  const src = S("src/orchestrator/loop.ts");
  const check = src.indexOf("loop.workflow_scope_precheck");
  const firstCycle = src.indexOf("let cycle = 0;");
  assert.ok(check > 0 && firstCycle > check, "the check must precede the execute loop");
  assert.match(src.slice(check, check + 900), /if \(verdict === false\)/,
    "null (unknown scopes) must not stop the run");
});

test("getTokenScopes reads the header and never throws", () => {
  const src = S("src/adapters/github.ts");
  assert.match(src, /x-oauth-scopes/);
  const i = src.indexOf("export async function getTokenScopes");
  const body = src.slice(i, i + src.slice(i).indexOf("\n}\n"));
  assert.match(body, /catch \{\s*return null;/, "an unreadable scope list is unknown, not empty");
});

test("the scope check is wired in production", () => {
  const src = S("src/index.ts");
  assert.match(src, /tokenScopes: async \(\{ repoFullName, requester \}\)/);
  assert.match(src, /canPushWorkflows\(await getTokenScopes\(/);
});
