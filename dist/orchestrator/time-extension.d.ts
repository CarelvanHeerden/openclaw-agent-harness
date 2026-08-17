/**
 * beta.129: the wall-clock ask.
 *
 * THE BUG THIS EXISTS FOR. Session d48ba433 ran for 122 minutes against a
 * 2-hour ceiling with $18 of its $40 budget unspent, and had no way to buy more
 * time. The confirmation gate can raise MONEY before a run starts, and b123
 * quietly taught it to raise TIME too, but once the loop is moving the ceiling
 * is immovable: `hardTimeout` is a hard abort with no question attached. So a
 * run that was converging got guillotined with money in the bank.
 *
 * THE SHAPE OF THE FIX. When the clock will not fit another cycle but the
 * findings are not finished, pause and ask. Two properties matter more than the
 * feature itself:
 *
 *   1. The wait is BOUNDED. An unanswered question must never be the reason a
 *      deliverable is missing from GitHub. When the wait elapses the loop ships
 *      exactly as b120 made it ship, and the operator is none the worse off.
 *   2. The loop waits IN PLACE. A clarification pause returns out of runInner
 *      and resumes through a fresh plan, which would cost another lead call and
 *      could produce a different plan than the one the commits were built
 *      against. Polling for the answer inside the review boundary keeps the
 *      cycle counter, the findings history and the worktree exactly as they
 *      are.
 */
/** Marker in `sessions.clarification_subtask` identifying this pause. */
export declare const TIME_EXTENSION_KIND = "time_extension";
/** Sentinel `clarification_seq`: this pause belongs to no sub-task. */
export declare const TIME_EXTENSION_SEQ = -3;
/** Nobody gets to extend past a day, however they phrase it. */
export declare const MAX_EXTENSION_SECONDS: number;
export declare function isTimeExtensionPause(clarificationSubtask: string | null | undefined): boolean;
/**
 * How long the live loop intends to keep polling for an answer. Written into
 * the pause marker so `harness_answer` can tell whether a loop is still sitting
 * there waiting (record the answer and let it pick it up) or has already given
 * up and shipped (resume the normal way, through harness_revise).
 */
export declare function renderTimeExtensionMarker(waitUntilMs: number): string;
export declare function readTimeExtensionWaitUntil(clarificationSubtask: string | null | undefined): number;
export interface TimeExtensionReply {
    approved: boolean;
    /** Seconds to add. Zero when not approved. */
    seconds: number;
    /** Why we read it that way, for the audit trail. */
    interpretation: "declined" | "explicit_duration" | "approved_default" | "unrecognised";
}
export declare function parseTimeExtensionReply(answer: string, opts: {
    defaultSeconds: number;
    maxSeconds?: number;
}): TimeExtensionReply;
export declare function renderTimeExtensionQuestion(input: {
    cycle: number;
    blockingFindings: number;
    spentUsd: number;
    budgetUsd: number;
    remainingSeconds: number;
    observedCycleSeconds: number;
    defaultSeconds: number;
    waitSeconds: number;
}): string;
//# sourceMappingURL=time-extension.d.ts.map