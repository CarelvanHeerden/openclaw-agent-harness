#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { downgradeBlockers } from "../dist/state/runtime-compat.js";

const databasePath = process.argv[2];
const targetVersion = process.argv[3];
if (!databasePath || !targetVersion) {
  throw new Error("Usage: node scripts/check-downgrade.mjs <state.db> <target-version>");
}
const db = new DatabaseSync(resolve(databasePath), { readOnly: true });
try {
  const blockers = downgradeBlockers(db, targetVersion);
  console.log(JSON.stringify({ ok: blockers.length === 0, targetVersion, blockers }, null, 2));
  if (blockers.length > 0) process.exitCode = 2;
} finally {
  db.close();
}
