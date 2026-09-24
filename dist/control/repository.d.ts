import type { DatabaseSync } from "node:sqlite";
import type { AuthorityNonceStore } from "./authority.js";
import type { AuthorityDecision, AuthorityEnvelope, ControlRun, ControlState, ControlStateEvent } from "./types.js";
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
    acquireLease(runId: string, ownerId: string, ttlMs: number, now?: number): RunLease | null;
    renewLease(runId: string, ownerId: string, fence: number, ttlMs: number, now?: number): boolean;
    releaseLease(runId: string, ownerId: string, fence: number, now?: number): boolean;
}
//# sourceMappingURL=repository.d.ts.map