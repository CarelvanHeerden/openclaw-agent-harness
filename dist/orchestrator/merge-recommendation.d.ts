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
    findings: Array<{
        severity: string;
        dimension?: string;
        title?: string;
    }>;
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
/**
 * Pure derivation. No I/O.
 */
export declare function deriveMergeRecommendation(input: RecommendationInput): RecommendationResult;
//# sourceMappingURL=merge-recommendation.d.ts.map