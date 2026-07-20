/**
 * beta.49 (C): revise-brief finding hygiene.
 *
 * `harness_revise` builds its brief from the prior session's STORED adversary
 * findings (reviews table) verbatim -- it never re-runs the adversary, so a
 * finding emitted before C3 (beta.48 adversary discipline) survives forever.
 * Session 21da9f9c's finding 10 ("rename grc/ -> governance-risk/ IF no
 * existing grc dir exists") was exactly this: a CONDITIONAL premise that was
 * factually false (91 grc files already existed), replayed into every
 * revise-of-21da9f9c and refused every time.
 *
 * A CONDITIONAL finding is one whose stated action depends on an unverified
 * claim about repo state. We can't reliably re-verify arbitrary prose against
 * the repo at brief-build time (no worktree yet), so instead we DEMOTE it: the
 * finding is rewritten so the lead emits a premise-check observe sub-task
 * first and only mutates if the premise holds. Combined with beta.48 C1/C2, a
 * contradicted premise now produces a visible, non-fatal skip instead of a
 * hard worker refusal that kills the run.
 *
 * This module is a pure, exported helper so the detection is unit-testable
 * (the buildReviseBrief closure in registration.ts is not importable).
 */
/**
 * Matches unresolved repo-state conditionals: "if no X", "unless Y",
 * "assuming Z", "if ... exist(s)", "provided that", "only if", etc.
 */
export declare const CONDITIONAL_FINDING_RE: RegExp;
/** Extract the human-readable text of a stored finding (schema is loose). */
export declare function findingText(f: unknown): string;
/** True when the finding's action depends on an unresolved repo-state premise. */
export declare function isConditionalFinding(f: unknown): boolean;
//# sourceMappingURL=finding-hygiene.d.ts.map