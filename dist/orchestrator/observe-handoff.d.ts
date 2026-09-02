/**
 * beta.134 (observe-handoff): carry an `observe` sub-task's report into the
 * sub-tasks that depend on it.
 *
 * A plan that opens with an observe probe ("map the architecture, report the
 * real paths") and then implements against it was, until now, only half wired.
 * The probe ran, the worker wrote a detailed report, and the report went
 * nowhere: `emitObserveCompleted` audits the file list and the cost, the
 * `discoveredRealPaths` set keeps the PATHS the probe happened to touch, and
 * the prose -- the part that says which module owns what and which convention
 * the repo actually follows -- was dropped on the floor.
 *
 * The next sub-task was then handed a prompt that says, of the lead's
 * `workerContext`, "TRUST and USE this context; do NOT re-explore the repo to
 * re-derive it", plus an intent written by the lead in terms of "apply the
 * paths reported by sub-task 1". So the worker was told to apply findings it
 * had never been shown and forbidden from going to look for them. That is not
 * an under-specified task, it is a contradictory one, and a model that resolves
 * it by writing a confident summary of edits it never made is doing the only
 * thing the prompt leaves room for. Sonnet mostly ignored the "do NOT
 * re-explore" clause and re-derived the facts, which hid the hole; gpt-5.6
 * obeyed it and the hole became a run that shipped nothing while reporting
 * success.
 *
 * This module is the missing half: the loop records each observe sub-task's
 * final message, and every later sub-task that declares `dependsOn` on it (or,
 * absent an explicit `dependsOn`, any earlier observe in the run) gets the
 * report verbatim in its prompt, under a budget.
 */
/** One completed observe sub-task's report, as handed to a dependent. */
export interface ObserveReport {
    /** The observe sub-task's `seq`, so the dependent can name its source. */
    seq: number;
    title: string;
    /** The worker's final message: the probe's findings, verbatim. */
    report: string;
}
/**
 * Per-report and total char budgets.
 *
 * An observe report is prose a model wrote about a repo, so it is bounded in
 * practice (the StitchGuard probe that motivated this ran 7,152 chars) but not
 * in principle. These caps mirror the `workerContext` excerpt budgets: enough
 * that a real architecture map survives intact, small enough that a runaway
 * probe cannot push the implementing worker's prompt past its context or its
 * cost forecast.
 */
export declare const OBSERVE_REPORT_MAX_CHARS = 8000;
export declare const OBSERVE_REPORTS_TOTAL_MAX_CHARS = 16000;
/**
 * Which recorded observe reports belong in THIS sub-task's prompt.
 *
 * `dependsOn` is authoritative when the lead set it: those and only those.
 * When it is absent the fallback is every observe report from an EARLIER seq,
 * which is deliberately generous -- the lead omitting `dependsOn` is the common
 * case (it is optional in the schema and plans routinely skip it), and the
 * failure this fixes came from a worker having too little, never too much.
 * The total budget below is what keeps "generous" from meaning "unbounded".
 *
 * A sub-task never receives its own report, so a re-run observe on a revise
 * cycle is not fed its previous answer.
 */
export declare function selectObserveReports(subTask: {
    seq: number;
    dependsOn?: number[];
}, recorded: ReadonlyMap<number, ObserveReport>): ObserveReport[];
/**
 * Render selected reports into a prompt block. Returns "" when there are none,
 * so a plan without an observe step produces a byte-identical prompt.
 */
export declare function renderObserveReportsBlock(reports: readonly ObserveReport[]): string;
//# sourceMappingURL=observe-handoff.d.ts.map