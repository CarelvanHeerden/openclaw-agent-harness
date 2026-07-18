/**
 * beta.35: revise-loop fixes.
 *
 * Root cause (from the beta.34 taxonomy smoke, session ea881f25): a `revise`
 * cycle re-runs the plan's mutate sub-task against base = the worker's current
 * HEAD. When the fix is already correct, the worker makes no new commit, the
 * `commit_made` contract failed (HEAD == base), and the whole session died.
 * And even if that sub-task passed, the adversary structurally could not reach
 * `pass` on a UI change with no in-loop preview deploy, so the loop exhausted
 * cycles and failed anyway.
 *
 * Fixes:
 *   #1+#2: a revise-cycle no-op (worker made no change) is legal -> the
 *          sub-task is marked completed_no_change instead of failing.
 *   #3:    cycles exhausted on a `revise` (not `block`) verdict SHIPS the PR
 *          with an honest annotation, do_not_merge recommendation (human
 *          approves). `block` still fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loopSrc = readFileSync(resolve(repoRoot, "src/orchestrator/loop.ts"), "utf8");
const indexSrc = readFileSync(resolve(repoRoot, "src/index.ts"), "utf8");

let OrchestratorLoop = null;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
} catch {
  OrchestratorLoop = null;
}
const base = {
  currentStatus: "reviewing",
  verdict: undefined,
  cyclesRan: 0,
  maxCycles: 3,
  reactions: { shipIt: false, abort: false, pause: false },
  budgetExhausted: false,
  hardTimeout: false,
};

test("#3: advance ships (done) on revise at last cycle",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, verdict: "revise", cyclesRan: 2, maxCycles: 3 });
    assert.equal(r.nextStatus, "done");
    assert.equal(r.reason, "shipped_max_cycles_revise");
  });

test("#3: advance still fails on block at last cycle (ships nothing)",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, verdict: "block", cyclesRan: 2, maxCycles: 3 });
    assert.equal(r.nextStatus, "failed");
    assert.equal(r.reason, "adversary_block");
  });

test("#3: advance still loops back to executing on revise while cycles remain",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, verdict: "revise", cyclesRan: 1, maxCycles: 3 });
    assert.equal(r.nextStatus, "executing");
    assert.equal(r.reason, "adversary_revise");
  });

test("#1+#2: loop source accepts a revise-cycle no-op as completed_no_change", () => {
  // Guard the exact conditions so a refactor can't silently re-break it:
  // only on cycle > 1, only when every failing check is a no-change kind,
  // and only when the worker itself reported no commit.
  assert.match(loopSrc, /completed_no_change/, "must have a completed_no_change status path");
  assert.match(loopSrc, /loop\.subtask_revise_no_change/, "must emit the revise-no-op audit event");
  assert.match(loopSrc, /NO_CHANGE_KINDS/, "must scope the no-op to no-change verify kinds");
  assert.match(loopSrc, /cycle > 1 && onlyNoChangeFailures && workerMadeNoCommit/, "must gate on revise cycle + only-no-change failures + no worker commit");
});

test("#1+#2: the no-op path does NOT weaken confabulation detection", () => {
  // A push/PR/file claim that didn't happen must still hard-fail: the
  // no-change set must be exactly commit/file-committed/file-written.
  const m = loopSrc.match(/NO_CHANGE_KINDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "NO_CHANGE_KINDS set must exist");
  const kinds = m[1];
  for (const allowed of ["commit_made", "file_committed", "file_written"]) {
    assert.match(kinds, new RegExp(`"${allowed}"`), `no-change set should include ${allowed}`);
  }
  for (const forbidden of ["branch_pushed", "pr_opened", "remote_branch_exists", "file_pushed", "pr_state", "file_in_pr"]) {
    assert.ok(!kinds.includes(`"${forbidden}"`), `no-change set must NOT include ${forbidden} (that's a real confabulation)`);
  }
});

test("#3: renderPrBody annotates a non-pass ship + points at deploy verification", () => {
  assert.match(indexSrc, /shippedWithoutCleanPass/, "renderPrBody must detect a non-pass ship");
  assert.match(indexSrc, /Shipped without a clean adversary pass/, "PR body must carry the honest annotation");
  assert.match(indexSrc, /Runtime not verified in-loop/, "PR body must flag unverified runtime");
  assert.match(indexSrc, /harness_merge_pr/, "PR body must point at the merge-time deploy verification");
});
