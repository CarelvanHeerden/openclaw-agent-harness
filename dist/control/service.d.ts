import type { DatabaseSync } from "node:sqlite";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
import type { AutonomousControlEngine } from "./engine.js";
import type { InternalMergeService } from "./merge.js";
import type { ControlRepository, RunLease } from "./repository.js";
import type { PrReadinessInput } from "./readiness.js";
export declare const CONTROL_PLANE_CONTRACT_VERSION = "control-plane-contract/v2";
export declare const CONFIRM_DOMAIN = "control-plane-confirm/v2";
export declare const MERGE_DOMAIN = "control-plane-merge/v2";
export type ControlOperation = "confirm_change" | "merge_change";
export interface TrustedControlContext {
    requesterSenderId?: string;
    conversationId?: string;
    workspaceId?: string;
    trustedControlAttestation?: Readonly<{
        version: 2;
        provenance: "host_verified";
        operation: ControlOperation;
        actorIdentity: string;
        conversationIdentity: string;
        hostEventId: string;
        nonce: string;
        issuedAt: number;
        expiresAt: number;
        bindingDigest: string;
    }>;
}
export interface PrepareChangeInput {
    request: string;
    repository: string;
    baseRef?: string;
    scope?: string[];
    excludedScope?: string[];
    budgetUsd?: number;
    timeLimitSeconds?: number;
}
export interface RepositoryResolution {
    repositoryIdentity: string;
    baseRef: string;
    baseRevision: string;
    credentialRoute: string;
    policyDigest: string;
    securityClass: "low" | "medium" | "high";
}
export interface ExecuteControlInput {
    changeId: string;
    brief: CrystallisedBrief;
    actorIdentity: string;
    conversationIdentity: string;
    repositoryIdentity: string;
    baseRef: string;
    baseRevision: string;
    budgetUsd: number;
    timeLimitSeconds: number;
    scope: readonly string[];
    excludedScope: readonly string[];
    credentialRouteDigest: string;
    lease: RunLease;
    assertCurrent: () => void;
    checkpoint: (sha: string, payloadDigest: string) => void;
}
export interface ControlServiceDeps {
    db: DatabaseSync;
    repository: ControlRepository;
    engine: AutonomousControlEngine;
    mergeService: InternalMergeService;
    crystallise: (request: string) => Promise<{
        kind: "brief";
        brief: CrystallisedBrief;
        costUsd?: number;
    } | {
        kind: "clarify";
        question: string;
        costUsd?: number;
    } | {
        kind: "reject";
        reason: string;
        costUsd?: number;
    }>;
    resolveRepository: (input: {
        repository: string;
        baseRef?: string;
        actorIdentity: string;
    }) => Promise<RepositoryResolution>;
    executeEngine: (input: ExecuteControlInput) => Promise<PrReadinessInput>;
    now?: () => number;
    confirmationTtlMs?: number;
    dispatchLeaseMs?: number;
    maximumBudgetUsd?: number;
    maximumTimeSeconds?: number;
    minimumRuntimeVersion?: string;
}
export declare function controlDigest(domain: string, binding: unknown): string;
export declare class ControlError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class ControlPlaneService {
    private readonly deps;
    private readonly now;
    private readonly ttl;
    private readonly dispatchLeaseMs;
    private readonly recoveryTimer;
    constructor(deps: ControlServiceDeps);
    dispose(): void;
    prepare(input: PrepareChangeInput, context: TrustedControlContext): Promise<Record<string, unknown>>;
    confirm(changeId: string, context: TrustedControlContext): Promise<Record<string, unknown>>;
    result(changeId: string, context: TrustedControlContext): Record<string, unknown>;
    merge(changeId: string, context: TrustedControlContext): Promise<Record<string, unknown>>;
    private dispatch;
    private recoverDispatches;
    private proposal;
    private requireAttestation;
    private consumeAttestation;
    private confirmBindingDigest;
    private mergeBindingDigest;
    private summary;
}
//# sourceMappingURL=service.d.ts.map