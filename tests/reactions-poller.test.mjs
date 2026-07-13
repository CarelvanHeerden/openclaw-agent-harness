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

test("ReactionsPoller.pollOnce: applies exponential backoff on unchanged snapshots",
  { skip: ReactionsPoller === null }, async () => {
    const state = makeStore();
    state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','executing',?,?,50,0,0)`).run(Date.now(), Date.now());

    let reads = 0;
    const snap = { shipIt: false, abort: false, pause: false, budgetBump: false };
    const reader = { async read() { reads++; return snap; } };
    const poller = new ReactionsPoller(state, reader, {
      intervalMs: 1000,
      maxBackoffMultiplier: 3,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Algorithm: with streak=k after last read at tick L, we skip while
    // (T - L) <= k. So streak=1 skips 1 tick, streak=2 skips 2 ticks, etc.

    // Tick 1: no prior state -> reads. streak=0, L=1.
    await poller.pollOnce();
    assert.equal(reads, 1);

    // Tick 2: streak=0 -> reads. Unchanged -> streak=1, L=2.
    await poller.pollOnce();
    assert.equal(reads, 2);

    // Tick 3: streak=1, (3-2)=1 <= 1 -> SKIP.
    await poller.pollOnce();
    assert.equal(reads, 2, "streak=1 skips 1 tick");

    // Tick 4: (4-2)=2 > 1 -> reads. Unchanged -> streak=2, L=4.
    await poller.pollOnce();
    assert.equal(reads, 3);

    // Ticks 5,6: streak=2 skips 2 ticks.
    await poller.pollOnce();
    await poller.pollOnce();
    assert.equal(reads, 3);

    // Tick 7: (7-4)=3 > 2 -> reads. Unchanged -> streak=3, L=7.
    await poller.pollOnce();
    assert.equal(reads, 4);

    // Backoff caps at maxBackoffMultiplier=3, so streak stays at 3.
    // Ticks 8,9,10: skip. Tick 11: (11-7)=4 > 3 -> reads.
    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();
    assert.equal(reads, 4);
    await poller.pollOnce();
    assert.equal(reads, 5, "backoff capped at maxBackoffMultiplier");
  });

test("ReactionsPoller.pollOnce: backoff resets when reactions change",
  { skip: ReactionsPoller === null }, async () => {
    const state = makeStore();
    state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','executing',?,?,50,0,0)`).run(Date.now(), Date.now());

    let reads = 0;
    let shipIt = false;
    const reader = { async read() { reads++; return { shipIt, abort: false, pause: false, budgetBump: false }; } };
    const poller = new ReactionsPoller(state, reader, {
      intervalMs: 1000,
      maxBackoffMultiplier: 5,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Build up backoff
    await poller.pollOnce(); // T=1: reads=1, streak=0, L=1
    await poller.pollOnce(); // T=2: reads=2, streak=1 (unchanged), L=2
    await poller.pollOnce(); // T=3: SKIP (streak=1)
    await poller.pollOnce(); // T=4: reads=3, streak=2, L=4

    // Reactions change now
    shipIt = true;
    await poller.pollOnce(); // T=5: SKIP (streak=2, 5-4=1 <= 2)
    assert.equal(reads, 3);
    await poller.pollOnce(); // T=6: SKIP (6-4=2 <= 2)
    assert.equal(reads, 3);
    await poller.pollOnce(); // T=7: reads (7-4=3 > 2). Snapshot changed -> streak=0, L=7
    assert.equal(reads, 4);

    // Streak reset. Next tick unchanged (shipIt still true) reads immediately.
    await poller.pollOnce(); // T=8: reads=5, streak=1 (unchanged), L=8
    assert.equal(reads, 5, "streak reset means next poll happens immediately");

    const st = poller._debugState().get("S1");
    assert.ok(st, "debug state exposed");
    assert.equal(st.streak, 1, "unchanged after reset -> streak=1");
  });

test("ReactionsPoller.pollOnce: terminal sessions never polled + state reaped",
  { skip: ReactionsPoller === null }, async () => {
    const state = makeStore();
    state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','executing',?,?,50,0,0)`).run(Date.now(), Date.now());

    const reader = { async read() { return { shipIt: false, abort: false, pause: false, budgetBump: false }; } };
    const poller = new ReactionsPoller(state, reader, { intervalMs: 1000, logger: { info() {}, warn() {}, error() {} } });

    await poller.pollOnce();
    assert.ok(poller._debugState().has("S1"));

    // Session moves to done -> should be dropped from state map on next poll
    state.db.prepare(`UPDATE sessions SET status='done' WHERE id='S1'`).run();
    await poller.pollOnce();
    assert.equal(poller._debugState().has("S1"), false, "terminal session reaped from backoff state");
  });
