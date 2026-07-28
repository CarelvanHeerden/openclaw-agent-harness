/**
 * beta.83: two "make a silent thing visible" fixes surfaced by the DR/BCP run
 * (session 37b01e86).
 *
 * #1 revise-spec RAW-FINDINGS FALLBACK VISIBILITY: when the Fable revise-spec
 *    turn fails/empties on a cycle>1 revise (e.g. lane-cap timeout, the beta.73
 *    signature), workers fall back to the RAW adversary findings (beta.66) --
 *    previously only an audit line, so nobody knew cycle 2 ran on reduced
 *    fidelity. buildProgressSnapshot now sets `reviseSpecFellBack` + appends a
 *    warning to the headline for the current cycle. (Behavioral tests.)
 *
 * #2 SESSION-BUDGET SOFT-WARN also fires after the ADVERSARY REVIEW cost lands.
 *    Pre-beta.83 the ONLY soft-warn check was inside runOne (the sub-task
 *    loop), so a run that crossed its session budget DURING the review (the
 *    DR/BCP run: $11.62 -> $12.27 = 123% across the review) NEVER warned. Now
 *    the review path re-checks the live total and warns once. (runInner is
 *    private -> source-assertion wiring, matching the repo's beta.62/70 pattern.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let buildProgressSnapshot, Database;
try {
  ({ buildProgressSnapshot } = await import("../dist/orchestrator/progress.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  buildProgressSnapshot = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");
const loopSrc = readFileSync(resolve(here, "..", "src", "orchestrator", "loop.ts"), "utf8");
const progressSrc = readFileSync(resolve(here, "..", "src", "orchestrator", "progress.ts"), "utf8");

function makeDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}
function insertSession(db, id, over = {}) {
  const s = { status: "executing", repo: "o/r", branch: "harness/x", cycles_ran: 2, cost_usd: 12.27, budget_usd: 10, ...over };
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, pr_number, final_pr_url, deploy_status)
     VALUES (?, ?, '', 'U1', 'U1', ?, ?, '/tmp/wt', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(id, `agent:${id}`, s.repo, s.branch, s.status, Date.now(), Date.now(), s.budget_usd, s.cost_usd, s.cycles_ran);
}
function insertSubTask(db, sessionId, seq, status, title, cycle = 2) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, cost_usd, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'w', ?, 0.1, ?, ?, ?, ?)`,
  ).run(`${sessionId}-c${cycle}-s${seq}`, sessionId, cycle, seq, title, status, now, null, now, now);
}
function insertAudit(db, sessionId, event, payload = {}, atOffset = 0) {
  db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, event, JSON.stringify(payload), Date.now() + atOffset);
}

// ---------- #1 behavioral ----------

test("beta83 #1: revise-spec FAILED on the current cycle -> reviseSpecFellBack=true + headline warns", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s1", { status: "executing", cycles_ran: 2 });
  insertSubTask(db, "s1", 1, "running", "cycle-2 worker");
  insertAudit(db, "s1", "loop.revise_spec_failed", { cycle: 2, error: "subtask_deadline (lane cap)" }, 10);
  const snap = buildProgressSnapshot(db, "s1");
  assert.equal(snap.reviseSpecFellBack, true);
  assert.match(snap.headline, /RAW adversary findings/);
  assert.match(snap.headline, /cycle 2/);
  assert.ok(!snap.headline.includes("\n"), "headline stays single-line");
});

test("beta83 #1: revise-spec EMPTY on the current cycle -> also flagged", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s2", { status: "executing", cycles_ran: 2 });
  insertSubTask(db, "s2", 1, "running", "cycle-2 worker");
  insertAudit(db, "s2", "loop.revise_spec_empty", { cycle: 2 }, 10);
  const snap = buildProgressSnapshot(db, "s2");
  assert.equal(snap.reviseSpecFellBack, true);
});

test("beta83 #1: revise-spec APPLIED (later than a fail) on the current cycle -> NOT flagged", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s3", { status: "executing", cycles_ran: 2 });
  insertSubTask(db, "s3", 1, "running", "cycle-2 worker");
  insertAudit(db, "s3", "loop.revise_spec_failed", { cycle: 2 }, 10);
  insertAudit(db, "s3", "loop.revise_spec_applied", { cycle: 2, subTasks: 4 }, 20); // most-recent wins
  const snap = buildProgressSnapshot(db, "s3");
  assert.equal(snap.reviseSpecFellBack, false, "an applied revise-spec that superseded the fail must clear the flag");
  assert.ok(!/RAW adversary findings/.test(snap.headline));
});

test("beta83 #1: a fallback in a PRIOR cycle does not haunt a recovered later cycle", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s4", { status: "executing", cycles_ran: 3 });
  insertSubTask(db, "s4", 1, "running", "cycle-3 worker", 3);
  insertAudit(db, "s4", "loop.revise_spec_failed", { cycle: 2 }, 10); // OLD cycle
  insertAudit(db, "s4", "loop.revise_spec_applied", { cycle: 3, subTasks: 3 }, 20); // current cycle recovered
  const snap = buildProgressSnapshot(db, "s4");
  assert.equal(snap.reviseSpecFellBack, false, "only the LATEST cycle's revise-spec outcome should drive the flag");
});

test("beta83 #1: cycle 1 (no revise-spec) is never flagged", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s5", { status: "executing", cycles_ran: 1 });
  insertSubTask(db, "s5", 1, "running", "cycle-1 worker", 1);
  const snap = buildProgressSnapshot(db, "s5");
  assert.equal(snap.reviseSpecFellBack, false);
  assert.ok(!/RAW adversary findings/.test(snap.headline));
});

test("beta83 #1: a clarification pause keeps its own headline (warning does not clobber it)", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s6", { status: "awaiting_clarification", cycles_ran: 2 });
  db.prepare(`UPDATE sessions SET clarification_question = ?, clarification_seq = 3 WHERE id = 's6'`).run("Which endpoint?");
  insertSubTask(db, "s6", 3, "pending", "cycle-2 worker");
  insertAudit(db, "s6", "loop.revise_spec_failed", { cycle: 2 }, 10);
  const snap = buildProgressSnapshot(db, "s6");
  assert.match(snap.headline, /Awaiting clarification/);
  assert.ok(!/RAW adversary findings/.test(snap.headline), "clarification headline must not be appended to");
  // the flag itself can still be true (data), only the headline is protected
  assert.equal(snap.reviseSpecFellBack, true);
});

test("beta83 #1: empty snapshot (unknown session) defaults reviseSpecFellBack=false", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  const snap = buildProgressSnapshot(db, "nope");
  assert.equal(snap.reviseSpecFellBack, false);
});

// ---------- #1 wiring ----------

test("beta83 #1: progress.ts declares reviseSpecFellBack + scopes detection to the latest cycle", () => {
  assert.ok(progressSrc.includes("reviseSpecFellBack"), "ProgressSnapshot must carry reviseSpecFellBack");
  assert.ok(progressSrc.includes("loop.revise_spec_failed") && progressSrc.includes("loop.revise_spec_empty"), "detection must read the fallback audit events");
  assert.ok(progressSrc.includes("latestCycle > 1"), "detection is scoped to a revise cycle (>1)");
  assert.ok(progressSrc.includes("headlineWithWarnings"), "headline must be augmented with the warning");
});

// ---------- #2 wiring (runInner is private) ----------

test("beta83 #2: the session-budget soft-warn ALSO fires on the review path (phase:review)", () => {
  // The pre-beta.83 warn lived only in runOne; the review path recorded review
  // cost (totalCost += report.costUsd) with no warn check. Assert the new
  // review-path check exists and is a review-phase audit.
  assert.ok(loopSrc.includes('phase: "review"'), "the new soft-warn audit must be tagged phase:review");
  const addIdx = loopSrc.indexOf("totalCost += report.costUsd");
  const warnAfter = loopSrc.indexOf("this.warnSessionBudgetSoft(sessionId, row.requester, totalCost, row.budget_usd)", addIdx);
  assert.ok(addIdx > 0 && warnAfter > addIdx, "warnSessionBudgetSoft must be called AFTER the review cost is added to totalCost");
});

test("beta83 #2: the review-path warn reuses the same one-shot sessionBudgetWarned latch", () => {
  // Both the runOne check and the review check gate on the SAME latch so a run
  // still warns at most once.
  const occurrences = (loopSrc.match(/!sessionBudgetWarned/g) || []).length;
  assert.ok(occurrences >= 2, "sessionBudgetWarned latch must gate BOTH the runOne and the review-path soft-warn");
  assert.ok(loopSrc.includes("totalCost > row.budget_usd && !sessionBudgetWarned"), "the review-path check compares the LIVE totalCost against the session budget");
});
