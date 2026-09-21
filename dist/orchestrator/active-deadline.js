export const DEADLINE_POLICY_VERSION = "active-time/2026-09-rc.11";
function row(db, sessionId) {
    const value = db
        .prepare(`SELECT hard_timeout_seconds, active_limit_ms, active_elapsed_ms,
              active_segment_started_at, human_pause_started_at
         FROM sessions WHERE id = ?`)
        .get(sessionId);
    if (!value)
        throw new Error(`session ${sessionId} not found`);
    return value;
}
/**
 * Open an active segment and return the remaining authorized active time.
 *
 * An already-open segment means the prior process died while active. Charge
 * that whole gap through restart; only an explicit human pause is excluded.
 */
export function resumeActiveDeadline(db, sessionId, configuredSeconds, now = Date.now()) {
    const current = row(db, sessionId);
    const limitMs = current.active_limit_ms ??
        Math.max(1, current.hard_timeout_seconds ?? configuredSeconds) * 1000;
    let elapsedMs = Math.max(0, current.active_elapsed_ms ?? 0);
    if (current.active_segment_started_at !== null) {
        elapsedMs += Math.max(0, now - current.active_segment_started_at);
    }
    db.prepare(`UPDATE sessions
        SET active_limit_ms = ?, active_elapsed_ms = ?, active_segment_started_at = ?,
            human_pause_started_at = NULL, deadline_policy_version = ?,
            minimum_runtime_version = COALESCE(minimum_runtime_version, '2.0.0-rc.12'),
            updated_at = ?
      WHERE id = ?`).run(limitMs, elapsedMs, now, DEADLINE_POLICY_VERSION, now, sessionId);
    return {
        limitMs,
        elapsedMs,
        remainingMs: Math.max(0, limitMs - elapsedMs),
        segmentStartedAt: now,
        pausedAt: null,
    };
}
export function pauseActiveDeadline(db, sessionId, now = Date.now()) {
    const current = row(db, sessionId);
    const limitMs = current.active_limit_ms ??
        Math.max(1, current.hard_timeout_seconds ?? 7200) * 1000;
    const elapsedMs = Math.max(0, current.active_elapsed_ms ?? 0) +
        (current.active_segment_started_at === null ? 0 : Math.max(0, now - current.active_segment_started_at));
    db.prepare(`UPDATE sessions
        SET active_limit_ms = ?, active_elapsed_ms = ?, active_segment_started_at = NULL,
            human_pause_started_at = COALESCE(human_pause_started_at, ?),
            deadline_policy_version = ?, updated_at = ?
      WHERE id = ?`).run(limitMs, elapsedMs, now, DEADLINE_POLICY_VERSION, now, sessionId);
    return {
        limitMs,
        elapsedMs,
        remainingMs: Math.max(0, limitMs - elapsedMs),
        segmentStartedAt: null,
        pausedAt: current.human_pause_started_at ?? now,
    };
}
/** Close active accounting at a terminal boundary without inventing a human pause. */
export function closeActiveDeadline(db, sessionId, now = Date.now()) {
    const current = row(db, sessionId);
    const limitMs = current.active_limit_ms ??
        Math.max(1, current.hard_timeout_seconds ?? 7200) * 1000;
    const elapsedMs = Math.max(0, current.active_elapsed_ms ?? 0) +
        (current.active_segment_started_at === null ? 0 : Math.max(0, now - current.active_segment_started_at));
    db.prepare(`UPDATE sessions
        SET active_limit_ms = ?, active_elapsed_ms = ?, active_segment_started_at = NULL,
            human_pause_started_at = NULL, deadline_policy_version = ?, updated_at = ?
      WHERE id = ?`).run(limitMs, elapsedMs, DEADLINE_POLICY_VERSION, now, sessionId);
    return {
        limitMs,
        elapsedMs,
        remainingMs: Math.max(0, limitMs - elapsedMs),
        segmentStartedAt: null,
        pausedAt: null,
    };
}
export function activeDeadlineSnapshot(db, sessionId, now = Date.now()) {
    const current = row(db, sessionId);
    const limitMs = Math.max(0, current.active_limit_ms ?? (current.hard_timeout_seconds ?? 7200) * 1000);
    const elapsedMs = Math.max(0, current.active_elapsed_ms ?? 0) +
        (current.active_segment_started_at === null ? 0 : Math.max(0, now - current.active_segment_started_at));
    return {
        limitMs,
        elapsedMs,
        remainingMs: Math.max(0, limitMs - elapsedMs),
        segmentStartedAt: current.active_segment_started_at,
        pausedAt: current.human_pause_started_at,
    };
}
export function extendActiveDeadline(db, sessionId, seconds, now = Date.now()) {
    const current = activeDeadlineSnapshot(db, sessionId, now);
    const limitMs = current.limitMs + Math.max(0, seconds) * 1000;
    db.prepare(`UPDATE sessions SET active_limit_ms = ?, hard_timeout_seconds = CAST(? / 1000 AS INTEGER),
                         updated_at = ? WHERE id = ?`).run(limitMs, limitMs, now, sessionId);
    return { ...current, limitMs, remainingMs: Math.max(0, limitMs - current.elapsedMs) };
}
//# sourceMappingURL=active-deadline.js.map