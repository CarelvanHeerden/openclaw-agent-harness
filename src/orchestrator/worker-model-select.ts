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

/**
 * Boilerplate/scaffolding intent cues. Deliberately narrow -- these are things
 * that pattern-follow an existing file with no cross-file reasoning. NOT
 * included: anything about "route"/"api"/"auth"/"logic"/"handler"/"proxy"
 * (those carry judgment) or "test" (tests need care).
 */
const MECHANICAL_INTENT_RE =
  /(\bsidebar\b|prisma (models?|schema|back-?relations?)|(add|create|generate).{0,40}\bmigrations?\b|prisma migrate|\bscaffold\b|\bboilerplate\b|barrel (export|file)|re-?export|\bindex (export|barrel)\b|generate(d)? (types|client)|import .{0,20}\bicon\b)/i;

/**
 * Cues that a sub-task is DEFINITELY not mechanical even if a boilerplate word
 * appears. If any hit, we treat it as standard/complex.
 */
const NON_MECHANICAL_RE =
  /\b(api|route|endpoint|handler|authz|auth|rbac|permission|upload|download|proxy|blob|multipart|business ?logic|algorithm|refactor|migrate .* data|backfill|test|spec|debug|fix (a )?bug|security|validation logic)\b/i;

/** Is this sub-task mechanical? Honour lead hint first, then heuristic. */
export function isMechanicalSubTask(st: ModelSelectSubTask): boolean {
  if (st.complexity === "mechanical") return true;
  if (st.complexity === "standard" || st.complexity === "complex") return false;

  // Heuristic fallback (only when the lead gave no hint).
  const text = `${st.title ?? ""} ${st.intent ?? ""}`;
  if (NON_MECHANICAL_RE.test(text)) return false;
  if (!MECHANICAL_INTENT_RE.test(text)) return false;

  // Conservative scope gate: mechanical scaffolding touches a SMALL number of
  // files (typically 1). More than 2 files -> likely broader -> not mechanical.
  const files = (st.filesLikelyTouched ?? []).filter(Boolean);
  if (files.length > 2) return false;

  return true;
}

/**
 * Return the model id to dispatch this sub-task's worker on.
 * Falls back to the default worker model whenever the mechanical model is
 * unset or the sub-task is not mechanical.
 */
export function selectWorkerModel(st: ModelSelectSubTask, models: ModelSelectConfig): string {
  const mech = models.worker_mechanical?.trim();
  if (mech && isMechanicalSubTask(st)) return mech;
  return models.worker;
}
