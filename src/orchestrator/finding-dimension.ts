/**
 * beta.116: one canonical vocabulary for finding dimensions.
 *
 * The adversary's system prompt lists its review axes in prose:
 *
 *   1. Spec compliance: ...
 *   2. Codebase fit: does it match existing patterns/conventions?
 *   3. Quality: ...
 *
 * and its TypeScript interface declares `dimension: "spec" | "fit" | "quality"
 * | "security" | "runtime"`. A TypeScript union is a compile-time claim about
 * our own code, not a runtime constraint on a language model, and the model
 * reads the prose heading rather than the enum. Across the local runs it
 * emitted `codebase-fit` twenty-one times and `fit` once.
 *
 * Nothing validated that, and `codebase-fit` matched neither of the two sets
 * the router consults -- `DIFF_ADDRESSABLE` (spec|quality|security) nor
 * `META_DIMENSIONS` (fit|runtime) -- so those findings fell into a third state
 * nobody designed: broadcast to every sub-task as context, targeted at none,
 * and excluded from b107's orphan adoption because that gate also tests
 * `isDiffAddressable`. The finding was preserved, unactionable, and re-raised
 * every cycle until the run shipped with it open.
 *
 * The b115 DR/BCP run (session 1d5db24b) shows the cost. Five of its eight
 * mapping misses were `codebase-fit` findings naming concrete files:
 *
 *   cycle 2  medium  src/app/api/grc/continuity-exercises/route.ts
 *                    "POST creates a ContinuityExercise with no ActivityLog"
 *   cycle 2  medium  src/app/api/grc/continuity-exercises/[id]/route.ts
 *                    "PUT updates with no ActivityLog"
 *   cycle 2  medium  src/lib/help/help-content.ts
 *                    "New page and sidebar entry added without updating help-content.ts"
 *   cycle 3  medium  src/lib/help/help-content.ts   (again)
 *   cycle 3  low     src/app/api/grc/continuity-exercises/[id]/route.ts
 *
 * The first two name files that sub-tasks in that very plan owned and had just
 * written. Structural targeting would have routed them to the right worker in
 * one hop; instead the router never entered the targeting branch at all. The
 * third is the exact scenario b107's orphan adoption was written for -- its
 * doc comment names `src/lib/help/help-content.ts` as the worked example -- and
 * adoption could never fire for it, because a `fit` finding is not
 * diff-addressable. b107 could not fix its own motivating case.
 *
 * Two rules, applied everywhere:
 *
 *   1. Normalise the dimension before anyone tests it, so a label the model
 *      invents is understood rather than silently dropped into a dead branch.
 *   2. Prefer evidence over labels. A finding that names a file can be acted on
 *      by editing that file, whatever it calls itself; see `isRoutable`.
 *
 * Pure/deterministic.
 */

/** The five dimensions the rest of the harness reasons about. */
export type CanonicalDimension = "spec" | "fit" | "quality" | "security" | "runtime";

const CANONICAL = new Set<string>(["spec", "fit", "quality", "security", "runtime"]);

/**
 * Exact aliases observed in real runs, plus near neighbours worth pinning.
 * Consulted after separator folding, so `codebase_fit` and `codebase fit`
 * arrive here as `codebase-fit`.
 */
const ALIASES: Record<string, CanonicalDimension> = {
  "codebase-fit": "fit",
  "code-fit": "fit",
  "codebase": "fit",
  "convention": "fit",
  "conventions": "fit",
  "consistency": "fit",
  "code-quality": "quality",
  "maintainability": "quality",
  "readability": "quality",
  "spec-compliance": "spec",
  "specification": "spec",
  "requirement": "spec",
  "requirements": "spec",
  "correctness": "spec",
  "sec": "security",
  "vulnerability": "security",
  "runtime-behaviour": "runtime",
  "runtime-behavior": "runtime",
};

/**
 * Fold a model-supplied dimension onto one of the five canonical values.
 *
 * Returns "" for something genuinely unrecognisable, which callers must treat
 * as "no opinion" -- routing then falls back to the evidence (does it name a
 * file?) rather than guessing a dimension and acting on the guess.
 */
export function normaliseDimension(raw: string | null | undefined): CanonicalDimension | "" {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) return "";
  if (CANONICAL.has(s)) return s as CanonicalDimension;
  const alias = ALIASES[s];
  if (alias) return alias;
  // Last resort: a compound label that CONTAINS a canonical word, e.g. a future
  // "security-hardening" or "spec-gap". Ordered most-specific-first so
  // "code-quality-and-security" resolves to security rather than quality only
  // by accident of iteration order. Substring matching is deliberately the last
  // rule -- an exact alias should never be decided by it.
  for (const key of ["security", "runtime", "quality", "spec", "fit"] as CanonicalDimension[]) {
    if (s.includes(key)) return key;
  }
  return "";
}

/** Shape shared by every finding consumer; each module has its own richer type. */
export interface DimensionalFinding {
  dimension?: string | null;
  file?: string | null;
}

const hasFile = (f: DimensionalFinding): boolean => String(f.file ?? "").trim().length > 0;

/**
 * Can a worker act on this finding by editing a file?
 *
 * Yes when it names one -- with a single exception. A `runtime` finding is
 * evidence about a deployed system (a 500 in production, a missing metric), and
 * the file it points at is where the behaviour was observed, not necessarily a
 * defect to edit; b112's `unproven_runtime` classification already exists to
 * keep those out of code cycles. Everything else that names a file is fair game,
 * INCLUDING `fit` -- "this route logs no ActivityLog while every sibling does"
 * is fixed by editing exactly the named route.
 *
 * A finding with no file is not routable by definition: there is nowhere to send
 * it, so it stays a broadcast that every worker sees as context.
 */
export function isRoutable(f: DimensionalFinding): boolean {
  if (!hasFile(f)) return false;
  return normaliseDimension(f.dimension) !== "runtime";
}

/**
 * Should this finding go to every sub-task as context rather than to an owner?
 *
 * The complement of `isRoutable`, named separately because the call sites read
 * better for it and because "broadcast" is a positive instruction, not merely
 * the absence of routing.
 */
export function isBroadcastOnly(f: DimensionalFinding): boolean {
  return !isRoutable(f);
}

/**
 * Is this a cross-cutting dimension whose findings are EXPECTED to arrive
 * without a file, and so must not drag a revise cycle into running every
 * sub-task?
 *
 * Kept dimension-based (not file-based) because that is the question the
 * unscopable gate actually asks: "is a missing file surprising here?". For
 * `fit` and `runtime` it is not.
 */
export function isMetaDimension(f: DimensionalFinding): boolean {
  const d = normaliseDimension(f.dimension);
  return d === "fit" || d === "runtime";
}
