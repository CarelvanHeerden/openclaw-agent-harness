/**
 * beta.34: post-ship merge recommendation.
 *
 * After the harness opens the PR (`loop.shipped`), it emits a human-facing
 * MERGE / DO-NOT-MERGE recommendation. This is NOT a second model review --
 * it is DERIVED from signals the harness already has: the adversary verdict,
 * the review findings, whether the loop reached a clean pass (vs. shipping at
 * max cycles), and (optionally) CI check status on the PR head.
 *
 * Design intent (Carel): a DO-NOT-MERGE recommendation should be structurally
 * RARE. If the adversarial reviewer looped (up to max_cycles) and signed off
 * with `pass`, the PR is clean by definition. A do-not-merge therefore means
 * one of:
 *   - the loop shipped WITHOUT a clean pass (e.g. ran out of cycles), or
 *   - a blocking-severity finding survived into the final review, or
 *   - CI is red on the PR head.
 * These feed the HARD GATE in harness_merge_pr: if the recommendation is
 * do_not_merge, the merge tool refuses (no override; use the GitHub UI).
 */

/**
 * beta.62: added `needs_human_review` -- set ONLY by the graceful-degradation
 * path in the loop when a cycle-N adversary review crashed but the underlying
 * work is complete + self-verified green (so the PR is opened for inspection
 * rather than discarded). It is distinct from `do_not_merge` (which means the
 * adversary produced a verdict that withheld sign-off): `needs_human_review`
 * means the adversary NEVER FINISHED, so there is no machine sign-off at all.
 * The harness_merge_pr HARD GATE treats it exactly like do_not_merge (refuse;
 * human merges via the GitHub UI) -- it is never auto-overridable.
 */
export type MergeRecommendation = "merge" | "do_not_merge" | "needs_human_review";

export interface ReviewSignal {
  verdict: "pass" | "revise" | "block" | string;
  findings: Array<{ severity: string; dimension?: string; title?: string }>;
}

export interface RecommendationInput {
  /** The FINAL adversary review for the session. */
  review: ReviewSignal | undefined;
  /** True if the loop reached a clean adversary pass (vs. shipping at cap). */
  reachedCleanPass: boolean;
  /**
   * Optional CI status on the PR head commit, if fetched. "success" |
   * "failure" | "pending" | "none" (no checks configured) | undefined
   * (not fetched).
   */
  ciStatus?: "success" | "failure" | "pending" | "none" | undefined;
}

export interface RecommendationResult {
  recommendation: MergeRecommendation;
  reason: string;
}

const BLOCKING_SEVERITIES = new Set(["block", "blocker", "critical", "high"]);

/**
 * Pure derivation. No I/O.
 */
export function deriveMergeRecommendation(input: RecommendationInput): RecommendationResult {
  const { review, reachedCleanPass, ciStatus } = input;

  // 1. No review at all -> cannot recommend merge.
  if (!review) {
    return {
      recommendation: "do_not_merge",
      reason: "No adversary review was produced for this session, so the change is unverified. Not safe to auto-merge.",
    };
  }

  // 2. Verdict is not a clean pass.
  if (review.verdict !== "pass") {
    return {
      recommendation: "do_not_merge",
      reason: `The adversary's final verdict was "${review.verdict}", not "pass". The review loop did not sign off on this change.`,
    };
  }

  // 3. Verdict is pass but the loop shipped without actually reaching a clean
  //    pass (e.g. hit max cycles). Treat the "pass" as unreliable.
  if (!reachedCleanPass) {
    return {
      recommendation: "do_not_merge",
      reason: "The review loop shipped at its cycle/budget limit without a clean adversary sign-off. The pass is not trustworthy.",
    };
  }

  // 4. A blocking-severity finding survived into the final (passing) review.
  const blocking = review.findings.filter((f) => BLOCKING_SEVERITIES.has((f.severity || "").toLowerCase()));
  if (blocking.length > 0) {
    const titles = blocking.map((f) => f.title || f.dimension || "(untitled)").slice(0, 3).join("; ");
    return {
      recommendation: "do_not_merge",
      reason: `The final review passed but carries ${blocking.length} blocking-severity finding(s): ${titles}. Resolve before merge.`,
    };
  }

  // 5. CI is explicitly failing on the PR head.
  if (ciStatus === "failure") {
    return {
      recommendation: "do_not_merge",
      reason: "CI checks are failing on the PR head commit. Not safe to merge until CI is green.",
    };
  }

  // 6. Clean pass, no blockers, CI not failing -> MERGE.
  const infoCount = review.findings.length;
  const ciNote =
    ciStatus === "success"
      ? " CI is green."
      : ciStatus === "pending"
        ? " CI is still running (not yet green) -- the merge will proceed on your say-so, but you may prefer to wait."
        : ciStatus === "none"
          ? " No CI checks are configured on this repo."
          : "";
  return {
    recommendation: "merge",
    reason:
      `The adversary looped to a clean pass with no blocking findings` +
      (infoCount ? ` (${infoCount} informational/low finding(s), none blocking)` : "") +
      `.${ciNote} Recommended to merge.`,
  };
}
