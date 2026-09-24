export const READINESS_FAILURE_CODES = [
  "review_not_passed",
  "blocking_findings",
  "review_crash",
  "missing_probes",
  "stale_publication",
  "pr_identity_mismatch",
  "required_ci_unregistered",
  "required_ci_not_green",
  "runtime_evidence_indeterminate",
  "runtime_evidence_failed",
  "security_evidence_indeterminate",
  "security_evidence_failed",
  "spend_exceeded",
] as const;

export type ReadinessFailureCode = (typeof READINESS_FAILURE_CODES)[number];

export interface ExactShaEvidence {
  readonly sha: string;
  readonly observedAt: number;
}

export interface RequiredCiEvidence {
  readonly registered: boolean;
  readonly requiredChecks: readonly string[];
  readonly successfulChecks: readonly string[];
  readonly sha: string;
  readonly status: "success" | "failure" | "pending" | "indeterminate";
}

export interface DeterminateEvidence {
  readonly status: "pass" | "fail" | "not_required" | "indeterminate";
  readonly detail?: string;
}

export interface PrReadinessInput {
  readonly finalVerdict: "pass" | "revise" | "block" | "crashed" | "indeterminate";
  readonly blockingFindings: number;
  readonly reviewCompleted: boolean;
  readonly verificationProbes: Readonly<{ completed: number; required: number; indeterminate: number }>;
  readonly candidateSha: string;
  readonly publication?: ExactShaEvidence;
  readonly pullRequest: Readonly<{
    repository: string;
    baseRef: string;
    headSha: string;
    open: boolean;
  }>;
  readonly expectedRepository: string;
  readonly expectedBaseRef: string;
  readonly requiredCi: RequiredCiEvidence;
  readonly runtimeEvidence: DeterminateEvidence;
  readonly securityEvidence: DeterminateEvidence;
  readonly spendUsd: number;
  readonly budgetUsd: number;
}

export type PrReadinessResult = Readonly<
  | { ready: true; state: "pr_ready"; verifiedSha: string; checkedAt: number }
  | { ready: false; state: "failed"; failures: readonly ReadinessFailureCode[] }
>;

function sameSet(required: readonly string[], successful: readonly string[]): boolean {
  const green = new Set(successful);
  return required.every((check) => green.has(check));
}

export function evaluatePrReadiness(input: PrReadinessInput, checkedAt = Date.now()): PrReadinessResult {
  const failures: ReadinessFailureCode[] = [];
  if (!input.reviewCompleted || input.finalVerdict !== "pass") failures.push("review_not_passed");
  if (input.finalVerdict === "crashed") failures.push("review_crash");
  if (!Number.isSafeInteger(input.blockingFindings) || input.blockingFindings !== 0) failures.push("blocking_findings");

  const probes = input.verificationProbes;
  if (
    !Number.isSafeInteger(probes.completed) ||
    !Number.isSafeInteger(probes.required) ||
    !Number.isSafeInteger(probes.indeterminate) ||
    probes.completed !== probes.required ||
    probes.indeterminate !== 0
  ) failures.push("missing_probes");

  if (!input.publication || input.publication.sha !== input.candidateSha) failures.push("stale_publication");
  if (
    !input.pullRequest.open ||
    input.pullRequest.repository !== input.expectedRepository ||
    input.pullRequest.baseRef !== input.expectedBaseRef ||
    input.pullRequest.headSha !== input.candidateSha
  ) failures.push("pr_identity_mismatch");

  const ci = input.requiredCi;
  if (!ci.registered || ci.requiredChecks.length === 0) failures.push("required_ci_unregistered");
  if (
    ci.status !== "success" ||
    ci.sha !== input.candidateSha ||
    !sameSet(ci.requiredChecks, ci.successfulChecks)
  ) failures.push("required_ci_not_green");

  if (input.runtimeEvidence.status === "indeterminate") failures.push("runtime_evidence_indeterminate");
  else if (input.runtimeEvidence.status === "fail") failures.push("runtime_evidence_failed");
  if (input.securityEvidence.status === "indeterminate") failures.push("security_evidence_indeterminate");
  else if (input.securityEvidence.status === "fail") failures.push("security_evidence_failed");
  if (!Number.isFinite(input.spendUsd) || !Number.isFinite(input.budgetUsd) || input.spendUsd > input.budgetUsd) failures.push("spend_exceeded");

  if (failures.length > 0) return Object.freeze({ ready: false, state: "failed", failures: Object.freeze([...new Set(failures)]) });
  return Object.freeze({ ready: true, state: "pr_ready", verifiedSha: input.candidateSha, checkedAt });
}
