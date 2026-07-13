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
 *       mark 'resumable' — the dispatcher will pick these up on the next
 *       inbound message OR the retention/cron worker can attempt an
 *       automatic resume.
 *
 * Recovery is deliberately conservative: we NEVER auto-restart an
 * expensive worker session without a human touch. Instead, the harness
 * posts a Slack message like
 *   ":arrows_counterclockwise: This session was interrupted at cycle 2,
 *    sub-task 5. React :arrows_counterclockwise: to resume, :x: to abort."
 * and lets the reaction handler take it from there.
 */

import type { StateStore } from "./store.js";

export interface RecoveryOptions {
  staleAfterSeconds: number;
  notify?: (session: RecoveredSession) => Promise<void>;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void };
}

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

const NON_TERMINAL = ["crystallising", "planning", "executing", "reviewing"] as const;

export function findInterruptedSessions(state: StateStore, staleAfterSeconds: number): RecoveredSession[] {
  const cutoff = Date.now() - staleAfterSeconds * 1000;
  const rows = state.db
    .prepare(
      `SELECT id, requester, slack_channel, slack_thread, status, cycles_ran,
              last_completed_sub_task, updated_at
       FROM sessions
       WHERE status IN (${NON_TERMINAL.map(() => "?").join(",")})
       ORDER BY updated_at DESC`,
    )
    .all(...NON_TERMINAL) as Array<Omit<RecoveredSession, "stale">>;
  return rows.map((r) => ({ ...r, stale: r.updated_at < cutoff }));
}

export async function recoverSessions(state: StateStore, opts: RecoveryOptions): Promise<{ interrupted: number; resumable: number }> {
  const found = findInterruptedSessions(state, opts.staleAfterSeconds);
  let interrupted = 0;
  let resumable = 0;

  for (const s of found) {
    if (s.stale) {
      state.db.prepare(`UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE id = ?`).run(Date.now(), s.id);
      state.audit("recovery.marked_interrupted", { sessionId: s.id, wasStatus: s.status }, s.id);
      interrupted++;
    } else {
      state.audit("recovery.marked_resumable", { sessionId: s.id, wasStatus: s.status }, s.id);
      resumable++;
    }
    try {
      await opts.notify?.(s);
    } catch (err) {
      opts.logger.warn("[recovery] notify failed", { err: String(err), sessionId: s.id });
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
