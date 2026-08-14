/**
 * beta.127: turn a red CI run into findings the revise loop can act on.
 *
 * Until b127 a CI failure reached exactly one place: the merge recommendation,
 * as `needs_human_review` plus a log excerpt. The loop had already finished. So
 * the harness would run four cycles of adversary review, ship, discover CI was
 * red, and write "Do NOT merge" onto a PR nobody had fixed.
 *
 * The b126 smoke is the shape of it. 33 sub-tasks, zero verification failures,
 * an extra cycle granted for converging findings, 107 minutes, $18.78 -- and a
 * PR failing 2 tests out of 8836. One was a pre-existing test the run broke by
 * inserting a sidebar entry into the middle of a group asserted to be
 * contiguous; the other was a test the run wrote itself, comparing a Date to
 * the string it becomes after JSON serialisation. Both one-liners. Neither was
 * visible to any cycle, because the only thing that runs the repo's suite is
 * CI, and CI ran after the last cycle had ended.
 *
 * This module is the translation layer: job log in, `ReviewFinding[]` out,
 * shaped so the existing revise machinery routes them like any other finding.
 */
import type { ReviewFinding } from "./fable5-adversary.js";
export interface CiFindingOptions {
    /** Cap on findings produced, so a catastrophic red build cannot flood a cycle. */
    maxFindings?: number;
    /** The commit CI actually ran against, quoted in the detail. */
    sha?: string;
}
/**
 * Build blocking findings from the failing-CI log excerpt.
 *
 * Each finding carries:
 *   - `file`: the failing TEST file, so the sub-task that owns it is targeted.
 *   - `relatedFiles`: every repo path named in the failure body, so co-fix
 *     routing can reach the source file when the test names it.
 *   - `detail`: the verbatim excerpt, because the worker needs the assertion,
 *     not a summary of it.
 *
 * When no file can be identified the finding is returned with no `file`, which
 * the mapper treats as a miss and broadcasts to every sub-task. That is the
 * right default: a red build is a property of the whole branch, and it is
 * better to show it to everyone than to route it confidently to the wrong
 * owner.
 */
export declare function buildCiFailureFindings(logs: string, opts?: CiFindingOptions): ReviewFinding[];
/**
 * A short, stable line for the audit trail and the ship note.
 */
export declare function describeCiFindings(findings: ReviewFinding[]): string;
//# sourceMappingURL=ci-findings.d.ts.map