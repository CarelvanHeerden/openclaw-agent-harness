/**
 * beta.120 (brief fidelity): show the human what the harness is about to build,
 * BEFORE it spends the budget.
 *
 * WHY THIS EXISTS. Two b119 smoke runs burned ~$18 and ~2h each building the
 * wrong feature, because the brief that reached the lead planner said
 * `scheduledAt` where the user's spec said `performedAt`. Nobody saw the
 * crystallised brief until the PR arrived. The drift was obvious on sight and
 * survived only because nothing ever put it in front of a human.
 *
 * A crystallised brief costs cents; a run costs tens of dollars and hours. This
 * gate spends the cents, prints the acceptance criteria, and waits. The existing
 * `awaiting_clarification` + `harness_answer` machinery does the waiting, so a
 * confirmation is just an answer that happens to mean "yes".
 */
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";

export type ConfirmMode = "off" | "high_risk" | "always";

/**
 * Marker stored in `sessions.clarification_subtask` so a resume can tell a
 * brief-confirmation pause (nothing has run; no worktree exists) apart from a
 * mid-run sub-task pause (commits may exist and must be preserved). Reuses the
 * existing column rather than migrating the schema for one flag.
 */
export const BRIEF_CONFIRMATION_KIND = "brief_confirmation";

/** Sentinel `clarification_seq`: this pause belongs to no sub-task. */
export const BRIEF_CONFIRMATION_SEQ = -2;

export function isBriefConfirmationPause(clarificationSubtask: string | null | undefined): boolean {
  if (!clarificationSubtask) return false;
  try {
    const parsed = JSON.parse(clarificationSubtask) as { kind?: string };
    return parsed?.kind === BRIEF_CONFIRMATION_KIND;
  } catch {
    return false;
  }
}

export type RiskLevel = "low" | "medium" | "high";

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function riskRank(level: string | undefined): number {
  const key = (level ?? "").trim().toLowerCase();
  return key in RISK_ORDER ? RISK_ORDER[key as RiskLevel] : RISK_ORDER.medium;
}

export interface ConfirmDecisionInput {
  mode: ConfirmMode;
  riskLevel: string | undefined;
  /**
   * Lowest risk level that triggers a confirmation under "high_risk" mode.
   *
   * NOTE the deliberate absence of a budget threshold. `sessions.estimated_usd`
   * looks like a per-task estimate but `recommendBudget` computes it as
   * `requested ?? session_default_usd` clamped by the ceiling and daily
   * headroom -- i.e. it IS the cap, not a prediction. Gating on it at any
   * sane dollar figure would fire on every run and turn "high_risk" into
   * "always" behind the operator's back. The crystalliser's riskLevel is the
   * only genuine per-task signal available here.
   */
  minRisk: RiskLevel;
  /**
   * True when the caller proved it did not paraphrase (it passed a file, or an
   * operator explicitly waived the gate).
   */
  waived?: boolean;
}

export interface ConfirmDecision {
  confirm: boolean;
  /** Why the gate fired, for the audit log. Empty when it did not fire. */
  reason: "" | "mode_always" | "risk_at_or_above_threshold";
}

/**
 * Decide whether this run pauses for a human to eyeball the brief.
 *
 * Deliberately NOT waived by a file-sourced request: reading the right file does
 * not prove the crystalliser read it the way the user meant. `waived` exists for
 * an explicit operator override only.
 */
export function decideBriefConfirmation(input: ConfirmDecisionInput): ConfirmDecision {
  if (input.waived === true) return { confirm: false, reason: "" };
  if (input.mode === "off") return { confirm: false, reason: "" };
  if (input.mode === "always") return { confirm: true, reason: "mode_always" };
  // mode === "high_risk"
  return riskRank(input.riskLevel) >= riskRank(input.minRisk)
    ? { confirm: true, reason: "risk_at_or_above_threshold" }
    : { confirm: false, reason: "" };
}

const MAX_CRITERIA_SHOWN = 14;
const MAX_LIST_SHOWN = 12;
const MAX_CRITERION_CHARS = 400;

function bullets(items: readonly string[] | undefined, max: number, perItem = MAX_CRITERION_CHARS): string[] {
  const list = (items ?? []).filter((s) => typeof s === "string" && s.trim().length > 0);
  const shown = list.slice(0, max).map((s) => {
    const t = s.trim();
    return `  - ${t.length > perItem ? `${t.slice(0, perItem - 1)}…` : t}`;
  });
  if (list.length > max) shown.push(`  - …and ${list.length - max} more`);
  return shown;
}

export interface RenderConfirmationInput {
  brief: CrystallisedBrief;
  estimatedUsd: number;
  effectiveBudget: number;
  /** Set when the request was read from disk rather than retyped by an agent. */
  sourcePath?: string;
  /**
   * beta.129: the wall-clock ceiling this run will start with, so the gate can
   * name it. It is the only limit that can stop a run with money still in the
   * bank, and until now it was never mentioned at the one moment the operator
   * could have changed it.
   */
  hardTimeoutSeconds?: number;
  /**
   * beta.122: the session the confirmation belongs to, printed in the body.
   *
   * `harness_run` returns the id correctly, but on the b121 smoke the relaying
   * agent showed the operator `9f4b8..` for a session actually called
   * `1ef99186-...`. Putting it in the text the skill already requires be
   * relayed VERBATIM means a correct id survives a careless retelling.
   */
  sessionId?: string;
}

/**
 * Rounding to whole hours only ever reads correctly for the 2h default. A
 * 50-minute ceiling rendered as "1h" on the first local b129 run, and anything
 * under half an hour renders as "0h" -- a number that invites the operator to
 * ignore a limit that is about to stop their run.
 */
function describeWallClock(seconds: number): string {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * The text a human reads before any money is spent. Leads with the fields that
 * actually catch drift -- the acceptance criteria and the files -- because that
 * is where `scheduledAt` would have stood out.
 */
export function renderBriefConfirmation(input: RenderConfirmationInput): string {
  const b = input.brief;
  const lines: string[] = [];
  lines.push(`Before I spend anything, confirm this is what you want built.`);
  lines.push("");
  lines.push(`**${b.title}**`);
  if (b.motivation?.trim()) {
    const m = b.motivation.trim();
    lines.push("");
    lines.push(m.length > 600 ? `${m.slice(0, 599)}…` : m);
  }
  lines.push("");
  lines.push(`Acceptance criteria (${(b.acceptanceCriteria ?? []).length}):`);
  lines.push(...bullets(b.acceptanceCriteria, MAX_CRITERIA_SHOWN));
  lines.push("");
  lines.push("Files it expects to touch:");
  lines.push(...(bullets(b.filesLikelyTouched, MAX_LIST_SHOWN, 160).length
    ? bullets(b.filesLikelyTouched, MAX_LIST_SHOWN, 160)
    : ["  - (none specified)"]));
  lines.push("");
  lines.push("Explicitly out of scope:");
  lines.push(...(bullets(b.outOfScope, MAX_LIST_SHOWN, 200).length
    ? bullets(b.outOfScope, MAX_LIST_SHOWN, 200)
    : ["  - (none specified)"]));
  lines.push("");
  lines.push(
    `Repository ${b.repoHint ?? "(not specified)"}. Risk ${b.riskLevel ?? "unknown"}. ` +
      `Estimated ~$${input.estimatedUsd.toFixed(2)}, cap $${input.effectiveBudget.toFixed(2)}.`,
  );
  lines.push(
    input.sourcePath
      ? `Source: read verbatim from ${input.sourcePath}.`
      : `Source: the request text as the calling agent supplied it — if you gave it a spec file, check nothing was paraphrased away.`,
  );
  lines.push("");
  lines.push(
    `Reply "confirm" to start, or tell me what to change (your reply is folded into the brief and the corrected version runs).`,
  );
  // beta.122: the cap is the one number an operator most often wants to change
  // at this moment, and until now saying so did nothing -- "Confirm, Budget
  // $40" was filed as a correction to the SPEC and the run started at $10.
  // beta.129: the time half of this has been parsed since b123 and advertised
  // never, so nobody used it. Session d48ba433 was killed by the 2-hour default
  // with $18 of its $40 unspent; "with a time budget of 4 hours" was accepted
  // syntax at that moment and no message anywhere said so. A capability the
  // operator cannot discover is a capability that does not exist.
  lines.push(
    `To change the cap or the clock at the same time, say it in the reply — e.g. "confirm, budget $30" or ` +
      `"confirm, budget $40 with a time budget of 4 hours" — and the run starts at those numbers. ` +
      `The default wall clock is ${describeWallClock(input.hardTimeoutSeconds ?? 7200)}, and a run that hits it stops whether or not the budget is spent.`,
  );
  if (input.sessionId) {
    lines.push("");
    lines.push(`Session \`${input.sessionId}\`.`);
  }
  return lines.join("\n");
}

/**
 * Recognise a plain, UNQUALIFIED go-ahead.
 *
 * The asymmetry matters: reading "confirm, but use performedAt not scheduledAt"
 * as approval would start a run that ignores the correction -- exactly the
 * failure this whole gate exists to prevent. Reading a bare "confirm" as a
 * correction merely appends a no-op acceptance criterion. So this matches the
 * WHOLE answer or nothing, and every qualified reply is treated as a change.
 */
const AFFIRMATIONS = new Set([
  "confirm",
  "confirmed",
  "yes",
  "y",
  "go",
  "go ahead",
  "proceed",
  "ship it",
  "shipit",
  "approved",
  "approve",
  "lgtm",
  "ok",
  "okay",
  "do it",
  "start",
  "run it",
  "correct",
  "looks good",
  "looks right",
  "that's right",
  "thats right",
]);

export function isBriefConfirmation(answer: string): boolean {
  const a = (answer ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    // Trailing politeness only -- never a clause that could carry meaning.
    .replace(/[\s,]*(please|thanks|thank you|ta)\b/g, "")
    .replace(/[.!,;:\s]+$/g, "")
    .trim();
  return a.length > 0 && AFFIRMATIONS.has(a);
}

/**
 * beta.122: pull a budget out of the confirmation reply, and decide what is
 * left over.
 *
 * On the b121 smoke the relaying agent told the operator to reply
 * "confirm, budget $30" if the cap looked low. He replied "Confirm, Budget
 * $40". `isBriefConfirmation` correctly refused to read a qualified reply as
 * approval, so the whole string was filed as an authoritative correction to
 * the SPEC -- acceptance criterion #16 became "Confirm, Budget $40. This
 * supersedes anything above that contradicts it" -- and the run started at the
 * $10 default anyway. The gate was soliciting an instruction it could not obey
 * and then corrupting the brief with it.
 *
 * The budget clause is removed from the remaining text, so what is left can be
 * judged on its own: "confirm, budget $40" is an approval with a new cap, while
 * "budget $40, and use performedAt" is a real correction that also raises it.
 */
export interface ParsedConfirmationReply {
  /** A cap in whole dollars, when the reply named one. */
  budgetUsd?: number;
  /** A wall-clock ceiling in seconds, when the reply named one. */
  timeoutSeconds?: number;
  /** The reply with the budget and time clauses removed. */
  remainder: string;
  /** True when nothing but those clauses (and politeness) remained. */
  approves: boolean;
  /**
   * rc.6: controls the operator tried to set that could not be read. A
   * non-empty list means the run MUST NOT START -- see `parseConfirmationReply`.
   */
  ambiguities: ControlAmbiguity[];
}

/**
 * beta.123: the TIME half of the same sentence.
 *
 * b122 shipped the money parser and the very next reply was "confirm, set the
 * Budget to $40 with a time budget of 3 hours". Two things went wrong at once.
 * The money regex matches `\bbudget\b` followed by a number, and "time budget
 * of 3 hours" is exactly that shape -- reorder the clauses and the run would
 * have been capped at $3. And the time clause it left behind meant the
 * remainder was never empty, so a plain approval was filed as a spec
 * correction for the second release running.
 *
 * So time is parsed FIRST and cut out of the string, and money is matched on
 * what remains. A unit is required, which is what keeps this away from money:
 * no bare number is ever read as a duration.
 */
const TIME_CLAUSE = new RegExp(
  [
    String.raw`(?:\b(?:set|make|change|raise|bump|increase|extend|put|give|allow|with|and)\b\s+)?`,
    // "give IT A time budget" stacks two of these, so repeat rather than allow one.
    String.raw`(?:\b(?:the|a|an|it|us|my|this)\b\s+)*`,
    String.raw`(?:time\s*(?:budget|limit|cap|box|out)|wall[-\s]?clock(?:\s+(?:budget|limit|cap))?|timebox|deadline)`,
    String.raw`\s*(?:to|of|is|=|:|at)?\s*`,
    String.raw`(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b`,
  ].join(""),
  "i",
);

const TIME_UNIT = String.raw`(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)`;

/**
 * rc.6: the cue can follow the number as easily as precede it. "Confirm, Budget
 * $50 with a 10 hour budget" is one of the replies this gate actually received,
 * and `TIME_CLAUSE` reads cue-then-number only, so the ten hours were lost while
 * the fifty dollars landed.
 */
const TIME_CLAUSE_TRAILING = new RegExp(
  [
    String.raw`(?:\b(?:with|and|for|within|give|allow|in)\b\s+)?`,
    String.raw`(?:\b(?:a|an|the|it|us|my|this)\b\s+)*`,
    String.raw`(\d+(?:\.\d+)?)\s*` + TIME_UNIT,
    String.raw`\s*(?:time\s*)?(?:budget|limit|cap|box)\b`,
  ].join(""),
  "i",
);

/**
 * rc.6: "budget of 10 hours" is the trap the b123 comment names from the other
 * direction. `BUDGET_CLAUSE` matches `budget`-then-number and would cap the run
 * at $10; the unit says plainly that this is a clock. Time is parsed first, so
 * matching it here is what stops the money regex ever seeing it.
 */
const BUDGET_OF_DURATION = new RegExp(
  String.raw`\bbudget\b\s*(?:to|of|is|=|:|at)?\s*(\d+(?:\.\d+)?)\s*` + TIME_UNIT + String.raw`\b`,
  "i",
);

const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

/**
 * The precision here is deliberately lopsided.
 *
 * Missing a budget costs what b121 cost: the reply is filed as a correction and
 * the run uses the default cap. Inventing one is worse -- it would both set a
 * wrong cap and DELETE the matched words from the operator's correction. So
 * every form needs an explicit money marker, except the word "budget" itself,
 * which in a reply to a prompt about the budget cannot mean anything else.
 * "set the retry limit to 3" therefore stays entirely in the correction.
 */
// beta.123: swallow the imperative that introduces the clause. Without this,
// "confirm, set the Budget to $40" leaves "confirm, set the" behind -- not an
// affirmation by any reading, so the approval was lost even once the money was
// understood.
const BUDGET_VERB = String.raw`(?:\b(?:set|make|change|raise|bump|increase|put|use|give)\b\s+(?:\b(?:the|a|an|it|us|my|this)\b\s+)*)?`;

const BUDGET_CLAUSE = new RegExp(
  BUDGET_VERB +
    "(?:" +
    [
    // "budget $40", "budget: 40", "budget of 40 usd" -- bare number allowed.
    String.raw`\bbudget\b\s*(?:to|of|is|=|:)?\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?`,
    // "cap $30", "ceiling of 30 dollars" -- these words have domain meanings,
    // so a currency marker is required.
    String.raw`\b(?:cap|limit|ceiling)\b\s*(?:to|of|is|=|:)?\s*(?:\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?))`,
    // "$30 budget".
    String.raw`\$\s*(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?\s*(?:budget|cap|limit)\b`,
    // "bump to $40".
    String.raw`\b(?:bump|raise|increase)\b[^.,;]*?\$\s*(\d+(?:\.\d{1,2})?)`,
    ].join("|") +
    ")",
  "i",
);

/**
 * rc.6: the shorthand, with no cue word at all.
 *
 * These are deliberately NOT part of the clauses above, and they are only ever
 * consulted under the affirmation-only gate in `parseConfirmationReply`. A bare
 * number is the one shape that can equally well belong to the feature ("the
 * price threshold should be $60"), so the only safe licence to read it as a
 * limit is that there is no feature text for it to belong to.
 */
const BARE_MONEY = /(?:\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b)/i;
const BARE_DURATION = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*` + TIME_UNIT + String.raw`\b`, "i");

/**
 * rc.6: text that names a control and still has no number we can use.
 *
 * Scanned over what is LEFT once every clause above has been cut out, so a
 * budget that parsed cleanly can never trip it. The windows are short and stop
 * at clause punctuation on purpose: "confirm but set the retry limit to 3" has
 * to stay an ordinary correction, and so does "the budget column should be an
 * integer". What must not stay an ordinary correction is "budget -$50", where
 * the operator plainly meant a cap and no cap was read.
 */
const MONEY_CUE_RESIDUE = /\bbudget\b[^.,;]{0,16}?(?:\d|\$)/i;
const CURRENCY_CUE_RESIDUE = /\b(?:cap|ceiling|limit)\b[^.,;]{0,16}?(?:\$|\busd\b|\bdollars?\b)/i;
const TIME_CUE_RESIDUE = /\b(?:time\s*(?:budget|limit|cap|box|out)|timebox|wall[-\s]?clock|deadline|timeout)\b[^.,;]{0,16}?\d/i;

/** Which operational control a reply failed to express usably. */
export type ControlName = "budget" | "timeout";

export type ControlAmbiguityKind =
  /** A number was read but is not a limit anyone could run under. */
  | "out_of_range"
  /** A control was named; nothing usable followed it. */
  | "unreadable_amount"
  /** The same control was given two different values. */
  | "conflicting_values";

/**
 * A control the operator clearly tried to set and the harness could not read.
 *
 * The presence of ONE of these is a full stop: the session does not start. That
 * is the whole point of rc.6 -- see the header on `parseConfirmationReply`.
 */
export interface ControlAmbiguity {
  control: ControlName;
  kind: ControlAmbiguityKind;
  /** The offending fragment, quoted back so the re-ask is about their words. */
  text: string;
}

/** Tidy the sentence left behind once a clause has been cut out of it. */
function tidyRemainder(text: string): string {
  return text
    // rc.6: a clause cut out of the MIDDLE leaves orphaned punctuation behind.
    // "yes — $60, 10 hrs, please" reduces to "yes — , , please", which is the
    // affirmation it always was and no longer looks like one.
    .replace(/\s*[—–-]+\s*(?=[,;]|\s*$)/g, "")
    .replace(/(?:\s*,\s*){2,}/g, ", ")
    // The conjunction that joined the two clauses is now dangling.
    .replace(/\s*(?:,|;|\band\b|\bbut\b|\bwith\b)\s*$/i, "")
    .replace(/^\s*(?:,|;|\band\b|\bbut\b|\bwith\b)\s*/i, "")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * rc.6 (#1184): the same sentence, one release later, and the third distinct
 * way this gate has mishandled it.
 *
 * The operator was invited to name a cap in his reply. He replied:
 *
 *     Confirm, $60, 10 hours
 *
 * Neither clause carries a cue word, so neither parsed, so the reply was not an
 * approval -- and `registration.ts` does one thing with a non-approval: it
 * files the WHOLE STRING as an authoritative acceptance criterion and starts
 * the run anyway. "$60, 10 hours" became a stated requirement of a compliance
 * calendar, and the session began at the $50 and five hours nobody had asked
 * for. Three hours later it declined the CI repair that would have made the
 * branch green, because it had spent $53.81 against the $50 it was never told
 * to raise. Both halves of that outcome trace to this function returning
 * `approves: false` with no limits.
 *
 * Two changes, pulling deliberately in opposite directions:
 *
 *  1. READ THE SHORTHAND. A bare "$60" or "10 hours" in a reply that is
 *     otherwise nothing but "confirm" cannot mean anything except the limits,
 *     because there is no other content for it to belong to. That gate -- the
 *     leftovers must reduce to an affirmation -- is exactly what keeps
 *     "confirm, but the price threshold should be $60" a feature correction.
 *
 *  2. FAIL CLOSED ON THE REST. Anything that names a control and still yields
 *     no usable number ("budget of 0", "time budget of 400 hours", "budget
 *     -$50") now stops the run and asks. Until rc.6 these fell through to
 *     prose, which ignored the instruction AND pasted it into the spec. One
 *     extra message is cheap; the alternative cost a session.
 *
 * The b122 asymmetry underneath is unchanged: inventing a cap is worse than
 * missing one, because it sets a wrong ceiling AND deletes the operator's
 * words from their correction.
 */
export function parseConfirmationReply(answer: string): ParsedConfirmationReply {
  const raw = (answer ?? "").trim();
  const ambiguities: ControlAmbiguity[] = [];

  // Time first, and cut it out before money is looked for: "a time budget of 3
  // hours" is `budget`-followed-by-a-number, and would otherwise be read as $3.
  let working = raw;
  let timeoutSeconds: number | undefined;
  for (const re of [TIME_CLAUSE, BUDGET_OF_DURATION, TIME_CLAUSE_TRAILING]) {
    const t = re.exec(working);
    if (!t) continue;
    const qty = Number(t[1]);
    const unit = (t[2] ?? "").toLowerCase();
    const seconds = Math.round(qty * (unit.startsWith("h") ? 3600 : 60));
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS) {
      timeoutSeconds = seconds;
    } else {
      // rc.6: a duration that is zero, negative or absurd is an instruction we
      // cannot carry out. Before rc.6 the words were left in the correction and
      // the run started on the default clock; now it stops and asks.
      ambiguities.push({ control: "timeout", kind: "out_of_range", text: t[0].trim() });
    }
    // Cut it out either way. If it stays, the money regex reads "time budget of
    // 0 hours" as a $0 cap and reports the wrong control back to the operator.
    working = tidyRemainder(working.replace(t[0], " "));
    break;
  }

  const m = BUDGET_CLAUSE.exec(working);
  const captured = m ? m.slice(1).find((g) => typeof g === "string" && g.length > 0) : undefined;
  const value = Number(captured);
  let budgetUsd: number | undefined;
  if (m && Number.isFinite(value) && value > 0) {
    budgetUsd = value;
    working = tidyRemainder(working.replace(m[0], " "));
  } else if (m) {
    ambiguities.push({ control: "budget", kind: "out_of_range", text: m[0].trim() });
    working = tidyRemainder(working.replace(m[0], " "));
  }

  // rc.6: the shorthand pass, on trial. Bare numbers are only limits when
  // nothing but an affirmation survives their removal, so everything here is
  // computed against a copy and thrown away unless that holds.
  {
    let trial = working;
    const trialAmbiguities: ControlAmbiguity[] = [];
    let trialBudget = budgetUsd;
    let trialTimeout = timeoutSeconds;

    const bd = BARE_DURATION.exec(trial);
    if (bd) {
      const qty = Number(bd[1]);
      const unit = (bd[2] ?? "").toLowerCase();
      const seconds = Math.round(qty * (unit.startsWith("h") ? 3600 : 60));
      const usable = Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS;
      if (!usable) trialAmbiguities.push({ control: "timeout", kind: "out_of_range", text: bd[0].trim() });
      else if (trialTimeout !== undefined && trialTimeout !== seconds) {
        trialAmbiguities.push({ control: "timeout", kind: "conflicting_values", text: bd[0].trim() });
      } else trialTimeout = seconds;
      trial = tidyRemainder(trial.replace(bd[0], " "));
    }

    const bm = BARE_MONEY.exec(trial);
    if (bm) {
      const amount = Number(bm.slice(1).find((g) => typeof g === "string" && g.length > 0));
      if (!Number.isFinite(amount) || amount <= 0) {
        trialAmbiguities.push({ control: "budget", kind: "out_of_range", text: bm[0].trim() });
      } else if (trialBudget !== undefined && trialBudget !== amount) {
        trialAmbiguities.push({ control: "budget", kind: "conflicting_values", text: bm[0].trim() });
      } else trialBudget = amount;
      trial = tidyRemainder(trial.replace(bm[0], " "));
    }

    if ((bd || bm) && (trial.length === 0 || isBriefConfirmation(trial))) {
      working = trial;
      budgetUsd = trialBudget;
      timeoutSeconds = trialTimeout;
      ambiguities.push(...trialAmbiguities);
    }
  }

  // rc.6: last, whatever named a control and never produced a number. Scanned
  // over the leftovers, so a clause that parsed cleanly is already gone.
  if (MONEY_CUE_RESIDUE.test(working) || CURRENCY_CUE_RESIDUE.test(working)) {
    ambiguities.push({ control: "budget", kind: "unreadable_amount", text: working });
  }
  if (TIME_CUE_RESIDUE.test(working)) {
    ambiguities.push({ control: "timeout", kind: "unreadable_amount", text: working });
  }

  const remainder = working === raw ? raw : tidyRemainder(working);
  return {
    budgetUsd,
    timeoutSeconds,
    remainder,
    ambiguities,
    // Nothing left, or only an affirmation left, means those clauses were the
    // entire qualification -- so this IS an approval.
    approves: remainder.length === 0 || isBriefConfirmation(remainder),
  };
}

/**
 * The narrow question to put back to the operator when a control could not be
 * read. Deliberately quotes their own words and asks for one thing.
 */
export function describeControlAmbiguities(ambiguities: readonly ControlAmbiguity[]): string {
  const lines: string[] = [];
  lines.push(
    `I have not started the run, because part of that reply looks like a limit and I could not read it as one. ` +
      `Guessing would either spend money you did not authorise or quietly keep a default you meant to change.`,
  );
  lines.push("");
  for (const a of ambiguities) {
    const name = a.control === "budget" ? "budget" : "wall clock";
    const why =
      a.kind === "out_of_range"
        ? `is not a ${name} the harness can run under`
        : a.kind === "conflicting_values"
          ? `gives the ${name} a second, different value`
          : `names a ${name} but no amount I can read`;
    lines.push(`  - "${a.text}" ${why}.`);
  }
  lines.push("");
  lines.push(
    `Reply with the limits stated plainly and nothing else — for example "confirm, budget $60, 10 hours" — ` +
      `or "confirm" on its own to start at the current limits.`,
  );
  return lines.join("\n");
}

/** What the run will actually execute under, read back from the session row. */
export interface EffectiveLimits {
  budgetUsd: number;
  hardTimeoutSeconds: number;
  /** Set when the operator asked for more than the operator-configured ceiling. */
  requestedBudgetUsd?: number;
}

/**
 * rc.6: the receipt.
 *
 * The gate used to answer "Brief confirmed; session is running" whatever it had
 * actually persisted, so an operator who set a cap and an operator whose cap was
 * silently dropped read the same sentence. This states the numbers the run will
 * be governed by, and its caller builds it from a re-read of the row rather than
 * from what it intended to write.
 */
export function renderLimitsReceipt(limits: EffectiveLimits): string {
  const clamped =
    typeof limits.requestedBudgetUsd === "number" && limits.requestedBudgetUsd > limits.budgetUsd
      ? ` (you asked for $${limits.requestedBudgetUsd.toFixed(2)}; the operator ceiling is $${limits.budgetUsd.toFixed(2)})`
      : "";
  return (
    `Running under budget $${limits.budgetUsd.toFixed(2)}${clamped} and a wall clock of ` +
    `${describeWallClock(limits.hardTimeoutSeconds)}. A run that hits either stops.`
  );
}
