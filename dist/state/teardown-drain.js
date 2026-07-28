/**
 * beta.82: progress-aware teardown drain.
 *
 * ROOT CAUSE (killed b54/b60/b80/b81 on otherwise-clean runs): the teardown
 * drain (index.ts) waited for an owned running loop to finish, but bounded by a
 * HARD `teardown_drain_seconds` ceiling (default 3600s). On a long feature run
 * (Prisma model + API + UI is 40-60+ min AND can span multiple cycles), a
 * plugin re-register mid-run (OKF/config churn) schedules a teardown of the
 * PREVIOUS runtime. That teardown then guillotined the DB at exactly the 1-hour
 * mark -- `runtime.state.close()` closed the handle the still-live loop was
 * using -> "database is not open" -> orphaned loop -> the session hangs in
 * `executing` forever with no terminal.
 *
 * THE FIX: don't force-close the DB out from under a loop that is STILL MAKING
 * PROGRESS. While draining, poll the owned session's progress marker
 * (`max(last_checkpoint_at, updated_at)`). As long as it keeps advancing, keep
 * holding the DB open PAST the drain deadline -- a live, progressing loop is
 * never guillotined. Only proceed with the force-teardown when the loop has
 * gone STALE (no progress past `stuck_loop_seconds`), which is exactly when
 * force-closing is safe: the loop is wedged/dead anyway, so closing its DB can
 * no longer orphan real work.
 *
 * This is a pure decision helper so it can be unit-tested without a real DB /
 * timers; index.ts injects the clock + progress reader.
 */
/**
 * Decide what the drain loop should do on this poll.
 *
 * - No owned running loops        -> drain-complete (safe to close).
 * - Before the deadline            -> keep-waiting (loops-still-running).
 * - Past the deadline BUT the loop is still progressing
 *   (progress marker advanced since last poll, OR it is fresher than
 *    `stuckThresholdMs`) -> keep-waiting (loop-still-progressing): a live loop
 *   is never guillotined, even past the deadline.
 * - Past the deadline AND the loop is STALE (no advance since last poll AND
 *   older than `stuckThresholdMs`) -> force-teardown (loops-wedged-stale):
 *   the loop is wedged, closing its DB can't orphan real work.
 */
export function decideDrainAction(input) {
    const { nowMs, deadlineMs, sample, prevProgressMs, stuckThresholdMs } = input;
    if (sample.running.length === 0)
        return { kind: "drain-complete" };
    if (nowMs < deadlineMs)
        return { kind: "keep-waiting", reason: "loops-still-running" };
    // Past the hard deadline. Only force-close if the loop is genuinely wedged.
    const advancedSinceLastPoll = sample.lastProgressMs > prevProgressMs;
    const freshMs = sample.lastProgressMs > 0 ? nowMs - sample.lastProgressMs : Number.POSITIVE_INFINITY;
    const isFresh = freshMs < stuckThresholdMs;
    if (advancedSinceLastPoll || isFresh) {
        return { kind: "keep-waiting", reason: "loop-still-progressing" };
    }
    return { kind: "force-teardown", reason: "loops-wedged-stale" };
}
//# sourceMappingURL=teardown-drain.js.map