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
export function decideRecoveryResume(input) {
    if (!input.enabled)
        return { resume: true };
    // A plan on its own is not enough to refuse on. A session that planned and
    // then died before running anything has nothing but the plan to lose, and
    // re-planning it is exactly the cheap recovery this path was built for.
    // What must not be thrown away is finished WORK.
    if (!input.hasPlan)
        return { resume: true };
    if (!Number.isFinite(input.cyclesRan) || input.cyclesRan < 1)
        return { resume: true };
    return { resume: false, outcome: input.prUrl.trim() ? "ship_for_review" : "preserve_worktree" };
}
//# sourceMappingURL=recovery-guard.js.map