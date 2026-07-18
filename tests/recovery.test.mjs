import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let recoverSessions, findInterruptedSessions, Database;
try {
  ({ recoverSessions, findInterruptedSessions } = await import("../dist/state/recovery.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  recoverSessions = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  const audits = [];
  const state = {
    db,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
  };
  return { state, audits };
}

function insertSession(db, id, status, updatedAt) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
      worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  ).run(id, `t-${id}`, "C1", "U1", "u1", "o/r", "harness/x", "/tmp/wt", status, updatedAt, updatedAt, 50);
}

test("findInterruptedSessions: only picks non-terminal states",
  { skip: recoverSessions === null }, () => {
    const { state } = makeStore();
    insertSession(state.db, "a", "planning", Date.now());
    insertSession(state.db, "b", "done", Date.now());
    insertSession(state.db, "c", "aborted", Date.now());
    insertSession(state.db, "d", "executing", Date.now());
    const found = findInterruptedSessions(state, 3600);
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((f) => f.id).sort(), ["a", "d"]);
  });

test("findInterruptedSessions: marks stale by cutoff",
  { skip: recoverSessions === null }, () => {
    const { state } = makeStore();
    const now = Date.now();
    insertSession(state.db, "fresh", "executing", now);
    insertSession(state.db, "old", "executing", now - 7200 * 1000);
    const found = findInterruptedSessions(state, 3600);
    const map = Object.fromEntries(found.map((f) => [f.id, f.stale]));
    assert.equal(map.fresh, false);
    assert.equal(map.old, true);
  });

test("recoverSessions: moves stale to interrupted, calls notify",
  { skip: recoverSessions === null }, async () => {
    const { state } = makeStore();
    const now = Date.now();
    insertSession(state.db, "stale", "executing", now - 7200 * 1000);
    insertSession(state.db, "fresh", "reviewing", now);
    const notified = [];
    const { interrupted, resumable } = await recoverSessions(state, {
      staleAfterSeconds: 3600,
      notify: async (s) => { notified.push(s.id); },
      logger: { info() {}, warn() {} },
    });
    assert.equal(interrupted, 1);
    assert.equal(resumable, 1);
    assert.deepEqual(notified.sort(), ["fresh", "stale"]);
    const staleStatus = state.db.prepare(`SELECT status FROM sessions WHERE id = 'stale'`).get().status;
    assert.equal(staleStatus, "interrupted");
    const freshStatus = state.db.prepare(`SELECT status FROM sessions WHERE id = 'fresh'`).get().status;
    assert.equal(freshStatus, "reviewing");
  });

// beta.30: in agent-orchestrated mode a fresh in-flight session must be
// AUTO-RESUMED (no reaction poller / listener to resume it otherwise). This
// was the ProjectThanos symptom: container restarted mid-run, session sat at
// 'planning', recovery marked it 'resumable', logs went dead.
test("recoverSessions: agent-orchestrated mode auto-resumes fresh sessions (does NOT strand)",
  { skip: recoverSessions === null }, async () => {
    const { state, audits } = makeStore();
    const now = Date.now();
    insertSession(state.db, "stale", "executing", now - 7200 * 1000);
    insertSession(state.db, "fresh", "planning", now);
    const resumed = [];
    const { interrupted, resumable } = await recoverSessions(state, {
      staleAfterSeconds: 3600,
      agentOrchestrated: true,
      autoResume: async (s) => { resumed.push(s.id); },
      notify: async () => { throw new Error("notify must NOT be called for auto-resumed fresh sessions"); },
      logger: { info() {}, warn() {} },
    });
    assert.equal(interrupted, 1);
    assert.equal(resumable, 1);
    // fresh session was auto-resumed, not left waiting on a reaction.
    assert.deepEqual(resumed, ["fresh"]);
    assert.ok(audits.some((a) => a.event === "recovery.auto_resuming" && a.sessionId === "fresh"));
    // stale still marked interrupted.
    assert.equal(state.db.prepare(`SELECT status FROM sessions WHERE id = 'stale'`).get().status, "interrupted");
  });

test("recoverSessions: agentOrchestrated without autoResume audits the strand risk (defensive)",
  { skip: recoverSessions === null }, async () => {
    const { state, audits } = makeStore();
    insertSession(state.db, "fresh", "planning", Date.now());
    const { resumable } = await recoverSessions(state, {
      staleAfterSeconds: 3600,
      agentOrchestrated: true,
      // no autoResume provided
      logger: { info() {}, warn() {} },
    });
    assert.equal(resumable, 1);
    assert.ok(audits.some((a) => a.event === "recovery.autoresume_unavailable" && a.sessionId === "fresh"));
  });

test("recoverSessions: listener mode keeps conservative 'resumable' + notify (no auto-resume)",
  { skip: recoverSessions === null }, async () => {
    const { state, audits } = makeStore();
    insertSession(state.db, "fresh", "planning", Date.now());
    const notified = [];
    const { resumable } = await recoverSessions(state, {
      staleAfterSeconds: 3600,
      agentOrchestrated: false,
      autoResume: async () => { throw new Error("autoResume must NOT be called in listener mode"); },
      notify: async (s) => { notified.push(s.id); },
      logger: { info() {}, warn() {} },
    });
    assert.equal(resumable, 1);
    assert.deepEqual(notified, ["fresh"]);
    assert.ok(audits.some((a) => a.event === "recovery.marked_resumable" && a.sessionId === "fresh"));
  });
