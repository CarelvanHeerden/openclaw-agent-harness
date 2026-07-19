/**
 * Progress snapshot builder (beta.37).
 *
 * WHY THIS EXISTS
 * ---------------
 * The harness is TOOL-DRIVEN (beta.34 removed the Slack listener). It no
 * longer has — and must not have — a direct line to Slack. A `harness_run`
 * kicked off by the OpenClaw agent is fire-and-forget: the tool returns a
 * `sessionId` immediately and the loop runs in the background with ZERO
 * feedback surfaced to the caller. Users (and other OpenClaw instances)
 * reasonably assume the run has hung.
 *
 * The pre-beta.37 `reportProgress` hook tried to `chat.postMessage` directly
 * into `sessions.slack_channel` / `sessions.slack_thread`. For an
 * agent-orchestrated run those are `""` / `"agent:<uuid>"` (no real Slack
 * binding), so every post was rejected by Slack and swallowed by a blind
 * `.catch(() => {})`. Net effect: not a single progress line ever reached
 * anyone. That direct-to-Slack path is architecturally wrong now anyway.
 *
 * THE MODEL (poll)
 * ----------------
 * Instead of the harness pushing to Slack, the calling OpenClaw agent POLLS
 * a new `harness_progress` tool on an interval and relays each new update to
 * Slack in its own voice. This module builds the snapshot that tool returns,
 * sourced entirely from data the loop ALREADY persists:
 *   - `sessions`   : phase (status), cost_usd / budget_usd, cycles_ran
 *   - `sub_tasks`  : per-sub-task N/M with live status + cost
 *   - `audit_log`  : recent lifecycle event stream (tail)
 *
 * No new writes are required on the hot path — this is a pure read model.
 * `reportProgress` is retained ONLY as an audit-writer (loop.progress rows)
 * so the phase transitions show up in the event tail; it no longer touches
 * Slack.
 */
import type { DatabaseSync } from "node:sqlite";
/** Statuses that mean the run is over (no more updates will come). */
export declare const TERMINAL_STATUSES: Set<string>;
export interface ProgressSubTask {
    seq: number;
    cycle: number;
    title: string;
    status: string;
    costUsd: number;
    startedAt: number | null;
    completedAt: number | null;
}
export interface ProgressEvent {
    event: string;
    at: number;
    detail?: unknown;
}
export interface ProgressSnapshot {
    ok: boolean;
    found: boolean;
    sessionId: string;
    /** High-level phase, mapped from the session status to human words. */
    phase: string;
    status: string;
    terminal: boolean;
    repo: string;
    branch: string;
    cycle: number;
    cost: {
        spentUsd: number;
        budgetUsd: number;
        ratio: number;
    };
    subTasks: {
        total: number;
        done: number;
        running: number;
        failed: number;
        current: ProgressSubTask | null;
        all: ProgressSubTask[];
    };
    prNumber: number | null;
    prUrl: string | null;
    deployStatus: string | null;
    /** Wall-clock ms since the most recent audit event on this session. */
    msSinceLastEvent: number | null;
    lastEventAt: number | null;
    /** Tail of recent lifecycle events (newest last), for the agent to narrate. */
    recentEvents: ProgressEvent[];
    /**
     * A one-line, human-friendly summary the calling agent can post verbatim or
     * rephrase. Slack-mrkdwn-safe (no markdown tables/headings).
     */
    headline: string;
}
/**
 * Build a progress snapshot for a session. Pure read; never mutates state.
 * `limit` bounds the recent-event tail (default 12).
 */
export declare function buildProgressSnapshot(db: DatabaseSync, sessionId: string, limit?: number): ProgressSnapshot;
/** One-line Slack-mrkdwn-safe summary. No tables, no headings. */
export declare function buildHeadline(input: {
    phase: string;
    status: string;
    terminal: boolean;
    total: number;
    done: number;
    current: ProgressSubTask | null;
    spentUsd: number;
    budgetUsd: number;
    prNumber: number | null;
    deployStatus: string | null;
}): string;
//# sourceMappingURL=progress.d.ts.map