/**
 * State store: SQLite via better-sqlite3, sync API.
 * Applies schema on first open. Idempotent.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

export interface StateStore {
  db: Database.Database;
  close: () => void;
  audit: (event: string, payload: unknown, sessionId?: string) => void;
}

export async function openStateStore(pathHint: string): Promise<StateStore> {
  const path = resolve(pathHint.replace(/^~/, process.env.HOME ?? ""));
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaPath = resolve(new URL("./schema.sql", import.meta.url).pathname);
  const schema = readFileSync(schemaPath, "utf8");
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
