/**
 * beta.91 (Fix 2): safe parallel dispatch of independent sub-tasks.
 *
 * PROBLEM: sub-tasks run strictly serially (subtask_concurrency default 1) even
 * when several touch disjoint files with no dependency between them (e.g. the
 * DR/BCP run's Prisma-models, sidebar, and POI-generalise sub-tasks could all
 * run at once). Wall-clock is dominated by this serialisation.
 *
 * The dispatcher in loop.ts ALREADY supports bounded concurrency + dependsOn
 * gating -- the only reason it runs serial is concurrency=1. Naively bumping
 * the default is unsafe: two workers writing the SAME file in the SAME worktree
 * would race (they share one on-disk worktree + git index). So this module adds
 * the missing guard: only let two sub-tasks run concurrently when their
 * declared file scopes are DISJOINT.
 *
 * DESIGN: `canDispatchConcurrently(candidate, inFlightSubTasks)` returns false
 * when the candidate's `filesLikelyTouched` intersects any in-flight sub-task's
 * scope (or when either side declares no files -- unknown scope = treat as
 * conflicting, i.e. force serial for that pair). The loop consults this in the
 * fill-loop so it never starts a second worker that could clobber a running
 * one. Dependency ordering (dependsOn) is still enforced separately by the
 * existing topo gate; this only adds the file-overlap guard on top.
 *
 * SAFETY:
 *   - Opt-in via effective concurrency. `resolveEffectiveConcurrency` returns 1
 *     (serial, beta.90 behaviour) unless `subtask_concurrency > 1` AND the
 *     feature flag is on.
 *   - Unknown scope (empty filesLikelyTouched on either side) => NOT safe to
 *     parallelise => serial for that pair. We never guess a worker is isolated.
 *   - A file appearing in two scopes forces those two serial, but unrelated
 *     pairs still overlap -> partial parallelism, never an unsafe write race.
 *   - Verify/adversary safety net unchanged.
 *
 * Pure/deterministic.
 */
export interface ParallelSubTask {
    seq: number;
    filesLikelyTouched?: string[];
}
/** Do two file-scope sets intersect? */
export declare function fileScopesOverlap(a: string[] | undefined, b: string[] | undefined): boolean;
/**
 * May `candidate` start while `inFlight` sub-tasks are running?
 * Requires a KNOWN, DISJOINT scope vs every in-flight sub-task.
 *
 *  - candidate with no declared files -> false (unknown scope, force serial).
 *  - any in-flight with no declared files -> false (unknown scope, force serial).
 *  - any file overlap -> false.
 *  - otherwise -> true.
 */
export declare function canDispatchConcurrently(candidate: ParallelSubTask, inFlight: ParallelSubTask[]): boolean;
/**
 * Resolve the effective concurrency ceiling for a cycle.
 * Returns 1 (serial) unless the feature is enabled AND subtask_concurrency > 1.
 */
export declare function resolveEffectiveConcurrency(opts: {
    subtaskConcurrency: number;
    parallelEnabled: boolean;
}): number;
//# sourceMappingURL=parallel-safety.d.ts.map