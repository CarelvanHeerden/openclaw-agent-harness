/**
 * State store: SQLite via the built-in `node:sqlite` module, sync API.
 * Applies schema on first open. Idempotent.
 *
 * The schema is loaded from schema.sql at package root. It is intentionally
 * copied into dist/state/schema.sql by the build (see package.json "files").
 *
 * We deliberately use `node:sqlite` (built into Node >= 22.5) rather than
 * `better-sqlite3` so the plugin has ZERO native dependencies. OpenClaw's
 * plugin loader installs deps with `npm install --ignore-scripts`, which
 * silently skips `better-sqlite3`'s `install` script and leaves the plugin
 * with no native binary. `node:sqlite` avoids the whole problem — it ships
 * with Node itself.
 */
import { DatabaseSync } from "node:sqlite";
export interface StateStore {
    db: DatabaseSync;
    close: () => void;
    audit: (event: string, payload: unknown, sessionId?: string) => void;
}
/**
 * Open (or create) the state store.
 *
 * NOTE: This is intentionally synchronous. OpenClaw's plugin loader
 * requires `register()` to be synchronous, and this is called from that
 * critical path. All the underlying primitives (`mkdirSync`, `readFileSync`,
 * `DatabaseSync` constructor, `db.exec`, `db.prepare`) are sync anyway.
 *
 * The async wrapper is retained as a thin re-export below so callers that
 * were previously awaiting can continue to do so without a code change.
 */
export declare function openStateStoreSync(pathHint: string): StateStore;
/**
 * Async facade over {@link openStateStoreSync} for callers that previously
 * awaited this function. Prefer the sync variant in new code, especially
 * on the plugin `register()` critical path.
 */
export declare function openStateStore(pathHint: string): Promise<StateStore>;
//# sourceMappingURL=store.d.ts.map