// beta.77 — harness-native OUTBOUND progress/terminal delivery.
//
// The DR/BCP wedge (session 44377c62 / poller d47c8686): the harness loop ran
// and terminated cleanly, but the channel-agent turn that relays harness_progress
// to Slack WEDGED (embedded_run:started, recovery=none), so no progress/terminal
// announcement reached anyone. Fix: a SECOND, independent outbound path — direct
// chat.postMessage via the vault bot token — for progress/terminal ONLY, gated on
// a REAL Slack binding. Clarifications/inbound stay agent-mediated (unchanged).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  hasRealSlackBinding,
  SlackProgressPoster,
} from "../dist/slack/progress-poster.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const src = (rel) => readFileSync(join(ROOT, "src", rel), "utf8");

const silentLogger = { info() {}, warn() {} };

// ───────────────────────────────────────────────────────────────────────────
// hasRealSlackBinding — the gate that keeps the pre-beta.37 failure from
// returning (agent runs have ""/agent:<uuid> which Slack rejects + swallows).
// ───────────────────────────────────────────────────────────────────────────
test("hasRealSlackBinding: real channel + real thread => true", () => {
  assert.equal(hasRealSlackBinding("C0BHN081CA0", "1785164455.892749"), true);
});

test("hasRealSlackBinding: empty channel => false", () => {
  assert.equal(hasRealSlackBinding("", "1785164455.892749"), false);
});

test("hasRealSlackBinding: agent-orchestrated synthetic thread => false", () => {
  assert.equal(hasRealSlackBinding("C0BHN081CA0", "agent:44377c62-da5a-439e-b925-b21c3d3af452"), false);
  // channel is also "" for agent runs, but the thread guard alone must catch it
  assert.equal(hasRealSlackBinding("", "agent:xyz"), false);
});

test("hasRealSlackBinding: reclaimed tombstone thread => false", () => {
  assert.equal(hasRealSlackBinding("C0BHN081CA0", "retired:sid:1785164455.892749"), false);
});

test("hasRealSlackBinding: empty/nullish thread => false", () => {
  assert.equal(hasRealSlackBinding("C0BHN081CA0", ""), false);
  assert.equal(hasRealSlackBinding("C0BHN081CA0", null), false);
  assert.equal(hasRealSlackBinding(null, "1785.1"), false);
  assert.equal(hasRealSlackBinding(undefined, undefined), false);
});

// ───────────────────────────────────────────────────────────────────────────
// SlackProgressPoster.post — direct chat.postMessage, best-effort, never throws.
// ───────────────────────────────────────────────────────────────────────────
test("post: hits chat.postMessage with Bearer token + thread_ts", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { status: 200, ok: true, headers: new Map(), json: async () => ({ ok: true, ts: "1785.9" }) };
  };
  const poster = new SlackProgressPoster({ slackToken: "xoxb-TESTTOKEN", fetchImpl, logger: silentLogger });
  const r = await poster.post("C0BHN081CA0", "1785164455.892749", ":robot_face: Executing sub-task 2/3.");
  assert.equal(r.ok, true);
  assert.equal(r.ts, "1785.9");
  assert.equal(captured.url, "https://slack.com/api/chat.postMessage");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer xoxb-TESTTOKEN");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.channel, "C0BHN081CA0");
  assert.equal(body.thread_ts, "1785164455.892749");
  assert.match(body.text, /Executing sub-task 2\/3/);
});

test("post: refuses (no fetch) when the binding is synthetic", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error("should not fetch"); };
  const poster = new SlackProgressPoster({ slackToken: "xoxb-x", fetchImpl, logger: silentLogger });
  const r = await poster.post("", "agent:abc", "hi");
  assert.equal(r.ok, false);
  assert.equal(r.error, "no_real_binding");
  assert.equal(called, false);
});

test("post: best-effort on Slack ok:false — returns ok:false, never throws", async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, headers: new Map(), json: async () => ({ ok: false, error: "channel_not_found" }) });
  const poster = new SlackProgressPoster({ slackToken: "xoxb-x", fetchImpl, logger: silentLogger });
  const r = await poster.post("C0X", "1785.1", "hi");
  assert.equal(r.ok, false);
  assert.equal(r.error, "channel_not_found");
});

test("post: best-effort on HTTP 429 rate limit — swallowed", async () => {
  const fetchImpl = async () => ({ status: 429, ok: false, headers: new Map([["retry-after", "30"]]), json: async () => ({}) });
  const poster = new SlackProgressPoster({ slackToken: "xoxb-x", fetchImpl, logger: silentLogger });
  const r = await poster.post("C0X", "1785.1", "hi");
  assert.equal(r.ok, false);
  assert.equal(r.error, "ratelimited");
});

test("post: best-effort on thrown fetch — caught, returns ok:false", async () => {
  const fetchImpl = async () => { throw new Error("ECONNRESET"); };
  const poster = new SlackProgressPoster({ slackToken: "xoxb-x", fetchImpl, logger: silentLogger });
  const r = await poster.post("C0X", "1785.1", "hi");
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNRESET/);
});

// ───────────────────────────────────────────────────────────────────────────
// Behavioural: deliverProgress fires from the loop's setStatus on BOTH a phase
// transition and a terminal transition (single choke point = full coverage).
// (private setStatus is compile-time only; callable from the built JS.)
// ───────────────────────────────────────────────────────────────────────────
test("deliverProgress fires from setStatus on phase AND terminal transitions", async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  // Minimal schema for what setStatus touches.
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER, last_progress_at INTEGER);`);
  db.prepare(`INSERT INTO sessions (id, status, updated_at, last_progress_at) VALUES ('s1','planning',0,0)`).run();

  const calls = [];
  const loop = new OrchestratorLoop({
    state: { db, audit() {} },
    deliverProgress: (sessionId, status) => { calls.push({ sessionId, status }); },
  });

  // private in TS, present on the instance at runtime.
  loop.setStatus("s1", "executing");
  loop.setStatus("s1", "done");

  assert.deepEqual(calls, [
    { sessionId: "s1", status: "executing" },
    { sessionId: "s1", status: "done" },
  ]);
  // and the status column actually advanced (proves we didn't short-circuit)
  const row = db.prepare(`SELECT status FROM sessions WHERE id='s1'`).get();
  assert.equal(row.status, "done");
  db.close();
});

test("deliverProgress throwing can NEVER escape setStatus (best-effort hot path)", async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER, last_progress_at INTEGER);`);
  db.prepare(`INSERT INTO sessions (id, status, updated_at, last_progress_at) VALUES ('s1','planning',0,0)`).run();
  const loop = new OrchestratorLoop({
    state: { db, audit() {} },
    deliverProgress: () => { throw new Error("poster blew up"); },
  });
  // must not throw
  assert.doesNotThrow(() => loop.setStatus("s1", "aborted"));
  db.close();
});

// ───────────────────────────────────────────────────────────────────────────
// Wiring source-assertions.
// ───────────────────────────────────────────────────────────────────────────
test("loop.ts fires deliverProgress from setStatus, guarded, and imports NO Slack", () => {
  const loop = src("orchestrator/loop.ts");
  assert.match(loop, /deliverProgress\?\s*:\s*\(sessionId: string, status: LoopStatus\)\s*=>\s*void/);
  // fired inside setStatus, wrapped in try/catch (guarded)
  const setStatusBody = loop.slice(loop.indexOf("private setStatus"), loop.indexOf("private markProgress"));
  assert.match(setStatusBody, /this\.deps\.deliverProgress\?\.\(sessionId, status\)/);
  assert.match(setStatusBody, /try\s*\{[\s\S]*deliverProgress[\s\S]*\}\s*catch/);
  // the loop stays Slack-agnostic: no import of the poster/adapter into loop.ts
  assert.doesNotMatch(loop, /from "\.\.\/slack\/progress-poster/);
  assert.doesNotMatch(loop, /from "\.\.\/adapters\/slack/);
});

test("index.ts gates deliverProgress on poster + native_progress_delivery + hasRealSlackBinding", () => {
  const idx = src("index.ts");
  assert.match(idx, /import \{ SlackProgressPoster, hasRealSlackBinding \} from "\.\/slack\/progress-poster\.js"/);
  // deliverProgress closure: all three gates present
  const dp = idx.slice(idx.indexOf("deliverProgress: (sessionId"), idx.indexOf("deliverProgress: (sessionId") + 2200); // beta.86/.88: widened for de-dup guard + terminal-eviction inserts
  assert.match(dp, /runtime\.progressPoster/);
  assert.match(dp, /native_progress_delivery === false/);
  assert.match(dp, /hasRealSlackBinding\(channel, thread\)/);
  assert.match(dp, /buildProgressSnapshot\(state\.db, sessionId\)\.headline/);
  assert.match(dp, /poster\.post\(/);
});

test("index.ts builds the poster in async bootstrap under credential_service, reusing the token", () => {
  const idx = src("index.ts");
  // built inside the same block that resolves slackToken for the reactions poller
  assert.match(idx, /runtime\.progressPoster = new SlackProgressPoster\(\{ slackToken, logger: api\.logger \}\)/);
  // gated on native_progress_delivery !== false at build time too
  const block = idx.slice(idx.indexOf("Reactions poller (only if"), idx.indexOf("Reactions poller (only if") + 900);
  assert.match(block, /native_progress_delivery !== false/);
  // runtime slot initialised null
  assert.match(idx, /progressPoster: null/);
});

test("config + manifest declare native_progress_delivery (default true)", () => {
  const cfg = src("config.ts");
  assert.match(cfg, /native_progress_delivery\?\s*:\s*boolean/);
  assert.match(cfg, /native_progress_delivery: true/); // DEFAULTS
  const manifest = JSON.parse(src("../openclaw.plugin.json"));
  const slackSchema = manifest.configSchema.properties.slack;
  const slackProps = slackSchema.properties;
  assert.ok(slackProps.native_progress_delivery, "manifest must declare slack.native_progress_delivery");
  assert.equal(slackProps.native_progress_delivery.type, "boolean");
  assert.equal(slackProps.native_progress_delivery.default, true);
  // additionalProperties:false means an undeclared key would reject the whole config
  assert.equal(slackSchema.additionalProperties, false);
});

test("clarification/inbound path is UNTOUCHED — questions never direct-posted", () => {
  const idx = src("index.ts");
  const reg = src("tools/registration.ts");
  // harness_answer remains the resume path; deliverProgress must NOT be wired
  // into the clarification finalise or harness_answer (questions stay agent-mediated).
  assert.match(reg, /harness_answer/);
  // the poster is only invoked from the deliverProgress closure, not from any
  // clarification handler — assert the poster symbol appears only in the wiring
  // we expect (bootstrap build + deliverProgress), not near harness_answer.
  assert.doesNotMatch(reg, /progressPoster|SlackProgressPoster|chat\.postMessage/);
});
