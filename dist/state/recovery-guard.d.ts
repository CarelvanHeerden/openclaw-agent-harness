/**
 * beta.132: should a recovered session be re-driven, or surfaced to a human?
 *
 * THE BUG THIS EXISTS FOR. `recovery.auto_resuming` re-drives `loop.run`, and
 * `loop.run` re-plans from scratch. Not "resumes" -- re-plans: a fresh lead
 * call and a fresh scout (mean $6.24 across this repo's own audit history),
 * `cycles_ran` back to zero, and every completed sub-task re-run against a
 * branch that already carries its commits. b81 stopped this for `executing`.
 * Every other phase fell straight through.
 *
 * It fires unattended, on plugin boot, for any session left in a non-terminal
 * status. Restarting the container is how a new build gets installed, so a
 * boot landing on a live run is routine rather than exotic -- session 2b4c1d33
 * was sitting at `planning` holding a $6.03 plan and two finished cycles when
 * one picked it up.
 *
 * The decision lives here, apart from the bootstrap wiring it serves, because
 * a rule about spending money should be readable and testable without standing
 * up a plugin.
 */
export type RecoveryResumeVerdict = {
    resume: true;
}
/** The work is already on the remote; record a verdict and stop. */
 | {
    resume: false;
    outcome: "ship_for_review";
}
/** Nothing was pushed; keep the worktree so the commits survive the heal. */
 | {
    resume: false;
    outcome: "preserve_worktree";
};
export interface RecoveryResumeInput {
    /** `loop.recovery_replan_guard`. False restores the pre-beta.132 re-drive. */
    enabled: boolean;
    /** Does a persisted plan exist? Without one there is nothing to re-plan over. */
    hasPlan: boolean;
    /** Completed cycles. Zero means no worker spend to protect yet. */
    cyclesRan: number;
    /** `sessions.final_pr_url`, if the run got as far as opening one. */
    prUrl: string;
}
export declare function decideRecoveryResume(input: RecoveryResumeInput): RecoveryResumeVerdict;
//# sourceMappingURL=recovery-guard.d.ts.map