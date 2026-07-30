/**
 * beta.91 (Fix 3): pick a cheaper/faster model for MECHANICAL sub-tasks.
 *
 * PROBLEM (Staging's beta.90 DR/BCP smoke): the mechanical sub-tasks
 * (Prisma models 38s, migration 31s, sidebar 26s, POI-generalise 34s) each run
 * on the (opus) worker model. They are pure scaffolding -- pattern-follow an
 * existing file, no real judgment -- and would be <15s on a smaller model.
 * Meanwhile the lead + adversary (where judgment lives) stay on the strong
 * model, untouched.
 *
 * FIX: a per-sub-task model override. When `models.worker_mechanical` is
 * configured AND the sub-task looks mechanical (observe-only probes are NOT
 * mechanical -- they read; scaffolding IS), dispatch that sub-task on the
 * mechanical model. Otherwise fall back to `models.worker` (the default),
 * so an un-configured harness behaves EXACTLY as beta.90.
 *
 * SAFETY:
 *   - Opt-in: no `worker_mechanical` set -> always returns the default worker
 *     model (zero behaviour change).
 *   - The lead planner may (beta.91) tag a sub-task `complexity:"mechanical"`.
 *     If it does, we honour it. If it does NOT, we use a CONSERVATIVE heuristic
 *     that only classifies a sub-task mechanical when it is HIGHLY likely to be
 *     scaffolding (single narrow file, known-boilerplate intent) -- when in
 *     doubt we return the strong worker model (never downgrade a risky task).
 *   - The verify/adversary safety net is unchanged: a mechanical sub-task's
 *     output is still verified + reviewed, so a weaker model that gets it wrong
 *     is caught, not shipped.
 *
 * Pure/deterministic. No fs/git/SDK.
 */
export type SubTaskComplexity = "mechanical" | "standard" | "complex";
export interface ModelSelectSubTask {
    intent?: string;
    title?: string;
    filesLikelyTouched?: string[];
    taskMode?: string;
    /** beta.91: optional lead-provided hint. Authoritative when present. */
    complexity?: SubTaskComplexity;
}
export interface ModelSelectConfig {
    /** the default (strong) worker model. */
    worker: string;
    /** optional cheaper model for mechanical sub-tasks. Absent = feature off. */
    worker_mechanical?: string;
}
/** Is this sub-task mechanical? Honour lead hint first, then heuristic. */
export declare function isMechanicalSubTask(st: ModelSelectSubTask): boolean;
/**
 * Return the model id to dispatch this sub-task's worker on.
 * Falls back to the default worker model whenever the mechanical model is
 * unset or the sub-task is not mechanical.
 */
export declare function selectWorkerModel(st: ModelSelectSubTask, models: ModelSelectConfig): string;
//# sourceMappingURL=worker-model-select.d.ts.map