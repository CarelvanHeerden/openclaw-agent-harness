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
export declare function pruneRetention(store: StateStore, opts: PruneOptions): PruneResult;
//# sourceMappingURL=retention.d.ts.map