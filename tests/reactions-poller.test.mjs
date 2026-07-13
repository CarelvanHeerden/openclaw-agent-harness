import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let ReactionsPoller, Database;
try {
  ({ ReactionsPoller } = await import("../dist/slack/reactions-poller.js"));
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  ReactionsPoller = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return { db, audit() {} };
}

test("ReactionsPoller.pollOnce: writes reactions_json for non-terminal sessions only",
  { skip: ReactionsPoller === null }, async () => {
    const state = makeStore();
    state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','executing',?,?,50,0,0)`).run(Date.now(), Date.now());
    state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S2','T2','C','U','u','o/r','b','/wt','done',?,?,50,0,0)`).run(Date.now(), Date.now());

    const readCalls = [];
    const reader = { async read(id) { readCalls.push(id); return { shipIt: true, abort: false, pause: false, budgetBump: false }; } };
    const poller = new ReactionsPoller(state, reader, { logger: { info() {}, warn() {}, error() {} } });
    const updated = await poller.pollOnce();

    assert.equal(updated, 1);
    assert.deepEqual(readCalls, ["S1"]);
    const s1 = state.db.prepare(`SELECT reactions_json FROM sessions WHERE id = 'S1'`).get();
    assert.match(s1.reactions_json, /"shipIt":true/);
    const s2 = state.db.prepare(`SELECT reactions_json FROM sessions WHERE id = 'S2'`).get();
    assert.equal(s2.reactions_json, null);
  });

test("ReactionsPoller.pollOnce: survives reader errors",
  { skip: ReactionsPoller === null }, async () => {
    const state = makeStore();
    state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','executing',?,?,50,0,0)`).run(Date.now(), Date.now());
    state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S2','T2','C','U','u','o/r','b','/wt','reviewing',?,?,50,0,0)`).run(Date.now(), Date.now());
    const reader = { async read(id) { if (id === "S1") throw new Error("boom"); return { shipIt: false, abort: false, pause: false, budgetBump: false }; } };
    const warnings = [];
    const poller = new ReactionsPoller(state, reader, { logger: { info() {}, warn(m, meta) { warnings.push({ m, meta }); }, error() {} } });
    const updated = await poller.pollOnce();
    // S1 fails, S2 succeeds
    assert.equal(updated, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].m, /read failed/);
  });

test("ReactionsPoller: start/stop are idempotent and safe",
  { skip: ReactionsPoller === null }, async () => {
    const state = makeStore();
    const reader = { async read() { return { shipIt: false, abort: false, pause: false, budgetBump: false }; } };
    const poller = new ReactionsPoller(state, reader, { intervalMs: 60_000, logger: { info() {}, warn() {}, error() {} } });
    await poller.start();
    await poller.start();
    await poller.stop();
    await poller.stop();
  });
