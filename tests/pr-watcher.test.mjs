import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let PrMergedWatcher, parsePrUrl, Database;
try {
  ({ PrMergedWatcher, parsePrUrl } = await import("../dist/adapters/github-watcher.js"));
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  PrMergedWatcher = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return {
    db,
    audit(event, payload, sessionId) {
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
  };
}

function insertShipped(db, id, prUrl) {
  db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
    worktree_path, status, final_pr_url, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
    VALUES (?, 'T', 'C1', 'U1', 'u1', 'o/r', 'harness/x', '/wt/S', 'done', ?, ?, ?, 50, 0, 1)`)
    .run(id, prUrl, Date.now(), Date.now());
}

test("parsePrUrl: valid PR URL",
  { skip: PrMergedWatcher === null }, () => {
    assert.deepEqual(parsePrUrl("https://github.com/o/r/pull/42"), { owner: "o", repo: "r", number: 42 });
  });

test("parsePrUrl: rejects garbage",
  { skip: PrMergedWatcher === null }, () => {
    assert.equal(parsePrUrl("https://example.com/foo"), null);
  });

test("PrMergedWatcher: marks merged PR closed, calls slack + git release",
  { skip: PrMergedWatcher === null }, async () => {
    const state = makeStore();
    insertShipped(state.db, "S1", "https://github.com/o/r/pull/9");

    let slackText = "";
    let releasedFor = "";
    const w = new PrMergedWatcher(state, {
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ state: "closed", merged: true, merged_at: "2026-07-13T15:00:00Z" }),
      }),
      slackNotify: async (_ch, _ts, text) => { slackText = text; },
      git: { release: async (id) => { releasedFor = id; } },
      resolveGhToken: async () => "ghp_test",
    });

    const closed = await w.pollOnce();
    assert.equal(closed, 1);
    assert.match(slackText, /PR merged/);
    assert.equal(releasedFor, "S1");

    // Second poll should not repeat (prClosedAt now set)
    const closed2 = await w.pollOnce();
    assert.equal(closed2, 0);
  });

test("PrMergedWatcher: closed-without-merge posts different message",
  { skip: PrMergedWatcher === null }, async () => {
    const state = makeStore();
    insertShipped(state.db, "S2", "https://github.com/o/r/pull/10");
    let slackText = "";
    const w = new PrMergedWatcher(state, {
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ state: "closed", merged: false, merged_at: null }),
      }),
      slackNotify: async (_ch, _ts, text) => { slackText = text; },
      resolveGhToken: async () => "ghp",
    });
    await w.pollOnce();
    assert.match(slackText, /closed without merge/);
  });

test("PrMergedWatcher: open PR is left alone",
  { skip: PrMergedWatcher === null }, async () => {
    const state = makeStore();
    insertShipped(state.db, "S3", "https://github.com/o/r/pull/11");
    const w = new PrMergedWatcher(state, {
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ state: "open", merged: false, merged_at: null }),
      }),
      slackNotify: async () => {},
      resolveGhToken: async () => "ghp",
    });
    const closed = await w.pollOnce();
    assert.equal(closed, 0);
  });
