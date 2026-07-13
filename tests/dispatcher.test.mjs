import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let openStateStore, Dispatcher, BudgetEnforcer, PatRouter, OrchestratorLoop;
try {
  ({ openStateStore } = await import("../dist/state/store.js"));
  ({ Dispatcher } = await import("../dist/slack/dispatcher.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
} catch {
  Dispatcher = null;
}

const noopLogger = { info() {}, warn() {}, error() {} };

async function makeState() {
  const dir = mkdtempSync(join(tmpdir(), "oah-test-"));
  const state = await openStateStore(join(dir, "state.db"));
  return { state, dir };
}

const configStub = {
  slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause", budget_bump: "money" } },
  budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
  repos: { allowed: ["example-org/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
  models: { lead: "L", worker: "W", adversary: "A", classifier: "C" },
  loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600 },
  vercel: { enabled: false, credential_service: "", project_id: "", preview_wait_seconds: 30 },
  storage: { state_db_path: "", worktree_root: "", audit_retention_days: 90, prune_terminal_sessions: false, prune_terminal_sessions_days: 365 },
  safety: { worker_permission_mode: "acceptEdits", bash_whitelist: [], bash_denylist_tokens: [], path_denylist: [], allow_git_push: false, allow_network_commands: false },
  pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
};

test("dispatcher: rejects not-a-dev message with polite reply, marks session aborted",
  { skip: Dispatcher === null }, async () => {
    const { state } = await makeState();
    const replies = [];
    const reactions = [];

    // Loop stub -- should NOT be called if crystallise rejects
    const loop = { run: async () => { throw new Error("should not be called"); } };

    const d = new Dispatcher({
      config: configStub,
      state,
      loop,
      logger: noopLogger,
      crystallise: async () => ({ kind: "reject", intent: "not_dev", reason: "small talk", costUsd: 0 }),
      slackReply: async (channel, threadTs, text) => { replies.push({ channel, threadTs, text }); return { ts: "1" }; },
      slackReact: async (channel, ts, name) => { reactions.push({ channel, ts, name }); },
    });

    await d.startNewSession({ channel: "C1", user: "U1", ts: "T1", text: "hey" });

    // Give the fire-and-forget a moment to run
    await new Promise((r) => setTimeout(r, 20));

    const row = state.db.prepare("SELECT status FROM sessions WHERE slack_thread = ?").get("T1");
    assert.equal(row.status, "aborted");
    assert.ok(replies.some((r) => /doesn't look like a dev task/i.test(r.text)));
    assert.ok(reactions.some((r) => r.name === "eyes"));
    state.close();
  });

test("dispatcher: clarify pauses without invoking loop",
  { skip: Dispatcher === null }, async () => {
    const { state } = await makeState();
    const replies = [];
    const loop = { run: async () => { throw new Error("nope"); } };

    const d = new Dispatcher({
      config: configStub,
      state,
      loop,
      logger: noopLogger,
      crystallise: async () => ({ kind: "clarify", question: "Which repo?", costUsd: 0 }),
      slackReply: async (channel, threadTs, text) => { replies.push({ text }); return { ts: "1" }; },
      slackReact: async () => {},
    });

    await d.startNewSession({ channel: "C1", user: "U1", ts: "T2", text: "do a thing" });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(replies.some((r) => /Which repo/.test(r.text)));
    // Session stays in "crystallising"
    const row = state.db.prepare("SELECT status FROM sessions WHERE slack_thread = ?").get("T2");
    assert.equal(row.status, "crystallising");
    state.close();
  });

test("dispatcher: brief -> loop.run -> shipped reports PR url",
  { skip: Dispatcher === null }, async () => {
    const { state } = await makeState();
    const replies = [];
    const brief = { title: "Add /hello", motivation: "smoke test needs it", acceptanceCriteria: ["ok"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const loop = {
      run: async (sessionId, b) => {
        assert.deepEqual(b, brief);
        return { status: "shipped", sessionId, prUrl: "https://gh/x/y/pull/1", cycles: 2, totalCostUsd: 3.14 };
      },
    };

    const d = new Dispatcher({
      config: configStub,
      state,
      loop,
      logger: noopLogger,
      crystallise: async () => ({ kind: "brief", brief, costUsd: 0 }),
      slackReply: async (_c, _t, text) => { replies.push({ text }); return { ts: "1" }; },
      slackReact: async () => {},
    });

    await d.startNewSession({ channel: "C1", user: "U1", ts: "T3", text: "add /hello" });
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(replies.some((r) => r.text.includes("Add /hello")));
    assert.ok(replies.some((r) => r.text.includes("PR opened: https://gh/x/y/pull/1")));
    state.close();
  });

test("dispatcher: UNIQUE constraint dedupes duplicate startNewSession for same thread",
  { skip: Dispatcher === null }, async () => {
    const { state } = await makeState();
    const brief = { title: "x", motivation: "shorter than", acceptanceCriteria: ["a"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    let leadRuns = 0;
    const loop = {
      run: async (sessionId) => { leadRuns++; return { status: "shipped", sessionId, prUrl: "u", cycles: 1, totalCostUsd: 0 }; },
    };

    const d = new Dispatcher({
      config: configStub,
      state,
      loop,
      logger: noopLogger,
      crystallise: async () => ({ kind: "brief", brief, costUsd: 0 }),
      slackReply: async () => ({ ts: "1" }),
      slackReact: async () => {},
    });

    await d.startNewSession({ channel: "C1", user: "U1", ts: "T4", text: "" });
    await d.startNewSession({ channel: "C1", user: "U1", ts: "T4", text: "" });
    await new Promise((r) => setTimeout(r, 30));

    const count = state.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE slack_thread = ?").get("T4").n;
    assert.equal(count, 1);
    state.close();
  });
