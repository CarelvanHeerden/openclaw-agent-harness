/**
 * Public autonomous control-plane helpers. Historical execution machinery is
 * intentionally not re-exported from this package facade.
 */
export { AutonomousControlEngine, decideEngineAuthority } from "../control/engine.js";
export { evaluatePrReadiness } from "../control/readiness.js";
import { runningSessionIds as internalRunningSessionIds } from "./legacy-loop.js";
/** Internal lifecycle signal; it does not expose an execution entry point. */
export function runningSessionIds() { return internalRunningSessionIds(); }
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
    "budget_exceeded", "time_exceeded", "scope_escalation", "path_violation",
    "security_escalation", "credential_escalation",
]);
//# sourceMappingURL=loop.js.map