import type { ControlRepository, RunLease } from "./repository.js";
import type { AuthorityRequest, ControlRun } from "./types.js";
import { type PrReadinessInput, type PrReadinessResult } from "./readiness.js";
export declare const AUTONOMOUS_CONTINUATION_KINDS: readonly ["implementation_choice", "replan", "retry", "repair", "verification_retry", "review_repair"];
export declare const TERMINAL_AUTHORITY_CODES: readonly ["budget_exceeded", "time_exceeded", "scope_escalation", "path_violation", "security_escalation", "credential_escalation", "irreversible_expansion", "authority_expired", "authority_violation"];
export type AutonomousContinuationKind = (typeof AUTONOMOUS_CONTINUATION_KINDS)[number];
export type TerminalAuthorityCode = (typeof TERMINAL_AUTHORITY_CODES)[number];
export type EngineAuthorityDecision = Readonly<{
    outcome: "continue";
    kind: AutonomousContinuationKind;
    auditCode: "autonomous_in_envelope";
} | {
    outcome: "terminate";
    code: TerminalAuthorityCode;
    reason: string;
}>;
export interface DecideEngineAuthorityInput {
    readonly kind: AutonomousContinuationKind;
    readonly request: AuthorityRequest;
}
export declare function decideEngineAuthority(run: ControlRun, input: DecideEngineAuthorityInput): EngineAuthorityDecision;
export interface AutonomousEngineOptions {
    readonly repository: ControlRepository;
    readonly ownerId: string;
    readonly leaseTtlMs: number;
    readonly now?: () => number;
}
/**
 * Deterministic post-confirmation controller. It has no callback for asking a
 * person and no paused state: every request either continues inside the
 * immutable envelope or moves the run to a terminal failure.
 */
export declare class AutonomousControlEngine {
    private readonly options;
    private readonly now;
    constructor(options: AutonomousEngineOptions);
    acquire(runId: string): RunLease;
    decide(runId: string, lease: RunLease, input: DecideEngineAuthorityInput): EngineAuthorityDecision;
    evaluateReadiness(runId: string, lease: RunLease, input: PrReadinessInput): PrReadinessResult;
    checkpoint(runId: string, lease: RunLease, checkpointSha: string, payloadDigest: string): void;
    private requireRun;
    private requireFencedRun;
}
//# sourceMappingURL=engine.d.ts.map