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
export const TIME_EXTENSION_KIND = "time_extension";

/** Sentinel `clarification_seq`: this pause belongs to no sub-task. */
export const TIME_EXTENSION_SEQ = -3;

/** Nobody gets to extend past a day, however they phrase it. */
export const MAX_EXTENSION_SECONDS = 24 * 60 * 60;

export function isTimeExtensionPause(clarificationSubtask: string | null | undefined): boolean {
  if (!clarificationSubtask) return false;
  try {
    const parsed = JSON.parse(clarificationSubtask) as { kind?: string };
    return parsed?.kind === TIME_EXTENSION_KIND;
  } catch {
    return false;
  }
}

/**
 * How long the live loop intends to keep polling for an answer. Written into
 * the pause marker so `harness_answer` can tell whether a loop is still sitting
 * there waiting (record the answer and let it pick it up) or has already given
 * up and shipped (resume the normal way, through harness_revise).
 */
export function renderTimeExtensionMarker(waitUntilMs: number): string {
  return JSON.stringify({ kind: TIME_EXTENSION_KIND, waitUntilMs });
}

export function readTimeExtensionWaitUntil(clarificationSubtask: string | null | undefined): number {
  if (!clarificationSubtask) return 0;
  try {
    const parsed = JSON.parse(clarificationSubtask) as { kind?: string; waitUntilMs?: number };
    if (parsed?.kind !== TIME_EXTENSION_KIND) return 0;
    return typeof parsed.waitUntilMs === "number" && Number.isFinite(parsed.waitUntilMs) ? parsed.waitUntilMs : 0;
  } catch {
    return 0;
  }
}

/**
 * A BARE duration counts here, unlike the confirmation gate.
 *
 * b121/b123 had to demand an explicit "time budget" marker because that reply
 * could also be setting money, and "a time budget of 3 hours" read as "$3" for
 * two releases running. This prompt asks about nothing but time, so "30 more
 * minutes" is unambiguous and demanding ceremony would only make the operator
 * repeat themselves.
 */
const DURATION = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i;

const AFFIRMATIVE = /\b(yes|yep|yeah|yup|sure|ok|okay|go|continue|carry on|keep going|extend|more time|proceed|please do)\b/i;

/**
 * Two grades of refusal, because "no" is not always one.
 *
 * "no more than 20 minutes" is an APPROVAL that happens to start with the
 * letters n-o, and reading it as a refusal would throw away the very extension
 * the operator just granted. So a bare negative only declines when the reply
 * names no duration at all. An instruction to finish, by contrast, means finish
 * whatever else it says.
 */
const SOFT_NEGATIVE = /^(no|nope|nah|negative)\b/i;
const HARD_STOP = /^(stop|ship|land|abort|cancel|finish|done|enough|wrap)\b/i;

export interface TimeExtensionReply {
  approved: boolean;
  /** Seconds to add. Zero when not approved. */
  seconds: number;
  /** Why we read it that way, for the audit trail. */
  interpretation: "declined" | "explicit_duration" | "approved_default" | "unrecognised";
}

export function parseTimeExtensionReply(
  answer: string,
  opts: { defaultSeconds: number; maxSeconds?: number },
): TimeExtensionReply {
  const raw = (answer ?? "").trim();
  const max = Math.max(0, opts.maxSeconds ?? MAX_EXTENSION_SECONDS);
  const clamp = (s: number) => Math.max(0, Math.min(Math.round(s), max));

  if (!raw) return { approved: false, seconds: 0, interpretation: "unrecognised" };
  if (HARD_STOP.test(raw)) return { approved: false, seconds: 0, interpretation: "declined" };

  const d = DURATION.exec(raw);
  if (!d && SOFT_NEGATIVE.test(raw)) return { approved: false, seconds: 0, interpretation: "declined" };
  if (d) {
    const qty = Number(d[1]);
    const unit = (d[2] ?? "").toLowerCase();
    const seconds = clamp(qty * (unit.startsWith("h") ? 3600 : 60));
    if (seconds > 0) return { approved: true, seconds, interpretation: "explicit_duration" };
  }

  if (AFFIRMATIVE.test(raw)) {
    const seconds = clamp(opts.defaultSeconds);
    if (seconds > 0) return { approved: true, seconds, interpretation: "approved_default" };
  }

  // Anything we cannot read lands the work. Shipping a reviewed branch is a
  // recoverable outcome; guessing that an unreadable reply meant "keep
  // spending" is not.
  return { approved: false, seconds: 0, interpretation: "unrecognised" };
}

/**
 * What made the harness run short of clock. The two cases read very
 * differently to an operator: one is "the review still has objections", the
 * other is "the branch is already pushed and the build is red", and answering
 * the second wrongly leaves a do-not-merge PR sitting in the queue.
 */
export type TimeExtensionTrigger = "review" | "ci_repair";

export function renderTimeExtensionQuestion(input: {
  cycle: number;
  blockingFindings: number;
  spentUsd: number;
  budgetUsd: number;
  remainingSeconds: number;
  observedCycleSeconds: number;
  defaultSeconds: number;
  waitSeconds: number;
  trigger?: TimeExtensionTrigger;
  /** For `ci_repair`: what CI actually reported, e.g. "1 failing test". */
  ciSummary?: string;
}): string {
  const mins = (s: number) => `${Math.max(0, Math.round(s / 60))} min`;
  const money = `$${input.spentUsd.toFixed(2)} of $${input.budgetUsd.toFixed(2)} spent`;
  const ci = input.trigger === "ci_repair";
  const lines: string[] = [];
  if (ci) {
    lines.push(
      `Out of time, not out of money: the branch is reviewed and pushed, but CI came back red` +
        `${input.ciSummary ? ` -- ${input.ciSummary}` : ""}. ${money}, and ${mins(input.remainingSeconds)} left on the wall clock.`,
    );
  } else {
    lines.push(
      `Out of time, not out of money: cycle ${input.cycle} finished with ${input.blockingFindings} blocking finding` +
        `${input.blockingFindings === 1 ? "" : "s"} still open, ${money}, ` +
        `and ${mins(input.remainingSeconds)} left on the wall clock.`,
    );
  }
  lines.push(
    `Cycles on this run have been taking about ${mins(input.observedCycleSeconds)}, so ${ci ? "a repair cycle" : "another one"} does not fit inside the ceiling.`,
  );
  lines.push(
    `Reply with more time to ${ci ? "fix it" : "keep going"} -- "1 hour", "30 minutes", or just "yes" for ${mins(input.defaultSeconds)}. ` +
      `Reply "ship" to land ${ci ? "the PR with CI still red, flagged do-not-merge" : "what exists now with those findings open"}.`,
  );
  lines.push(
    `If nothing comes back within ${mins(input.waitSeconds)} the run ships anyway, so this question cannot strand the work.`,
  );
  return lines.join(" ");
}
