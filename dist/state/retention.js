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
export function pruneRetention(store, opts) {
    const now = Date.now();
    const auditCutoff = now - opts.auditRetentionDays * 86_400_000;
    const dailyCutoff = now - 90 * 86_400_000;
    const auditRes = store.db
        .prepare(`DELETE FROM audit_log WHERE created_at < ?`)
        .run(auditCutoff);
    const dailyRes = store.db
        .prepare(`DELETE FROM budgets_daily WHERE day < ?`)
        .run(new Date(dailyCutoff).toISOString().slice(0, 10));
    let terminalRes = { changes: 0 };
    if (opts.pruneTerminalSessions) {
        const days = opts.pruneTerminalSessionsDays ?? 365;
        const cutoff = now - days * 86_400_000;
        terminalRes = store.db
            .prepare(`DELETE FROM sessions
         WHERE status IN ('done', 'failed', 'aborted')
           AND updated_at < ?`)
            .run(cutoff);
    }
    const result = {
        auditRowsDeleted: auditRes.changes,
        budgetsDailyRowsDeleted: dailyRes.changes,
        terminalSessionsDeleted: terminalRes.changes,
        cutoffDay: new Date(auditCutoff).toISOString().slice(0, 10),
    };
    store.audit("retention.prune", result);
    return result;
}
//# sourceMappingURL=retention.js.map