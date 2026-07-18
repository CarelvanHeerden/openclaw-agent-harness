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
export type MergeRecommendation = "merge" | "do_not_merge";
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