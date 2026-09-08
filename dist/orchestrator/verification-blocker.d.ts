/**
 * rc.3: a missing compiler is not a code defect.
 *
 * On StitchGuard PR #1168 the absent `tsc` binary became a high-severity
 * application finding, over and over. Nothing a worker could edit would produce
 * a `tsc`, so every repair cycle spent on it changed nothing, and the finding
 * came back in the next review because the binary was still missing. Four
 * cycles of a $20 run were bought by a `npm install` nobody had run.
 *
 * The harness already has the right mechanism for its own tooling facts:
 * `source: "harness_env"` classifies straight to `env` (merge-blocking,
 * non-cycle-driving) without consulting the prose. The gap is the finding the
 * MODEL authored. The adversary writes "the typecheck cannot run: tsc is not
 * installed" as `high`/`quality`, and `isNonDemotable` -- correctly, in
 * general -- refuses to let a keyword demote a high-severity finding. So the
 * one class of high-severity finding that genuinely cannot be fixed in a diff
 * is the one class the guard protects.
 *
 * This module is the narrow structural exception. It matches a tool, binary,
 * runtime or dependency being UNAVAILABLE -- not code being wrong -- and
 * nothing else. A finding about application code that happens to mention npm
 * does not match, because the pattern requires the unavailability itself.
 *
 * A verification blocker:
 *   - keeps the merge recommendation at do_not_merge (it classifies `env`,
 *     which `blocksMerge` treats as merge-blocking);
 *   - is never assigned to a code worker;
 *   - is never described as an application defect;
 *   - does not consume repair cycles;
 *   - carries a concrete human/environment action, because "the harness could
 *     not verify this" is only useful to somebody who is told what to do.
 */
import type { ReviewFinding } from "./adversary.js";
export type VerificationBlockerKind = "missing_binary" | "missing_dependency" | "runtime_evidence_unavailable" | "network_failure" | "broken_worktree";
export interface VerificationBlocker {
    kind: VerificationBlockerKind;
    /** The tool or resource that was unavailable, when the text names one. */
    subject: string | null;
    /** What a human or the environment has to do; no worker can do it. */
    humanAction: string;
}
/**
 * Detect a verification blocker in a finding, or return null.
 *
 * Deliberately conservative. Every pattern requires the UNAVAILABILITY, not
 * merely a mention of tooling -- "the build script should run tsc in strict
 * mode" is a real diff-addressable finding and must stay one. A false positive
 * here silently stops a genuine defect driving repair cycles, which is exactly
 * the failure mode `isNonDemotable` exists to prevent, so the bar is high.
 */
export declare function detectVerificationBlocker(f: ReviewFinding): VerificationBlocker | null;
/**
 * The line a human reads. Says what could not be verified, why no worker was
 * given it, and what to do -- in that order, because the first question an
 * operator asks a stalled run is "why did nobody fix this".
 */
export declare function describeVerificationBlocker(f: ReviewFinding, b: VerificationBlocker): string;
//# sourceMappingURL=verification-blocker.d.ts.map