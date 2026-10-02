import { createHash } from "node:crypto";
import { isTypecheckEquivalentCheck, verificationResolutionDigest, type VerificationResolutionEvidence } from "./verification-reconciliation.js";
import { reviewFindingsDigest } from "./review-evidence.js";
import type { ReviewFinding } from "../orchestrator/adversary.js";
import { blocksMerge, classifyFinding } from "../orchestrator/finding-classify.js";

export const READINESS_POLICY_VERSION = "strict-readiness/v4";

export const READINESS_FAILURE_CODES = [
  "review_not_passed", "review_verdict_inconsistent", "review_evidence_stale", "verification_resolution_invalid", "blocking_findings", "review_crash", "missing_probes",
  "stale_publication", "pr_identity_mismatch", "required_ci_unregistered",
  "required_ci_not_green", "runtime_evidence_indeterminate", "runtime_evidence_failed",
  "security_evidence_indeterminate", "security_evidence_failed", "elapsed_time_exceeded",
  "scope_exceeded", "operation_not_authorized", "credential_route_changed",
  "secret_exposure", "spend_exceeded",
] as const;
export type ReadinessFailureCode = (typeof READINESS_FAILURE_CODES)[number];

export interface ExactShaEvidence { readonly sha: string; readonly observedAt: number }
export interface RequiredCiEvidence {
  readonly registered: boolean;
  readonly requiredChecks: readonly string[];
  readonly successfulChecks: readonly string[];
  readonly sha: string;
  readonly status: "success" | "failure" | "pending" | "indeterminate";
  readonly observedChecks?: readonly string[];
  readonly policySource?: string;
  readonly policyStatus?: "readable" | "denied" | "indeterminate";
  readonly policyDetail?: string;
}
export interface DeterminateEvidence { readonly status: "pass" | "fail" | "not_required" | "indeterminate"; readonly detail?: string; readonly sha?: string; readonly observedAt?: number }
export interface OperationReceipt { readonly operation: string; readonly observedAt: number; readonly sha?: string; readonly source: string }
export interface BoundReviewEvidence {
  readonly recordId: string;
  readonly expectedRecordId: string;
  readonly runId: string;
  readonly expectedRunId: string;
  readonly cycle: number;
  readonly expectedCycle: number;
  readonly baseSha: string;
  readonly expectedBaseSha: string;
  readonly candidateSha: string;
  readonly expectedCandidateSha: string;
  readonly completed: boolean;
  readonly verdict: PrReadinessInput["finalVerdict"];
  readonly findingsDigest: string;
  readonly computedFindingsDigest: string;
  readonly recordDigest: string;
  readonly computedRecordDigest: string;
}

export interface PrReadinessInput {
  readonly finalVerdict: "pass" | "revise" | "block" | "crashed" | "indeterminate";
  readonly blockingFindings: number;
  readonly reviewBlockingFindings: number;
  readonly findingClassificationContext: Readonly<{repoHasTestScript:boolean;hasDeclaredGenerators:boolean}>;
  readonly reviewCompleted: boolean;
  readonly reviewFindings: readonly ReviewFinding[];
  readonly verificationProbes: Readonly<{ completed: number; required: number; indeterminate: number }>;
  readonly candidateSha: string;
  readonly publication?: ExactShaEvidence;
  readonly pullRequest: Readonly<{ repository: string; baseRef: string; headSha: string; open: boolean; number?: number; url?: string }>;
  readonly expectedRepository: string;
  readonly expectedBaseRef: string;
  readonly requiredCi: RequiredCiEvidence;
  readonly runtimeEvidence: DeterminateEvidence;
  readonly securityEvidence: DeterminateEvidence;
  readonly elapsedTimeMs: number;
  readonly timeLimitMs: number;
  readonly readinessTimeoutMs?: number;
  readonly changedPaths: readonly string[];
  readonly allowedScope: readonly string[];
  readonly excludedScope: readonly string[];
  readonly operationsPerformed: readonly string[];
  readonly operationReceipts: readonly OperationReceipt[];
  readonly allowedOperations: readonly string[];
  readonly credentialRouteDigest: string;
  readonly expectedCredentialRouteDigest: string;
  readonly secretExposure: Readonly<{ detected: boolean; evidence: "pass" | "fail" | "indeterminate" }>;
  readonly spendUsd: number;
  readonly budgetUsd: number;
  readonly reviewEvidence: BoundReviewEvidence;
  readonly verificationResolutions?: readonly VerificationResolutionEvidence[];
}

export type PrReadinessResult = Readonly<
  | { ready: true; state: "pr_ready"; verifiedSha: string; checkedAt: number; policyVersion: string; contentDigest: string }
  | { ready: false; state: "failed"; failures: readonly ReadinessFailureCode[]; checkedAt: number; policyVersion: string; contentDigest: string }
>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
export function readinessContentDigest(input: PrReadinessInput, checkedAt: number, failures: readonly ReadinessFailureCode[]): string {
  return digest({ policyVersion: READINESS_POLICY_VERSION, input, checkedAt, failures });
}
function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return new Set(left).size === left.length && new Set(right).size === right.length &&
    left.length === right.length && left.every((item) => right.includes(item));
}
function cleanPath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""); }
function within(path: string, root: string): boolean {
  if (/^[A-Za-z]:/.test(path) || /^(?:\\\\|\/\/)/.test(path)) return false;
  const candidate = cleanPath(path); const allowed = cleanPath(root).replace(/\/\*\*$/, "");
  return allowed === "**" || allowed === "**/*" || candidate === allowed || candidate.startsWith(`${allowed}/`);
}

export function evaluatePrReadiness(input: PrReadinessInput, checkedAt = Date.now()): PrReadinessResult {
  const failures: ReadinessFailureCode[] = [];
  const reviewEvidence = input.reviewEvidence;
  let authoritativeVerdict = input.finalVerdict;
  if (!reviewEvidence) {
    failures.push("review_evidence_stale");
  } else {
    const bound =
      reviewEvidence.completed &&
      reviewEvidence.recordId === reviewEvidence.expectedRecordId &&
      reviewEvidence.runId === reviewEvidence.expectedRunId &&
      Number.isSafeInteger(reviewEvidence.cycle) &&
      reviewEvidence.cycle === reviewEvidence.expectedCycle &&
      reviewEvidence.baseSha === reviewEvidence.expectedBaseSha &&
      reviewEvidence.candidateSha === reviewEvidence.expectedCandidateSha &&
      reviewEvidence.expectedCandidateSha === input.candidateSha &&
      /^[a-f0-9]{64}$/.test(reviewEvidence.findingsDigest) &&
      reviewEvidence.findingsDigest === reviewEvidence.computedFindingsDigest &&
      reviewEvidence.findingsDigest === reviewFindingsDigest(JSON.stringify(input.reviewFindings)) &&
      /^[a-f0-9]{64}$/.test(reviewEvidence.recordDigest) &&
      reviewEvidence.recordDigest === reviewEvidence.computedRecordDigest;
    if (!bound) failures.push("review_evidence_stale");
    else {
      authoritativeVerdict = reviewEvidence.verdict;
      if (
        input.finalVerdict !== reviewEvidence.verdict ||
        (reviewEvidence.verdict === "pass" && input.blockingFindings !== 0)
      ) failures.push("review_verdict_inconsistent");
    }
  }
  if (!input.reviewCompleted || authoritativeVerdict !== "pass") failures.push("review_not_passed");
  for(const resolution of input.verificationResolutions??[]){
    const {evidenceDigest,...unsigned}=resolution;
    const valid=
      resolution.kind==="resolved_by_remote_ci" &&
      resolution.repository===input.expectedRepository &&
      resolution.findingFingerprint.trim().length>0 &&
      resolution.reviewDigest===input.reviewEvidence?.recordDigest &&
      resolution.pullRequestNumber===input.pullRequest.number &&
      resolution.candidateSha===input.candidateSha &&
      isTypecheckEquivalentCheck(resolution.remoteCheck) &&
      input.requiredCi.requiredChecks.includes(resolution.remoteCheck) &&
      input.requiredCi.successfulChecks.includes(resolution.remoteCheck) &&
      resolution.conclusion==="success" &&
      Number.isFinite(resolution.observedAt) &&
      resolution.observedAt>=(input.publication?.observedAt??Number.POSITIVE_INFINITY) &&
      resolution.observedAt<=checkedAt &&
      /^[a-f0-9]{64}$/.test(evidenceDigest) &&
      evidenceDigest===verificationResolutionDigest(unsigned);
    if(!valid)failures.push("verification_resolution_invalid");
  }
  const resolutionCount=(input.verificationResolutions??[]).length;
  const unavailableReviewedFindings=input.reviewFindings.filter((finding)=>
    finding.source==="harness_env"&&
    finding.localVerification?.kind==="typecheck"&&
    finding.localVerification.state==="unavailable"&&
    !["resolved","stale","accepted","dispositioned","resolved_by_remote_ci"].includes(finding.lifecycleState??"")
  );
  const unavailableReviewFingerprints=new Set(unavailableReviewedFindings.map((finding)=>finding.fingerprint).filter((fingerprint):fingerprint is string=>!!fingerprint));
  const unavailableReviewBlockers=unavailableReviewedFindings.length;
  const computedReviewBlockingFindings=input.reviewFindings.filter((finding)=>
    blocksMerge(finding,classifyFinding(finding,input.findingClassificationContext)),
  ).length;
  if(
    !Number.isSafeInteger(input.reviewBlockingFindings) ||
    input.reviewBlockingFindings!==computedReviewBlockingFindings ||
    input.reviewBlockingFindings<unavailableReviewBlockers ||
    input.reviewBlockingFindings<input.blockingFindings ||
    input.reviewBlockingFindings-input.blockingFindings!==resolutionCount ||
    new Set((input.verificationResolutions??[]).map((resolution)=>resolution.findingFingerprint)).size!==resolutionCount ||
    (input.verificationResolutions??[]).some((resolution)=>!unavailableReviewFingerprints.has(resolution.findingFingerprint))
  )failures.push("verification_resolution_invalid");
  if (authoritativeVerdict === "crashed") failures.push("review_crash");
  if (!Number.isSafeInteger(input.blockingFindings) || input.blockingFindings !== 0) failures.push("blocking_findings");
  const probes = input.verificationProbes;
  if (![probes.completed, probes.required, probes.indeterminate].every(Number.isSafeInteger) || probes.required < 1 || probes.completed !== probes.required || probes.indeterminate !== 0) failures.push("missing_probes");
  if (!input.publication || input.publication.sha !== input.candidateSha || !Number.isFinite(input.publication.observedAt) || input.publication.observedAt <= 0 || input.publication.observedAt > checkedAt) failures.push("stale_publication");
  if (!input.pullRequest.open || input.pullRequest.repository !== input.expectedRepository || input.pullRequest.baseRef !== input.expectedBaseRef || input.pullRequest.headSha !== input.candidateSha) failures.push("pr_identity_mismatch");
  const ci = input.requiredCi;
  if (!ci.registered || ci.requiredChecks.length === 0) failures.push("required_ci_unregistered");
  if (ci.status !== "success" || ci.sha !== input.candidateSha || !exactSet(ci.requiredChecks, ci.successfulChecks)) failures.push("required_ci_not_green");
  const readinessTimeoutMs = input.readinessTimeoutMs;
  const exactFreshEvidence = (evidence: DeterminateEvidence): boolean => {
    if (evidence.sha !== input.candidateSha || !Number.isFinite(evidence.observedAt) || evidence.observedAt! <= 0 || evidence.observedAt! > checkedAt) return false;
    if (!input.publication || evidence.observedAt! < input.publication.observedAt) return false;
    return readinessTimeoutMs === undefined || (Number.isFinite(readinessTimeoutMs) && readinessTimeoutMs > 0 && checkedAt - evidence.observedAt! <= readinessTimeoutMs);
  };
  if (input.runtimeEvidence.status === "indeterminate") failures.push("runtime_evidence_indeterminate");
  else if (input.runtimeEvidence.status === "fail") failures.push("runtime_evidence_failed");
  else if (input.runtimeEvidence.status === "pass" && !exactFreshEvidence(input.runtimeEvidence)) failures.push("runtime_evidence_indeterminate");
  if (input.securityEvidence.status === "indeterminate") failures.push("security_evidence_indeterminate");
  else if (input.securityEvidence.status === "fail") failures.push("security_evidence_failed");
  else if (input.securityEvidence.status === "pass" && !exactFreshEvidence(input.securityEvidence)) failures.push("security_evidence_indeterminate");
  if (!Number.isFinite(input.elapsedTimeMs) || !Number.isFinite(input.timeLimitMs) || input.elapsedTimeMs < 0 || input.elapsedTimeMs > input.timeLimitMs) failures.push("elapsed_time_exceeded");
  if (input.changedPaths.some((path) => !input.allowedScope.some((root) => within(path, root)) || input.excludedScope.some((root) => within(path, root)))) failures.push("scope_exceeded");
  const receipts = input.operationReceipts ?? [];
  const receiptOperations = receipts.map((receipt) => receipt.operation);
  const receiptsMeasured = receipts.every((receipt) => receipt.source.trim().length > 0 && Number.isFinite(receipt.observedAt) && receipt.observedAt > 0 && receipt.observedAt <= checkedAt && (!receipt.sha || receipt.sha === input.candidateSha));
  if (input.operationsPerformed.some((operation) => !input.allowedOperations.includes(operation)) || !exactSet([...new Set(input.operationsPerformed)], [...new Set(receiptOperations)]) || !receiptsMeasured) failures.push("operation_not_authorized");
  if (!/^[a-f0-9]{64}$/.test(input.credentialRouteDigest) || input.credentialRouteDigest !== input.expectedCredentialRouteDigest) failures.push("credential_route_changed");
  if (input.secretExposure.detected || input.secretExposure.evidence !== "pass") failures.push("secret_exposure");
  if (!Number.isFinite(input.spendUsd) || !Number.isFinite(input.budgetUsd) || input.spendUsd < 0 || input.spendUsd > input.budgetUsd) failures.push("spend_exceeded");
  const unique = Object.freeze([...new Set(failures)]);
  const contentDigest = readinessContentDigest(input, checkedAt, unique);
  return unique.length > 0
    ? Object.freeze({ ready: false, state: "failed", failures: unique, checkedAt, policyVersion: READINESS_POLICY_VERSION, contentDigest })
    : Object.freeze({ ready: true, state: "pr_ready", verifiedSha: input.candidateSha, checkedAt, policyVersion: READINESS_POLICY_VERSION, contentDigest });
}
