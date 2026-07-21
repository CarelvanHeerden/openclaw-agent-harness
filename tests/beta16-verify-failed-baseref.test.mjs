/**
 * beta.16 regression: `verify_failed` audit events carry `baseRef` +
 * `baseSemantics: "worker-session-start"`.
 *
 * Beta.15 shipped these fields on `loop.commit_verify_failed` and
 * `loop.file_committed_verify_failed`. The beta.15 happy-path smoke never
 * exercised them (verify passed -> no failed events fired). Staging's
 * failure-injection smoke on 2026-07-17 08:05 UTC (session `1610be9d`)
 * confirmed the payload contract is correct AND the SHA is genuinely
 * pinned at worker-session-open, not plan-time / session-create-time.
 *
 * This test converts that smoke into a deterministic regression guard so
 * a future refactor cannot silently drop the fields or move the pinning
 * point without failing CI.
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
    // beta.57: env_wait_retry_enabled=false -- the state-based retry gate
    // (mutate + no commit + cycle 1) would otherwise re-dispatch this test's
    // deliberately-failing worker and emit a second subtask_verification
    // event. This test guards the verify_failed payload shape, not the retry.
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, env_wait_retry_enabled: false },
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

/**
 * Simulates the exact beta.16 failure-injection scenario from Staging:
 * lead builds a 3-check contract (file_written, file_committed, commit_made),
 * worker returns "completed" but the observable side-effects (HEAD unchanged,
 * file not in commit history) fail verification. Both target events must
 * fire with the correct payload shape.
 */
test(
  "beta.16 regression: commit_verify_failed carries baseRef + baseSemantics='worker-session-start'",
  { skip: OrchestratorLoop === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "S_FAILINJ");

    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    // Use explicit verify to force the exact 3-check contract; independent
    // of regex inference behaviour so the test doesn't couple to that.
    const plan = {
      repo: "o/r",
      branch: "harness/smoke-beta16-fail-inject",
      worktreePath: "/tmp/wt/failinj",
      subTasks: [
        {
          seq: 1,
          title: "Write and stage docs/BETA16_SMOKE.md but do NOT commit",
          intent: "Worker writes and stages the file but skips commit -- forces file_committed and commit_made verify failures.",
          filesLikelyTouched: ["docs/BETA16_SMOKE.md"],
          successCriteria: [],
          estimatedTokens: 100,
          verify: [
            { kind: "file_written", file: "docs/BETA16_SMOKE.md" },
            { kind: "file_committed", file: "docs/BETA16_SMOKE.md" },
            { kind: "commit_made" },
          ],
        },
      ],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    };

    // Pin the worker-session-start SHA so we can assert it's carried through
    // to the audit event verbatim. Staging observed `01ac598bb480`.
    const WORKER_START_SHA_FULL = "01ac598bb4809d5b2363fb20cac644fc6fc8f4ad";
    const EXPECTED_BASE_REF = WORKER_START_SHA_FULL.slice(0, 12); // "01ac598bb480"

    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      // Worker claims completed but produced no commit.
      runWorker: async () => ({
        status: "completed",
        filesChanged: ["docs/BETA16_SMOKE.md"],
        commitSha: null,
        sdkSessionId: "sdk-failinj-1",
        costUsd: 0.05,
        tokensIn: 10,
        tokensOut: 10,
        reason: "end_turn",
      }),
      runAdversary: async () => { throw new Error("adversary must not run on hard-failed verification"); },
      pushBranchAndOpenPr: async () => { throw new Error("push must not run"); },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      // Critical: worktreeHeadSha returns the worker-session-start SHA. The
      // loop captures this BEFORE calling runWorker, then reuses the same
      // value for the base-ref field in verify_failed audit payloads.
      worktreeHeadSha: async () => WORKER_START_SHA_FULL,
      buildVerifyProbes: () => ({
        // beta.8 required probes
        remoteBranchExists: async () => ({ exists: false, detail: "not exercised by this contract" }),
        prUrlPresent: async () => ({ present: false, detail: "not exercised by this contract" }),
        // file_written passes: file was written+staged (untracked)
        fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "file present on disk" }),
        fileWrittenSince: async () => ({ written: true, detail: "fallback probe: file written" }),
        // commit_made FAILS: HEAD unchanged vs baseSha
        commitMadeSince: async () => ({
          made: false,
          detail: `no new commit (HEAD ${WORKER_START_SHA_FULL.slice(0, 7)} == base ${WORKER_START_SHA_FULL.slice(0, 7)})`,
        }),
        // file_committed FAILS: file not in commits since base
        fileCommittedSince: async () => ({
          committed: false,
          detail: "file not in commits since base (0 file(s) checked)",
        }),
      }),
      releaseWorktree: async () => {},
    });

    const outcome = await loop.run("S_FAILINJ", brief);
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /failed_verification/);

    // ---- Assert the two target events fire with the right payload ----
    const commitFailed = state.audits.filter((e) => e.event === "loop.commit_verify_failed");
    assert.equal(commitFailed.length, 1, `expected 1 loop.commit_verify_failed, got ${commitFailed.length}`);
    assert.equal(commitFailed[0].payload.baseRef, EXPECTED_BASE_REF);
    assert.equal(commitFailed[0].payload.baseSemantics, "worker-session-start");
    assert.equal(commitFailed[0].payload.seq, 1);
    assert.ok(typeof commitFailed[0].payload.detail === "string" && commitFailed[0].payload.detail.length > 0);

    const fileCommittedFailed = state.audits.filter((e) => e.event === "loop.file_committed_verify_failed");
    assert.equal(fileCommittedFailed.length, 1);
    assert.equal(fileCommittedFailed[0].payload.baseRef, EXPECTED_BASE_REF);
    assert.equal(fileCommittedFailed[0].payload.baseSemantics, "worker-session-start");

    // Umbrella event should also fire with a summary + results array.
    const umbrella = state.audits.filter((e) => e.event === "loop.subtask_verification");
    assert.equal(umbrella.length, 1);
    assert.equal(umbrella[0].payload.ok, false);
    assert.ok(Array.isArray(umbrella[0].payload.results));
  },
);

test(
  "beta.16 regression: verify-passed events do NOT carry baseRef (only failures do)",
  { skip: OrchestratorLoop === null },
  async () => {
    // Guard against a well-intentioned refactor that "helpfully" adds
    // baseRef to the umbrella loop.subtask_verification payload. Payload
    // shape is only guaranteed on the *_verify_failed events; consumers
    // may be relying on the umbrella event's shape being unchanged.
    const state = makeStore();
    insertSession(state.db, "S_OK");

    const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
    const plan = {
      repo: "o/r",
      branch: "harness/ok",
      worktreePath: "/tmp/wt/ok",
      subTasks: [
        {
          seq: 1,
          title: "Write and commit",
          intent: "Write file and commit.",
          filesLikelyTouched: ["docs/X.md"],
          successCriteria: [],
          estimatedTokens: 100,
          verify: [{ kind: "commit_made" }],
        },
      ],
      reviewChecklist: [],
      riskLevel: "low",
      approxCostUsd: 0,
    };

    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["docs/X.md"], commitSha: "newsha", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      worktreeHeadSha: async () => "01ac598bb4809d5b2363fb20cac644fc6fc8f4ad",
      buildVerifyProbes: () => ({
        remoteBranchExists: async () => ({ exists: true, detail: "" }),
        prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "" }),
        fileWrittenSince: async () => ({ written: true, detail: "" }),
        commitMadeSince: async () => ({ made: true, detail: "HEAD advanced" }),
      }),
      releaseWorktree: async () => {},
    });

    const outcome = await loop.run("S_OK", brief);
    assert.equal(outcome.status, "shipped");

    const umbrella = state.audits.filter((e) => e.event === "loop.subtask_verification");
    assert.equal(umbrella.length, 1);
    assert.equal(umbrella[0].payload.ok, true);
    // Baseline shape check: no baseRef on the umbrella event.
    assert.equal(umbrella[0].payload.baseRef, undefined);
    assert.equal(umbrella[0].payload.baseSemantics, undefined);
  },
);
