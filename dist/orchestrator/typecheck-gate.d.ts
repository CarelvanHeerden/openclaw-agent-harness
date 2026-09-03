/**
 * beta.111: make a branch that does not compile fail the review.
 *
 * ProjectThanos PR #932 has been through three revise runs. Its head does not
 * typecheck:
 *
 *   src/app/api/grc/continuity-exercises/[id]/route.ts(124,14): error TS2551:
 *   Property 'ownerUserId' does not exist on type 'ContinuityExerciseUpdateInput'.
 *
 * The b108 revise introduced it (`ac1dc948`, the ownerUserId reassignment
 * guard) and nothing has caught it since, because the adversary reviews the
 * DIFF, not the compiler. A worker's own verify sub-task did surface it, but
 * nothing gated on that, so it was a note in a report nobody acted on. CI is
 * green on the PR -- that repo's CI does not run a typecheck -- so "let CI
 * catch it" does not hold either.
 *
 * The cheap correct scope: report errors in files THIS BRANCH CHANGED. That
 * needs one typecheck run, not a second one at the base commit to diff
 * against, and it keeps a repo with pre-existing breakage usable -- #932 also
 * carries 71 unrelated failing tests from a React version mismatch, and a gate
 * that blocked on those would block every run forever. An error in a file you
 * just edited is yours to deal with either way.
 */
import type { ReviewFinding } from "./adversary.js";
export interface TscError {
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
}
export declare function parseTscErrors(output: string): TscError[];
/**
 * Errors in files this branch changed. Uses the shared tolerant matcher so a
 * route-group-normalised or differently-rooted path still lines up with the
 * committed-file list, the same way every other per-file check does.
 */
export declare function errorsInChangedFiles(errors: TscError[], changedFiles: string[]): TscError[];
/**
 * `high`, not `medium`. A branch that does not compile is not mergeable on
 * anybody's reading, and `high` is in merge-recommendation's blocking set, so
 * this blocks the merge even if the adversary passes. It is also
 * diff-addressable and above medium, so isBlockingFinding counts it and the
 * beta.109 no-blocking-findings gate keeps cycling instead of shipping.
 */
export declare function buildTypecheckFinding(errors: TscError[], script: string): ReviewFinding;
//# sourceMappingURL=typecheck-gate.d.ts.map