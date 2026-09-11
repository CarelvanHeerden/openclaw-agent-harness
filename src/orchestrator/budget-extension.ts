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
export const BUDGET_EXTENSION_KIND = "budget_extension";

/** Sentinel `clarification_seq`: this pause belongs to no sub-task. */
export const BUDGET_EXTENSION_SEQ = -4;

/**
 * One grant may not more than double what was already approved, and never less
 * than a $50 allowance for the small budgets where doubling is still pocket
 * change. A typo in a reply ("yes, 6000") should cost a clamp and an audit
 * line, not the month's budget. An operator who genuinely wants more can be
 * asked again -- the loop will come back if it runs short a second time.
 */
export function maxExtensionUsd(authorizedMaximumUsd: number): number {
  return Math.max(50, authorizedMaximumUsd > 0 ? authorizedMaximumUsd : 0);
}

export function isBudgetExtensionPause(clarificationSubtask: string | null | undefined): boolean {
  if (!clarificationSubtask) return false;
  try {
    const parsed = JSON.parse(clarificationSubtask) as { kind?: string };
    return parsed?.kind === BUDGET_EXTENSION_KIND;
  } catch {
    return false;
  }
}

export function renderBudgetExtensionMarker(waitUntilMs: number): string {
  return JSON.stringify({ kind: BUDGET_EXTENSION_KIND, waitUntilMs });
}

export function readBudgetExtensionWaitUntil(clarificationSubtask: string | null | undefined): number {
  if (!clarificationSubtask) return 0;
  try {
    const parsed = JSON.parse(clarificationSubtask) as { kind?: string; waitUntilMs?: number };
    if (parsed?.kind !== BUDGET_EXTENSION_KIND) return 0;
    return typeof parsed.waitUntilMs === "number" && Number.isFinite(parsed.waitUntilMs) ? parsed.waitUntilMs : 0;
  } catch {
    return 0;
  }
}

/**
 * A BARE amount counts here, for the reason the wall-clock parser gives for
 * bare durations: this prompt asks about nothing but money, so "20 more" is
 * unambiguous and demanding a cue word would only make the operator repeat
 * themselves. The confirmation gate cannot afford that latitude -- there, a
 * number might belong to the feature.
 */
const AMOUNT = /(?:\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?|bucks?)\b|\b(\d+(?:\.\d{1,2})?)\b)/i;

const AFFIRMATIVE = /\b(yes|yep|yeah|yup|sure|ok|okay|go|continue|carry on|keep going|extend|proceed|please do|approved?|fund|pay|spend)\b/i;

/**
 * Two grades of refusal, on beta.129's reasoning. "no more than $20" is an
 * approval that begins with the letters n-o, so a bare negative only declines
 * when the reply names no amount at all; an instruction to finish means finish
 * whatever else it says.
 */
const SOFT_NEGATIVE = /^(no|nope|nah|negative)\b/i;
const HARD_STOP = /^(stop|ship|land|abort|cancel|finish|done|enough|wrap)\b/i;

export interface BudgetExtensionReply {
  approved: boolean;
  /** Dollars to add. Zero when not approved. */
  usd: number;
  /** Why we read it that way, for the audit trail. */
  interpretation: "declined" | "explicit_amount" | "approved_default" | "unrecognised";
  /** Set when an explicit amount was reduced to the per-grant bound. */
  clamped?: boolean;
}

export function parseBudgetExtensionReply(
  answer: string,
  opts: { defaultUsd: number; maxUsd: number },
): BudgetExtensionReply {
  const raw = (answer ?? "").trim();
  const max = Math.max(0, opts.maxUsd);
  const clamp = (n: number) => Math.max(0, Math.min(Math.round(n * 100) / 100, max));

  if (!raw) return { approved: false, usd: 0, interpretation: "unrecognised" };
  if (HARD_STOP.test(raw)) return { approved: false, usd: 0, interpretation: "declined" };

  const a = AMOUNT.exec(raw);
  const captured = a ? a.slice(1).find((g) => typeof g === "string" && g.length > 0) : undefined;
  if (!captured && SOFT_NEGATIVE.test(raw)) return { approved: false, usd: 0, interpretation: "declined" };
  if (captured) {
    const asked = Number(captured);
    const usd = clamp(asked);
    if (usd > 0) return { approved: true, usd, interpretation: "explicit_amount", ...(usd < asked ? { clamped: true } : {}) };
  }

  if (AFFIRMATIVE.test(raw)) {
    const usd = clamp(opts.defaultUsd);
    if (usd > 0) return { approved: true, usd, interpretation: "approved_default" };
  }

  // Anything unreadable lands the work. Shipping what exists is recoverable;
  // reading an unreadable reply as "keep spending" is not.
  return { approved: false, usd: 0, interpretation: "unrecognised" };
}

/**
 * Which stop prompted the ask. These read very differently to an operator, and
 * answering one of them as though it were another wastes the money: funding a
 * repair buys a green build, funding a sub-task buys an unfinished feature
 * another attempt, and they are not worth the same to the person paying.
 */
export type BudgetExtensionTrigger =
  | "ci_repair"
  | "cycle_extension"
  | "review"
  | "sub_task"
  | "daily_cap";

export function renderBudgetExtensionQuestion(input: {
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
}): string {
  const mins = (s: number) => `${Math.max(0, Math.round(s / 60))} min`;
  const usd = (n: number) => `$${Math.max(0, n).toFixed(2)}`;
  const spent = `${usd(input.spentUsd)} of ${usd(input.authorizedMaximumUsd)} spent`;
  const lines: string[] = [];

  switch (input.trigger) {
    case "ci_repair":
      lines.push(
        `Out of money, not out of time: the branch is reviewed and pushed, but CI came back red` +
          `${input.ciSummary ? ` -- ${input.ciSummary}` : ""}. ${spent}, and the repair reserve will not cover a fix cycle.`,
      );
      break;
    case "cycle_extension":
      lines.push(
        `Cycle ${input.cycle} is converging but the budget will not fund another one. ${spent}.`,
      );
      break;
    case "review":
      lines.push(
        `There is committed work waiting on an adversary review the budget will not cover. ${spent}. ` +
          `Without the review nothing ships, because an unreviewed branch is not a deliverable.`,
      );
      break;
    case "sub_task":
      lines.push(
        `The next piece of work${input.subTaskTitle ? ` (${input.subTaskTitle})` : ""} would cross the limit. ${spent}.`,
      );
      break;
    case "daily_cap":
      lines.push(
        `This run has hit your DAILY cap${input.dailyCapUsd ? ` of ${usd(input.dailyCapUsd)}` : ""}, not just its own budget. ${spent}.`,
      );
      break;
  }

  // Which wall is binding changes what a "yes" actually costs the operator:
  // this run's own budget is money they already scoped, the daily cap is money
  // budgeted for the rest of the day's work.
  if (input.dailyCapUsd && input.trigger !== "daily_cap") {
    lines.push(`The binding limit here is your DAILY cap of ${usd(input.dailyCapUsd)}, not this run's budget.`);
  }
  if (input.shortfallUsd > 0) {
    lines.push(`Roughly ${usd(input.shortfallUsd)} short of what the next step is projected to cost.`);
  }
  lines.push(
    `Reply with an amount to add -- "$20", "50 more", or just "yes" for ${usd(input.defaultUsd)}. ` +
      `Reply "ship" to land what exists now.`,
  );
  lines.push(
    `If nothing comes back within ${mins(input.waitSeconds)} the run continues as it would have without this question, so it cannot strand the work.`,
  );
  return lines.join(" ");
}
