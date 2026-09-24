import type { DatabaseSync } from "node:sqlite";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
export declare const CONTROL_PLANE_CONTRACT_VERSION = "control-plane-contract/v1";
export declare const CONTROL_PLANE_SCHEMA_VERSION = 1;
export declare const CONFIRM_DOMAIN = "control-plane-confirm/v1";
export declare const MERGE_DOMAIN = "control-plane-merge/v1";
export type ChangeState = "prepared" | "accepted" | "running" | "pr_ready" | "failed" | "merged" | "merge_failed";
export type ControlOperation = "confirm_change" | "merge_change";
export interface TrustedControlContext {
    requesterSenderId?: string;
    conversationId?: string;
    workspaceId?: string;
    hostEventId?: string;
    receivedAt?: number;
    trustedControlAttestation?: Readonly<{
        version: 1;
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
export interface EngineStartInput {
    changeId: string;
    /** Stable across controller restart; the engine insert must be idempotent on this value. */
    engineSessionId: string;
    brief: CrystallisedBrief;
    actorIdentity: string;
    conversationIdentity: string;
    repositoryIdentity: string;
    baseRef: string;
    baseRevision: string;
    budgetUsd: string;
    timeLimitSeconds: number;
    scope: readonly string[];
    excludedScope: readonly string[];
}
export interface ReadinessInput {
    changeId: string;
    pullRequestNumber: number;
    pullRequestUrl: string;
    verdict: "pass" | "revise" | "block";
    blocking: number;
    publishedSha: string;
    prHeadSha: string;
    requiredCiDigest: string;
    runtimeEvidenceDigest: string;
    spendUsd: number;
}
export interface MergeStartInput {
    changeId: string;
    actorIdentity: string;
    conversationIdentity: string;
    pullRequestNumber: number;
    prHeadSha: string;
    readinessDigest: string;
    mergeMethod: "squash" | "merge" | "rebase";
}
export interface ControlServiceDeps {
    db: DatabaseSync;
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
    resolveRepository?: (input: {
        repository: string;
        baseRef?: string;
        actorIdentity: string;
    }) => Promise<RepositoryResolution>;
    startEngine: (input: EngineStartInput) => Promise<{
        engineSessionId?: string;
    } | void>;
    mergeChange: (input: MergeStartInput) => Promise<{
        merged: boolean;
        mergeSha?: string;
        message?: string;
    }>;
    now?: () => number;
    confirmationTtlMs?: number;
    maximumBudgetUsd?: number;
    maximumTimeSeconds?: number;
}
export declare function controlDigest(domain: string, binding: unknown): string;
export declare class ControlError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare class ControlPlaneService {
    private readonly deps;
    private readonly now;
    private readonly confirmationTtlMs;
    constructor(deps: ControlServiceDeps);
    prepare(input: PrepareChangeInput, context: TrustedControlContext): Promise<Record<string, unknown>>;
    confirm(changeId: string, context: TrustedControlContext): Promise<Record<string, unknown>>;
    recordReadiness(input: ReadinessInput): void;
    recordTerminalFailure(changeId: string, code: "budget_exceeded" | "time_exceeded" | "scope_escalation" | "path_violation" | "security_escalation" | "credential_escalation" | "verification_failed" | "execution_failed", summary: string): void;
    result(changeId: string, context: TrustedControlContext): Record<string, unknown>;
    merge(changeId: string, context: TrustedControlContext): Promise<Record<string, unknown>>;
    private recoverExecutionIntents;
    private engineSessionId;
    private dispatchExactlyOnce;
    private resolveHostAttestation;
    private consumeAttestation;
    private confirmBindingDigest;
    private mergeBindingDigest;
    private get;
    private summaryFor;
}
//# sourceMappingURL=service.d.ts.map