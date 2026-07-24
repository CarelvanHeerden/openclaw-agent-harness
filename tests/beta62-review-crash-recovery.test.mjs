// beta.62 — silent cycle-N adversary-review crash: telemetry + graceful PR +
// worktree preservation. Fixes the b60-attempt-2 failure class
// (`cycle_2_review_silent_crash`):
//   session f292357f ran 2 full cycles (8 good commits, all cycle-1 findings
//   addressed, seq-6 self-verify PASS on all 5 criteria) at $10.15/$20, then
//   the cycle-2 adversary review call CRASHED. The review catch emitted NO
//   audit for a non-timeout error, then finaliseFailed -> setStatus('failed')
//   (also no audit) -> `status=failed` written with a ~4min gap and NO event
//   describing the crash + the worktree released, discarding the deliverable.
//
// Fix 1: ALWAYS emit `loop.review_failed` on a review crash (timeout or not),
//         and fold the post-review persist awaits into the same try so an
//         uncaught throw there can't escape silently.
// Fix 2: graceful degradation — cycle>=2 + prior completed review + green
//         self-verify -> open the PR with merge_recommendation=needs_human_review.
// Fix 3: when NOT salvageable, fail but PRESERVE the worktree (inspectable).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}
const mr = await import("../dist/orchestrator/merge-recommendation.js");

const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(overrides = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, graceful_pr_on_review_crash: true },
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
     VALUES (?, 'T1', 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, ?, 0, 0)`,
  ).run(id, Date.now(), Date.now(), budget);
}

// A sub-task whose intent infers a verify contract (so a green
// loop.subtask_verification is emitted, feeding the self-verify gate).
const commitSubTask = (seq) => ({
  seq, title: `t${seq}`, intent: "commit the change", filesLikelyTouched: [],
  successCriteria: ["commit made"], estimatedTokens: 100,
});
const greenProbes = () => ({
  remoteBranchExists: async () => ({ exists: true, detail: "" }),
  prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "" }),
  fileWrittenSince: async () => ({ written: true, detail: "" }),
  fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "" }),
  commitMadeSince: async () => ({ made: true, detail: "" }),
  fileCommittedSince: async () => ({ committed: true, detail: "" }),
});

const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/s", subTasks: [commitSubTask(1)], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

// ---- Behavioral: cycle-2 review crash -> GRACEFUL PR (needs_human_review) ----
test("beta62: cycle-2 review crash with green self-verify opens PR flagged needs_human_review (not discarded)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "G1");
    let advCall = 0, prCalls = 0, releaseCalls = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => {
        advCall++;
        if (advCall === 1) return { verdict: "revise", findings: [{ dimension: "quality", severity: "low", title: "f", detail: "d" }], summary: "revise", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
        throw new Error("simulated cycle-2 adversary SDK crash");
      },
      pushBranchAndOpenPr: async () => { prCalls++; return "https://github.com/o/r/pull/42"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => { releaseCalls++; return { ok: true, path: "/tmp/wt/s" }; },
    });

    const outcome = await loop.run("G1", brief);

    // The work is salvaged into a PR, NOT thrown away.
    assert.equal(outcome.status, "shipped", "must ship a graceful PR, not fail");
    assert.equal(outcome.prUrl, "https://github.com/o/r/pull/42");
    assert.equal(prCalls, 1, "PR must be opened exactly once via the graceful path");
    assert.equal(advCall, 2, "cycle-2 review must have been attempted (and crashed)");

    const row = state.db.prepare(`SELECT status, merge_recommendation, final_pr_url FROM sessions WHERE id='G1'`).get();
    assert.equal(row.status, "done");
    assert.equal(row.merge_recommendation, "needs_human_review", "review-crash PR must be flagged needs_human_review");
    assert.equal(row.final_pr_url, "https://github.com/o/r/pull/42");

    // Fix 1: the crash is now audited (was invisible in b60-a2).
    const rf = state.audits.filter((e) => e.event === "loop.review_failed");
    assert.equal(rf.length, 1, "exactly one loop.review_failed must be emitted");
    assert.equal(rf[0].payload.isTimeout, false);
    assert.match(String(rf[0].payload.error), /cycle-2 adversary SDK crash/);
    // recovery decision is audited + eligible
    const rec = state.audits.filter((e) => e.event === "loop.review_crash_recovery");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].payload.eligible, true);
    assert.equal(rec[0].payload.selfVerifyGreen, true);
    // shipped via recovery flag set
    const shipped = state.audits.filter((e) => e.event === "loop.shipped");
    assert.equal(shipped.length, 1);
    assert.equal(shipped[0].payload.viaReviewCrashRecovery, true);
    state.close();
  });

// ---- Behavioral: cycle-1 review crash -> FAIL + PRESERVE worktree ----
test("beta62: cycle-1 review crash (no prior review) fails but PRESERVES the worktree",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "P1");
    let prCalls = 0, releaseCalls = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => { throw new Error("cycle-1 adversary crash"); },
      pushBranchAndOpenPr: async () => { prCalls++; return "unused"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => { releaseCalls++; return { ok: true, path: "/tmp/wt/s" }; },
    });

    const outcome = await loop.run("P1", brief);
    assert.equal(outcome.status, "failed", "cycle-1 crash (no prior review) is not salvageable");
    assert.match(outcome.reason, /review_crash/);
    assert.equal(prCalls, 0, "must NOT open a PR without a prior completed review");
    assert.equal(releaseCalls, 0, "worktree must be PRESERVED (not released) on the non-graceful crash");

    const rf = state.audits.filter((e) => e.event === "loop.review_failed");
    assert.equal(rf.length, 1, "the crash must still be audited even when not salvageable");
    const rec = state.audits.filter((e) => e.event === "loop.review_crash_recovery");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].payload.eligible, false);
    assert.equal(rec[0].payload.hasPriorReview, false);
    const preserved = state.audits.filter((e) => e.event === "loop.failed_worktree_preserved");
    assert.equal(preserved.length, 1, "must emit loop.failed_worktree_preserved");
    state.close();
  });

// ---- Behavioral: graceful disabled -> fail (still preserves worktree) ----
test("beta62: graceful_pr_on_review_crash=false keeps hard-fail behaviour",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "D1");
    let advCall = 0, prCalls = 0;
    const loop = new OrchestratorLoop({
      config: config({ loop: { ...config().loop, graceful_pr_on_review_crash: false } }),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => {
        advCall++;
        if (advCall === 1) return { verdict: "revise", findings: [{ dimension: "quality", severity: "low", title: "f", detail: "d" }], summary: "revise", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
        throw new Error("cycle-2 crash");
      },
      pushBranchAndOpenPr: async () => { prCalls++; return "unused"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => ({ ok: true, path: "/tmp/wt/s" }),
    });
    const outcome = await loop.run("D1", brief);
    assert.equal(outcome.status, "failed");
    assert.equal(prCalls, 0, "graceful disabled -> no PR");
    const rec = state.audits.filter((e) => e.event === "loop.review_crash_recovery")[0];
    assert.equal(rec.payload.eligible, false);
    assert.equal(rec.payload.gracefulEnabled, false);
    state.close();
  });

// ---- Behavioral: review timeout still emits loop.review_failed (isTimeout) ----
test("beta62: a review TIMEOUT emits loop.review_failed with isTimeout=true (plus adversary_timeout)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "T1");
    const loop = new OrchestratorLoop({
      config: config({ loop: { ...config().loop, adversary_timeout_seconds: 0.05 } }),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => new Promise((r) => setTimeout(() => r({ verdict: "pass", findings: [], summary: "", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }), 5000)),
      pushBranchAndOpenPr: async () => "unused",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => ({ ok: true, path: "/tmp/wt/s" }),
    });
    const outcome = await loop.run("T1", brief);
    assert.equal(outcome.status, "failed"); // cycle 1, no prior review -> not salvageable
    const rf = state.audits.filter((e) => e.event === "loop.review_failed");
    assert.equal(rf.length, 1);
    assert.equal(rf[0].payload.isTimeout, true, "timeout must be flagged isTimeout=true");
    const to = state.audits.filter((e) => e.event === "loop.adversary_timeout");
    assert.equal(to.length, 1, "the distinct adversary_timeout audit must still fire");
    state.close();
  });

// ---- Type + merge-gate: needs_human_review is a real recommendation value ----
test("beta62: MergeRecommendation type includes needs_human_review (source)", () => {
  const src = S("src/orchestrator/merge-recommendation.ts");
  assert.match(src, /export type MergeRecommendation = "merge" \| "do_not_merge" \| "needs_human_review"/);
});

test("beta62: merge gate treats needs_human_review as a hard refuse (never overridable, source)", () => {
  const src = S("src/index.ts");
  // the narrow cast widened
  assert.match(src, /as "merge" \| "do_not_merge" \| "needs_human_review"/);
  // reviewCrashPr flag excludes it from override
  assert.match(src, /reviewCrashPr = rec === "needs_human_review"/);
  assert.match(src, /overridable = vercelConfigured && reviseOnly && !reviewCrashPr/);
});

// ---- Wiring source-assertions for the loop changes ----
test("beta62: loop wires review_failed telemetry + folds post-review persist into the try (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  // Fix 1: the review catch emits loop.review_failed unconditionally
  assert.match(src, /"loop\.review_failed"/);
  // the post-review persist awaits are now INSIDE the review try (before the catch)
  const tryBlock = src.slice(src.indexOf("let report: ReviewReport;"), src.indexOf('this.deps.state.audit("loop.review"'));
  // beta.69 (F5): a post-cancel discard block sits between saveReview and the
  // catch, still INSIDE the review try. Assert both persist awaits precede the
  // catch (order preserved) rather than requiring them to be immediately
  // adjacent to `} catch`.
  assert.match(tryBlock, /await this\.deps\.budget\.recordSpend\(row\.requester, report\.costUsd, sessionId\);\s*\n\s*this\.saveReview\(sessionId, cycle, report\);/);
  assert.match(tryBlock, /\} catch/);
  // Fix 1: crash routes to finaliseReviewCrash
  assert.match(src, /return await this\.finaliseReviewCrash\(/);
});

test("beta62: finaliseReviewCrash gate = graceful && cycle>=2 && priorReview && green self-verify (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /graceful_pr_on_review_crash !== false/);
  assert.match(src, /const eligible = gracefulEnabled && cycle >= 2 && !!priorReview && selfVerifyGreen/);
  assert.match(src, /merge_recommendation = \?[\s\S]*?\.run\(prUrl, prNumber \?\? null, "needs_human_review"/);
});

test("beta62: finaliseFailedPreserveWorktree does NOT release the worktree (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  const body = src.slice(src.indexOf("private finaliseFailedPreserveWorktree"), src.indexOf("private async finaliseReviewCrash"));
  assert.doesNotMatch(body, /scheduleWorktreeReleaseForSession/);
  assert.match(body, /"loop\.failed_worktree_preserved"/);
});

// ---- Config + manifest wiring ----
test("beta62: graceful_pr_on_review_crash in config interface + default true (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /graceful_pr_on_review_crash\?: boolean/);
  assert.match(src, /graceful_pr_on_review_crash: true/);
});

test("beta62: graceful_pr_on_review_crash declared in manifest configSchema (additionalProperties:false)", () => {
  const manifest = JSON.parse(S("openclaw.plugin.json"));
  const loopProps = manifest.configSchema.properties.loop.properties;
  assert.ok(loopProps.graceful_pr_on_review_crash, "must be declared or additionalProperties:false rejects the whole config");
  assert.equal(loopProps.graceful_pr_on_review_crash.type, "boolean");
  assert.equal(loopProps.graceful_pr_on_review_crash.default, true);
});
