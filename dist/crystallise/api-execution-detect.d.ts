/**
 * beta.79 (F1): API-execution brief detection.
 *
 * ORIGIN — the beta.77 DR/BCP smoke (session 95b341cb, PR #881). Staging's
 * forensic proved the convergence gate was healthy; the REAL defect was that
 * the lead SILENTLY PIVOTED an API-execution task into markdown documentation.
 * The DR/BCP prompt's 9 acceptance criteria ALL described external-API
 * side-effects against a LIVE GRC system (`POST /api/grc/evidence`,
 * `DELETE /api/grc/policies/...`, `{ ok: true }` return contracts, HTTP status
 * codes against project-thanos.vercel.app). Not one AC said "document X". But
 * every sub-task across 3 cycles was a `mutate` on a markdown file, so the
 * adversary kept finding "you assert this happened when nothing shows it
 * happened" — because nothing DID happen. The run only produced docs ABOUT the
 * procedure.
 *
 * Root cause in code: the classifier only picks `dev_task|clarify|not_dev|
 * unsafe` (weak-clarify bias), and lead task modes are `observe|mutate|mixed`
 * — all repo-file operations. There is NO "execute-against-external-API" mode
 * and no "this isn't repo work" reject path. Handed an API-execution brief,
 * the lead's only trained move is to make files.
 *
 * THE FIX (this module): a PURE detector run against the CRYSTALLISED brief
 * (the ACs are structured text at that point). When the ACs are DOMINATED by
 * external-API-execution signals, the crystalliser returns a `clarify` (reusing
 * the existing beta.55 human-in-loop entry) instead of a brief — asking the
 * requester whether this is repo CODE work or an operational task to run
 * against the live system (out of scope for the code-gen harness).
 *
 * DESIGN BIAS: false-NEGATIVE over false-positive. A normal repo task that
 * merely MENTIONS an endpoint in one AC ("add a test asserting the handler
 * returns 201") must NOT trip this — that's why we require the endpoint to be
 * an OUTCOME/side-effect to PERFORM (≥ minCriteria matched) AND to DOMINATE
 * (matched/total >= minRatio). Blocking a real code task is the worse failure.
 */
import type { CrystallisedBrief } from "./prompt-refiner.js";
export interface ApiExecutionDetectionResult {
    isApiExecution: boolean;
    /** The acceptance criteria (verbatim) that matched an API-execution signal. */
    matchedCriteria: string[];
    /** matched / total acceptance criteria, in [0, 1]. */
    ratio: number;
    /** Human-facing one-liner naming why it fired (or didn't). */
    reason: string;
}
export interface ApiExecutionDetectOptions {
    /** Master switch. When false, always returns isApiExecution=false. Default true. */
    enabled?: boolean;
    /** Minimum number of ACs that must carry an execution signal. Default 2. */
    minCriteria?: number;
    /** Minimum matched/total AC ratio to fire (dominance). Default 0.4. */
    minRatio?: number;
}
/**
 * Detect whether a crystallised brief is fundamentally an API-EXECUTION task
 * (perform live side-effects) rather than a repo code-generation task.
 */
export declare function detectApiExecutionBrief(brief: Pick<CrystallisedBrief, "acceptanceCriteria" | "title" | "motivation">, opts?: ApiExecutionDetectOptions): ApiExecutionDetectionResult;
/**
 * The clarifying question surfaced to the requester when a brief is detected as
 * API-execution. Names the concrete matched signal and asks the ONE decision.
 */
export declare function buildApiExecutionClarification(result: ApiExecutionDetectionResult): string;
//# sourceMappingURL=api-execution-detect.d.ts.map