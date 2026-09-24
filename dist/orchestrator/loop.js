/**
 * Autonomous control-plane entry point. Confirmed changes have no interactive
 * exchange: deterministic in-envelope choices continue, while an
 * authority or readiness violation produces one terminal result.
 *
 * The rc.13 executor remains isolated in legacy-loop.ts solely to finish or
 * inspect pre-migration session records.
 */
export * from "./legacy-loop.js";
export { AutonomousControlEngine, decideEngineAuthority } from "../control/engine.js";
export { evaluatePrReadiness } from "../control/readiness.js";
export function isStrictReadinessAudit(input) {
    return input.state === "pr_ready" && input.verdict === "pass" && input.blocking === 0 &&
        input.published_sha === input.pr_head_sha && input.required_ci === "green" &&
        input.runtime_evidence === "determinate" && input.spend_within_budget_envelope === true;
}
export const CONTROL_RECOVERY_CONTRACT = Object.freeze({
    control_plane_contract_version: 2,
    control_plane_schema_version: 2,
    legacy_rc13: "terminal_only",
    migration: "idempotent",
    verified_checkpoint: true,
    lease_owner: true,
    lease_expires_at: true,
    lease_generation: true,
    merge_provider_idempotency: true,
});
export const TERMINAL_ENVELOPE_CODES = Object.freeze([
    "budget_exceeded",
    "time_exceeded",
    "scope_escalation",
    "path_violation",
    "security_escalation",
    "credential_escalation",
]);
//# sourceMappingURL=loop.js.map