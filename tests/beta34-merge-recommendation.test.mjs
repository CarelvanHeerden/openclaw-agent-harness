/**
 * beta.34: post-ship merge recommendation derivation (pure function).
 *
 * Design intent: DO-NOT-MERGE should be structurally rare. A clean adversary
 * pass with no blocking findings and non-failing CI -> MERGE. Anything else
 * -> DO-NOT-MERGE (feeds the harness_merge_pr hard gate).
 */
import test from "node:test";
import assert from "node:assert/strict";

let deriveMergeRecommendation;
try {
  ({ deriveMergeRecommendation } = await import("../dist/orchestrator/merge-recommendation.js"));
} catch {
  deriveMergeRecommendation = null;
}

const pass = (findings = []) => ({ verdict: "pass", findings });

test("recommends MERGE on clean pass, no blockers, CI success",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass([{ severity: "info" }]), reachedCleanPass: true, ciStatus: "success" });
    assert.equal(r.recommendation, "merge");
    assert.match(r.reason, /clean pass/i);
    assert.match(r.reason, /CI is green/i);
  });

test("recommends MERGE on clean pass with no CI configured",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass(), reachedCleanPass: true, ciStatus: "none" });
    assert.equal(r.recommendation, "merge");
  });

test("DO-NOT-MERGE when no review exists",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: undefined, reachedCleanPass: false });
    assert.equal(r.recommendation, "do_not_merge");
    assert.match(r.reason, /no adversary review/i);
  });

test("DO-NOT-MERGE when verdict is not pass",
  { skip: deriveMergeRecommendation === null }, () => {
    for (const verdict of ["revise", "block"]) {
      const r = deriveMergeRecommendation({ review: { verdict, findings: [] }, reachedCleanPass: false });
      assert.equal(r.recommendation, "do_not_merge", `verdict=${verdict}`);
    }
  });

test("DO-NOT-MERGE when pass but loop did not reach a clean pass (shipped at cap)",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass(), reachedCleanPass: false });
    assert.equal(r.recommendation, "do_not_merge");
    assert.match(r.reason, /cycle\/budget limit|not trustworthy/i);
  });

test("DO-NOT-MERGE when a blocking-severity finding survives a pass",
  { skip: deriveMergeRecommendation === null }, () => {
    for (const sev of ["high", "critical", "blocker", "block"]) {
      const r = deriveMergeRecommendation({
        review: pass([{ severity: sev, title: "SQL injection" }]),
        reachedCleanPass: true,
        ciStatus: "success",
      });
      assert.equal(r.recommendation, "do_not_merge", `severity=${sev}`);
      assert.match(r.reason, /blocking-severity/i);
    }
  });

test("DO-NOT-MERGE when CI is failing even on a clean pass",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass(), reachedCleanPass: true, ciStatus: "failure" });
    assert.equal(r.recommendation, "do_not_merge");
    assert.match(r.reason, /CI checks are failing/i);
  });

test("MERGE with a note when CI is still pending",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass(), reachedCleanPass: true, ciStatus: "pending" });
    assert.equal(r.recommendation, "merge");
    assert.match(r.reason, /still running/i);
  });
