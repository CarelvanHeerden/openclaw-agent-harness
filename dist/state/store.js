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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
function locateSchema() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        resolve(here, "schema.sql"), // colocated with dist/state/store.js
        resolve(here, "../../src/state/schema.sql"), // dev mode: dist/state -> src/state
        resolve(here, "../state/schema.sql"), // fallback
    ];
    for (const c of candidates) {
        if (existsSync(c))
            return c;
    }
    throw new Error(`schema.sql not found near ${here}`);
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
export function openStateStoreSync(pathHint) {
    const path = resolve(pathHint.replace(/^~/, process.env.HOME ?? ""));
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // `node:sqlite` has no `.pragma()` helper; use `.exec` with PRAGMA text.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    const schema = readFileSync(locateSchema(), "utf8");
    db.exec(schema);
    // Additive migrations. Each entry is 'try to add column, ignore if already there'.
    // Keep this list short and only ever ADD, never DROP or MODIFY (breaks rollback).
    const additiveMigrations = [
        // 2026-07-13: promote pr_merged / pr_closed_at / pr_merged_at out of reactions_json.
        // reactions_json is for reaction state only; PR lifecycle deserves proper columns.
        { table: "sessions", column: "pr_merged", type: "INTEGER" }, // 0/1
        { table: "sessions", column: "pr_closed_at", type: "INTEGER" }, // epoch ms
        { table: "sessions", column: "pr_merged_at", type: "INTEGER" }, // epoch ms (nullable)
        // beta.34: post-ship merge recommendation + PR number for the merge tool.
        { table: "sessions", column: "pr_number", type: "INTEGER" }, // GitHub PR number
        { table: "sessions", column: "merge_recommendation", type: "TEXT" }, // 'merge' | 'do_not_merge'
        { table: "sessions", column: "merge_recommendation_reason", type: "TEXT" }, // human-readable reasoning
        { table: "sessions", column: "deploy_status", type: "TEXT" }, // 'ready'|'error'|'pending'|'unavailable'|'reverted'|'repair_budget_paused'|NULL
        { table: "sessions", column: "deploy_detail", type: "TEXT" }, // logs excerpt / url / error
        { table: "sessions", column: "deploy_repair_attempt", type: "INTEGER" }, // beta.36: post-merge deploy-repair attempt count
        { table: "sessions", column: "parent_session_id", type: "TEXT" }, // beta.36: links a repair session to the session whose deploy it repairs
    ];
    for (const m of additiveMigrations) {
        try {
            db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
        }
        catch (err) {
            const msg = String(err);
            if (!/duplicate column name/i.test(msg))
                throw err;
        }
    }
    // One-shot backfill from legacy reactions_json blob into proper columns.
    // Safe to run on every open: it only touches rows where the column is still
    // NULL. On a fresh install this is a no-op.
    try {
        const legacyRows = db
            .prepare(`SELECT id, reactions_json FROM sessions
          WHERE reactions_json IS NOT NULL AND reactions_json != ''
            AND (pr_merged IS NULL OR pr_closed_at IS NULL)`)
            .all();
        const upd = db.prepare(`UPDATE sessions SET pr_merged = COALESCE(?, pr_merged),
                            pr_closed_at = COALESCE(?, pr_closed_at),
                            pr_merged_at = COALESCE(?, pr_merged_at)
        WHERE id = ?`);
        for (const row of legacyRows) {
            try {
                const j = JSON.parse(row.reactions_json);
                upd.run(typeof j.prMerged === "boolean" ? (j.prMerged ? 1 : 0) : null, typeof j.prClosedAt === "number" ? j.prClosedAt : null, typeof j.prMergedAt === "number" ? j.prMergedAt : null, row.id);
            }
            catch { /* ignore per-row parse failures */ }
        }
    }
    catch { /* first open before column exists is fine */ }
    const insertAudit = db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`);
    let open = true;
    return {
        db,
        isOpen: () => open,
        close: () => {
            // Idempotent: on a re-register race two teardown paths can both reach
            // here. `node:sqlite` throws "database is not open" on a double close,
            // which is exactly the error we are trying to eliminate downstream.
            if (!open)
                return;
            open = false;
            db.close();
        },
        audit: (event, payload, sessionId) => {
            insertAudit.run(sessionId ?? null, event, JSON.stringify(payload ?? {}), Date.now());
        },
    };
}
/**
 * Async facade over {@link openStateStoreSync} for callers that previously
 * awaited this function. Prefer the sync variant in new code, especially
 * on the plugin `register()` critical path.
 */
export async function openStateStore(pathHint) {
    return openStateStoreSync(pathHint);
}
//# sourceMappingURL=store.js.map