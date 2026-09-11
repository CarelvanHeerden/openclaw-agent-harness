/**
 * rc.6: the money ask, built to the shape beta.129 gave the wall-clock ask.
 *
 * THE BUG THIS EXISTS FOR. Every money-based stop in the loop was silent. A run
 * that could not afford a repair cycle, a review, or another sub-task simply
 * declined and reported a one-word reason into the audit log, while the person
 * who would happily have paid for it found out afterwards from a do-not-merge
 * PR. #1184 ended exactly there: $53.81 spent, a red build, a four-job CI
 * failure nobody was asked about, and an operator who had already authorised
 * $60 in the first place.
 *
 * The money override itself is not new. `:moneybag:` has always let an operator
 * spend past the caps, and the loop reads it at three admission points. But a
 * reaction is a PUSH: it only helps someone who is watching at the moment the
 * decision is made. This is the same authority, pulled -- the harness asks the
 * question at the moment it matters instead of hoping somebody is looking.
 *
 * The two beta.129 properties carry over unchanged, and matter more than the
 * feature:
 *
 *   1. The wait is BOUNDED. An unanswered question must never be why a
 *      deliverable is missing. When the window closes the loop does exactly
 *      what it did before this existed.
 *   2. The loop waits IN PLACE, polling `clarification_answer`, so the cycle
 *      counter, findings history and worktree survive the pause.
 *
 * WHAT REMAINS UNASKABLE. The per-user MONTHLY cap in `BudgetEnforcer.check`.
 * It is checked at session admission rather than in the loop, and it is the one
 * wall a run may not talk its way past.
 */
/** Marker in `sessions.clarification_subtask` identifying this pause. */
export declare const BUDGET_EXTENSION_KIND = "budget_extension";
/** Sentinel `clarification_seq`: this pause belongs to no sub-task. */
export declare const BUDGET_EXTENSION_SEQ = -4;
/**
 * One grant may not more than double what was already approved, and never less
 * than a $50 allowance for the small budgets where doubling is still pocket
 * change. A typo in a reply ("yes, 6000") should cost a clamp and an audit
 * line, not the month's budget. An operator who genuinely wants more can be
 * asked again -- the loop will come back if it runs short a second time.
 */
export declare function maxExtensionUsd(authorizedMaximumUsd: number): number;
export declare function isBudgetExtensionPause(clarificationSubtask: string | null | undefined): boolean;
export declare function renderBudgetExtensionMarker(waitUntilMs: number): string;
export declare function readBudgetExtensionWaitUntil(clarificationSubtask: string | null | undefined): number;
export interface BudgetExtensionReply {
    approved: boolean;
    /** Dollars to add. Zero when not approved. */
    usd: number;
    /** Why we read it that way, for the audit trail. */
    interpretation: "declined" | "explicit_amount" | "approved_default" | "unrecognised";
    /** Set when an explicit amount was reduced to the per-grant bound. */
    clamped?: boolean;
}
export declare function parseBudgetExtensionReply(answer: string, opts: {
    defaultUsd: number;
    maxUsd: number;
}): BudgetExtensionReply;
/**
 * Which stop prompted the ask. These read very differently to an operator, and
 * answering one of them as though it were another wastes the money: funding a
 * repair buys a green build, funding a sub-task buys an unfinished feature
 * another attempt, and they are not worth the same to the person paying.
 */
export type BudgetExtensionTrigger = "ci_repair" | "cycle_extension" | "review" | "sub_task" | "daily_cap";
export declare function renderBudgetExtensionQuestion(input: {
    trigger: BudgetExtensionTrigger;
    cycle: number;
    spentUsd: number;
    authorizedMaximumUsd: number;
    /** What the harness wants to do next and cannot pay for. */
    shortfallUsd: number;
    defaultUsd: number;
    waitSeconds: number;
    /** Set when the blocking wall is the DAILY cap rather than this run's budget. */
    dailyCapUsd?: number;
    /** For `ci_repair`: what CI actually reported. */
    ciSummary?: string;
    /** For `sub_task`: which piece of work is waiting. */
    subTaskTitle?: string;
}): string;
//# sourceMappingURL=budget-extension.d.ts.map