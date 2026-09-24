import type { DatabaseSync } from "node:sqlite";
import type { AuthorityNonceStore } from "./authority.js";
import type { AuthorityDecision, AuthorityEnvelope, ControlRun, ControlState, ControlStateEvent } from "./types.js";
import type { EngineAuthorityDecision } from "./engine.js";
import type { PrReadinessResult } from "./readiness.js";
export interface CreateControlRunInput {
    readonly id?: string;
    readonly authority: AuthorityEnvelope;
    readonly createdAt?: number;
}
export interface TransitionControlRunInput {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly to: ControlState;
    readonly actor: string;
    readonly reason: string;
    readonly at?: number;
    readonly terminalCode?: string;
    readonly pullRequestUrl?: string;
}
export interface RunLease {
    readonly runId: string;
    readonly ownerId: string;
    readonly fence: number;
    readonly acquiredAt: number;
    readonly expiresAt: number;
    readonly authorityHash?: string;
}
export interface FencedTransitionControlRunInput extends TransitionControlRunInput {
    readonly lease: RunLease;
}
export declare class ControlRepository implements AuthorityNonceStore {
    private readonly db;
    constructor(db: DatabaseSync);
    createRun(input: CreateControlRunInput): ControlRun;
    getRun(runId: string): ControlRun | null;
    transition(input: TransitionControlRunInput): ControlRun;
    listStateEvents(runId: string): readonly ControlStateEvent[];
    consume(nonce: string, envelopeDigest: string, consumedAt: number): boolean;
    recordDecision(runId: string, envelope: AuthorityEnvelope, decision: AuthorityDecision, at?: number): void;
    acquireLease(runId: string, ownerId: string, ttlMs: number, now?: number, authorityHash?: string): RunLease | null;
    renewLease(runId: string, ownerId: string, fence: number, ttlMs: number, now?: number): boolean;
    releaseLease(runId: string, ownerId: string, fence: number, now?: number): boolean;
    validateLease(lease: RunLease, now?: number): boolean;
    transitionFenced(input: FencedTransitionControlRunInput): ControlRun;
    recordEngineDecision(runId: string, lease: RunLease, decision: EngineAuthorityDecision, at?: number): void;
    recordReadiness(runId: string, lease: RunLease, result: PrReadinessResult, at?: number): void;
    writeVerifiedCheckpoint(runId: string, lease: RunLease, checkpointSha: string, payloadDigest: string, at?: number): void;
}
//# sourceMappingURL=repository.d.ts.map