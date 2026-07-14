/**
 * State store: SQLite via better-sqlite3, sync API.
 * Applies schema on first open. Idempotent.
 *
 * The schema is loaded from schema.sql at package root. It is intentionally
 * copied into dist/state/schema.sql by the build (see package.json "files").
 */
import Database from "better-sqlite3";
export interface StateStore {
    db: Database.Database;
    close: () => void;
    audit: (event: string, payload: unknown, sessionId?: string) => void;
}
export declare function openStateStore(pathHint: string): Promise<StateStore>;
//# sourceMappingURL=store.d.ts.map