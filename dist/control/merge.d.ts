import type { DatabaseSync } from "node:sqlite";
import type { ControlRepository } from "./repository.js";
import { type PrReadinessInput } from "./readiness.js";
export interface VerifiedMergeAuthorization {
    readonly version: 2;
    readonly id: string;
    readonly runId: string;
    readonly actorIdentity: string;
    readonly conversationIdentity: string;
    readonly repository: string;
    readonly baseRef: string;
    readonly prNumber: number;
    readonly expectedHeadSha: string;
    readonly publishedSha: string;
    readonly readinessDigest: string;
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
    readonly mergeSha?: string;
    readonly readiness: PrReadinessInput;
}
export interface MergeProvider {
    inspect(input: {
        runId: string;
        repository: string;
        prNumber: number;
        readinessDigest: string;
    }): Promise<MergeInspection>;
    merge(input: {
        runId: string;
        repository: string;
        prNumber: number;
        expectedHeadSha: string;
        idempotencyKey: string;
    }): Promise<{
        mergeSha: string;
    }>;
    verifyMerged(input: {
        runId: string;
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
    status: "merge_in_progress";
} | {
    status: "refused";
    code: "merge_attestation_required" | "stale_pr_head" | "pr_identity_mismatch" | "readiness_changed" | "authorization_expired" | "authorization_replayed";
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
    private recoveryInFlight;
    private static readonly INTENT_LEASE_MS;
    private static readonly MAX_RECOVERY_ATTEMPTS;
    private static readonly MAX_INSPECTIONS_PER_ATTEMPT;
    constructor(db: DatabaseSync, repository: ControlRepository, provider: MergeProvider, now?: () => number);
    registerAuthorizationAndIntent(a: VerifiedMergeAuthorization, now?: number): string;
    registerAuthorization(a: VerifiedMergeAuthorization): void;
    recoverPending(): Promise<void>;
    merge(id: string): Promise<MergeServiceResult>;
    private waitForIntent;
    private mergeLeased;
    private reconcileClaimedMerge;
    private verifyPersistedAuthorizationRow;
    private verifyPersistedAuthorization;
    private verifyPersistedReadiness;
    private acquireIntentLease;
    private validIntentLease;
    private releaseIntentLease;
    private refuseRun;
    private failRun;
    private terminalize;
    private completeRun;
}
//# sourceMappingURL=merge.d.ts.map