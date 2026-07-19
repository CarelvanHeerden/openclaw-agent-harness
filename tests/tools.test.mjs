import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let registerHarnessTools, Database, setCurrentRuntime, getCurrentRuntime;
try {
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ setCurrentRuntime, getCurrentRuntime } = await import("../dist/runtime-registry.js"));
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
  let dbOpen = true;
  const state = {
    db,
    isOpen() { return dbOpen; },
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    close() { if (!dbOpen) return; dbOpen = false; db.close(); },
  };
  const loopCalls = [];
  const loop = {
    run: async (sessionId, brief) => {
      loopCalls.push({ sessionId, brief });
      return { status: "shipped", sessionId, prUrl: "https://x/pr/1", cycles: 1, totalCostUsd: 0.1 };
    },
  };
  // Configurable crystallise stub for harness_run tests. Default: returns a
  // brief. Override runtime.crystallise in a test to exercise clarify/reject.
  const crystalliseCalls = [];
  const crystallise = async (userText) => {
    crystalliseCalls.push(userText);
    return {
      kind: "brief",
      costUsd: 0,
      brief: {
        title: "Stub brief",
        motivation: "stub motivation for the request",
        acceptanceCriteria: ["it works"],
        filesLikelyTouched: [],
        outOfScope: [],
        riskLevel: "low",
      },
    };
  };
  return {
    state,
    loop,
    audits,
    loopCalls,
    crystalliseCalls,
    crystallise,
    // Default: a key resolves (so model_auth_resolvable passes). Tests that
    // want to exercise the missing-key path override runtime.anthropicApiKey.
    anthropicApiKey: async () => "sk-test-key",
    // Default: a GitHub token resolves (git_credential_resolvable passes).
    githubServiceFor: () => "github-o",
    githubToken: async () => "gh-test-token",
    gitResolutionFor: () => ({ credentialService: "github-o", provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" }),
    gitToken: async () => "gh-test-token",
    config: {
      storage: { audit_retention_days: 90, prune_terminal_sessions: false, prune_terminal_sessions_days: 365 },
      slack: { listener_enabled: false, channel: "C1", authorised_users: ["U1"] },
      repos: { allowed: ["o/*"] },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
      pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{owner}", auth: { api_key_env: "GH_TOKEN" } },
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

test("registration: registers 13 tools",
  { skip: registerHarnessTools === null }, () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    assert.deepEqual(
      [...tools.keys()].sort(),
      ["harness_bootstrap_test_repo", "harness_cancel", "harness_health", "harness_merge_pr", "harness_progress", "harness_resume", "harness_retention_prune", "harness_run", "harness_session_get", "harness_start_session", "harness_status", "harness_telemetry", "harness_upload_logs"],
    );
  });

test("harness_run: crystallises then starts a session (no Slack thread needed)",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const r = await tools.get("harness_run").execute({ requester: "U1", request: "add a health endpoint to the api" });
    assert.equal(r.details.ok, true);
    assert.match(r.details.sessionId, /.+/);
    assert.equal(runtime.crystalliseCalls.length, 1);
    assert.equal(runtime.loopCalls.length, 1);
    assert.equal(runtime.loopCalls[0].brief.title, "Stub brief");
    // A synthetic agent:<id> thread key was used; row exists.
    const row = runtime.state.db.prepare("SELECT slack_thread, slack_channel FROM sessions WHERE id = ?").get(r.details.sessionId);
    assert.match(row.slack_thread, /^agent:/);
    assert.equal(row.slack_channel, "");
  });

test("harness_run: relays a clarify question and does NOT start a session",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.crystallise = async () => ({ kind: "clarify", costUsd: 0, question: "Which repo?" });
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const r = await tools.get("harness_run").execute({ requester: "U1", request: "do the thing" });
    assert.equal(r.details.ok, false);
    assert.equal(r.details.needsClarification, true);
    assert.equal(r.details.question, "Which repo?");
    assert.equal(runtime.loopCalls.length, 0);
  });

test("harness_run: rejects non-dev / unsafe requests",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.crystallise = async () => ({ kind: "reject", costUsd: 0, intent: "not_dev", reason: "just a question" });
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const r = await tools.get("harness_run").execute({ requester: "U1", request: "what is the capital of france" });
    assert.equal(r.details.ok, false);
    assert.equal(r.details.rejected, true);
    assert.equal(r.details.intent, "not_dev");
    assert.equal(runtime.loopCalls.length, 0);
  });

test("harness_run: unauthorised requester is refused before crystallise",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const r = await tools.get("harness_run").execute({ requester: "U_HACKER", request: "add a feature please" });
    assert.equal(r.details.ok, false);
    assert.equal(r.details.unauthorised, true);
    assert.equal(runtime.crystalliseCalls.length, 0);
    assert.equal(runtime.loopCalls.length, 0);
  });

test("harness_start_session: works without Slack channel/thread (agent-orchestrated)",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const r = await tools.get("harness_start_session").execute({
      requester: "U1",
      brief: { title: "Do X", motivation: "because we need X done", acceptanceCriteria: ["X exists"] },
    });
    assert.equal(r.details.ok, true);
    assert.equal(runtime.loopCalls.length, 1);
    const row = runtime.state.db.prepare("SELECT slack_thread FROM sessions WHERE id = ?").get(r.details.sessionId);
    assert.match(row.slack_thread, /^agent:/);
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
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    // Minimally-valid config: channel, users, repos allow-list
    runtime.config.slack = { channel: "C_TEST", authorised_users: ["U1"], reactions: {}, credential_service: "slack-x" };
    runtime.config.repos = { allowed: ["o/r"] };
    runtime.config.vercel = { enabled: false };
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_health").execute({});
    assert.equal(res.details.ok, true);
    const dbCheck = res.details.checks.find((c) => c.name === "db_reachable");
    assert.equal(dbCheck.ok, true);
    const chanCheck = res.details.checks.find((c) => c.name === "config_slack_channel");
    assert.equal(chanCheck.detail, "C_TEST");
    // model_auth check present and green (stub resolves a key).
    const authCheck = res.details.checks.find((c) => c.name === "model_auth_resolvable");
    assert.equal(authCheck.ok, true);
  });

test("harness_health: DEGRADED when config missing repos",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.config.slack = { channel: "C_TEST", authorised_users: ["U1"], reactions: {} };
    runtime.config.repos = { allowed: [] };
    runtime.config.vercel = { enabled: false };
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_health").execute({});
    assert.equal(res.details.ok, false);
    assert.match(res.content[0].text, /DEGRADED/);
  });

test("harness_health: DEGRADED when no Anthropic key resolves (model_auth fatal)",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.config.slack = { channel: "C_TEST", authorised_users: ["U1"], reactions: {} };
    runtime.config.repos = { allowed: ["o/r"] };
    runtime.config.vercel = { enabled: false };
    runtime.config.models.auth = { credential_service: "", api_key_env: "ANTHROPIC_API_KEY" };
    runtime.anthropicApiKey = async () => undefined;   // no key anywhere
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_health").execute({});
    assert.equal(res.details.ok, false, "missing model auth must degrade health");
    const authCheck = res.details.checks.find((c) => c.name === "model_auth_resolvable");
    assert.equal(authCheck.ok, false);
    assert.match(authCheck.detail, /login|no key/i);
  });

test("harness_health: DEGRADED when no GitHub token resolves (git_credential fatal)",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    runtime.config.slack = { channel: "C_TEST", authorised_users: ["U1"], reactions: {} };
    runtime.config.repos = { allowed: ["o/r"] };
    runtime.config.vercel = { enabled: false };
    // GitHub token resolution fails (vault empty + env unset).
    runtime.gitToken = async () => { throw new Error("no GitHub token resolved (vault empty and env GH_TOKEN unset)"); };
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_health").execute({});
    assert.equal(res.details.ok, false, "missing GitHub token must degrade health");
    const gh = res.details.checks.find((c) => c.name === "git_credential_resolvable");
    assert.equal(gh.ok, false);
    assert.match(gh.detail, /plan phase will fail|no token/i);
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

// --- Regression: harness_status must not hit a closed DB after re-register ---
//
// Repro for the beta.2 bug: on a plugin re-register, the previous runtime's
// state DB is closed. Tool closures captured the old runtime, so invoking
// harness_status touched the closed `node:sqlite` handle and threw
// "database is not open". harness_health happened to bind to the still-open
// handle, which is why it passed while status failed on the same gateway.
//
// The fix routes tool DB access through the LIVE runtime (runtime-registry).
test("harness_status: routes to live runtime after re-register (closed gen not touched)",
  { skip: registerHarnessTools === null }, async () => {
    // Generation A: register tools against it, then publish it as live.
    const runtimeA = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtimeA);
    setCurrentRuntime(runtimeA);

    // Sanity: status works against the open generation A.
    const before = tools.get("harness_status").execute({});
    assert.equal(before.details.ok, true);

    // Simulate a re-register: a fresh generation B becomes live, and the old
    // generation A is torn down (its DB closed) as teardown() does.
    const runtimeB = makeRuntime();
    setCurrentRuntime(runtimeB);
    runtimeA.state.close();

    // The A-captured closure must NOT throw "database is not open"; it should
    // resolve the live generation B (open) instead.
    const after = tools.get("harness_status").execute({});
    assert.equal(after.details.ok, true, "status should work against the live runtime after re-register");

    // And a query that would previously hit A's closed handle succeeds.
    runtimeB.state.db.prepare(
      `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
       VALUES ('SB','TB','CB','U1','u','o/r','b','/wt','planning',?,?,50,0,0)`,
    ).run(Date.now(), Date.now());
    const again = tools.get("harness_status").execute({});
    assert.equal(again.details.activeSessionCount, 1);

    setCurrentRuntime(null);
  });

// If a closed generation is somehow the ONLY thing we can resolve, the guard
// must surface a clear, retryable error rather than the opaque sqlite string.
test("harness_status: clear error when only a closed generation is reachable",
  { skip: registerHarnessTools === null }, () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    setCurrentRuntime(null);      // nothing live -> fall back to captured runtime
    runtime.state.close();        // ...which is now closed
    assert.throws(
      () => tools.get("harness_status").execute({}),
      /re-registering|not open/i,
    );
  });

test("harness_bootstrap_test_repo: requires owner",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_bootstrap_test_repo").execute({});
    assert.equal(res.details.ok, false);
    assert.match(res.content[0].text, /owner is required/i);
  });

test("harness_bootstrap_test_repo: surfaces a clear error when no token resolves",
  { skip: registerHarnessTools === null }, async () => {
    const runtime = makeRuntime();
    // pat.resolve present, but token resolution fails.
    runtime.pat = { resolve: () => ({ provider: "github", credentialService: "github-o", commitIdentity: { name: "x", email: "x@e" }, apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN", provenance: "default_pattern" }) };
    runtime.gitToken = async () => { throw new Error("no GitHub token resolved (vault empty and env GH_TOKEN unset)"); };
    const { api, tools } = collectTools();
    registerHarnessTools(api, runtime);
    const res = await tools.get("harness_bootstrap_test_repo").execute({ owner: "someone", requester: "U1" });
    assert.equal(res.details.ok, false);
    assert.equal(res.details.reason, "no_token");
    assert.match(res.content[0].text, /token/i);
  });
