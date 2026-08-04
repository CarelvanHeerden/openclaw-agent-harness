/**
 * beta.103: WRITE EVIDENCE-BACKED PATH CORRECTIONS BACK INTO THE PLAN.
 *
 * ROOT CAUSE this fixes (b102 smoke, session 670c8440, PR #906 -- three revise
 * cycles that never converged):
 *
 * The lead planned the continuity-exercises page at
 * `src/app/(app)/grc/continuity-exercises/page.tsx`. That route group does not
 * exist; the repo uses `(portal)`. b101's plan-path validation flagged it and
 * b76's `rederiveContractPath` corrected it at VERIFY time -- the sub-task
 * passed against the real `(portal)` path. But the correction was applied to
 * the local contract array only:
 *
 *     return { ...v, path: rd.path };   // loop.ts, contract build
 *
 * `st.filesLikelyTouched` kept the fiction. Every downstream consumer that
 * reasons about "which sub-task owns this file" then read the fictional path:
 *
 *   - `computeReviseScope` (revise-scope.ts) intersects finding files against
 *     `filesLikelyTouched`. The adversary filed two findings against the REAL
 *     `src/app/(portal)/.../page.tsx` -- a MEDIUM (the edit drawer always sends
 *     `ownersSignOff`, 403-ing every legitimate non-owner edit) and a LOW (an
 *     unescaped apostrophe that makes `npm run lint` error, which is a REQUIRED
 *     status check on that repo). Neither `(app)` nor `(portal)` is a suffix of
 *     the other, and the finding carries a directory so the bare-basename
 *     escape hatch does not apply. No intersection -> the sub-task that owned
 *     BOTH findings was skipped on cycle 3 (`skipSeqs:[5,6,7,8]`).
 *   - `mapFindingsToSubTasks` (revise-mapping.ts) matches the same way, so the
 *     findings became mapping misses and were broadcast to sub-tasks that could
 *     not act on them.
 *
 * Net effect: findings were re-raised verbatim for three cycles as "prior-cycle
 * fix did not land", the run burned its cycle ceiling, and the PR shipped
 * blocked on a one-character lint error. Severity ranking was NOT the cause --
 * neither the scoper nor the mapper filters by severity. The plan was lying
 * about where the work lived, and nothing ever corrected it.
 *
 * THE FIX: once verification has proven a path correction against real touched
 * files, fold it back into the sub-task's declared scope so later cycles reason
 * about reality. Corrections are evidence-backed by construction -- they come
 * from `rederiveContractPath` (learned from paths this run actually touched)
 * and `reconcileTestContractPaths` (1:1, no-ambiguity) -- so this narrows the
 * plan toward the truth rather than widening it on a guess.
 *
 * Pure. No fs, no git, no SDK.
 */
export interface PathCorrection {
    /** the path the plan declared (fictional / stale). */
    from: string;
    /** the path verification proved the work actually lives at. */
    to: string;
}
export interface WritebackResult {
    /** the new file list, with corrected entries replaced in place. */
    files: string[];
    /** the corrections that actually matched an entry (for audit). */
    applied: PathCorrection[];
}
/**
 * Replace declared paths with their verified real counterparts.
 *
 * Order is preserved (a sub-task's file list is human-readable output) and
 * duplicates are collapsed, so correcting `(app)/page.tsx` -> `(portal)/page.tsx`
 * when `(portal)/page.tsx` is ALREADY listed yields one entry, not two.
 *
 * A correction whose `from` is absent from the list is ignored rather than
 * appended: this function only ever rewrites what the plan already claimed, so
 * it cannot widen a sub-task's scope and cannot resurrect a path the plan
 * deliberately dropped. A no-op correction (`from === to`) is likewise ignored.
 */
export declare function applyPathCorrections(files: string[] | undefined, corrections: PathCorrection[]): WritebackResult;
/**
 * Human-readable one-liner for the audit trail / operator log.
 */
export declare function describePathCorrections(applied: PathCorrection[]): string;
//# sourceMappingURL=plan-path-writeback.d.ts.map