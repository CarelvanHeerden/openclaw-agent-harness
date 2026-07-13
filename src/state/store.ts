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

export async function openStateStore(pathHint: string): Promise<StateStore> {
  const path = resolve(pathHint.replace(/^~/, process.env.HOME ?? ""));
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = readFileSync(locateSchema(), "utf8");
  db.exec(schema);

  // Additive migrations. Each entry is 'try to add column, ignore if already there'.
  // Keep this list short and only ever ADD, never DROP or MODIFY (breaks rollback).
  const additiveMigrations: Array<{ table: string; column: string; type: string }> = [
    // 2026-07-13: promote pr_merged / pr_closed_at / pr_merged_at out of reactions_json.
    // reactions_json is for reaction state only; PR lifecycle deserves proper columns.
    { table: "sessions", column: "pr_merged",       type: "INTEGER" },   // 0/1
    { table: "sessions", column: "pr_closed_at",    type: "INTEGER" },   // epoch ms
    { table: "sessions", column: "pr_merged_at",    type: "INTEGER" },   // epoch ms (nullable)
  ];
  for (const m of additiveMigrations) {
    try {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`);
    } catch (err) {
      const msg = String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
  }

  // One-shot backfill from legacy reactions_json blob into proper columns.
  // Safe to run on every open: it only touches rows where the column is still
  // NULL. On a fresh install this is a no-op.
  try {
    const legacyRows = db
      .prepare(
        `SELECT id, reactions_json FROM sessions
          WHERE reactions_json IS NOT NULL AND reactions_json != ''
            AND (pr_merged IS NULL OR pr_closed_at IS NULL)`,
      )
      .all() as Array<{ id: string; reactions_json: string }>;
    const upd = db.prepare(
      `UPDATE sessions SET pr_merged = COALESCE(?, pr_merged),
                            pr_closed_at = COALESCE(?, pr_closed_at),
                            pr_merged_at = COALESCE(?, pr_merged_at)
        WHERE id = ?`,
    );
    for (const row of legacyRows) {
      try {
        const j = JSON.parse(row.reactions_json) as { prMerged?: boolean; prClosedAt?: number; prMergedAt?: number };
        upd.run(
          typeof j.prMerged === "boolean" ? (j.prMerged ? 1 : 0) : null,
          typeof j.prClosedAt === "number" ? j.prClosedAt : null,
          typeof j.prMergedAt === "number" ? j.prMergedAt : null,
          row.id,
        );
      } catch { /* ignore per-row parse failures */ }
    }
  } catch { /* first open before column exists is fine */ }

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
