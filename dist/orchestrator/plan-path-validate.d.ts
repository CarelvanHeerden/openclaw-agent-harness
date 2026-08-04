/**
 * beta.101: PLAN-TIME DETECTION OF FICTIONAL PATHS.
 *
 * The b100 smoke's whole failure cascade started with one invented path. The
 * lead planned "add a GRC sidebar nav entry" against
 * `src/components/layout/grc-nav.tsx` -- a file that does not exist in a
 * directory that does not exist. The worker did the right thing (found the real
 * nav in `src/components/ui/sidebar.tsx` and edited it correctly), verification
 * failed against the fictional contract path, and the run burned a
 * clarification round-trip, a re-plan and a review turn on a plan defect that
 * was detectable before any worker started.
 *
 * The discriminator is the PARENT DIRECTORY, not the file. A plan naming a file
 * that does not exist yet is completely normal -- most sub-tasks create files.
 * A plan naming a file whose parent directory ALSO does not exist is either
 * inventing a convention the repo does not use, or genuinely creating a new
 * module. Distinguishing those two needs intent, so this never blocks: it flags
 * the path so the worker's brief can carry "this path is unverified; locate the
 * real one before assuming it".
 */
export interface SuspectPlanPath {
    path: string;
    /** The absent ancestor directory that makes this path suspect. */
    missingDir: string;
}
/**
 * Pure: given plan paths and the repo's tracked file list, return the paths
 * whose file is absent AND whose parent directory contains nothing at all.
 *
 * Paths at the repo root are never flagged (the root always exists), and a path
 * that names an existing file is never flagged regardless of anything else.
 */
export declare function findSuspectPlanPaths(planPaths: string[], repoFiles: string[]): SuspectPlanPath[];
/**
 * Advisory note folded into the worker dispatch context. Phrased to redirect
 * rather than forbid: the path may be a legitimately new module, and the worker
 * is the one with the repo in front of it.
 */
export declare function describeSuspectPlanPaths(suspects: SuspectPlanPath[]): string;
//# sourceMappingURL=plan-path-validate.d.ts.map