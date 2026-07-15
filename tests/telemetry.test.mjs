import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let registerHarnessTools, Database;
try {
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  registerHarnessTools = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeRuntime() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return {
    state: {
      db,
      audit() {},
    },
    loop: { run: async () => ({}) },
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
  return {
    api: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerTool: (def) => {
        // Wrap execute to match old single-arg calling convention.
        // OpenClaw SDK execute is (callId, params, ctx?) but tests still call
        // `.execute(input)` — we prepend a fake callId here.
        const wrapped = { ...def, execute: (input) => def.execute("test-call-id", input) };
        tools.set(def.name, wrapped);
        return () => tools.delete(def.name);
      },
    },
    tools,
  };
}

const nowMonth = new Date().toISOString().slice(0, 7);
const monthStartMs = Date.UTC(Number(nowMonth.split("-")[0]), Number(nowMonth.split("-")[1]) - 1, 1);

test("harness_telemetry: aggregates monthly, daily, sessions",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.state.db.prepare(`INSERT INTO budgets_monthly (month, user, spent_usd, session_count) VALUES (?, 'U1', 12.5, 3)`).run(nowMonth);
    runtime.state.db.prepare(`INSERT INTO budgets_monthly (month, user, spent_usd, session_count) VALUES (?, 'U2', 3.0, 1)`).run(nowMonth);
    runtime.state.db.prepare(`INSERT INTO budgets_daily (day, user, spent_usd) VALUES (?, 'U1', 5.0)`).run(`${nowMonth}-01`);
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S1','T','C','U1','u','o/r','b','/wt','done',?,?,50,4.5,2)`).run(monthStartMs + 1000, monthStartMs + 2000);
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran) VALUES ('S2','T2','C','U1','u','o/r','b','/wt','failed',?,?,50,8.0,3)`).run(monthStartMs + 3000, monthStartMs + 4000);

    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_telemetry").execute({});
    assert.equal(res.details.ok, true);
    assert.equal(res.details.totals.sessions, 2);
    assert.equal(res.details.totals.shipped, 1);
    assert.equal(res.details.totals.failed, 1);
    assert.equal(res.details.totals.monthUsd, 15.5);
  });

test("harness_telemetry: filters by user",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.state.db.prepare(`INSERT INTO budgets_monthly (month, user, spent_usd, session_count) VALUES (?, 'U1', 12.5, 3)`).run(nowMonth);
    runtime.state.db.prepare(`INSERT INTO budgets_monthly (month, user, spent_usd, session_count) VALUES (?, 'U2', 3.0, 1)`).run(nowMonth);
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_telemetry").execute({ user: "U1" });
    assert.equal(res.details.totals.monthUsd, 12.5);
  });
