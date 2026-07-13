import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let registerHarnessTools, Database;
try {
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ default: Database } = await import("better-sqlite3"));
} catch {
  registerHarnessTools = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeRuntime() {
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
    close() { db.close(); },
  };
  const loopCalls = [];
  const loop = {
    run: async (sessionId, brief) => {
      loopCalls.push({ sessionId, brief });
      return { status: "shipped", sessionId, prUrl: "https://x/pr/1", cycles: 1, totalCostUsd: 0.1 };
    },
  };
  return {
    state,
    loop,
    audits,
    loopCalls,
    config: {
      storage: { audit_retention_days: 90, prune_terminal_sessions: false, prune_terminal_sessions_days: 365 },
      slack: { channel: "C1" },
      repos: { allowed: ["o/*"] },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    },
  };
}

function collectTools() {
  const tools = new Map();
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: (def) => {
      tools.set(def.name, def);
      return () => tools.delete(def.name);
    },
  };
  return { api, tools };
}

test("registration: registers 6 tools",
  { skip: registerHarnessTools === null }, () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    assert.deepEqual(
      [...tools.keys()].sort(),
      ["harness_cancel", "harness_resume", "harness_retention_prune", "harness_session_get", "harness_status", "harness_telemetry"],
    );
  });

test("harness_cancel: sets abort flag on non-terminal session",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','executing',?,?,50,0,0)`).run(Date.now(), Date.now());
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_cancel").execute({ sessionId: "S1", reason: "test" });
    assert.equal(res.details.ok, true);
    const row = runtime.state.db.prepare(`SELECT reactions_json FROM sessions WHERE id = 'S1'`).get();
    assert.match(row.reactions_json, /"abort":true/);
  });

test("harness_cancel: refuses terminal session",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','done',?,?,50,0,0)`).run(Date.now(), Date.now());
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_cancel").execute({ sessionId: "S1" });
    assert.equal(res.details.ok, false);
    assert.equal(res.details.alreadyTerminal, true);
  });

test("harness_resume: kicks loop for interrupted session with brief",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const brief = JSON.stringify({ title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" });
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','interrupted',?,?,?,50,0,0)`).run(brief, Date.now(), Date.now());
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_resume").execute({ sessionId: "S1" });
    assert.equal(res.details.ok, true);
    // Give the fire-and-forget a beat
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runtime.loopCalls.length, 1);
    const row = runtime.state.db.prepare(`SELECT status FROM sessions WHERE id = 'S1'`).get();
    assert.equal(row.status, "planning");
  });

test("harness_resume: refuses done session",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','done',?,?,50,0,0)`).run(Date.now(), Date.now());
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_resume").execute({ sessionId: "S1" });
    assert.equal(res.details.ok, false);
    assert.equal(res.details.badStatus, "done");
  });

test("harness_resume: refuses session without brief",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U','u','o/r','b','/wt','interrupted',?,?,50,0,0)`).run(Date.now(), Date.now());
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_resume").execute({ sessionId: "S1" });
    assert.equal(res.details.ok, false);
    assert.equal(res.details.missingBrief, true);
  });
