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
export const TERMINAL_STATUSES = new Set(["done", "failed", "aborted", "failed_verification"]);

export interface ProgressSubTask {
  seq: number;
  cycle: number;
  title: string;
  status: string; // pending|running|done|completed_no_change|failed|failed_verification|interrupted
  costUsd: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface ProgressEvent {
  event: string;
  at: number; // epoch ms
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
  cost: { spentUsd: number; budgetUsd: number; ratio: number };
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

const PHASE_BY_STATUS: Record<string, string> = {
  planning: "Planning",
  crystallising: "Crystallising the brief",
  executing: "Executing",
  reviewing: "Adversarial review",
  done: "Done",
  failed: "Failed",
  failed_verification: "Failed verification",
  aborted: "Aborted",
};

interface SessionRow {
  id: string;
  status: string;
  repo: string;
  branch: string;
  cycles_ran: number;
  cost_usd: number;
  budget_usd: number;
  pr_number: number | null;
  final_pr_url: string | null;
  deploy_status: string | null;
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Build a progress snapshot for a session. Pure read; never mutates state.
 * `limit` bounds the recent-event tail (default 12).
 */
export function buildProgressSnapshot(db: DatabaseSync, sessionId: string, limit = 12): ProgressSnapshot {
  const empty = (found: boolean): ProgressSnapshot => ({
    ok: true,
    found,
    sessionId,
    phase: found ? "Unknown" : "Not found",
    status: "unknown",
    terminal: false,
    repo: "",
    branch: "",
    cycle: 0,
    cost: { spentUsd: 0, budgetUsd: 0, ratio: 0 },
    subTasks: { total: 0, done: 0, running: 0, failed: 0, current: null, all: [] },
    prNumber: null,
    prUrl: null,
    deployStatus: null,
    msSinceLastEvent: null,
    lastEventAt: null,
    recentEvents: [],
    headline: found ? "" : `No harness session with id ${sessionId}.`,
  });

  const row = db
    .prepare(
      `SELECT id, status, repo, branch, cycles_ran, cost_usd, budget_usd,
              pr_number, final_pr_url, deploy_status
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;

  if (!row) return empty(false);

  const status = row.status;
  const terminal = TERMINAL_STATUSES.has(status);
  const phase = PHASE_BY_STATUS[status] ?? status;

  // Sub-tasks for the LATEST cycle only (that's what "current progress" means).
  const latestCycle = row.cycles_ran > 0 ? row.cycles_ran : 1;
  const stRows = db
    .prepare(
      `SELECT seq, cycle, description AS title, status, cost_usd AS costUsd,
              started_at AS startedAt, completed_at AS completedAt
         FROM sub_tasks WHERE session_id = ? AND cycle = ?
         ORDER BY seq ASC`,
    )
    .all(sessionId, latestCycle) as Array<{
    seq: number;
    cycle: number;
    title: string;
    status: string;
    costUsd: number;
    startedAt: number | null;
    completedAt: number | null;
  }>;

  const all: ProgressSubTask[] = stRows.map((r) => ({
    seq: r.seq,
    cycle: r.cycle,
    title: r.title,
    status: r.status,
    costUsd: round(r.costUsd ?? 0),
    startedAt: r.startedAt ?? null,
    completedAt: r.completedAt ?? null,
  }));

  const DONE_STATES = new Set(["done", "completed_no_change"]);
  const FAIL_STATES = new Set(["failed", "failed_verification"]);
  const done = all.filter((s) => DONE_STATES.has(s.status)).length;
  const running = all.filter((s) => s.status === "running").length;
  const failed = all.filter((s) => FAIL_STATES.has(s.status)).length;
  const current: ProgressSubTask | null =
    all.find((s) => s.status === "running") ??
    all.find((s) => s.status === "pending") ??
    (all.length > 0 ? all[all.length - 1]! : null);

  // Recent audit tail.
  const evRows = db
    .prepare(
      // Order by (created_at, id) so events written within the same
      // millisecond still tail in insertion order deterministically
      // (audit_log.id is an AUTOINCREMENT PK = monotonic insertion order).
      `SELECT event, payload, created_at AS at
         FROM audit_log WHERE session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(sessionId, Math.max(1, limit)) as Array<{ event: string; payload: string; at: number }>;

  const recentEvents: ProgressEvent[] = evRows
    .map((e) => {
      let detail: unknown = undefined;
      try {
        detail = e.payload ? JSON.parse(e.payload) : undefined;
      } catch {
        detail = undefined;
      }
      return { event: e.event, at: e.at, detail };
    })
    .reverse(); // newest last

  const lastEventAt = evRows.length > 0 ? evRows[0]!.at : null;
  const msSinceLastEvent = lastEventAt != null ? Date.now() - lastEventAt : null;

  const budgetUsd = row.budget_usd ?? 0;
  const spentUsd = row.cost_usd ?? 0;
  const ratio = budgetUsd > 0 ? round(spentUsd / budgetUsd, 4) : 0;

  const headline = buildHeadline({
    phase,
    status,
    terminal,
    total: all.length,
    done,
    current,
    spentUsd,
    budgetUsd,
    prNumber: row.pr_number ?? null,
    deployStatus: row.deploy_status ?? null,
  });

  return {
    ok: true,
    found: true,
    sessionId,
    phase,
    status,
    terminal,
    repo: row.repo,
    branch: row.branch,
    cycle: latestCycle,
    cost: { spentUsd: round(spentUsd), budgetUsd: round(budgetUsd), ratio },
    subTasks: { total: all.length, done, running, failed, current, all },
    prNumber: row.pr_number ?? null,
    prUrl: row.final_pr_url ?? null,
    deployStatus: row.deploy_status ?? null,
    msSinceLastEvent,
    lastEventAt,
    recentEvents,
    headline,
  };
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** One-line Slack-mrkdwn-safe summary. No tables, no headings. */
export function buildHeadline(input: {
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
}): string {
  const cost = input.budgetUsd > 0 ? ` (${fmtUsd(input.spentUsd)}/${fmtUsd(input.budgetUsd)})` : ` (${fmtUsd(input.spentUsd)})`;

  if (input.status === "done") {
    const pr = input.prNumber ? ` — PR #${input.prNumber}` : "";
    return `Done${pr}${cost}.`;
  }
  if (input.status === "failed" || input.status === "failed_verification") {
    return `Failed during ${input.phase.toLowerCase()}${cost}.`;
  }
  if (input.status === "aborted") return `Aborted${cost}.`;

  if (input.status === "executing" && input.total > 0) {
    const n = Math.min(input.done + 1, input.total);
    const title = input.current?.title ? ` — ${truncate(input.current.title, 80)}` : "";
    return `Executing sub-task ${n}/${input.total}${title}${cost}.`;
  }
  if (input.status === "reviewing") return `Adversarial review in progress${cost}.`;
  if (input.status === "planning") return `Planning the change${cost}.`;

  return `${input.phase}${cost}.`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
