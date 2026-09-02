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
export const OBSERVE_REPORT_MAX_CHARS = 8000;
export const OBSERVE_REPORTS_TOTAL_MAX_CHARS = 16000;

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
export function selectObserveReports(
  subTask: { seq: number; dependsOn?: number[] },
  recorded: ReadonlyMap<number, ObserveReport>,
): ObserveReport[] {
  if (recorded.size === 0) return [];
  const wanted =
    subTask.dependsOn && subTask.dependsOn.length > 0
      ? subTask.dependsOn.filter((s) => s !== subTask.seq)
      : [...recorded.keys()].filter((s) => s < subTask.seq);
  const out: ObserveReport[] = [];
  for (const seq of [...new Set(wanted)].sort((a, b) => a - b)) {
    const r = recorded.get(seq);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Render selected reports into a prompt block. Returns "" when there are none,
 * so a plan without an observe step produces a byte-identical prompt.
 */
export function renderObserveReportsBlock(reports: readonly ObserveReport[]): string {
  if (reports.length === 0) return "";
  const lines: string[] = [
    ``,
    `## Findings from earlier sub-tasks (READ THIS FIRST)`,
    `These are the VERBATIM reports of the investigation sub-tasks this one`,
    `depends on. When your intent or success criteria refer to "the paths",`,
    `"the conventions", or "the architecture reported by sub-task N", THIS is`,
    `what they refer to. Nothing else in this prompt contains those findings.`,
    `Use the exact paths, names, and conventions below rather than inventing`,
    `plausible ones. If something you need is genuinely NOT here, go and read`,
    `the repo to find it -- do not guess, and do not describe an edit you have`,
    `not actually made.`,
  ];
  let total = 0;
  for (const r of reports) {
    if (total >= OBSERVE_REPORTS_TOTAL_MAX_CHARS) {
      lines.push(``, `(remaining sub-task reports omitted: total char budget reached)`);
      break;
    }
    const budget = Math.min(OBSERVE_REPORT_MAX_CHARS, OBSERVE_REPORTS_TOTAL_MAX_CHARS - total);
    const body = r.report.slice(0, budget);
    const truncated =
      r.report.length > budget ? `\n... (truncated, ${r.report.length - budget} chars omitted)` : "";
    lines.push(``, `### Report from sub-task ${r.seq}: ${r.title}`, body + truncated);
    total += body.length;
  }
  return lines.join("\n");
}

/** The small audit-row shape needed to recover reports after a pause/restart. */
export interface ObserveReportAuditRow {
  event: string;
  payload: string;
}

/**
 * Rebuild the latest report for every observe sub-task from newest-first audit
 * rows. New rows carry the full capped report; `worker_end_turn` is the
 * backwards-compatible beta.134 fallback.
 */
export function recoverObserveReports(
  subTasks: ReadonlyArray<{ seq: number; title: string; taskMode?: string }>,
  rows: readonly ObserveReportAuditRow[],
): Map<number, ObserveReport> {
  const out = new Map<number, ObserveReport>();
  const observeBySeq = new Map(
    subTasks
      .filter((st) => st.taskMode === "observe")
      .map((st) => [st.seq, st] as const),
  );
  for (const row of rows) {
    let payload: {
      seq?: number;
      title?: string;
      report?: string;
      finalMessage?: string;
    };
    try {
      payload = JSON.parse(row.payload) as typeof payload;
    } catch {
      continue;
    }
    const seq = payload.seq;
    if (typeof seq !== "number" || out.has(seq)) continue;
    const st = observeBySeq.get(seq);
    if (!st) continue;
    const report = (
      row.event === "loop.observe_report_recorded"
        ? payload.report
        : row.event === "loop.worker_end_turn"
          ? payload.finalMessage
          : undefined
    )?.trim();
    if (!report) continue;
    out.set(seq, {
      seq,
      title: payload.title?.trim() || st.title,
      report: report.slice(0, OBSERVE_REPORT_MAX_CHARS),
    });
  }
  return out;
}
