/**
 * rc.5 -- the merge gate asks the same question the verdict gate does.
 *
 * ProjectThanos PR #1084, reported from production against rc.4:
 *
 *   lastVerdict: pass
 *   recommendation: do_not_merge
 *   reason: "The final review passed but carries 1 blocking finding(s) at
 *            medium severity or above: Preview deploy logs show 14 errors"
 *
 * The finding was a `runtime` one with no verified deploy behind it, which
 * `classifyFinding` files as `unproven_runtime` and the verdict gate correctly
 * ignored -- hence the `pass`. `countBlockingFindings` in the loop classified it
 * the same way and passed `blockingFindings: 0`.
 *
 * Step 4 of `deriveMergeRecommendation` then ignored that 0:
 *
 *   const blocking = findings.filter((f) => isAtLeastMedium(f.severity));
 *   const blockingCount = input.blockingFindings ?? blocking.length;   // 0
 *   if (blockingCount > 0 || blocking.length > 0)                      // fires
 *
 * The `??` already covered a caller that does not count, so the disjunction
 * added nothing but the power to override a caller that does -- and `Math.max`
 * then printed "1 blocking finding(s)" over the 0 it had been handed.
 *
 * Nothing could clear it. A revise cycle cannot produce runtime evidence, the
 * finding recurs every cycle, and `harness_merge_pr` hard-refuses on any
 * do_not_merge. The PR could only be merged by going around the harness.
 *
 * The tell was inside the same function: step 2b honours `blockingCount === 0`
 * and recommends merge. Two branches, one function, opposite answers about an
 * identical set of findings.
 *
 * rc.5 separates the two questions these gates were conflating:
 *   - isBlockingFinding -- is another worker cycle worth running?
 *   - blocksMerge       -- should a human look before this merges?
 * and makes `harness_merge_pr` read the second instead of raw severity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  blocksMerge,
  classifyFinding,
  gateVerdict,
  isBlockingFinding,
} from "../dist/orchestrator/finding-classify.js";
import { deriveMergeRecommendation } from "../dist/orchestrator/merge-recommendation.js";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const CTX = { repoHasTestScript: true, runtimeUnavailable: false };

/** The loop's two counters, applied exactly as loop.ts applies them. */
const cycleBlockers = (fs) => fs.filter((f) => isBlockingFinding(f, classifyFinding(f, CTX)));
const mergeBlockers = (fs) => fs.filter((f) => blocksMerge(f, classifyFinding(f, CTX)));

/** A recommendation derived the way the loop derives it, with both counts. */
const recommend = (verdict, findings, over = {}) => {
  const mb = mergeBlockers(findings);
  return deriveMergeRecommendation({
    review: { verdict, findings },
    blockingFindings: cycleBlockers(findings).length,
    mergeBlockingFindings: mb.length,
    mergeBlockingTitles: mb.map((f) => f.title || f.dimension || "(untitled)"),
    reachedCleanPass: verdict === "pass",
    ...over,
  });
};

/* ------------------------------------------------------------------ *
 * The reported case
 * ------------------------------------------------------------------ */

/** PR #1084's finding, as the adversary wrote it. */
const RUNTIME_1084 = {
  severity: "medium",
  dimension: "runtime",
  title: "Preview deploy logs show 14 errors",
  detail: "The preview deploy has not been verified at runtime; logs show 14 errors.",
};

test("PR #1084: the finding the verdict gate ignores does not block the merge", () => {
  // The premise: this is the class the verdict gate was built to wave through.
  assert.equal(classifyFinding(RUNTIME_1084, CTX), "unproven_runtime");
  assert.equal(isBlockingFinding(RUNTIME_1084, classifyFinding(RUNTIME_1084, CTX)), false);
  assert.equal(gateVerdict({ verdict: "revise", findings: [RUNTIME_1084], ctx: CTX }).verdict, "pass");

  // rc.4 shipped with this returning do_not_merge.
  const rec = recommend("pass", [RUNTIME_1084]);
  assert.equal(rec.recommendation, "merge", rec.reason);
  assert.doesNotMatch(rec.reason, /carries \d+ blocking finding/i);
});

test("PR #1084: the exact reason string production saw is no longer producible", () => {
  const rec = recommend("pass", [RUNTIME_1084]);
  assert.doesNotMatch(
    rec.reason,
    /carries 1 blocking finding\(s\) at medium severity or above/,
    "this is the string that appeared on #1084 alongside a passing verdict",
  );
});

test("a caller's classified zero is authoritative -- severity cannot override it", () => {
  // The regression guard for the deleted `|| blocking.length > 0`. The findings
  // are medium, so a severity-only filter finds two; the caller says none of
  // them block a merge, and the caller is the one that classified them.
  const rec = deriveMergeRecommendation({
    review: {
      verdict: "pass",
      findings: [
        { severity: "medium", dimension: "runtime", title: "no runtime data" },
        { severity: "high", dimension: "runtime", title: "no preview deploy" },
      ],
    },
    blockingFindings: 0,
    mergeBlockingFindings: 0,
    reachedCleanPass: true,
  });
  assert.equal(rec.recommendation, "merge", rec.reason);
});

test("the count in the reason is the count the caller gave, not a maximum of two", () => {
  // `Math.max(blockingCount, blocking.length)` is how a 0 was reported as a 1.
  const rec = deriveMergeRecommendation({
    review: {
      verdict: "pass",
      findings: [
        { severity: "medium", dimension: "quality", title: "real defect" },
        { severity: "medium", dimension: "runtime", title: "no preview deploy" },
      ],
    },
    blockingFindings: 1,
    mergeBlockingFindings: 1,
    mergeBlockingTitles: ["real defect"],
    reachedCleanPass: true,
  });
  assert.equal(rec.recommendation, "do_not_merge");
  assert.match(rec.reason, /carries 1 blocking finding/);
  assert.match(rec.reason, /real defect/);
  assert.doesNotMatch(rec.reason, /no preview deploy/, "a non-blocking finding must not be named as a blocker");
});

/* ------------------------------------------------------------------ *
 * The gate still gates
 * ------------------------------------------------------------------ */

test("a real unfixed defect still blocks the merge", () => {
  const defect = { severity: "medium", dimension: "quality", title: "off-by-one in the cursor" };
  assert.equal(classifyFinding(defect, CTX), "diff_addressable");
  const rec = recommend("pass", [defect]);
  assert.equal(rec.recommendation, "do_not_merge");
  assert.match(rec.reason, /off-by-one in the cursor/);
});

test("the harness saying it could not typecheck still blocks the merge", () => {
  // beta.115's finding, verbatim in shape: deliberately high, deliberately not
  // worth a cycle (no code change repairs a missing binary), and deliberately
  // required to stop a merge. The operator's proposed one-line fix -- gate on
  // isBlockingFinding alone -- would have started auto-merging past this.
  const gateFinding = {
    severity: "high",
    dimension: "runtime",
    source: "harness_env",
    title: "typecheck gate could not run",
    detail: "tsc: not found -- the typecheck gate could not run, so it cannot be fixed by changing code.",
  };
  assert.equal(classifyFinding(gateFinding, CTX), "env");
  assert.equal(isBlockingFinding(gateFinding, classifyFinding(gateFinding, CTX)), false, "not worth a cycle");
  assert.equal(blocksMerge(gateFinding, classifyFinding(gateFinding, CTX)), true, "but it must stop a merge");

  const rec = recommend("pass", [gateFinding]);
  assert.equal(rec.recommendation, "do_not_merge", rec.reason);
});

test("the two predicates answer different questions", () => {
  const env = { severity: "high", dimension: "runtime", source: "harness_env", title: "tsc: not found" };
  const defect = { severity: "medium", dimension: "quality", title: "off-by-one" };

  // env: stops a merge, does not buy a cycle.
  assert.equal(blocksMerge(env, classifyFinding(env, CTX)), true);
  assert.equal(isBlockingFinding(env, classifyFinding(env, CTX)), false);

  // a defect: both.
  assert.equal(blocksMerge(defect, classifyFinding(defect, CTX)), true);
  assert.equal(isBlockingFinding(defect, classifyFinding(defect, CTX)), true);
});

test("blocking a cycle implies blocking a merge, never the reverse", () => {
  // blocksMerge must stay a superset. If it ever narrowed below
  // isBlockingFinding, a finding worth another cycle could auto-merge.
  const severities = ["info", "low", "medium", "high", "critical", "Medium", "", undefined];
  const dimensions = ["spec", "fit", "quality", "security", "runtime"];
  for (const severity of severities) {
    for (const dimension of dimensions) {
      for (const title of ["off-by-one in the cursor", "no preview deploy", "eslint: not found", "no test script"]) {
        const f = { severity, dimension, title };
        const cls = classifyFinding(f, CTX);
        if (isBlockingFinding(f, cls)) {
          assert.equal(blocksMerge(f, cls), true, `cycle-blocking but not merge-blocking: ${dimension}/${severity}/${title}`);
        }
      }
    }
  }
});

test("a low-severity env aside does not block a merge", () => {
  // The medium floor applies to env too, or an adversary noting a missing
  // linter in passing becomes an unclearable gate.
  const aside = { severity: "low", dimension: "quality", title: "eslint: not found in the sandbox" };
  assert.equal(classifyFinding(aside, CTX), "env");
  assert.equal(blocksMerge(aside, classifyFinding(aside, CTX)), false);
  assert.equal(recommend("pass", [aside]).recommendation, "merge");
});

test("classes nobody can close do not gate the merge", () => {
  // All medium: rc.3's `isNonDemotable` deliberately stops a HIGH finding being
  // demoted on keywords, so a high one of these is diff_addressable by design
  // and does block. Medium is the band where the class decides.
  // `process` only exists as a class when the repo genuinely has no test script,
  // so each case carries the context that produces it.
  const cases = [
    ["unproven_runtime", { severity: "medium", dimension: "runtime", title: "no runtime data for this change" }, CTX],
    ["process", { severity: "medium", dimension: "quality", title: "there is no test script in this repo" }, { repoHasTestScript: false }],
    ["architectural", { severity: "medium", dimension: "fit", title: "response body too large for the serverless limit" }, CTX],
  ];
  for (const [expected, f, ctx] of cases) {
    const cls = classifyFinding(f, ctx);
    assert.equal(cls, expected, `precondition: ${expected}`);
    assert.equal(blocksMerge(f, cls), false, `${expected} must not gate a merge`);
  }
});

/* ------------------------------------------------------------------ *
 * The two branches of one function
 * ------------------------------------------------------------------ */

test("the pass and revise branches agree about an identical set of findings", () => {
  // Step 2b already honoured the classified count; step 4 did not. That
  // disagreement, inside one function, is what #1084 exposed.
  const findings = [RUNTIME_1084];
  const asRevise = recommend("revise", findings, { reachedCleanPass: false });
  const asPass = recommend("pass", findings, { reachedCleanPass: true });
  assert.equal(asRevise.recommendation, "merge", asRevise.reason);
  assert.equal(asPass.recommendation, "merge", asPass.reason);
});

test("a verdict the gate passes with no merge blockers is never do_not_merge", () => {
  // The invariant the two gates now share, over the shapes a run produces.
  const findings = [
    { severity: "medium", dimension: "runtime", title: "no preview deploy" },
    { severity: "low", dimension: "quality", title: "naming nit" },
    { severity: "info", dimension: "fit", title: "consider a helper" },
  ];
  assert.equal(gateVerdict({ verdict: "revise", findings, ctx: CTX }).verdict, "pass");
  assert.equal(mergeBlockers(findings).length, 0);
  assert.equal(recommend("pass", findings).recommendation, "merge");
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

test("the loop supplies the merge-blocking count it computed", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /mergeBlockingFindings\(findings: ReviewFinding\[\] \| undefined\)/, "the loop must count merge blockers");
  assert.match(src, /blocksMerge\(f, classifyFinding\(f, \{ repoHasTestScript: true \}\)\)/);
  // Anchored to the start of a line so a commented-out wiring fails here rather
  // than matching its own corpse.
  assert.match(src, /^\s*mergeBlockingFindings: mergeBlockers\.length,$/m, "and pass the count to the recommendation");
});

test("step 4 cannot fall back to raw severity when the caller has counted", () => {
  const src = S("src/orchestrator/merge-recommendation.ts");
  assert.doesNotMatch(
    src,
    /if \(blockingCount > 0 \|\| blocking\.length > 0\)/,
    "the disjunction that overrode the caller's classified count",
  );
  assert.doesNotMatch(src, /Math\.max\(blockingCount, blocking\.length\)/, "reporting a count the caller did not give");
  assert.match(src, /input\.mergeBlockingFindings \?\? input\.blockingFindings \?\? severityBlocking\.length/);
});

test("harness_merge_pr classifies rather than reading raw severity", () => {
  const src = S("src/index.ts");
  assert.match(src, /blocksMerge\(f, classifyFinding\(f, \{ repoHasTestScript: true \}\)\)/);
  assert.doesNotMatch(src, /hasBlockingFinding = findings\.some\(\(f\) => isAtLeastMedium\(f\.severity\)\)/);
});

/* ------------------------------------------------------------------ *
 * The env deferral is not an escape hatch
 * ------------------------------------------------------------------ */

test("an env-only block is deferred to CI, and refused unless CI is explicitly green", () => {
  const src = S("src/index.ts");
  // Only env-only, and never for a block verdict or a crashed review.
  assert.match(
    src,
    /deferToCi = rec !== "merge" && !overridable && envOnlyBlock && !reviewCrashPr && lastVerdict !== "block"/,
  );
  // `every` -- one real defect alongside the env finding and the deferral is off.
  assert.match(src, /blockers\.every\(\(f\) => classifyFinding\(f, \{ repoHasTestScript: true \}\) === "env"\)/);
  // Green means green. Written as !== "success" so a new CI state refuses.
  assert.match(src, /if \(deferToCi && ci !== "success"\)/);
  assert.doesNotMatch(src, /if \(deferToCi && ci === "none"\)/, "must fail toward the refusal, not enumerate states");
  // And it is audited either way.
  assert.match(src, /env_block_no_green_ci/);
  assert.match(src, /env_block_cleared_by_green_ci/);
});

test("the deferral sits after the failure, unreadable and pending refusals", () => {
  // If it ran before them, a red CI would merge on an env-only block.
  const src = S("src/index.ts");
  const at = (re) => src.search(re);
  const failure = at(/reason: "ci_failure"/);
  const unknown = at(/reason: "ci_indeterminate"/);
  const pending = at(/reason: "ci_pending"/);
  const deferred = at(/if \(deferToCi && ci !== "success"\)/);
  assert.ok(failure > 0 && unknown > 0 && pending > 0 && deferred > 0, "all four gates must be present");
  assert.ok(deferred > failure, "the deferral must not precede the CI failure refusal");
  assert.ok(deferred > unknown, "the deferral must not precede the unreadable-CI refusal");
  assert.ok(deferred > pending, "the deferral must not precede the pending-CI refusal");
});
