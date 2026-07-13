import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let openStateStore, SlackChannelListener;
try {
  ({ openStateStore } = await import("../dist/state/store.js"));
  ({ SlackChannelListener } = await import("../dist/slack/channel-listener.js"));
} catch {
  openStateStore = null;
  SlackChannelListener = null;
}

const CHANNEL = "C0DEVCHAN";
const USER = "U07UT6G8LQ4";

const cfg = {
  slack: {
    channel: CHANNEL,
    authorised_users: [USER],
    reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" },
  },
};

function makeListener(store) {
  const noopLogger = { info() {}, warn() {}, error() {} };
  const noopLoop = { async run() { return { status: "shipped", totalCostUsd: 0, cycles: 0 }; } };
  return new SlackChannelListener({ config: cfg, loop: noopLoop, state: store, logger: noopLogger });
}

function withStore(fn) {
  return async (t) => {
    if (openStateStore === null) { t.skip(); return; }
    const dir = mkdtempSync(join(tmpdir(), "oah-test-"));
    const store = await openStateStore(join(dir, "state.db"));
    try { await fn(store, t); }
    finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("routeMessage: bot messages are ignored", withStore(async (store) => {
  const l = makeListener(store);
  const r = l.routeMessage({ channel: CHANNEL, user: USER, text: "hi", ts: "1.0", bot_id: "B123" });
  assert.equal(r.kind, "ignore");
  assert.equal(r.reason, "bot_message");
}));

test("routeMessage: wrong channel ignored", withStore(async (store) => {
  const l = makeListener(store);
  const r = l.routeMessage({ channel: "C_OTHER", user: USER, text: "hi", ts: "1.0" });
  assert.equal(r.kind, "ignore");
  assert.equal(r.reason, "wrong_channel");
}));

test("routeMessage: unauthorised user ignored", withStore(async (store) => {
  const l = makeListener(store);
  const r = l.routeMessage({ channel: CHANNEL, user: "U_STRANGER", text: "hi", ts: "1.0" });
  assert.equal(r.kind, "ignore");
  assert.equal(r.reason, "unauthorised_user");
}));

test("routeMessage: top-level post starts new session", withStore(async (store) => {
  const l = makeListener(store);
  const r = l.routeMessage({ channel: CHANNEL, user: USER, text: "add a hello comment", ts: "100.5" });
  assert.equal(r.kind, "start_new_session");
  assert.equal(r.threadTs, "100.5");
}));

test("routeMessage: reply in-thread with existing session continues it", withStore(async (store) => {
  store.db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("S1", "100.5", CHANNEL, USER, "CarelvanHeerden", "org/repo", "harness/x", "/tmp/w", "crystallising", Date.now(), Date.now(), 50);
  const l = makeListener(store);
  const r = l.routeMessage({ channel: CHANNEL, user: USER, text: "go", ts: "200.1", thread_ts: "100.5" });
  assert.equal(r.kind, "continue_session");
  assert.equal(r.sessionId, "S1");
}));

test("routeMessage: reply in orphan thread is ignored (no session)", withStore(async (store) => {
  const l = makeListener(store);
  const r = l.routeMessage({ channel: CHANNEL, user: USER, text: "hey?", ts: "200.1", thread_ts: "99.0" });
  assert.equal(r.kind, "ignore");
  assert.equal(r.reason, "reply_in_thread_without_session");
}));
