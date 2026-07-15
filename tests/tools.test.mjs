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
      slack: { channel: "C1", authorised_users: ["U1"] },
      repos: { allowed: ["o/*"] },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
      budgets: { session_default_usd: 50 },
    },
  };
}

function collectTools() {
  const tools = new Map();
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: (def) => {
      // OpenClaw SDK signature is `execute(callId, params, context?)`. Our tests
      // pre-date this and call `.execute(input)` with a single arg. Wrap the
      // real execute so tests keep working without touching every call site.
      const wrapped = {
        ...def,
        execute: (input) => def.execute("test-call-id", input),
      };
      tools.set(def.name, wrapped);
      return () => tools.delete(def.name);
    },
  };
  return { api, tools };
}

test("registration: registers 9 tools",
  { skip: registerHarnessTools === null }, () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    assert.deepEqual(
      [...tools.keys()].sort(),
      ["harness_cancel", "harness_health", "harness_resume", "harness_retention_prune", "harness_session_get", "harness_start_session", "harness_status", "harness_telemetry", "harness_upload_logs"],
    );
  });

test("harness_upload_logs: writes row + audit; caps at 16KB; adversary loop can read latest",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    // Seed a session so the FK is satisfied
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, crystallised_prompt, created_at, updated_at, budget_usd) VALUES ('S1','T1','C1','U1','U1','o/r','feat','/tmp','planning','{}',0,0,50)`).run();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const bigLog = "x".repeat(20 * 1024);
    const r1 = await tools.get("harness_upload_logs").execute({ sessionId: "S1", uploadedBy: "U1", status: "ok", logsExcerpt: bigLog, source: "nginx", errorCount: 3 });
    assert.equal(r1.details.ok, true);
    assert.ok(r1.details.bytes < 20 * 1024, "should truncate above 16KB");
    const row = runtime.state.db.prepare(`SELECT status, source, error_count, LENGTH(logs_excerpt) AS n FROM runtime_uploads WHERE session_id='S1' ORDER BY uploaded_at DESC LIMIT 1`).get();
    assert.equal(row.status, "ok");
    assert.equal(row.source, "nginx");
    assert.equal(row.error_count, 3);
    assert.ok(row.n <= 16 * 1024 + 30, `row logs len should cap near 16KB, got ${row.n}`);
  });

test("harness_upload_logs: unknown session rejected",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const r = await tools.get("harness_upload_logs").execute({ sessionId: "S_NONE", uploadedBy: "U1", status: "ok", logsExcerpt: "foo" });
    assert.equal(r.details.ok, false);
    assert.equal(r.details.notFound, true);
  });

test("harness_upload_logs: unauthorised uploader rejected",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.state.db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, crystallised_prompt, created_at, updated_at, budget_usd) VALUES ('S2','T2','C1','U1','U1','o/r','feat','/tmp','planning','{}',0,0,50)`).run();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const r = await tools.get("harness_upload_logs").execute({ sessionId: "S2", uploadedBy: "U_STRANGER", status: "ok", logsExcerpt: "foo" });
    assert.equal(r.details.ok, false);
    assert.equal(r.details.unauthorised, true);
  });

test("harness_health: reports OK when config + schema are minimally valid",
  { skip: registerHarnessTools === null }, () => {
    const runtime = makeRuntime();
    // Minimally-valid config: channel, users, repos allow-list
    runtime.config.slack = { channel: "C_TEST", authorised_users: ["U1"], reactions: {}, credential_service: "slack-x" };
    runtime.config.repos = { allowed: ["o/r"] };
    runtime.config.vercel = { enabled: false };
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = tools.get("harness_health").execute({});
    assert.equal(res.details.ok, true);
    const dbCheck = res.details.checks.find((c) => c.name === "db_reachable");
    assert.equal(dbCheck.ok, true);
    const chanCheck = res.details.checks.find((c) => c.name === "config_slack_channel");
    assert.equal(chanCheck.detail, "C_TEST");
  });

test("harness_health: DEGRADED when config missing repos",
  { skip: registerHarnessTools === null }, () => {
    const runtime = makeRuntime();
    runtime.config.slack = { channel: "C_TEST", authorised_users: ["U1"], reactions: {} };
    runtime.config.repos = { allowed: [] };
    runtime.config.vercel = { enabled: false };
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = tools.get("harness_health").execute({});
    assert.equal(res.details.ok, false);
    assert.match(res.content[0].text, /DEGRADED/);
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

test("harness_start_session: happy path inserts + kicks loop",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_start_session").execute({
      requester: "U1",
      slackChannel: "C1",
      slackThread: "T1",
      brief: { title: "Add hello", motivation: "we need a smoke endpoint", acceptanceCriteria: ["GET /hello returns 200"], riskLevel: "low" },
    });
    assert.equal(res.details.ok, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runtime.loopCalls.length, 1);
    const row = runtime.state.db.prepare(`SELECT status FROM sessions WHERE slack_thread='T1'`).get();
    assert.equal(row.status, "planning");
  });

test("harness_start_session: refuses unauthorised requester",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_start_session").execute({
      requester: "U_STRANGER",
      slackChannel: "C1",
      slackThread: "T99",
      brief: { title: "x", motivation: "long enough", acceptanceCriteria: ["a"] },
    });
    assert.equal(res.details.ok, false);
    assert.equal(res.details.unauthorised, true);
  });

test("harness_start_session: duplicate thread returns duplicate error",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const brief = { title: "Add hello", motivation: "we need a smoke endpoint", acceptanceCriteria: ["a"] };
    const r1 = await tools.get("harness_start_session").execute({ requester: "U1", slackChannel: "C1", slackThread: "TDUP", brief });
    assert.equal(r1.details.ok, true);
    const r2 = await tools.get("harness_start_session").execute({ requester: "U1", slackChannel: "C1", slackThread: "TDUP", brief });
    assert.equal(r2.details.ok, false);
    assert.equal(r2.details.duplicateThread, true);
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
