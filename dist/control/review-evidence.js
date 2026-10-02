import { createHash } from "node:crypto";
export function reviewFindingsDigest(serializedFindings) {
    return createHash("sha256").update(serializedFindings).digest("hex");
}
export function reviewRecordDigest(record) {
    return createHash("sha256").update(JSON.stringify({
        runId: record.runId,
        cycle: record.cycle,
        baseSha: record.baseSha,
        candidateSha: record.candidateSha,
        verdict: record.verdict,
        findingsDigest: record.findingsDigest,
        completed: record.completed,
    })).digest("hex");
}
export function isExactReviewedPublishedHead(reviewSha, publishedSha, pullRequestHeadSha) {
    return /^[a-f0-9]{40}$/i.test(reviewSha) &&
        reviewSha === publishedSha &&
        reviewSha === pullRequestHeadSha;
}
//# sourceMappingURL=review-evidence.js.map