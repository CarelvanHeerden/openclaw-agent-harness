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
import type { ReviewReport } from "./adversary.js";

/**
 * Abort reasons that mean "we ran out of runway", not "this is wrong". These
 * ship what they have.
 */
export const ABORT_REASONS_WORTH_SHIPPING: ReadonlySet<string> = new Set([
  "hard_timeout",
  "budget_exhausted",
  "daily_max_exhausted",
  "ship_time_reserved",
]);

/** Human-readable cause, for a PR body a person has to act on. */
function abortCauseSentence(reason: string): string {
  switch (reason) {
    case "hard_timeout":
      return "the session hit its wall-clock ceiling (`loop.session_hard_timeout_seconds`)";
    case "ship_time_reserved":
      return "the session was approaching its wall-clock ceiling and stopped revising in order to ship what it had";
    case "budget_exhausted":
      return "the session reached its budget ceiling";
    case "daily_max_exhausted":
      return "the requester's daily spend cap was reached";
    default:
      return `the session aborted (${reason})`;
  }
}

/**
 * The merge-recommendation reason attached to a salvaged PR. It must make two
 * things unmissable: this was NOT signed off, and it was stopped by a clock or
 * a budget rather than by a quality judgement.
 */
export function describeAbortSalvage(reason: string, cycles: number, lastReview: ReviewReport | null | undefined): string {
  const parts: string[] = [];
  parts.push(
    `NOT machine-approved -- this PR exists so the work is not lost. After ${cycles} review cycle${cycles === 1 ? "" : "s"}, ${abortCauseSentence(reason)}, so the run stopped before reaching a clean verdict.`,
  );
  if (lastReview) {
    const open = lastReview.findings?.length ?? 0;
    parts.push(
      `The last adversary pass returned "${lastReview.verdict}" with ${open} open finding${open === 1 ? "" : "s"}; they are listed on this PR and are NOT fixed.`,
    );
  } else {
    parts.push("No adversary verdict was reached at all, so nothing here has been reviewed.");
  }
  parts.push(
    "Read the diff before merging. To continue automatically instead, run harness_revise against this PR -- it resumes from this branch rather than starting again.",
  );
  return parts.join(" ");
}

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
export const MAX_RESERVE_FRACTION = 0.25;

/**
 * beta.129: a single anomalous cycle (a retry storm, a stuck worker that later
 * timed out) must not be able to convince the loop that no further cycle can
 * ever fit. Cap what one observed cycle is allowed to claim.
 */
export const MAX_CYCLE_ALLOWANCE_FRACTION = 0.5;

export function shouldReserveTimeToShip(input: {
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
  /**
   * beta.129: how long a cycle has ACTUALLY been taking on this run, in ms.
   *
   * b120 asked only "is there enough time left to push?" and so waved through
   * a cycle that could not possibly finish: session d48ba433 had ~20 minutes
   * left against a 10-minute reserve, started a 25-minute cycle, and was
   * guillotined during the review that would have shipped it. Reserving a
   * constant answers the wrong question. The question is whether another
   * cycle FITS -- the cycle plus the push, not the push alone.
   *
   * Omitted (or zero) preserves the b120 behaviour, which is what the first
   * review boundary of a run has to use since nothing has been measured yet.
   */
  observedCycleMs?: number;
}): boolean {
  if (!input.hasWork) return false;
  if (!Number.isFinite(input.hardDeadlineMs) || input.hardDeadlineMs <= 0) return false;
  let reserveMs = Math.max(0, input.reserveSeconds) * 1000;
  const totalMs = Math.max(0, input.totalBudgetSeconds ?? 0) * 1000;
  if (totalMs > 0) reserveMs = Math.min(reserveMs, totalMs * MAX_RESERVE_FRACTION);
  if (reserveMs <= 0) return false;
  const remaining = input.hardDeadlineMs - input.now;
  // Already past the deadline: that is the abort path's business, not ours.
  if (remaining <= 0) return false;

  let cycleMs = Number.isFinite(input.observedCycleMs) ? Math.max(0, input.observedCycleMs ?? 0) : 0;
  if (totalMs > 0) cycleMs = Math.min(cycleMs, totalMs * MAX_CYCLE_ALLOWANCE_FRACTION);

  return remaining < reserveMs + cycleMs;
}
