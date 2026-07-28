/**
 * beta.69: finding classifiability gate.
 *
 * ROOT CAUSE this fixes (forensic session 1f2e6642 — the `?all=true` grc-changes
 * export that burned 1h29m / $4.54 on a correct 30-LOC diff): the adversary loop
 * had NO concept of "can a diff-cycle worker legitimately fix this finding?". A
 * `revise` verdict was sustained by findings that were structurally unfixable in
 * a code cycle:
 *   - "No runtime data" — needs a preview deploy the harness never made (fired 3×).
 *   - "No tests / tests not wired" — repo has no test script BY DESIGN and the
 *     workerContext forbade adding one; flagged anyway, then the workaround got
 *     re-flagged (the D3 spiral).
 *   - recycled prior-cycle findings — cycle 2 had 0 convention findings and still
 *     revised.
 *
 * This module classifies every {@link ReviewFinding} as one of:
 *   - `diff_addressable`   — a worker can fix it by editing the diff. BLOCKING iff severity >= medium.
 *   - `process`            — about repo process/tooling the diff must not change (e.g. "no test script"). NON-blocking.
 *   - `env`                — build/tool environment ("exit 127", "eslint: not found"). NON-blocking.
 *   - `architectural`      — platform/deploy/size limits not addressable in a diff. NON-blocking.
 *   - `unproven_runtime`   — runtime dimension with no live deploy evidence. NON-blocking.
 *
 * The verdict gate (in fable5-adversary.ts `runAdversary`) then requires at least
 * one NEW, blocking (diff_addressable + severity>=medium) finding to sustain a
 * `revise`. Everything else is surfaced on the PR body, not used to block
 * convergence. `block` verdicts are never downgraded here.
 */
import type { ReviewFinding } from "./fable5-adversary.js";
export type FindingClass = "diff_addressable" | "process" | "env" | "architectural" | "unproven_runtime";
export interface ClassifyCtx {
    /**
     * True when the target repo has NO declared test script (so "add tests" /
     * "wire tests into a check script" is a process change the worker must not
     * make, not a diff defect). Derived from repoConventions / discovered scripts.
     */
    repoHasTestScript?: boolean;
    /**
     * True when runtime evidence is genuinely absent (no_deploy_yet / unavailable
     * and NOT satisfied by green local verification). When false, a runtime
     * finding that merely restates "no preview deploy" is `unproven_runtime`.
     */
    runtimeUnavailable?: boolean;
}
/**
 * Classify a single finding. Pure. Order matters: the most "structurally
 * unfixable in a diff" buckets win over the generic diff_addressable default.
 */
export declare function classifyFinding(f: ReviewFinding, ctx?: ClassifyCtx): FindingClass;
/**
 * A finding is BLOCKING (can sustain a `revise`) only when it is
 * `diff_addressable` AND at least `medium` severity. Everything else is
 * surfaced but non-blocking.
 */
export declare function isBlockingFinding(f: ReviewFinding, cls: FindingClass): boolean;
/**
 * Fuzzy "same finding as a prior cycle" test, used to strip recycled findings
 * from the "NEW this cycle" set (F3). Token-overlap on the title, mirroring the
 * conservative style of finding-hygiene.ts. Two findings match when they share
 * the same dimension AND >= `minShared` distinctive title tokens.
 */
export declare function isRecycledFinding(f: ReviewFinding, priorFindings: ReviewFinding[] | undefined, minShared?: number): boolean;
/**
 * The verdict gate. Given the model's verdict + findings and the classification
 * context, decide the final verdict.
 *
 *   - `block` is never downgraded (genuine redesign still hard-stops).
 *   - `revise` requires >= 1 NEW (non-recycled) blocking finding; otherwise it
 *     is downgraded to `pass` (the run has converged — remaining findings are
 *     non-blocking process/env/architectural/runtime notes that ship on the PR
 *     body, and the `reachedCleanPass=false`/do_not_merge gate still forces a
 *     human to approve the merge).
 *   - `pass` is left as-is (the old force-upgrade to revise is DELETED).
 */
export declare function gateVerdict(params: {
    verdict: "pass" | "revise" | "block";
    findings: ReviewFinding[];
    ctx: ClassifyCtx;
    priorFindings?: ReviewFinding[];
}): {
    verdict: "pass" | "revise" | "block";
    downgraded: boolean;
    newBlocking: ReviewFinding[];
};
//# sourceMappingURL=finding-classify.d.ts.map