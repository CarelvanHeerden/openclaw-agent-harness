/**
 * Public autonomous control-plane helpers. Historical execution machinery is
 * intentionally not re-exported from this package facade.
 */
export { AutonomousControlEngine, decideEngineAuthority } from "../control/engine.js";
export { evaluatePrReadiness } from "../control/readiness.js";
/** Internal lifecycle signal; it does not expose an execution entry point. */
export declare function runningSessionIds(): string[];
export interface StrictReadinessAuditShape {
    state: "pr_ready";
    verdict: "pass";
    blocking: 0;
    published_sha: string;
    pr_head_sha: string;
    required_ci: "green";
    runtime_evidence: "determinate";
    spend_within_budget_envelope: true;
}
export declare function isStrictReadinessAudit(input: StrictReadinessAuditShape): boolean;
export declare const CONTROL_RECOVERY_CONTRACT: Readonly<{
    control_plane_contract_version: 2;
    control_plane_schema_version: 2;
    legacy_rc13: "terminal_only";
    migration: "idempotent";
    verified_checkpoint: true;
    lease_owner: true;
    lease_expires_at: true;
    lease_generation: true;
    merge_provider_idempotency: true;
}>;
export declare const TERMINAL_ENVELOPE_CODES: readonly string[];
//# sourceMappingURL=loop.d.ts.map