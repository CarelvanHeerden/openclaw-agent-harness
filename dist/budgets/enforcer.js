/**
 * Budget enforcer.
 *
 * Tracks spend per session, per user per day, per user per month.
 * Enforces caps. Warns at thresholds. Supports user-initiated overrides
 * (audit-logged).
 *
 * PHASE 0 SCAFFOLD.
 */
export class BudgetEnforcer {
    config;
    state;
    constructor(config, state) {
        this.config = config;
        this.state = state;
    }
    async canStartSession(user, requestedBudgetUsd) {
        const monthly = this.getMonthlySpend(user);
        const remainingMonthly = this.config.monthly_per_user_usd - monthly;
        const sessionBudget = Math.min(requestedBudgetUsd || this.config.session_default_usd, this.config.session_hard_ceiling_usd, remainingMonthly);
        if (remainingMonthly <= 0) {
            return {
                ok: false,
                reason: `Monthly budget exhausted for ${user} ($${monthly.toFixed(2)} / $${this.config.monthly_per_user_usd})`,
                remainingMonthlyUsd: 0,
                remainingSessionUsd: 0,
            };
        }
        return {
            ok: true,
            remainingMonthlyUsd: remainingMonthly,
            remainingSessionUsd: sessionBudget,
        };
    }
    async recordSpend(user, amountUsd, sessionId) {
        const day = new Date().toISOString().slice(0, 10);
        const month = day.slice(0, 7);
        this.state.db
            .prepare(`INSERT INTO budgets_daily (day, user, spent_usd) VALUES (?, ?, ?)
         ON CONFLICT (day, user) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd`)
            .run(day, user, amountUsd);
        this.state.db
            .prepare(`INSERT INTO budgets_monthly (month, user, spent_usd) VALUES (?, ?, ?)
         ON CONFLICT (month, user) DO UPDATE SET spent_usd = spent_usd + excluded.spent_usd`)
            .run(month, user, amountUsd);
        this.state.audit("budget.spend", { user, amountUsd, sessionId }, sessionId);
    }
    getMonthlySpend(user) {
        const month = new Date().toISOString().slice(0, 7);
        const row = this.state.db
            .prepare(`SELECT spent_usd FROM budgets_monthly WHERE month = ? AND user = ?`)
            .get(month, user);
        return row?.spent_usd ?? 0;
    }
}
//# sourceMappingURL=enforcer.js.map