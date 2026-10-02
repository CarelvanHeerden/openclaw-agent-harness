import type { DatabaseSync } from "node:sqlite";
import type { ReviewFinding } from "../orchestrator/adversary.js";
export interface VerificationResolutionEvidence {
    readonly kind: "resolved_by_remote_ci";
    readonly findingFingerprint: string;
    readonly reviewDigest: string;
    readonly findingTitle: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly candidateSha: string;
    readonly remoteCheck: string;
    readonly conclusion: "success";
    readonly observedAt: number;
    readonly evidenceDigest: string;
}
export declare function isTypecheckEquivalentCheck(name: string): boolean;
export declare function verificationResolutionDigest(value: Omit<VerificationResolutionEvidence, "evidenceDigest">): string;
export declare function reconcileLocalVerificationWithRemoteCi(input: {
    findings: readonly ReviewFinding[];
    repository: string;
    pullRequestNumber: number;
    candidateSha: string;
    ciSha: string;
    policyStatus: "readable" | "denied" | "indeterminate";
    policyChecks: readonly string[];
    successfulChecks: readonly string[];
    observedAt: number;
    reviewDigest: string;
}): {
    unresolvedFindings: ReviewFinding[];
    resolutions: VerificationResolutionEvidence[];
};
export declare function reconcileBoundLocalVerificationWithRemoteCi(reviewBound: boolean, input: Parameters<typeof reconcileLocalVerificationWithRemoteCi>[0]): ReturnType<typeof reconcileLocalVerificationWithRemoteCi>;
export declare function persistVerificationResolutions(db: DatabaseSync, sessionId: string, resolutions: readonly VerificationResolutionEvidence[]): void;
//# sourceMappingURL=verification-reconciliation.d.ts.map