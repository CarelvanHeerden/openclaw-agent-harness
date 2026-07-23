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
/** Statuses that mean the run is over (no more updates will come). */
export const TERMINAL_STATUSES = new Set(["done", "failed", "aborted", "failed_verification"]);
const PHASE_BY_STATUS = {
    planning: "Planning",
    crystallising: "Crystallising the brief",
    executing: "Executing",
    reviewing: "Adversarial review",
    done: "Done",
    failed: "Failed",
    failed_verification: "Failed verification",
    aborted: "Aborted",
    awaiting_clarification: "Awaiting clarification",
};
function round(n, dp = 4) {
    const f = 10 ** dp;
    return Math.round(n * f) / f;
}
/**
 * Build a progress snapshot for a session. Pure read; never mutates state.
 * `limit` bounds the recent-event tail (default 12).
 */
/**
 * beta.64 (P1-5): audit event names that count as SDK/worker ACTIVITY -- the
 * last one's timestamp seeds msSinceLastSdkActivity. subtask_start (a
 * loop.progress marker) is the anchor at the START of a worker turn, so during
 * an inner-turn hang this timestamp freezes and the derived age keeps growing.
 */
const SDK_ACTIVITY_EVENTS = new Set([
    "loop.progress",
    "loop.worker_end_turn",
    "loop.subtask_verification",
    "loop.subtask_observe_completed",
    "loop.worker_timeout_retry",
    "loop.worker_timeout",
    "loop.worker_first_token_timeout",
    "loop.review",
]);
export function buildProgressSnapshot(db, sessionId, limit = 12, stallSeconds = 1800, sdkActivityStallSeconds = 90) {
    const empty = (found) => ({
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
        msSinceProgress: null,
        stalled: false,
        msSinceLastSdkActivity: null,
        costZeroStallSuspected: false,
        recentEvents: [],
        headline: found ? "" : `No harness session with id ${sessionId}.`,
        needsClarification: false,
        clarificationQuestion: null,
        clarificationSeq: null,
    });
    const row = db
        .prepare(`SELECT id, status, repo, branch, cycles_ran, cost_usd, budget_usd,
              pr_number, final_pr_url, deploy_status,
              clarification_question, clarification_seq, last_progress_at
         FROM sessions WHERE id = ?`)
        .get(sessionId);
    if (!row)
        return empty(false);
    const status = row.status;
    const terminal = TERMINAL_STATUSES.has(status);
    const phase = PHASE_BY_STATUS[status] ?? status;
    // Sub-tasks for the LATEST cycle only (that's what "current progress" means).
    const latestCycle = row.cycles_ran > 0 ? row.cycles_ran : 1;
    const stRows = db
        .prepare(`SELECT seq, cycle, description AS title, status, cost_usd AS costUsd,
              started_at AS startedAt, completed_at AS completedAt
         FROM sub_tasks WHERE session_id = ? AND cycle = ?
         ORDER BY seq ASC`)
        .all(sessionId, latestCycle);
    const all = stRows.map((r) => ({
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
    const current = all.find((s) => s.status === "running") ??
        all.find((s) => s.status === "pending") ??
        (all.length > 0 ? all[all.length - 1] : null);
    // Recent audit tail.
    const evRows = db
        .prepare(
    // Order by (created_at, id) so events written within the same
    // millisecond still tail in insertion order deterministically
    // (audit_log.id is an AUTOINCREMENT PK = monotonic insertion order).
    `SELECT event, payload, created_at AS at
         FROM audit_log WHERE session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(sessionId, Math.max(1, limit));
    const recentEvents = evRows
        .map((e) => {
        let detail = undefined;
        try {
            detail = e.payload ? JSON.parse(e.payload) : undefined;
        }
        catch {
            detail = undefined;
        }
        return { event: e.event, at: e.at, detail };
    })
        .reverse(); // newest last
    const lastEventAt = evRows.length > 0 ? evRows[0].at : null;
    const msSinceLastEvent = lastEventAt != null ? Date.now() - lastEventAt : null;
    // beta.63 (Part A): stall surfacing. Only ACTIVE, non-terminal phases can
    // stall; awaiting_clarification is a resting pause (never "stalled").
    const lastProgressAt = row.last_progress_at ?? null;
    const msSinceProgress = lastProgressAt != null ? Date.now() - lastProgressAt : null;
    const ACTIVE_PHASES = new Set(["executing", "reviewing"]);
    // beta.64 (P1-5): derive ms since the last SDK/worker ACTIVITY event from the
    // audit tail. This grows DURING an inner-turn hang (the last activity was the
    // subtask_start marker) whereas msSinceProgress is bumped only on boundaries.
    let lastSdkActivityAt = null;
    for (let i = recentEvents.length - 1; i >= 0; i--) {
        if (SDK_ACTIVITY_EVENTS.has(recentEvents[i].event)) {
            lastSdkActivityAt = recentEvents[i].at;
            break;
        }
    }
    const msSinceLastSdkActivity = lastSdkActivityAt != null ? Date.now() - lastSdkActivityAt : null;
    // beta.64 (P1-6): a worker running > the sdk-activity window with cost still
    // $0 has produced no billable token -- a leading indicator of a pre-first-
    // token hang. Scoped to an executing turn with a running, zero-cost current
    // sub-task whose start is older than the window.
    const activityWindowMs = Math.max(30, sdkActivityStallSeconds) * 1000;
    const costZeroStallSuspected = status === "executing" &&
        !!current &&
        current.status === "running" &&
        (current.costUsd ?? 0) === 0 &&
        current.startedAt != null &&
        Date.now() - current.startedAt > activityWindowMs;
    const stalled = ACTIVE_PHASES.has(status) &&
        ((msSinceProgress != null && msSinceProgress > Math.max(300, stallSeconds) * 1000) ||
            // beta.64 (P1-5): INNER-TURN stall -- an executing worker turn with no SDK
            // activity past the ~90s window is a mid-turn hang (beta.63 smoke #2).
            (status === "executing" && msSinceLastSdkActivity != null && msSinceLastSdkActivity > Math.max(30, sdkActivityStallSeconds) * 1000));
    const budgetUsd = row.budget_usd ?? 0;
    const spentUsd = row.cost_usd ?? 0;
    const ratio = budgetUsd > 0 ? round(spentUsd / budgetUsd, 4) : 0;
    // beta.50: when a run failed on a verifier path mismatch (only
    // `file_committed`/`file_written`/`file_pushed` failed while a commit WAS
    // made), surface the specific mismatch in the headline instead of a generic
    // "Failed during failed" -- makes the route-group / path-drift class instant
    // to diagnose. Scan the most recent verify-failure event.
    let failureDetail;
    if (status === "failed" || status === "failed_verification") {
        const PATH_FAIL = new Set([
            "loop.file_committed_verify_failed",
            "loop.file_written_verify_failed",
            "loop.file_pushed_verify_failed",
        ]);
        for (let i = recentEvents.length - 1; i >= 0; i--) {
            const ev = recentEvents[i];
            if (PATH_FAIL.has(ev.event)) {
                const d = (ev.detail ?? {});
                if (typeof d.detail === "string")
                    failureDetail = `verifier path check: ${d.detail}`;
                break;
            }
        }
    }
    // beta.55 (B2): a clarification pause overrides the normal headline so the
    // polling agent sees the question directly and relays it.
    const needsClarification = status === "awaiting_clarification";
    const clarificationQuestion = needsClarification ? (row.clarification_question ?? null) : null;
    const clarificationSeq = needsClarification ? (row.clarification_seq ?? null) : null;
    const headline = needsClarification && clarificationQuestion
        ? `Awaiting clarification: ${clarificationQuestion.slice(0, 400)} (answer via harness_answer sessionId=${sessionId})`
        : buildHeadline({
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
            failureDetail,
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
        msSinceProgress,
        stalled,
        msSinceLastSdkActivity,
        costZeroStallSuspected,
        recentEvents,
        headline,
        needsClarification,
        clarificationQuestion,
        clarificationSeq,
    };
}
function fmtUsd(n) {
    return `$${n.toFixed(2)}`;
}
/** One-line Slack-mrkdwn-safe summary. No tables, no headings. */
export function buildHeadline(input) {
    const cost = input.budgetUsd > 0 ? ` (${fmtUsd(input.spentUsd)}/${fmtUsd(input.budgetUsd)})` : ` (${fmtUsd(input.spentUsd)})`;
    if (input.status === "done") {
        const pr = input.prNumber ? ` — PR #${input.prNumber}` : "";
        return `Done${pr}${cost}.`;
    }
    if (input.status === "failed" || input.status === "failed_verification") {
        const why = input.failureDetail ? ` — ${input.failureDetail}` : "";
        return `Failed during ${input.phase.toLowerCase()}${why}${cost}.`;
    }
    if (input.status === "aborted")
        return `Aborted${cost}.`;
    if (input.status === "executing" && input.total > 0) {
        const n = Math.min(input.done + 1, input.total);
        const title = input.current?.title ? ` — ${truncate(input.current.title, 80)}` : "";
        return `Executing sub-task ${n}/${input.total}${title}${cost}.`;
    }
    if (input.status === "reviewing")
        return `Adversarial review in progress${cost}.`;
    if (input.status === "planning")
        return `Planning the change${cost}.`;
    return `${input.phase}${cost}.`;
}
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return `${s.slice(0, max - 1)}…`;
}
//# sourceMappingURL=progress.js.map