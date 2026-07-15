/**
 * Retention pruning.
 *
 * The audit_log grows unbounded by design (append-only, no in-place edits).
 * This module prunes rows older than `auditRetentionDays`. Intended to be
 * called once a day from the plugin's maintenance hook (or via an OpenClaw
 * cron entry -- see docs/OPERATIONS.md).
 *
 * PRUNING RULES:
 *   - audit_log: strict cutoff. Rows older than N days are DELETEd.
 *   - budgets_daily: kept for 90 days regardless (small table, cheap).
 *   - budgets_monthly: kept forever (12 rows per user per year).
 *   - sessions / sub_tasks / reviews: kept forever unless the session is in a
 *     terminal state (done|failed|aborted) AND older than N days AND the user
 *     explicitly opts in via config.storage.prune_terminal_sessions=true
 *     (default false; QSAs prefer keeping the trail).
 */

import type { StateStore } from "./store.js";

export interface PruneResult {
  auditRowsDeleted: number;
  budgetsDailyRowsDeleted: number;
  terminalSessionsDeleted: number;
  cutoffDay: string;
}

export interface PruneOptions {
  auditRetentionDays: number;
  pruneTerminalSessions?: boolean;
  pruneTerminalSessionsDays?: number;
}

export function pruneRetention(store: StateStore, opts: PruneOptions): PruneResult {
  const now = Date.now();
  const auditCutoff = now - opts.auditRetentionDays * 86_400_000;
  const dailyCutoff = now - 90 * 86_400_000;

  const auditRes = store.db
    .prepare(`DELETE FROM audit_log WHERE created_at < ?`)
    .run(auditCutoff);

  const dailyRes = store.db
    .prepare(`DELETE FROM budgets_daily WHERE day < ?`)
    .run(new Date(dailyCutoff).toISOString().slice(0, 10));

  // `node:sqlite` returns `changes` as `number | bigint`. Row counts here
  // are well within Number.MAX_SAFE_INTEGER; coerce for downstream consumers.
  const asNumber = (v: number | bigint): number => (typeof v === "bigint" ? Number(v) : v);

  let terminalChanges: number = 0;
  if (opts.pruneTerminalSessions) {
    const days = opts.pruneTerminalSessionsDays ?? 365;
    const cutoff = now - days * 86_400_000;
    const terminalRes = store.db
      .prepare(
        `DELETE FROM sessions
         WHERE status IN ('done', 'failed', 'aborted')
           AND updated_at < ?`,
      )
      .run(cutoff);
    terminalChanges = asNumber(terminalRes.changes);
  }

  const result: PruneResult = {
    auditRowsDeleted: asNumber(auditRes.changes),
    budgetsDailyRowsDeleted: asNumber(dailyRes.changes),
    terminalSessionsDeleted: terminalChanges,
    cutoffDay: new Date(auditCutoff).toISOString().slice(0, 10),
  };

  store.audit("retention.prune", result);
  return result;
}
