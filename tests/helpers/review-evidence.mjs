import { reviewFindingsDigest, reviewRecordDigest } from "../../dist/control/review-evidence.js";

export function testReviewEvidence(candidateSha, verdict = "pass", overrides = {}) {
  const runId = overrides.runId ?? "test-readiness-run";
  const cycle = overrides.cycle ?? 1;
  const baseSha = overrides.baseSha ?? "b".repeat(40);
  const findingsJson = JSON.stringify(overrides.findings ?? []);
  const findingsDigest = reviewFindingsDigest(findingsJson);
  const record = { runId, cycle, baseSha, candidateSha, verdict, findingsDigest, completed: true };
  return {
    recordId: `${runId}-r${cycle}`,
    expectedRecordId: `${runId}-r${cycle}`,
    runId,
    expectedRunId: runId,
    cycle,
    expectedCycle: cycle,
    baseSha,
    expectedBaseSha: baseSha,
    candidateSha,
    expectedCandidateSha: candidateSha,
    completed: true,
    verdict,
    findingsDigest,
    computedFindingsDigest: findingsDigest,
    recordDigest: reviewRecordDigest(record),
    computedRecordDigest: reviewRecordDigest(record),
    ...overrides,
  };
}
