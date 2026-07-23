/**
 * Session recovery.
 *
 * Called once at plugin bootstrap. Finds sessions that were mid-flight
 * (status in {crystallising, planning, executing, reviewing}) when the
 * process died, and decides for each:
 *
 *   - stale by clock (updated_at older than `recovery.stale_after_seconds`):
 *       mark 'interrupted' and post a Slack note.
 *   - fresh:
 *       LISTENER mode (slack.listener_enabled): mark 'resumable' and post a
 *         Slack note; the reaction handler resumes on a human :arrows_counterclockwise:.
 *       AGENT-ORCHESTRATED mode (default, slack.listener_enabled=false):
 *         there is NO reaction poller and NO Slack listener, so a 'resumable'
 *         session can NEVER be resumed -- it strands silently (and holds its
 *         thread lock). This was the beta.29 ProjectThanos symptom: the
 *         container restarted ~4min into a run, the session sat at 'planning',
 *         recovery marked it 'resumable', and the log went dead with nothing
 *         ever driving it forward. In this mode we AUTO-RESUME fresh sessions
 *         by re-driving the loop from their stored crystallised brief.
 *
 * Stale sessions (older than the hard timeout) are always marked
 * 'interrupted' -- they're too old to safely auto-resume.
 */
// beta.57 (P3): 'resumable' is included. A session marked 'resumable' by a
// LISTENER-mode recovery (or by an older build) whose process then died again
// was invisible to every later recovery scan -- it held its thread lock and
// stranded forever. In agent-orchestrated mode it now auto-resumes like any
// other fresh in-flight session; stale ones age out to 'interrupted'.
// 'awaiting_clarification' stays EXCLUDED on purpose: it is a deliberate
// human-in-the-loop pause that only harness_answer may resume.
const NON_TERMINAL = ["crystallising", "planning", "executing", "reviewing", "resumable"];
export function findInterruptedSessions(state, staleAfterSeconds) {
    const cutoff = Date.now() - staleAfterSeconds * 1000;
    const rows = state.db
        .prepare(`SELECT id, requester, slack_channel, slack_thread, status, cycles_ran,
              last_completed_sub_task, updated_at
       FROM sessions
       WHERE status IN (${NON_TERMINAL.map(() => "?").join(",")})
       ORDER BY updated_at DESC`)
        .all(...NON_TERMINAL);
    return rows.map((r) => ({ ...r, stale: r.updated_at < cutoff }));
}
export async function recoverSessions(state, opts) {
    const found = findInterruptedSessions(state, opts.staleAfterSeconds);
    let interrupted = 0;
    let resumable = 0;
    for (const s of found) {
        if (s.stale) {
            state.db.prepare(`UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE id = ?`).run(Date.now(), s.id);
            state.audit("recovery.marked_interrupted", { sessionId: s.id, wasStatus: s.status }, s.id);
            interrupted++;
            try {
                await opts.notify?.(s);
            }
            catch (err) {
                opts.logger.warn("[recovery] notify failed", { err: String(err), sessionId: s.id });
            }
        }
        else if (opts.agentOrchestrated) {
            // No reaction poller / listener in this mode -> a 'resumable' session
            // would strand forever. Auto-resume by re-driving the loop.
            resumable++;
            if (!opts.autoResume) {
                opts.logger.warn("[recovery] agentOrchestrated set but no autoResume provided; session will strand", { sessionId: s.id });
                state.audit("recovery.autoresume_unavailable", { sessionId: s.id, wasStatus: s.status }, s.id);
            }
            else {
                // beta.64 (P1-7): carry a visible `cause` so the audit trail explains
                // WHY the session is being auto-resumed (previously it fired with no
                // reason). An agent-orchestrated harness has no reaction poller/listener,
                // so a non-terminal session left by a restart/crash would strand -- the
                // recovery re-drives it. `wasStatus` is the phase it was interrupted in.
                state.audit("recovery.auto_resuming", { sessionId: s.id, wasStatus: s.status, cause: "interrupted_non_terminal_agent_orchestrated" }, s.id);
                try {
                    await opts.autoResume(s);
                }
                catch (err) {
                    opts.logger.warn("[recovery] autoResume failed", { err: String(err), sessionId: s.id });
                    state.audit("recovery.autoresume_failed", { sessionId: s.id, error: String(err) }, s.id);
                }
            }
        }
        else {
            // Listener mode: keep the conservative human-in-the-loop behaviour.
            state.audit("recovery.marked_resumable", { sessionId: s.id, wasStatus: s.status }, s.id);
            resumable++;
            try {
                await opts.notify?.(s);
            }
            catch (err) {
                opts.logger.warn("[recovery] notify failed", { err: String(err), sessionId: s.id });
            }
        }
    }
    if (found.length > 0) {
        opts.logger.info(`[recovery] scanned ${found.length} interrupted session(s)`, {
            interrupted,
            resumable,
        });
    }
    return { interrupted, resumable };
}
//# sourceMappingURL=recovery.js.map