import type { DatabaseSync } from "node:sqlite";
export declare const DEADLINE_POLICY_VERSION = "active-time/2026-09-rc.11";
export interface ActiveDeadlineSnapshot {
    limitMs: number;
    elapsedMs: number;
    remainingMs: number;
    segmentStartedAt: number | null;
    pausedAt: number | null;
}
/**
 * Open an active segment and return the remaining authorized active time.
 *
 * An already-open segment means the prior process died while active. Charge
 * that whole gap through restart; only an explicit human pause is excluded.
 */
export declare function resumeActiveDeadline(db: DatabaseSync, sessionId: string, configuredSeconds: number, now?: number): ActiveDeadlineSnapshot;
export declare function pauseActiveDeadline(db: DatabaseSync, sessionId: string, now?: number): ActiveDeadlineSnapshot;
export declare function activeDeadlineSnapshot(db: DatabaseSync, sessionId: string, now?: number): ActiveDeadlineSnapshot;
export declare function extendActiveDeadline(db: DatabaseSync, sessionId: string, seconds: number, now?: number): ActiveDeadlineSnapshot;
//# sourceMappingURL=active-deadline.d.ts.map