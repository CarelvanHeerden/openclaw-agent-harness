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
import type { StateStore } from "./store.js";
export interface RecoveryOptions {
    staleAfterSeconds: number;
    notify?: (session: RecoveredSession) => Promise<void>;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
    };
    /**
     * When true (agent-orchestrated mode, no reaction poller / Slack listener),
     * fresh in-flight sessions are auto-resumed instead of being left in the
     * un-resumable 'resumable' state. `autoResume` re-drives the loop from the
     * session's stored crystallised brief. Must be provided when
     * `agentOrchestrated` is true.
     */
    agentOrchestrated?: boolean;
    autoResume?: (session: RecoveredSession) => Promise<void>;
    /**
     * beta.81 (Track C / C4): recovery-resume circuit breaker. When MORE than
     * `maxResumes` auto-resumes fire for the SAME session within
     * `resumeWindowSeconds`, the session is HARD-STOPPED (marked `failed`,
     * reason `recovery_bounce_loop`) instead of resumed again. Forensic
     * d01a7484: 4x `recovery.auto_resuming` in ~40s on a `planning` session
     * bounce-looped and actively re-burned budget. Defaults (3 / 60) applied by
     * the caller. When either is <= 0 the breaker is disabled.
     */
    maxResumes?: number;
    resumeWindowSeconds?: number;
    /**
     * beta.107: is a loop for this session ALREADY running in this process?
     *
     * `findInterruptedSessions` selects every session in a non-terminal status
     * with no liveness filter, so a healthy, actively-running session is picked up
     * by any recovery sweep that happens while it runs -- and plugin re-register
     * churn makes those sweeps common. b47 already skipped the re-drive for a live
     * session, but it did so INSIDE `autoResume`, which runs after the breaker has
     * already counted the attempt. So the b81 breaker counts resumes that were
     * never performed, and four bursts of re-register churn inside a minute mark a
     * perfectly healthy session `failed` with `recovery_bounce_loop`.
     *
     * The b106 smoke (session 06b91509) fired two of those against a live planning
     * turn, at +83s and +126s -- half the budget for a hard-stop, spent on a run
     * that was working correctly. The scout roughly doubled how long the planning
     * phase stays in one status, which is what widened the window enough to notice.
     *
     * Checked BEFORE the breaker, so a live session is skipped entirely: no
     * `recovery.auto_resuming`, no ledger entry, no progress toward a hard stop.
     * The three other consumers of the guard (harness_resume force, and both
     * sweepStalls paths) already ask this question first; recovery was the outlier.
     */
    isLiveRunner?: (sessionId: string) => boolean;
}
/** Test-only: reset the circuit-breaker ledger. */
export declare function __resetRecoveryResumeLedger(): void;
/**
 * Record an auto-resume attempt for `sessionId` and report whether the
 * circuit breaker has now tripped (strictly MORE than `maxResumes` within
 * `windowSeconds`). Prunes entries outside the window. Disabled (never trips)
 * when maxResumes <= 0 or windowSeconds <= 0.
 */
export declare function recordResumeAndCheckBreaker(sessionId: string, maxResumes: number, windowSeconds: number, now?: number): {
    tripped: boolean;
    countInWindow: number;
};
export interface RecoveredSession {
    id: string;
    requester: string;
    slack_channel: string;
    slack_thread: string;
    status: string;
    cycles_ran: number;
    last_completed_sub_task: string | null;
    updated_at: number;
    stale: boolean;
}
export declare function findInterruptedSessions(state: StateStore, staleAfterSeconds: number): RecoveredSession[];
export declare function recoverSessions(state: StateStore, opts: RecoveryOptions): Promise<{
    interrupted: number;
    resumable: number;
}>;
//# sourceMappingURL=recovery.d.ts.map