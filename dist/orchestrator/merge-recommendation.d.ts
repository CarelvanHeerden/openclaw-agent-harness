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
    review: ReviewSignal | undefined;
    blockingFindings?: number;
    mergeBlockingFindings?: number;
    mergeBlockingTitles?: string[];
    reachedCleanPass: boolean;
    ciStatus?: "success" | "failure" | "pending" | "none" | undefined;
}
export interface RecommendationResult {
    recommendation: MergeRecommendation;
    reason: string;
}
/** A recommendation is mergeable only after a clean final pass and green CI. */
export declare function deriveMergeRecommendation(input: RecommendationInput): RecommendationResult;
//# sourceMappingURL=merge-recommendation.d.ts.map