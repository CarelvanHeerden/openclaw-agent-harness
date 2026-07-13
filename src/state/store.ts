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
