import { authorityEnvelopeDigest, evaluateAuthority } from "./authority.js";
import { evaluatePrReadiness } from "./readiness.js";
export const AUTONOMOUS_CONTINUATION_KINDS = [
    "implementation_choice",
    "replan",
    "retry",
    "repair",
    "verification_retry",
    "review_repair",
];
export const TERMINAL_AUTHORITY_CODES = [
    "budget_exceeded",
    "time_exceeded",
    "scope_escalation",
    "path_violation",
    "security_escalation",
    "credential_escalation",
    "irreversible_expansion",
    "authority_expired",
    "authority_violation",
];
const terminalCodeByReason = Object.freeze({
    budget_expansion: "budget_exceeded",
    time_expansion: "time_exceeded",
    cycle_expansion: "scope_escalation",
    retry_expansion: "scope_escalation",
    path_out_of_scope: "path_violation",
    security_expansion: "security_escalation",
    credential_change: "credential_escalation",
    irreversible_side_effect: "irreversible_expansion",
    expired: "authority_expired",
});
export function decideEngineAuthority(run, input) {
    if (run.state !== "autonomous_run") {
        return Object.freeze({ outcome: "terminate", code: "authority_violation", reason: `run_state_${run.state}` });
    }
    const decision = evaluateAuthority(run.authorityEnvelope, input.request);
    if (decision.outcome === "approve") {
        return Object.freeze({ outcome: "continue", kind: input.kind, auditCode: "autonomous_in_envelope" });
    }
    return Object.freeze({
        outcome: "terminate",
        code: terminalCodeByReason[decision.reason] ?? "authority_violation",
        reason: decision.reason,
    });
}
/**
 * Deterministic post-confirmation controller. It has no callback for asking a
 * person and no paused state: every request either continues inside the
 * immutable envelope or moves the run to a terminal failure.
 */
export class AutonomousControlEngine {
    options;
    now;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }
    acquire(runId) {
        const run = this.requireRun(runId);
        if (run.state !== "autonomous_run")
            throw new Error(`Run ${runId} is not autonomous`);
        const lease = this.options.repository.acquireLease(runId, this.options.ownerId, this.options.leaseTtlMs, this.now(), authorityEnvelopeDigest(run.authorityEnvelope));
        if (!lease)
            throw new Error(`Run ${runId} already has a live executor`);
        return lease;
    }
    decide(runId, lease, input) {
        const run = this.requireFencedRun(runId, lease);
        const decision = decideEngineAuthority(run, input);
        this.options.repository.recordEngineDecision(runId, lease, decision, this.now());
        if (decision.outcome === "terminate") {
            this.options.repository.transitionFenced({
                runId,
                expectedVersion: run.version,
                to: "failed",
                actor: "autonomous_engine",
                reason: decision.reason,
                terminalCode: decision.code,
                lease,
                at: this.now(),
            });
        }
        return decision;
    }
    evaluateReadiness(runId, lease, input) {
        const run = this.requireFencedRun(runId, lease);
        const result = evaluatePrReadiness(input, this.now());
        this.options.repository.recordReadiness(runId, lease, result, this.now());
        this.options.repository.transitionFenced({
            runId,
            expectedVersion: run.version,
            to: result.ready ? "pr_ready" : "failed",
            actor: "autonomous_engine",
            reason: result.ready ? "strict_readiness_passed" : result.failures.join(","),
            ...(result.ready ? {} : { terminalCode: result.failures[0] ?? "readiness_failed" }),
            lease,
            at: this.now(),
        });
        return result;
    }
    checkpoint(runId, lease, checkpointSha, payloadDigest) {
        this.requireFencedRun(runId, lease);
        this.options.repository.writeVerifiedCheckpoint(runId, lease, checkpointSha, payloadDigest, this.now());
    }
    requireRun(runId) {
        const run = this.options.repository.getRun(runId);
        if (!run)
            throw new Error(`Unknown control run ${runId}`);
        return run;
    }
    requireFencedRun(runId, lease) {
        if (lease.runId !== runId || !this.options.repository.validateLease(lease, this.now())) {
            throw new Error(`Stale executor write rejected for ${runId}`);
        }
        return this.requireRun(runId);
    }
}
//# sourceMappingURL=engine.js.map