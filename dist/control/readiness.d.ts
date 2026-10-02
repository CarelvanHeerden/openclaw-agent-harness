export declare const READINESS_POLICY_VERSION = "strict-readiness/v3";
export declare const READINESS_FAILURE_CODES: readonly ["review_not_passed", "review_verdict_inconsistent", "review_evidence_stale", "blocking_findings", "review_crash", "missing_probes", "stale_publication", "pr_identity_mismatch", "required_ci_unregistered", "required_ci_not_green", "runtime_evidence_indeterminate", "runtime_evidence_failed", "security_evidence_indeterminate", "security_evidence_failed", "elapsed_time_exceeded", "scope_exceeded", "operation_not_authorized", "credential_route_changed", "secret_exposure", "spend_exceeded"];
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
    readonly observedChecks?: readonly string[];
    readonly policySource?: string;
    readonly policyStatus?: "readable" | "denied" | "indeterminate";
    readonly policyDetail?: string;
}
export interface DeterminateEvidence {
    readonly status: "pass" | "fail" | "not_required" | "indeterminate";
    readonly detail?: string;
    readonly sha?: string;
    readonly observedAt?: number;
}
export interface OperationReceipt {
    readonly operation: string;
    readonly observedAt: number;
    readonly sha?: string;
    readonly source: string;
}
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
    readonly reviewCompleted: boolean;
    readonly verificationProbes: Readonly<{
        completed: number;
        required: number;
        indeterminate: number;
    }>;
    readonly candidateSha: string;
    readonly publication?: ExactShaEvidence;
    readonly pullRequest: Readonly<{
        repository: string;
        baseRef: string;
        headSha: string;
        open: boolean;
        number?: number;
        url?: string;
    }>;
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
    readonly secretExposure: Readonly<{
        detected: boolean;
        evidence: "pass" | "fail" | "indeterminate";
    }>;
    readonly spendUsd: number;
    readonly budgetUsd: number;
    readonly reviewEvidence: BoundReviewEvidence;
}
export type PrReadinessResult = Readonly<{
    ready: true;
    state: "pr_ready";
    verifiedSha: string;
    checkedAt: number;
    policyVersion: string;
    contentDigest: string;
} | {
    ready: false;
    state: "failed";
    failures: readonly ReadinessFailureCode[];
    checkedAt: number;
    policyVersion: string;
    contentDigest: string;
}>;
export declare function readinessContentDigest(input: PrReadinessInput, checkedAt: number, failures: readonly ReadinessFailureCode[]): string;
export declare function evaluatePrReadiness(input: PrReadinessInput, checkedAt?: number): PrReadinessResult;
//# sourceMappingURL=readiness.d.ts.map