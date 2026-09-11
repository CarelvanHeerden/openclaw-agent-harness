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
export declare const BRIEF_CONFIRMATION_KIND = "brief_confirmation";
/** Sentinel `clarification_seq`: this pause belongs to no sub-task. */
export declare const BRIEF_CONFIRMATION_SEQ = -2;
export declare function isBriefConfirmationPause(clarificationSubtask: string | null | undefined): boolean;
export type RiskLevel = "low" | "medium" | "high";
export declare function riskRank(level: string | undefined): number;
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
export declare function decideBriefConfirmation(input: ConfirmDecisionInput): ConfirmDecision;
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
 * The text a human reads before any money is spent. Leads with the fields that
 * actually catch drift -- the acceptance criteria and the files -- because that
 * is where `scheduledAt` would have stood out.
 */
export declare function renderBriefConfirmation(input: RenderConfirmationInput): string;
export declare function isBriefConfirmation(answer: string): boolean;
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
/** Which operational control a reply failed to express usably. */
export type ControlName = "budget" | "timeout";
export type ControlAmbiguityKind = 
/** A number was read but is not a limit anyone could run under. */
"out_of_range"
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
export declare function parseConfirmationReply(answer: string): ParsedConfirmationReply;
/**
 * The narrow question to put back to the operator when a control could not be
 * read. Deliberately quotes their own words and asks for one thing.
 */
export declare function describeControlAmbiguities(ambiguities: readonly ControlAmbiguity[]): string;
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
export declare function renderLimitsReceipt(limits: EffectiveLimits): string;
//# sourceMappingURL=brief-confirmation.d.ts.map