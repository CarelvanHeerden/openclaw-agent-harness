import type { DatabaseSync } from "node:sqlite";
export declare function compareRuntimeVersions(a: string, b: string): number;
export interface DowngradeBlocker {
    sessionId: string;
    status: string;
    minimumRuntimeVersion: string;
}
/**
 * A version marker is diagnostic, not a lock older code can enforce. The only
 * safe default is to refuse downgrade while an incompatible session is live.
 */
export declare function downgradeBlockers(db: DatabaseSync, targetVersion: string): DowngradeBlocker[];
export declare function assertDowngradeSafe(db: DatabaseSync, targetVersion: string): void;
//# sourceMappingURL=runtime-compat.d.ts.map