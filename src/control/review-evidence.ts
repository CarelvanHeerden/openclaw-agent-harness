import { createHash } from "node:crypto";

export interface BoundReviewRecord {
  readonly runId: string;
  readonly cycle: number;
  readonly baseSha: string;
  readonly candidateSha: string;
  readonly verdict: string;
  readonly findingsDigest: string;
  readonly completed: boolean;
}

export function reviewFindingsDigest(serializedFindings: string): string {
  return createHash("sha256").update(serializedFindings).digest("hex");
}

export function reviewRecordDigest(record: BoundReviewRecord): string {
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

export function isExactReviewedPublishedHead(reviewSha: string, publishedSha: string, pullRequestHeadSha: string): boolean {
  return /^[a-f0-9]{40}$/i.test(reviewSha) &&
    reviewSha === publishedSha &&
    reviewSha === pullRequestHeadSha;
}
