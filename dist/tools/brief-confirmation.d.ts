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
}
/**
 * The text a human reads before any money is spent. Leads with the fields that
 * actually catch drift -- the acceptance criteria and the files -- because that
 * is where `scheduledAt` would have stood out.
 */
export declare function renderBriefConfirmation(input: RenderConfirmationInput): string;
export declare function isBriefConfirmation(answer: string): boolean;
//# sourceMappingURL=brief-confirmation.d.ts.map