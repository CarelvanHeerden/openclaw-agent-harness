import { authorityEnvelopeDigest, evaluateAuthority } from "./authority.js";
import type { ControlRepository, RunLease } from "./repository.js";
import type { AuthorityRequest, ControlRun } from "./types.js";
import { evaluatePrReadiness, type PrReadinessInput, type PrReadinessResult } from "./readiness.js";

export const AUTONOMOUS_CONTINUATION_KINDS = [
  "implementation_choice",
  "replan",
  "retry",
  "repair",
  "verification_retry",
  "review_repair",
] as const;

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
] as const;

export type AutonomousContinuationKind = (typeof AUTONOMOUS_CONTINUATION_KINDS)[number];
export type TerminalAuthorityCode = (typeof TERMINAL_AUTHORITY_CODES)[number];

export type EngineAuthorityDecision = Readonly<
  | { outcome: "continue"; kind: AutonomousContinuationKind; auditCode: "autonomous_in_envelope" }
  | { outcome: "terminate"; code: TerminalAuthorityCode; reason: string }
>;

export interface DecideEngineAuthorityInput {
  readonly kind: AutonomousContinuationKind;
  readonly request: AuthorityRequest;
}

const terminalCodeByReason: Readonly<Record<string, TerminalAuthorityCode>> = Object.freeze({
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

export function decideEngineAuthority(run: ControlRun, input: DecideEngineAuthorityInput): EngineAuthorityDecision {
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
export class AutonomousControlEngine {
  private readonly now: () => number;

  constructor(private readonly options: AutonomousEngineOptions) {
    this.now = options.now ?? Date.now;
  }

  acquire(runId: string): RunLease {
    const run = this.requireRun(runId);
    if (run.state !== "autonomous_run") throw new Error(`Run ${runId} is not autonomous`);
    const lease = this.options.repository.acquireLease(
      runId,
      this.options.ownerId,
      this.options.leaseTtlMs,
      this.now(),
      authorityEnvelopeDigest(run.authorityEnvelope),
    );
    if (!lease) throw new Error(`Run ${runId} already has a live executor`);
    return lease;
  }

  decide(runId: string, lease: RunLease, input: DecideEngineAuthorityInput): EngineAuthorityDecision {
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

  evaluateReadiness(runId: string, lease: RunLease, input: PrReadinessInput): PrReadinessResult {
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

  checkpoint(runId: string, lease: RunLease, checkpointSha: string, payloadDigest: string): void {
    this.requireFencedRun(runId, lease);
    this.options.repository.writeVerifiedCheckpoint(runId, lease, checkpointSha, payloadDigest, this.now());
  }

  private requireRun(runId: string): ControlRun {
    const run = this.options.repository.getRun(runId);
    if (!run) throw new Error(`Unknown control run ${runId}`);
    return run;
  }

  private requireFencedRun(runId: string, lease: RunLease): ControlRun {
    if (lease.runId !== runId || !this.options.repository.validateLease(lease, this.now())) {
      throw new Error(`Stale executor write rejected for ${runId}`);
    }
    return this.requireRun(runId);
  }
}
