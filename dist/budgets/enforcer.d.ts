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
}
//# sourceMappingURL=enforcer.d.ts.map