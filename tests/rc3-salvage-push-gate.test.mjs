/**
 * rc.3 -- nothing is pushed that no adversary has reviewed.
 *
 * Raised by the external review (§2). The harness advertises "nothing pushes
 * until the adversary passes". Three salvage paths reached
 * `pushBranchAndOpenPr` for sessions where no review had EVER run, each by
 * synthesising a placeholder `revise` report:
 *
 *   - `tryBestEffortVerify`    -- the VERIFY sub-task's LLM turn timed out.
 *   - `finaliseAbortSalvaging` -- a budget, daily-cap or wall-clock ceiling.
 *   - `finaliseReviewCrash`    -- an infra error (beta.90 let this through on
 *                                 cycle 1 by design).
 *
 * All three stamped the PR `needs_human_review`, which is a genuine mitigation
 * and is also body text on a PR: it works if somebody reads it.
 *
 * The rule now: where a PRIOR review exists, shipping with the stamp stands --
 * something adversarial did look at this code, and throwing the work away has a
 * cost too. Where nothing has reviewed it, the worktree is preserved instead and
 * the push is refused. The commits are not lost; they stay on disk, resumable.
 *
 * The still-ships half of that rule is covered by the suites those paths came
 * from: beta62 (`cycle-2 review crash ... opens PR`) and beta129.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let OrchestratorLoop = null, BudgetEnforcer, PatRouter, Database, prLabelsFor = null;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}
const skip = { skip: OrchestratorLoop === null ? "dist not built" : false };

const config = () => ({
  slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
  budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
  repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
  models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
  loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, graceful_pr_on_review_crash: true },
  storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
  pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
  safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
});

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(root, "dist", "state", "schema.sql"), "utf8"));
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

const PLAN = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/s", subTasks: [], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

/** A session that has committed work in a worktree and is about to be aborted. */
function seedAbortableSession(db, id) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, lead_plan_json, crystallised_prompt)
     VALUES (?, 'T1', 'C1', 'U1', 'u1', 'o/r', 'harness/x', '/tmp/wt/s', 'executing', ?, ?, 50, 10, 1, ?, ?)`,
  ).run(
    id, Date.now(), Date.now(),
    JSON.stringify(PLAN),
    JSON.stringify({ title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" }),
  );
}

function seedReview(db, sessionId, cycle = 1, verdict = "revise") {
  db.prepare(
    `INSERT INTO reviews (id, session_id, cycle, verdict, findings, summary, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(`rev-${sessionId}-${cycle}`, sessionId, cycle, verdict, JSON.stringify([{ severity: "low", dimension: "quality", title: "nit" }]), "reviewed", Date.now());
}

function makeLoop(state, onPush, extraDeps = {}) {
  return new OrchestratorLoop({
    config: config(),
    state,
    budget: new BudgetEnforcer(config().budgets, state),
    pat: new PatRouter(config().pat_routing),
    logger: { info() {}, warn() {}, error() {} },
    runLead: async () => PLAN,
    runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0, tokensIn: 0, tokensOut: 0, reason: "end_turn" }),
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "", costUsd: 0, tokensIn: 0, tokensOut: 0 }),
    pushBranchAndOpenPr: async (args) => { onPush(args); return "https://github.com/o/r/pull/1"; },
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    releaseWorktree: async () => ({ ok: true, path: "/tmp/wt/s" }),
    ...extraDeps,
  });
}

/* ------------------------------------------------------------------ *
 * The abort-salvage path
 * ------------------------------------------------------------------ */

test("rc3: an abort with NO review preserves the commits instead of pushing them", skip, async () => {
  const state = makeStore();
  seedAbortableSession(state.db, "A1");
  let pushes = 0;
  const loop = makeLoop(state, () => { pushes++; });

  const outcome = await loop.finaliseAbortSalvaging("A1", "hard_timeout", 1, 12.5);

  assert.equal(pushes, 0, "no adversary has seen this code, so it is not pushed");
  assert.equal(outcome.status, "aborted");
  assert.match(outcome.reason, /worktree PRESERVED/, "the operator is told the commits are safe");

  const refused = state.audits.filter((e) => e.event === "loop.salvage_refused_unreviewed");
  assert.equal(refused.length, 1, "the refusal is auditable, not silent");
  assert.equal(refused[0].payload.path, "abort_salvage");
  assert.equal(refused[0].payload.abortReason, "hard_timeout");

  const row = state.db.prepare(`SELECT status, worktree_preserved, final_pr_url FROM sessions WHERE id='A1'`).get();
  assert.equal(row.status, "aborted");
  assert.equal(row.worktree_preserved, 1, "the directory must survive the next restart");
  assert.equal(row.final_pr_url, null);
  state.close();
});

test("rc3: an abort WITH a prior review still ships, stamped needs_human_review", skip, async () => {
  // The gate is about never-reviewed code, not about abandoning salvage. This
  // is the beta.120 behaviour the b119 smoke earned, and it must survive.
  const state = makeStore();
  seedAbortableSession(state.db, "A2");
  seedReview(state.db, "A2", 1, "revise");
  let pushed = null;
  const loop = makeLoop(state, (args) => { pushed = args; });

  const outcome = await loop.finaliseAbortSalvaging("A2", "budget_exhausted", 2, 30);

  assert.equal(outcome.status, "shipped");
  assert.ok(pushed, "the salvage PR is opened");
  assert.equal(pushed.reviewReport.verdict, "revise", "the real prior review is attached, not a placeholder");
  assert.equal(pushed.reviewReport.summary, "reviewed");

  const row = state.db.prepare(`SELECT merge_recommendation FROM sessions WHERE id='A2'`).get();
  assert.equal(row.merge_recommendation, "needs_human_review", "still never auto-mergeable");
  assert.equal(state.audits.filter((e) => e.event === "loop.salvage_refused_unreviewed").length, 0);
  state.close();
});

test("rc3: an abort with nothing committed is unchanged", skip, async () => {
  // The gate must not turn "there was never anything to salvage" into a
  // preserved empty worktree, and must not fire its audit on a session that
  // never had work to refuse pushing. HEAD still at the plan's fork point is
  // the one shape beta.129 accepts as genuinely empty.
  const state = makeStore();
  seedAbortableSession(state.db, "A3");
  state.db.prepare(`UPDATE sessions SET plan_base_sha = 'base-sha' WHERE id = 'A3'`).run();
  let pushes = 0;
  const loop = makeLoop(state, () => { pushes++; }, { worktreeHeadSha: async () => "base-sha" });

  const outcome = await loop.finaliseAbortSalvaging("A3", "hard_timeout", 1, 1);
  assert.equal(pushes, 0);
  assert.equal(state.audits.filter((e) => e.event === "loop.abort_nothing_to_salvage").length, 1);
  assert.equal(state.audits.filter((e) => e.event === "loop.salvage_refused_unreviewed").length, 0);
  assert.equal(outcome.status, "aborted");
  state.close();
});

/* ------------------------------------------------------------------ *
 * The other two paths, at the source
 * ------------------------------------------------------------------ */

test("rc3: all three salvage paths consult the same gate", () => {
  const src = S("src/orchestrator/loop.ts");
  for (const path of ["best_effort_verify", "abort_salvage", "review_crash"]) {
    assert.match(
      src,
      new RegExp(`refuseUnreviewedSalvage\\(sessionId, "${path}"`),
      `${path} must go through the shared gate rather than its own rule`,
    );
  }
  // One definition of "has anything reviewed this?", not three.
  assert.match(src, /private hasBeenReviewed\(sessionId: string\): boolean \{\s*return this\.getLastReview\(sessionId\) !== undefined;/);
});

test("rc3: best-effort verify refuses before it reaches the push", () => {
  const src = S("src/orchestrator/loop.ts");
  const body = src.slice(src.indexOf("private async tryBestEffortVerify"), src.indexOf("private async awaitCiVerification"));
  const gate = body.indexOf("refuseUnreviewedSalvage");
  const push = body.indexOf("pushBranchAndOpenPr");
  assert.ok(gate > 0, "the gate is present in tryBestEffortVerify");
  assert.ok(push > 0);
  assert.ok(gate < push, "the gate must be checked BEFORE the push, not after");
  assert.match(body, /verify_timeout_no_adversary_review/);
});

test("rc3: the review-crash path no longer synthesizes a review to push behind", () => {
  const src = S("src/orchestrator/loop.ts");
  const body = src.slice(src.indexOf("private async finaliseReviewCrash"));
  assert.doesNotMatch(body, /const synthesizedReview/, "beta.90's placeholder report is gone");
  assert.match(body, /const reviewForPr = priorReview;/);
});

/* ------------------------------------------------------------------ *
 * The do-not-merge stamp is now checkable
 * ------------------------------------------------------------------ */

test("rc3: PR labels describe how far the harness is vouching", async () => {
  ({ prLabelsFor } = await import("../dist/orchestrator/pr-labels.js"));

  assert.deepEqual(prLabelsFor({ verdict: "pass", findings: [] }), [], "a clean pass carries no warning label");
  assert.deepEqual(prLabelsFor({ verdict: "block", findings: [{}] }), ["do-not-merge"]);
  assert.deepEqual(prLabelsFor({ verdict: "revise", findings: [{}] }), ["do-not-merge"]);

  // A `revise` with no findings is the placeholder a salvage path attaches --
  // it says "nobody reviewed this", which is not the same as "revise".
  assert.deepEqual(prLabelsFor({ verdict: "revise", findings: [] }), ["do-not-merge", "harness:unreviewed"]);

  // A pass the gate manufactured from a revise.
  assert.deepEqual(prLabelsFor({ verdict: "pass", findings: [{}], verdictDowngraded: true }), ["harness:downgraded-pass"]);
});

test("rc3: the labels are actually sent, on both the open and the re-push path", () => {
  const gh = S("src/adapters/github.ts");
  assert.match(gh, /issues\/\$\{input\.prNumber\}\/labels/, "labels go to the issues endpoint");
  // A revise re-pushes into an existing PR and does not rewrite the body, so
  // the label is the only thing that can update.
  assert.equal((gh.match(/applyPrLabels\(/g) ?? []).length, 3, "defined once, called on both the create and the already-exists path");
  // Labelling requires issues:write; a token without it must not sink a run
  // whose code has already landed.
  const body = gh.slice(gh.indexOf("async function applyPrLabels"));
  assert.match(body, /catch \(err\)/);
  assert.doesNotMatch(body.slice(0, body.indexOf("catch (err)")), /throw new Error/);

  assert.match(S("src/index.ts"), /labels: prLabelsFor\(reviewReport\)/);
});
