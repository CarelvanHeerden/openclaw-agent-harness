/**
 * rc.3 -- severity is read in one place, and an unreadable one blocks.
 *
 * Raised by the external review (§3). `isBlockingFinding` compared severity
 * with `===` while every other consumer in the harness had independently
 * written `(f.severity ?? "").toLowerCase()`. The one that did not was the one
 * that decides whether a finding can stop a ship:
 *
 *   "Medium" !== "medium"  ->  finding not blocking
 *                          ->  gateVerdict downgrades revise to pass
 *                          ->  reachedCleanPass = true
 *                          ->  PR is auto-mergeable
 *
 * The parse boundary made it worse: `severity: f.severity ?? "low"` in
 * index.ts turned a MISSING severity into a non-blocking one. The adversary's
 * JSON is not schema-checked (runAdversarySdk requires only that `verdict`,
 * `findings` and `summary` exist, with `findings: unknown[]`), so both of these
 * are things a normal run produces, not crafted attacks.
 *
 * The two tests the reviewer asked for by name are `REVIEWER CASE 1` and
 * `REVIEWER CASE 2` below.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyFinding,
  gateVerdict,
  isAtLeastMedium,
  isBlockingFinding,
  normaliseSeverity,
} from "../dist/orchestrator/finding-classify.js";
import { deriveMergeRecommendation } from "../dist/orchestrator/merge-recommendation.js";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const CTX = { repoHasTestScript: false, runtimeUnavailable: false };

/** The gate as the loop applies it: a downgraded pass IS a clean pass. */
const reachesCleanPass = (findings, verdict = "revise") =>
  gateVerdict({ verdict, findings, ctx: CTX }).verdict === "pass";

/* ------------------------------------------------------------------ *
 * The two cases the reviewer specified
 * ------------------------------------------------------------------ */

test("REVIEWER CASE 1: {severity:'Medium'} does NOT produce a clean pass", () => {
  const finding = {
    severity: "Medium",
    dimension: "quality",
    title: "Session recovery races two claimants onto one worktree",
    detail: "Two concurrent resumes can both pass the liveness check and claim the same worktree.",
  };

  assert.equal(normaliseSeverity(finding.severity), "medium");
  assert.equal(isBlockingFinding(finding, classifyFinding(finding, CTX)), true);
  assert.equal(
    reachesCleanPass([finding]),
    false,
    "a real defect reported as 'Medium' must not be downgraded to an auto-mergeable pass",
  );
});

test("REVIEWER CASE 2: a diff-addressable defect containing 'regenerate' does NOT produce a clean pass", () => {
  // The word alone used to demote to `process` via GENERATED_ARTIFACT_RE, which
  // exists for stale OKF bundles, not for prose that happens to use the verb.
  const finding = {
    severity: "medium",
    dimension: "security",
    title: "Session token is never rotated",
    detail:
      "The token issued at login is reused indefinitely, so a captured token replays forever. " +
      "Regenerate the token on each login and invalidate the previous one.",
  };

  assert.equal(
    classifyFinding(finding, CTX),
    "diff_addressable",
    "'regenerate' in the prose must not reclassify a genuine defect as process work",
  );
  assert.equal(reachesCleanPass([finding]), false);
});

/* ------------------------------------------------------------------ *
 * normaliseSeverity
 * ------------------------------------------------------------------ */

test("rc3: severity normalises case, whitespace and the synonyms models actually emit", () => {
  const expected = {
    medium: ["medium", "Medium", "MEDIUM", "  medium  ", "moderate", "med", "warning"],
    high: ["high", "High", "major", "severe"],
    critical: ["critical", "CRITICAL", "crit", "blocker", "fatal"],
    low: ["low", "Low", "minor"],
    info: ["info", "informational", "note", "nit"],
  };
  for (const [want, inputs] of Object.entries(expected)) {
    for (const raw of inputs) {
      assert.equal(normaliseSeverity(raw), want, `${JSON.stringify(raw)} should normalise to ${want}`);
    }
  }
});

test("rc3: an unreadable severity is 'unknown', and 'unknown' blocks", () => {
  for (const raw of [undefined, null, "", "   ", "spicy", 3, {}, []]) {
    assert.equal(normaliseSeverity(raw), "unknown", `${JSON.stringify(raw)} should be unknown`);
    assert.equal(isAtLeastMedium(raw), true, "an unreadable severity must fail toward review");
  }
  // info and low are still genuinely non-blocking -- "unknown blocks" must not
  // collapse into "everything blocks".
  assert.equal(isAtLeastMedium("info"), false);
  assert.equal(isAtLeastMedium("low"), false);
});

test("rc3: a finding with NO severity does not reach a clean pass", () => {
  const finding = {
    dimension: "quality",
    title: "Null dereference when findings is empty",
    detail: "The loop crashes before it can save the review.",
  };
  assert.equal(normaliseSeverity(finding.severity), "unknown");
  assert.equal(reachesCleanPass([finding]), false, "`?? \"low\"` at the parse boundary was the bug");
});

/* ------------------------------------------------------------------ *
 * One reading of severity, not six
 * ------------------------------------------------------------------ */

test("rc3: the parse boundary normalises instead of defaulting to low", () => {
  const src = S("src/index.ts");
  assert.match(src, /severity: normaliseSeverity\(f\.severity\)/);
  assert.doesNotMatch(src, /severity: f\.severity \?\? "low"/);
});

test("rc3: the ship gate and the merge tool agree on what blocks", () => {
  const finding = { severity: "Medium", dimension: "quality", title: "off-by-one in the cursor" };

  // The adversary gate.
  assert.equal(isBlockingFinding(finding, classifyFinding(finding, CTX)), true);

  // The merge recommendation.
  const rec = deriveMergeRecommendation({
    review: { verdict: "revise", findings: [finding] },
    blockingFindings: 1,
    reachedCleanPass: false,
    ciStatus: "success",
  });
  assert.equal(rec.recommendation, "do_not_merge");

  // harness_merge_pr's override gate, which used to count only high/critical so
  // a medium left the PR eligible for the Vercel override.
  //
  // rc.5: severity alone was only half the consolidation. This gate still did no
  // CLASSIFICATION, so it disagreed with the recommendation it was gating on --
  // the beta.115 typecheck finding is deliberately high and deliberately
  // non-blocking, and severity alone made it an unoverridable permanent refusal.
  // It now reads the same predicate the recommendation does.
  const src = S("src/index.ts");
  assert.match(src, /blocksMerge\(f, classifyFinding\(f, \{ repoHasTestScript: true \}\)\)/);
  assert.doesNotMatch(
    src,
    /hasBlockingFinding = findings\.some\(\(f\) => isAtLeastMedium\(f\.severity\)\)/,
    "the merge gate must classify, not read raw severity",
  );
});

test("rc3: merge-recommendation reads severity through the shared helper", () => {
  const src = S("src/orchestrator/merge-recommendation.ts");
  assert.match(src, /import \{ isAtLeastMedium \} from "\.\/finding-classify\.js"/);
  assert.doesNotMatch(src, /AT_LEAST_MEDIUM\.has\(/);
});

/* ------------------------------------------------------------------ *
 * Keyword demotion is no longer a one-way ratchet
 * ------------------------------------------------------------------ */

test("rc3: security, high, critical and unreadable findings are not demoted by prose", () => {
  // Each of these carries a keyword that trips one of the demotion buckets.
  const tripwires = [
    { severity: "high", dimension: "quality", title: "Secret in plaintext", detail: "The infrastructure path writes it unencrypted." },
    { severity: "critical", dimension: "quality", title: "RCE in the upload handler", detail: "eslint: not found in this repo, so nothing caught it." },
    { severity: "medium", dimension: "security", title: "Auth bypass", detail: "There are no tests covering the admin route." },
    { dimension: "quality", title: "Data loss on merge-back", detail: "Requires a preview deploy to observe." },
  ];
  for (const f of tripwires) {
    assert.equal(
      classifyFinding(f, CTX),
      "diff_addressable",
      `${f.title} must not be demoted on a keyword`,
    );
    assert.equal(reachesCleanPass([f]), false);
  }
});

test("rc3: the demotions the buckets were built for still demote", () => {
  // These are the historical false positives (PR #870, forensic 1f2e6642) that
  // beta.69/70 added the buckets for. Fixing the ratchet must not reopen them.
  const stillDemoted = [
    ["process", { severity: "medium", dimension: "quality", title: "OKF bundle is stale", detail: "You did not regenerate the bundle; run npm run okf." }],
    ["env", { severity: "medium", dimension: "quality", title: "okf:check exited 127", detail: "eslint: not found" }],
    ["process", { severity: "medium", dimension: "quality", title: "No automated tests", detail: "Tests are not wired into any declared check script." }],
    ["architectural", { severity: "medium", dimension: "quality", title: "Response body too large", detail: "Exceeds the serverless function limit of 4.5mb." }],
  ];
  for (const [want, f] of stillDemoted) {
    assert.equal(classifyFinding(f, CTX), want, `${f.title} should still classify as ${want}`);
    assert.equal(isBlockingFinding(f, classifyFinding(f, CTX)), false);
  }
  assert.equal(reachesCleanPass(stillDemoted.map(([, f]) => f)), true, "the beta.69/70 convergence still works");
});

test("rc3: a CI finding is still undemotable, whatever its severity says", () => {
  const f = { source: "ci", severity: "Whatever", dimension: "quality", title: "jest failed", detail: "Cannot find module './x' -- regenerate?" };
  assert.equal(classifyFinding(f, CTX), "diff_addressable");
  assert.equal(reachesCleanPass([f]), false);
});

/* ------------------------------------------------------------------ *
 * A downgraded pass is visible as one
 * ------------------------------------------------------------------ */

test("rc3: a downgraded verdict is reported, warned about, and shown on the PR", () => {
  const g = gateVerdict({
    verdict: "revise",
    findings: [{ severity: "low", dimension: "quality", title: "naming nit" }],
    ctx: CTX,
  });
  assert.equal(g.verdict, "pass");
  assert.equal(g.downgraded, true);

  const adversary = S("src/orchestrator/fable5-adversary.ts");
  assert.match(adversary, /verdictDowngraded: gated\.downgraded/);
  assert.match(adversary, /logger\.warn\("\[adversary\] verdict downgraded/);

  const index = S("src/index.ts");
  assert.match(index, /verdictDowngraded\?: boolean/);
  assert.ok(index.includes("...downgradedAnnotation,"), "the annotation must be spread into the PR body");
  assert.ok(
    index.includes("was downgraded from"),
    "the PR body must distinguish a manufactured pass from an adversary pass",
  );
});
