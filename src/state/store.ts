/**
 * State store: SQLite via better-sqlite3, sync API.
 * Applies schema on first open. Idempotent.
 *
 * The schema is loaded from schema.sql at package root. It is intentionally
 * copied into dist/state/schema.sql by the build (see package.json "files").
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export interface StateStore {
  db: Database.Database;
  close: () => void;
  audit: (event: string, payload: unknown, sessionId?: string) => void;
}

function locateSchema(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "schema.sql"),               // colocated with dist/state/store.js
    resolve(here, "../../src/state/schema.sql"), // dev mode: dist/state -> src/state
    resolve(here, "../state/schema.sql"),      // fallback
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`schema.sql not found near ${here}`);
}

/**
 * Idempotent column-adds. SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS`,
 * so we probe `PRAGMA table_info` and only add missing columns. Every entry
 * here must be additive (never drop/rename) — the SQL file remains the source
 * of truth for a fresh install.
 */
function applyAdditiveMigrations(db: Database.Database): void {
  const migrations: Array<{ table: string; column: string; ddl: string }> = [
    // 2026-07-13 round-3: promote PR-merged tracking out of reactions_json blob.
    { table: "sessions", column: "pr_merged", ddl: "ALTER TABLE sessions ADD COLUMN pr_merged INTEGER NOT NULL DEFAULT 0" },
    { table: "sessions", column: "pr_closed_at", ddl: "ALTER TABLE sessions ADD COLUMN pr_closed_at INTEGER" },
    { table: "sessions", column: "pr_merged_at", ddl: "ALTER TABLE sessions ADD COLUMN pr_merged_at INTEGER" },
  ];
  for (const m of migrations) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === m.column)) {
      db.exec(m.ddl);
    }
  }
}

export async function openStateStore(pathHint: string): Promise<StateStore> {
  const path = resolve(pathHint.replace(/^~/, process.env.HOME ?? ""));
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = readFileSync(locateSchema(), "utf8");
  db.exec(schema);

  // Additive migrations for pre-existing databases. Each ALTER is guarded by
  // a column-existence check so this is safe to run on every open.
  // Keep these in chronological order and NEVER rename or drop.
  applyAdditiveMigrations(db);

  const insertAudit = db.prepare(
    `INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`,
  );

  return {
    db,
    close: () => db.close(),
    audit: (event, payload, sessionId) => {
      insertAudit.run(sessionId ?? null, event, JSON.stringify(payload ?? {}), Date.now());
    },
  };
}
