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
    /**
     * beta.63 (Part A): stall surfacing so a poller can SEE a wedge instead of
     * it looking identical to legit long work. `msSinceProgress` is ms since the
     * session's last_progress_at heartbeat; `stalled` is true when the session is
     * non-terminal in an active phase and msSinceProgress exceeds the watchdog
     * window (`stallSeconds`).
     */
    msSinceProgress: number | null;
    stalled: boolean;
    /**
     * beta.64 (P1-5): ms since the last SDK/worker ACTIVITY audit event
     * (subtask_start progress marker, worker_end_turn, subtask_verification,
     * timeout/retry). Unlike msSinceProgress (bumped only on sub-task BOUNDARIES),
     * this is the signal that keeps growing DURING an inner-turn hang -- the exact
     * blind spot of beta.63's between-transition watchdog. When it crosses the
     * sdk-activity window during an executing worker turn, `stalled` flips true so
     * harness_progress.stalled is no longer false during an inner-turn hang. Null
     * when no such event exists.
     */
    msSinceLastSdkActivity: number | null;
    /**
     * beta.64 (P1-6): leading stall indicator -- true when the current sub-task
     * has been `running` longer than the sdk-activity window with cost still $0
     * (no billable token produced). A worker that has burned wall-clock but $0 is
     * almost certainly hung before its first token (beta.63 smoke #2), which a
     * poller can surface BEFORE the full watchdog window elapses.
     */
    costZeroStallSuspected: boolean;
    /** Tail of recent lifecycle events (newest last), for the agent to narrate. */
    recentEvents: ProgressEvent[];
    /**
     * A one-line, human-friendly summary the calling agent can post verbatim or
     * rephrase. Slack-mrkdwn-safe (no markdown tables/headings).
     */
    headline: string;
    /**
     * beta.55 (B2): true when the session is paused in `awaiting_clarification`.
     * The polling agent MUST relay `clarificationQuestion` to the requester and
     * resume via harness_answer with their reply.
     */
    needsClarification: boolean;
    clarificationQuestion: string | null;
    clarificationSeq: number | null;
}
export declare function buildProgressSnapshot(db: DatabaseSync, sessionId: string, limit?: number, stallSeconds?: number, sdkActivityStallSeconds?: number): ProgressSnapshot;
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
    failureDetail?: string;
}): string;
//# sourceMappingURL=progress.d.ts.map