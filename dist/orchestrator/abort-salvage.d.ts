/**
 * beta.120 (fix 1): deciding what an abort owes the operator.
 *
 * An abort has two very different causes and they deserve opposite treatment:
 *
 *   - A RESOURCE CEILING (wall clock, session budget, daily cap) says nothing
 *     about the code. The work may be complete, reviewed and compiling. Hitting
 *     the ceiling means "stop spending", so the right move is to ship what
 *     exists for a human to judge.
 *   - A USER ABORT is a judgement: they want it stopped. Opening a PR they did
 *     not ask for would be presumptuous -- but deleting their branch is worse,
 *     so the commits stay on disk.
 *
 * The b119 take-2 smoke made the cost concrete: a 121.6-minute run against a
 * 120-minute ceiling threw away 27 commits, 15 files, a clean typecheck and a
 * converging review, and the only reason the work survived at all was that git
 * had not yet GC'd the objects out of a cached clone.
 */
import type { ReviewReport } from "./fable5-adversary.js";
/**
 * Abort reasons that mean "we ran out of runway", not "this is wrong". These
 * ship what they have.
 */
export declare const ABORT_REASONS_WORTH_SHIPPING: ReadonlySet<string>;
/**
 * The merge-recommendation reason attached to a salvaged PR. It must make two
 * things unmissable: this was NOT signed off, and it was stopped by a clock or
 * a budget rather than by a quality judgement.
 */
export declare function describeAbortSalvage(reason: string, cycles: number, lastReview: ReviewReport | null | undefined): string;
/**
 * beta.120 (fix 4): should the loop stop revising and go straight to shipping?
 *
 * The b119 take-2 run died at a review boundary with no time left to push,
 * because the deadline was only ever consulted to decide whether to ABORT --
 * never to decide whether there was still room to finish. Reserving a slice of
 * the budget for the ship step turns "out of time" from a cliff into a landing.
 */
/**
 * The reserve may never eat more than this share of the total session budget.
 *
 * Without the clamp the feature inverts itself: a deployment whose
 * `session_hard_timeout_seconds` is at or below the reserve would find that the
 * FIRST review boundary already has "too little time left", so it would ship
 * after one cycle and never revise at all. A default 600s reserve against a
 * 300s timeout does exactly that.
 */
export declare const MAX_RESERVE_FRACTION = 0.25;
export declare function shouldReserveTimeToShip(input: {
    now: number;
    hardDeadlineMs: number;
    reserveSeconds: number;
    /**
     * The session's whole wall-clock allowance, used to keep the reserve
     * proportionate. Omitted means unclamped.
     */
    totalBudgetSeconds?: number;
    /** Only meaningful when there is something to ship. */
    hasWork: boolean;
}): boolean;
//# sourceMappingURL=abort-salvage.d.ts.map