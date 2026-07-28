/**
 * Budget enforcer.
 *
 * Tracks spend per session, per user per day, per user per month.
 * Enforces caps. Warns at thresholds. Supports user-initiated overrides
 * (audit-logged).
 *
 * PHASE 0 SCAFFOLD.
 */
import type { BudgetsConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
export interface BudgetCheck {
    ok: boolean;
    reason?: string;
    remainingMonthlyUsd: number;
    remainingSessionUsd: number;
}
export declare class BudgetEnforcer {
    private readonly config;
    private readonly state;
    constructor(config: BudgetsConfig, state: StateStore);
    canStartSession(user: string, requestedBudgetUsd: number): Promise<BudgetCheck>;
    recordSpend(user: string, amountUsd: number, sessionId: string): Promise<void>;
    private getMonthlySpend;
    /**
     * beta.78 (Feature 2): total USD a user has spent TODAY (UTC day). Reads
     * the persistent `budgets_daily` ledger, so it survives OpenClaw restarts
     * and resets only on UTC date rollover (a new day = a fresh row). This is
     * the basis for the hard daily-cap stop and the daily-aware soft warning.
     */
    getDailySpend(user: string): number;
    /** beta.78: public read of a user's monthly spend (UTC month). */
    getMonthlySpendPublic(user: string): number;
}
//# sourceMappingURL=enforcer.d.ts.map