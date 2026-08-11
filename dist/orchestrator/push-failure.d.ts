/**
 * beta.119: WHAT A FAILED PUSH COSTS, AND WHAT TO SAY ABOUT IT.
 *
 * The CI-optimisation run against ProjectThanos did the work correctly -- one
 * line in `.github/workflows/ci.yml`, committed in the worktree -- and then
 * died at the push with:
 *
 *   refusing to allow an OAuth App to create or update workflow
 *   `.github/workflows/ci.yml` without `workflow` scope
 *
 * The loop routed that to `finaliseFailed`, which releases the worktree. The
 * branch and the commit went with it. Nothing about the failure was
 * unrecoverable -- the token needed one more scope, and the diff was one line
 * -- but the only copy of the work had been deleted by the time anyone read
 * the error.
 *
 * b62 already built `finaliseFailedPreserveWorktree` for exactly this reason
 * ("the b60-attempt-2 failure discarded 8 good commits precisely because the
 * crash path released the worktree"). It was wired to review crashes and never
 * to push failures, which is the one terminal where the commits provably exist
 * ONLY on local disk -- a push failure means, by definition, that nothing
 * reached the remote.
 *
 * This module classifies the error so the operator is told which of those it
 * hit and what to do next. Pure: no fs, no git, no network.
 */
export type PushFailureKind = "missing_workflow_scope" | "auth" | "protected_branch" | "non_fast_forward" | "network" | "unknown";
export interface PushFailureDiagnosis {
    kind: PushFailureKind;
    /** Would the same work succeed once the operator fixes something? */
    recoverable: boolean;
    /** One-line statement of what went wrong. */
    summary: string;
    /** What the operator should do, given the work is preserved on disk. */
    remedy: string;
}
/** Classify a push / PR-open error. Never throws. */
export declare function diagnosePushFailure(err: unknown): PushFailureDiagnosis;
/**
 * The operator-facing terminal message. Names the branch and the worktree,
 * because the entire point is that the work still exists and can be recovered.
 */
export declare function describePreservedPushFailure(input: {
    diagnosis: PushFailureDiagnosis;
    branch: string;
    worktreePath: string;
    error: string;
}): string;
//# sourceMappingURL=push-failure.d.ts.map