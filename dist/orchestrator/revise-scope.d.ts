/**
 * beta.91 (Fix 1): cycle-scoping for revise cycles.
 *
 * PROBLEM (Staging's beta.90 DR/BCP smoke, session baa8ba08): a revise cycle
 * (cycle > 1) re-ran ALL 12 sub-tasks even though 8 of them were
 * `subtask_revise_no_change` -- the worker re-checked an already-correct commit
 * and did nothing. That is ~5 min of pure "spin up a worker, confirm no change
 * needed, tear down" overhead per cycle, on top of a full adversary review that
 * scales with sub-task count.
 *
 * FIX: on a revise cycle, a sub-task whose file scope does NOT intersect ANY
 * finding's file is not something the current review is asking to change --
 * skip it (its prior-cycle commit is already correct and part of the branch).
 * Only re-run sub-tasks that a finding actually targets, PLUS anything the
 * skipped set depends on transitively is preserved (we never skip a sub-task a
 * KEPT sub-task depends on -- dependency safety first).
 *
 * SAFETY (why this can only reduce, never break, correctness):
 *   1. Scoped ONLY to cycle > 1 with review findings present. Cycle 1 is
 *      untouched.
 *   2. A finding with NO resolvable file (bare/absent `file`) makes the whole
 *      cycle UNSCOPABLE -> we skip the optimisation entirely and run every
 *      sub-task (matches beta.86 `strict_no_targets` conservatism -- we cannot
 *      prove a sub-task is irrelevant, so we run it).
 *   3. A sub-task with NO `filesLikelyTouched` is UNSCOPABLE for itself -> it is
 *      always KEPT (we cannot prove it is irrelevant).
 *   4. We NEVER skip a sub-task that a kept sub-task `dependsOn` (transitive) --
 *      the kept one may need its output committed/on-disk.
 *   5. This is purely which-sub-tasks-to-run; the adversary still reviews the
 *      WHOLE branch diff afterwards, so a wrongly-skipped file would still be
 *      caught by review, not silently shipped.
 *   6. (beta.91 QUESTION-8, Staging pass 1) An unscopable-for-itself sub-task S
 *      (empty filesLikelyTouched, e.g. a "verify feature complete" probe) that
 *      LOGICALLY reads state written by a skipped scaffolding sub-task is safe:
 *      the scaffolding sub-task's file is ALREADY COMMITTED from the prior
 *      cycle, so the branch on-disk state S reads is correct even though the
 *      scaffolding sub-task was not re-executed. And a cycle-1 sub-task that
 *      FAILED is forced back into re-execution by the loop's worker-deviation /
 *      failure path independent of scoping, so a stale file is never preserved.
 *      Hence dependency closure only needs the FORWARD dependsOn edges (below).
 *
 * All pure/deterministic. No fs, no git, no SDK.
 */
/** Minimal shape we read off a plan sub-task (structural, avoids a hard type import). */
export interface ScopeSubTask {
    seq: number;
    filesLikelyTouched?: string[];
    dependsOn?: number[];
    taskMode?: string;
}
/** Minimal shape we read off a review finding. */
export interface ScopeFinding {
    file?: string | null;
    /** beta.92: dimension drives the unscopable-gate exemption for meta findings. */
    dimension?: string | null;
}
export interface ReviseScopeResult {
    /** true when the optimisation applied (some sub-tasks were skipped). */
    scoped: boolean;
    /** seq numbers to RUN this cycle. */
    runSeqs: number[];
    /** seq numbers to SKIP (mark completed_no_change without a worker turn). */
    skipSeqs: number[];
    /** why the optimisation did NOT apply, when scoped=false. */
    reason?: "not_revise_cycle" | "no_findings" | "unscopable_findings" | "all_relevant";
    /** the normalised set of finding file basenames/paths used for matching (debug/audit). */
    findingFiles: string[];
}
/**
 * Does a sub-task's file scope intersect the finding-file set?
 *
 * Matching is PATH-STRUCTURAL (suffix either direction) for findings that carry
 * a directory component -- so a finding `src/app/api/.../route.ts` matches a
 * sub-task listing the same fuller path (or a partial adversary path that is a
 * suffix of it), but does NOT match a DIFFERENT `.../[id]/route.ts` sibling that
 * merely shares the `route.ts` basename. This is the beta.74/87 strict-contract
 * lesson: a bare basename over-targets siblings (route.ts / index.ts / page.tsx
 * are everywhere), so a basename-only match is used ONLY when the finding itself
 * is a bare filename with no directory (the adversary gave just a name). We err
 * toward keeping a sub-task on genuine ambiguity, never toward wrongly skipping.
 */
export declare function subTaskIntersectsFindings(files: string[], findingFilesNorm: string[], bareFindingBasenames: Set<string>): boolean;
/**
 * Compute which sub-tasks to run vs skip on a revise cycle.
 *
 * @param subTasks the (revise-spec-refreshed or raw) plan sub-tasks
 * @param findings the previous review's findings
 * @param cycle current cycle (1-based)
 */
export declare function computeReviseScope(subTasks: ScopeSubTask[], findings: ScopeFinding[] | undefined, cycle: number): ReviseScopeResult;
//# sourceMappingURL=revise-scope.d.ts.map