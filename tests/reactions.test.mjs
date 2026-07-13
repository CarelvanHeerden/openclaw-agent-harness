import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let SlackReactionsReader, Database;
try {
  ({ SlackReactionsReader } = await import("../dist/slack/reactions.js"));
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  SlackReactionsReader = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return { db, audit() {} };
}

function config(reactions = { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" }) {
  return {
    slack: { channel: "C1", authorised_users: ["U_OK"], reactions },
  };
}

function insertSession(db) {
  db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
    worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
    VALUES ('S1', 'T1', 'C1', 'U1', 'u1', 'o/r', 'harness/x', '/wt', 'executing', ?, ?, 50, 0, 0)`)
    .run(Date.now(), Date.now());
}

test("SlackReactionsReader: authorised rocket -> shipIt",
  { skip: SlackReactionsReader === null }, async () => {
    const state = makeStore();
    insertSession(state.db);
    const fakeFetch = async (url) => {
      if (url.includes("reactions.get")) {
        return {
          ok: true,
          json: async () => ({ ok: true, message: { reactions: [{ name: "rocket", users: ["U_OK"] }] } }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, messages: [] }) };
    };
    const r = new SlackReactionsReader({ config: config(), state, slackToken: "xoxb", fetchImpl: fakeFetch, logger: { info() {}, warn() {} } });
    const snap = await r.read("S1");
    assert.equal(snap.shipIt, true);
    assert.equal(snap.abort, false);
  });

test("SlackReactionsReader: unauthorised user's reaction ignored",
  { skip: SlackReactionsReader === null }, async () => {
    const state = makeStore();
    insertSession(state.db);
    const fakeFetch = async (url) => {
      if (url.includes("reactions.get")) {
        return {
          ok: true,
          json: async () => ({ ok: true, message: { reactions: [{ name: "x", users: ["U_STRANGER"] }] } }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, messages: [] }) };
    };
    const r = new SlackReactionsReader({ config: config(), state, slackToken: "xoxb", fetchImpl: fakeFetch, logger: { info() {}, warn() {} } });
    const snap = await r.read("S1");
    assert.equal(snap.abort, false);
  });

test("SlackReactionsReader: budget_bump maps to budgetBump",
  { skip: SlackReactionsReader === null }, async () => {
    const state = makeStore();
    insertSession(state.db);
    const fakeFetch = async (url) => {
      if (url.includes("reactions.get")) {
        return {
          ok: true,
          json: async () => ({ ok: true, message: { reactions: [{ name: "moneybag", users: ["U_OK"] }] } }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, messages: [] }) };
    };
    const r = new SlackReactionsReader({ config: config(), state, slackToken: "xoxb", fetchImpl: fakeFetch, logger: { info() {}, warn() {} } });
    const snap = await r.read("S1");
    assert.equal(snap.budgetBump, true);
  });

test("SlackReactionsReader: missing session returns all-false snapshot",
  { skip: SlackReactionsReader === null }, async () => {
    const state = makeStore();
    const r = new SlackReactionsReader({ config: config(), state, slackToken: "xoxb", fetchImpl: async () => ({ ok: true, json: async () => ({}) }), logger: { info() {}, warn() {} } });
    const snap = await r.read("no-such-session");
    assert.deepEqual(snap, { shipIt: false, abort: false, pause: false, budgetBump: false });
  });
