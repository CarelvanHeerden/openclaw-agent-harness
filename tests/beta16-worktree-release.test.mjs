/**
 * beta.16 fix #3: `releaseWorktree` is called on terminal transitions.
 *
 * Context: prior to beta.16, worktree cleanup was only wired via the
 * pr-watcher's release-on-close path. Every successful smoke left a
 * `pending-<ts>` worktree holding the smoke branch and blocked the next
 * fetch on that branch with `refusing to fetch into branch checked out
 * at ...`. Discovered on Staging 2026-07-17 08:05 UTC when the beta.16
 * failure-injection smoke crashed on startup because the beta.15
 * clean-pass smoke's worktree had never been released.
 *
 * beta.16 wires `releaseWorktree` into the orchestrator so it fires on:
 *   - loop.shipped (PR opened) -- primary win
 *   - loop.aborted (user_abort, hard_timeout, budget_exhausted)
 *   - hard failure (plan_failed, adversary_error, pr_error, etc.)
 *
 * The pr-watcher's release-on-close remains as a safety net.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(overrides = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600 },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git", "echo"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
    ...overrides,
  };
}

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  const audits = [];
  return {
    db,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    audits,
    close() { db.close(); },
  };
}

function insertSession(db, id, budget = 50) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, 'T1', 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, ?, 0, 0)`
  ).run(id, Date.now(), Date.now(), budget);
}

function baseDeps(state, plan, releaseCalls, releaseOutcome = { ok: true }) {
  return {
    config: config(),
    state,
    budget: new BudgetEnforcer(config().budgets, state),
    pat: new PatRouter(config().pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => plan,
    runWorker: async () => ({ status: "completed", filesChanged: [], commitSha: "s", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    // beta.17: releaseWorktree now receives worktreePath and returns {ok, error?}.
    releaseWorktree: async ({ sessionId, repoFullName, worktreePath, reason }) => {
      releaseCalls.push({ sessionId, repoFullName, worktreePath, reason });
      return typeof releaseOutcome === "function" ? releaseOutcome() : releaseOutcome;
    },
  };
}

const plan = () => ({
  repo: "o/r",
  branch: "harness/x",
  worktreePath: "/tmp/wt/s",
  subTasks: [{ seq: 1, title: "a", intent: "a", filesLikelyTouched: [], successCriteria: ["a"], estimatedTokens: 100 }],
  reviewChecklist: [],
  riskLevel: "low",
  approxCostUsd: 0,
});

const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };

test(
  "beta.16: releaseWorktree called on loop.shipped (happy path)",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_SHIP");
    const releaseCalls = [];
    const loop = new OrchestratorLoop(baseDeps(state, plan(), releaseCalls));

    const outcome = await loop.run("S_SHIP", brief);
    assert.equal(outcome.status, "shipped");

    assert.equal(releaseCalls.length, 1, `expected exactly one releaseWorktree call, got ${releaseCalls.length}`);
    assert.equal(releaseCalls[0].sessionId, "S_SHIP");
    assert.equal(releaseCalls[0].repoFullName, "o/r");
    assert.equal(releaseCalls[0].reason, "shipped");
    // beta.17: worktreePath must be threaded through. Beta.16's bug was
    // that this arg didn't exist and release() reconstructed from sessionId.
    assert.equal(releaseCalls[0].worktreePath, "/tmp/wt/s");

    const releasedEvents = state.audits.filter((e) => e.event === "loop.worktree_released");
    assert.equal(releasedEvents.length, 1);
    assert.equal(releasedEvents[0].payload.reason, "shipped");
    // beta.17: audit payload now carries ok + path so operators can
    // distinguish event-fired-but-nothing-happened from actual success.
    assert.equal(releasedEvents[0].payload.ok, true);
    assert.equal(releasedEvents[0].payload.path, "/tmp/wt/s");
  },
);

test(
  "beta.120: a user abort with commits PRESERVES the worktree instead of releasing it",
  { skip: OrchestratorLoop === null },
  async () => {
    // beta.16 asserted the opposite: an abort always released. beta.120 fix 1
    // reverses that for any abort that could be holding work. The b119 take-2
    // smoke is why -- an abort deleted 27 commits, and the only reason they
    // survived was that git had not yet GC'd a cached clone. A user abort still
    // does NOT open a PR (they asked for it to stop), but the commits stay.
    const state = makeStore();
    insertSession(state.db, "S_ABORT");
    state.db.prepare(`UPDATE sessions SET repo = 'o/r', worktree_path = '/tmp/wt/s_abort' WHERE id = 'S_ABORT'`).run();
    const releaseCalls = [];

    const deps = baseDeps(state, plan(), releaseCalls);
    deps.readReactions = async () => ({ shipIt: false, abort: true, pause: false, budgetBump: false });

    const loop = new OrchestratorLoop(deps);
    const outcome = await loop.run("S_ABORT", brief);
    assert.equal(outcome.status, "aborted");
    assert.match(outcome.reason, /^user_abort_reaction\b/);
    // The operator is told where the work is, in the field they actually read.
    assert.match(outcome.reason, /PRESERVED/);
    assert.match(outcome.reason, /\/tmp\/wt\/s/);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(releaseCalls.length, 0, "an abort holding commits must NOT release the worktree");
    const preserved = state.audits.filter((e) => e.event === "loop.abort_worktree_preserved");
    assert.equal(preserved.length, 1, "the preservation must be auditable, not just implied by silence");
    assert.equal(preserved[0].payload.worktreePath, "/tmp/wt/s");
  },
);

test(
  "beta.120: when the commit probe FAILS, the abort protects the worktree anyway",
  { skip: OrchestratorLoop === null },
  async () => {
    // The probe shells out to git in a worktree that may already be wedged --
    // exactly the conditions an abort happens under. "I could not tell whether
    // there is work here" must resolve to keeping it. A false positive costs a
    // directory; a false negative cost 27 commits on the b119 take-2 smoke.
    const state = makeStore();
    insertSession(state.db, "S_ABORT_PROBE_ERR");
    const releaseCalls = [];
    const deps = baseDeps(state, plan(), releaseCalls);
    deps.readReactions = async () => ({ shipIt: false, abort: true, pause: false, budgetBump: false });
    deps.worktreeHeadSha = async () => "abc123";
    deps.buildVerifyProbes = () => {
      throw new Error("git: index.lock exists");
    };

    const loop = new OrchestratorLoop(deps);
    const outcome = await loop.run("S_ABORT_PROBE_ERR", brief);
    assert.equal(outcome.status, "aborted");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(releaseCalls.length, 0, "a probe failure must never be read as 'nothing to lose'");
    assert.equal(state.audits.filter((e) => e.event === "loop.abort_worktree_preserved").length, 1);
    assert.equal(state.audits.filter((e) => e.event === "loop.abort_nothing_to_salvage").length, 0);
  },
);

test(
  "beta.120: an abort with NOTHING committed still releases the worktree",
  { skip: OrchestratorLoop === null },
  async () => {
    // The counterweight to the test above: preserving is for protecting work.
    // With no worktree there is nothing to protect and nothing to leak, and the
    // pre-beta.120 release behaviour is correct -- but it now says so out loud.
    const state = makeStore();
    insertSession(state.db, "S_ABORT_EMPTY");
    const releaseCalls = [];

    const deps = baseDeps(state, plan(), releaseCalls);
    deps.readReactions = async () => ({ shipIt: false, abort: true, pause: false, budgetBump: false });
    // An empty HEAD is the real "nothing was ever committed" signal.
    deps.worktreeHeadSha = async () => "";
    deps.buildVerifyProbes = () => ({ commitMadeSince: async () => ({ made: false, detail: "" }) });

    const loop = new OrchestratorLoop(deps);
    const outcome = await loop.run("S_ABORT_EMPTY", brief);
    assert.equal(outcome.status, "aborted");

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const nothing = state.audits.filter((e) => e.event === "loop.abort_nothing_to_salvage");
    assert.equal(nothing.length, 1, "an abort that deletes must record that there was nothing to lose");
  },
);

test(
  "beta.16: releaseWorktree called on hard failure (plan_failed)",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_FAIL");
    state.db.prepare(`UPDATE sessions SET repo = 'o/r', worktree_path = '/tmp/wt/s_fail' WHERE id = 'S_FAIL'`).run();
    const releaseCalls = [];

    const deps = baseDeps(state, plan(), releaseCalls);
    deps.runLead = async () => { throw new Error("planner exploded"); };

    const loop = new OrchestratorLoop(deps);
    const outcome = await loop.run("S_FAIL", brief);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /^plan_failed:/);

    // finaliseFailed schedules with `void`.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(releaseCalls.length, 1);
    assert.equal(releaseCalls[0].reason, "failed");
  },
);

test(
  "beta.16: releaseWorktree not called when dep omitted (back-compat)",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_NOOP");
    const releaseCalls = [];
    const deps = baseDeps(state, plan(), releaseCalls);
    delete deps.releaseWorktree; // simulate old-style test double

    const loop = new OrchestratorLoop(deps);
    const outcome = await loop.run("S_NOOP", brief);
    assert.equal(outcome.status, "shipped");
    assert.equal(releaseCalls.length, 0);
    // No audit events either (nothing to release).
    const releasedEvents = state.audits.filter((e) => e.event === "loop.worktree_released");
    assert.equal(releasedEvents.length, 0);
  },
);

test(
  "beta.16: releaseWorktree failure is caught and audited (loop.worktree_release_failed)",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_FAIL_REL");
    const releaseCalls = [];

    const deps = baseDeps(state, plan(), releaseCalls);
    // beta.17 covers two failure modes: (a) impl returns {ok:false, error},
    // (b) impl throws. Both must land in loop.worktree_release_failed.
    deps.releaseWorktree = async () => { throw new Error("git worktree remove exploded"); };

    const loop = new OrchestratorLoop(deps);
    const outcome = await loop.run("S_FAIL_REL", brief);
    assert.equal(outcome.status, "shipped", "release failure must not fail the outcome");

    const failEvents = state.audits.filter((e) => e.event === "loop.worktree_release_failed");
    assert.equal(failEvents.length, 1);
    assert.equal(failEvents[0].payload.reason, "shipped");
    // beta.17: payload uses `error` (not `err`) and includes ok:false.
    assert.equal(failEvents[0].payload.ok, false);
    assert.match(failEvents[0].payload.error, /git worktree remove exploded/);

    const okEvents = state.audits.filter((e) => e.event === "loop.worktree_released");
    assert.equal(okEvents.length, 0);
  },
);
