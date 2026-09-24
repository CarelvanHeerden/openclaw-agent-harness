import { createHash } from "node:crypto";

export const READINESS_POLICY_VERSION = "strict-readiness/v2";

export const READINESS_FAILURE_CODES = [
  "review_not_passed", "blocking_findings", "review_crash", "missing_probes",
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
}
export interface DeterminateEvidence { readonly status: "pass" | "fail" | "not_required" | "indeterminate"; readonly detail?: string }

export interface PrReadinessInput {
  readonly finalVerdict: "pass" | "revise" | "block" | "crashed" | "indeterminate";
  readonly blockingFindings: number;
  readonly reviewCompleted: boolean;
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
  readonly changedPaths: readonly string[];
  readonly allowedScope: readonly string[];
  readonly excludedScope: readonly string[];
  readonly operationsPerformed: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly credentialRouteDigest: string;
  readonly expectedCredentialRouteDigest: string;
  readonly secretExposure: Readonly<{ detected: boolean; evidence: "pass" | "fail" | "indeterminate" }>;
  readonly spendUsd: number;
  readonly budgetUsd: number;
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
function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length > 0 && new Set(left).size === left.length && new Set(right).size === right.length &&
    left.length === right.length && left.every((item) => right.includes(item));
}
function cleanPath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""); }
function within(path: string, root: string): boolean {
  const candidate = cleanPath(path); const allowed = cleanPath(root).replace(/\/\*\*$/, "");
  return allowed === "**" || allowed === "**/*" || candidate === allowed || candidate.startsWith(`${allowed}/`);
}

export function evaluatePrReadiness(input: PrReadinessInput, checkedAt = Date.now()): PrReadinessResult {
  const failures: ReadinessFailureCode[] = [];
  if (!input.reviewCompleted || input.finalVerdict !== "pass") failures.push("review_not_passed");
  if (input.finalVerdict === "crashed") failures.push("review_crash");
  if (!Number.isSafeInteger(input.blockingFindings) || input.blockingFindings !== 0) failures.push("blocking_findings");
  const probes = input.verificationProbes;
  if (![probes.completed, probes.required, probes.indeterminate].every(Number.isSafeInteger) || probes.required < 1 || probes.completed !== probes.required || probes.indeterminate !== 0) failures.push("missing_probes");
  if (!input.publication || input.publication.sha !== input.candidateSha || !Number.isFinite(input.publication.observedAt) || input.publication.observedAt <= 0 || input.publication.observedAt > checkedAt) failures.push("stale_publication");
  if (!input.pullRequest.open || input.pullRequest.repository !== input.expectedRepository || input.pullRequest.baseRef !== input.expectedBaseRef || input.pullRequest.headSha !== input.candidateSha) failures.push("pr_identity_mismatch");
  const ci = input.requiredCi;
  if (!ci.registered || ci.requiredChecks.length === 0) failures.push("required_ci_unregistered");
  if (ci.status !== "success" || ci.sha !== input.candidateSha || !exactSet(ci.requiredChecks, ci.successfulChecks)) failures.push("required_ci_not_green");
  if (input.runtimeEvidence.status === "indeterminate") failures.push("runtime_evidence_indeterminate");
  else if (input.runtimeEvidence.status === "fail") failures.push("runtime_evidence_failed");
  if (input.securityEvidence.status === "indeterminate") failures.push("security_evidence_indeterminate");
  else if (input.securityEvidence.status === "fail") failures.push("security_evidence_failed");
  if (!Number.isFinite(input.elapsedTimeMs) || !Number.isFinite(input.timeLimitMs) || input.elapsedTimeMs < 0 || input.elapsedTimeMs > input.timeLimitMs) failures.push("elapsed_time_exceeded");
  if (input.changedPaths.some((path) => !input.allowedScope.some((root) => within(path, root)) || input.excludedScope.some((root) => within(path, root)))) failures.push("scope_exceeded");
  if (input.operationsPerformed.some((operation) => !input.allowedOperations.includes(operation))) failures.push("operation_not_authorized");
  if (!/^[a-f0-9]{64}$/.test(input.credentialRouteDigest) || input.credentialRouteDigest !== input.expectedCredentialRouteDigest) failures.push("credential_route_changed");
  if (input.secretExposure.detected || input.secretExposure.evidence !== "pass") failures.push("secret_exposure");
  if (!Number.isFinite(input.spendUsd) || !Number.isFinite(input.budgetUsd) || input.spendUsd < 0 || input.spendUsd > input.budgetUsd) failures.push("spend_exceeded");
  const unique = Object.freeze([...new Set(failures)]);
  const contentDigest = digest({ policyVersion: READINESS_POLICY_VERSION, input, checkedAt, failures: unique });
  return unique.length > 0
    ? Object.freeze({ ready: false, state: "failed", failures: unique, checkedAt, policyVersion: READINESS_POLICY_VERSION, contentDigest })
    : Object.freeze({ ready: true, state: "pr_ready", verifiedSha: input.candidateSha, checkedAt, policyVersion: READINESS_POLICY_VERSION, contentDigest });
}
