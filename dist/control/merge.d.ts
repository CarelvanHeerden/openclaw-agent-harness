import type { DatabaseSync } from "node:sqlite";
import type { ControlRepository } from "./repository.js";
export interface VerifiedMergeAuthorization {
    readonly version: 1;
    readonly id: string;
    readonly runId: string;
    readonly actorIdentity: string;
    readonly conversationIdentity: string;
    readonly repository: string;
    readonly baseRef: string;
    readonly prNumber: number;
    readonly expectedHeadSha: string;
    readonly nonce: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly bindingDigest: string;
}
export interface MergeInspection {
    readonly repository: string;
    readonly baseRef: string;
    readonly prNumber: number;
    readonly headSha: string;
    readonly open: boolean;
    readonly merged: boolean;
    readonly finalVerdict: "pass" | "revise" | "block" | "indeterminate";
    readonly blockingFindings: number;
    readonly requiredCi: Readonly<{
        status: "success" | "failure" | "pending" | "indeterminate";
        sha: string;
        registered: boolean;
    }>;
}
export interface MergeProvider {
    inspect(input: {
        repository: string;
        prNumber: number;
    }): Promise<MergeInspection>;
    merge(input: {
        repository: string;
        prNumber: number;
        expectedHeadSha: string;
        idempotencyKey: string;
    }): Promise<{
        mergeSha: string;
    }>;
    verifyMerged(input: {
        repository: string;
        prNumber: number;
        mergeSha: string;
    }): Promise<boolean>;
}
export type MergeServiceResult = Readonly<{
    status: "merged";
    mergeSha: string;
} | {
    status: "already_merged";
    mergeSha?: string;
} | {
    status: "refused";
    code: "merge_attestation_required" | "stale_pr_head" | "pr_identity_mismatch" | "review_not_passed" | "blocking_findings" | "required_ci_not_green" | "authorization_expired" | "authorization_replayed";
} | {
    status: "merge_failed";
    code: "provider_failure" | "verification_failed";
}>;
export declare function mergeAuthorizationDigest(input: Omit<VerifiedMergeAuthorization, "bindingDigest">): string;
export declare function createVerifiedMergeAuthorization(input: Omit<VerifiedMergeAuthorization, "version" | "id" | "bindingDigest"> & {
    id?: string;
}): VerifiedMergeAuthorization;
export declare class InternalMergeService {
    private readonly db;
    private readonly repository;
    private readonly provider;
    private readonly now;
    constructor(db: DatabaseSync, repository: ControlRepository, provider: MergeProvider, now?: () => number);
    registerAuthorization(authorization: VerifiedMergeAuthorization): void;
    merge(authorizationId: string): Promise<MergeServiceResult>;
}
//# sourceMappingURL=merge.d.ts.map