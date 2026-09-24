/**
 * beta.34: post-ship merge recommendation derivation (pure function).
 *
 * A clean adversary pass with no blocking findings and exact-head green CI is
 * the only mergeable result. Missing, pending, or unregistered CI fails shut.
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
    assert.match(r.reason, /Final adversary pass/i);
    assert.match(r.reason, /CI is green/i);
  });

test("DO-NOT-MERGE when required CI is not configured",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass(), reachedCleanPass: true, ciStatus: "none" });
    assert.equal(r.recommendation, "do_not_merge");
  });

test("DO-NOT-MERGE when no review exists",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: undefined, reachedCleanPass: false });
    assert.equal(r.recommendation, "do_not_merge");
    assert.match(r.reason, /No completed adversary review/i);
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
    assert.match(r.reason, /clean final pass/i);
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
      assert.match(r.reason, /blocking finding\(s\)/i);
    }
  });

test("DO-NOT-MERGE when CI is failing even on a clean pass",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass(), reachedCleanPass: true, ciStatus: "failure" });
    assert.equal(r.recommendation, "do_not_merge");
    assert.match(r.reason, /not green/i);
  });

test("DO-NOT-MERGE while CI is still pending",
  { skip: deriveMergeRecommendation === null }, () => {
    const r = deriveMergeRecommendation({ review: pass(), reachedCleanPass: true, ciStatus: "pending" });
    assert.equal(r.recommendation, "do_not_merge");
    assert.match(r.reason, /pending, not green/i);
  });
