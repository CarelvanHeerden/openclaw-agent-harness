export interface BoundReviewRecord {
    readonly runId: string;
    readonly cycle: number;
    readonly baseSha: string;
    readonly candidateSha: string;
    readonly verdict: string;
    readonly findingsDigest: string;
    readonly completed: boolean;
}
export declare function reviewFindingsDigest(serializedFindings: string): string;
export declare function reviewRecordDigest(record: BoundReviewRecord): string;
export declare function isExactReviewedPublishedHead(reviewSha: string, publishedSha: string, pullRequestHeadSha: string): boolean;
//# sourceMappingURL=review-evidence.d.ts.map