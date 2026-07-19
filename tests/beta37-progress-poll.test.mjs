/**
 * beta.37: poll-model progress (`harness_progress` tool + buildProgressSnapshot).
 *
 * WHY: the harness is tool-driven (beta.34 removed the Slack listener), so it
 * must not post to Slack itself. The old `reportProgress` posted directly to
 * sessions.slack_channel/thread -- which are ""/"agent:<uuid>" for
 * agent-orchestrated runs -- and every post was silently dropped by a blind
 * .catch(() => {}). Users got ZERO feedback. beta.37 replaces that with a pure
 * read snapshot the calling OpenClaw agent polls and relays.
 *
 * These tests assert the snapshot is built correctly from the sessions /
 * sub_tasks / audit_log tables the loop already writes, and that the headline
 * is Slack-mrkdwn-safe (no tables/headings).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let buildProgressSnapshot, buildHeadline, TERMINAL_STATUSES, Database;
try {
  ({ buildProgressSnapshot, buildHeadline, TERMINAL_STATUSES } = await import("../dist/orchestrator/progress.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  buildProgressSnapshot = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}

function insertSession(db, id, over = {}) {
  const s = {
    status: "executing",
    repo: "o/r",
    branch: "harness/x",
    cycles_ran: 1,
    cost_usd: 0.25,
    budget_usd: 3,
    pr_number: null,
    final_pr_url: null,
    deploy_status: null,
    ...over,
  };
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, pr_number, final_pr_url, deploy_status)
     VALUES (?, ?, '', 'U1', 'U1', ?, ?, '/tmp/wt', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, `agent:${id}`, s.repo, s.branch, s.status,
    Date.now(), Date.now(), s.budget_usd, s.cost_usd, s.cycles_ran,
    s.pr_number, s.final_pr_url, s.deploy_status,
  );
}

function insertSubTask(db, sessionId, seq, status, title, over = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, cost_usd, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'w', ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${sessionId}-c1-s${seq}`, sessionId, over.cycle ?? 1, seq, title, status,
    over.costUsd ?? 0.1, over.startedAt ?? now, over.completedAt ?? null, now, now,
  );
}

function insertAudit(db, sessionId, event, payload = {}) {
  db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, event, JSON.stringify(payload), Date.now());
}

test("beta37: unknown session -> found:false, ok:true, safe empty snapshot", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  const snap = buildProgressSnapshot(db, "nope");
  assert.equal(snap.ok, true);
  assert.equal(snap.found, false);
  assert.equal(snap.terminal, false);
  assert.match(snap.headline, /No harness session/);
});

test("beta37: executing run reports current sub-task N/M + running cost", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s1", { status: "executing", cost_usd: 0.42, budget_usd: 3, cycles_ran: 1 });
  insertSubTask(db, "s1", 1, "done", "Rename taxonomy L1 labels", { completedAt: Date.now() });
  insertSubTask(db, "s1", 2, "running", "Update dropdown component");
  insertSubTask(db, "s1", 3, "pending", "Add unit test");
  insertAudit(db, "s1", "loop.progress", { status: "executing", cycle: 1 });

  const snap = buildProgressSnapshot(db, "s1");
  assert.equal(snap.found, true);
  assert.equal(snap.phase, "Executing");
  assert.equal(snap.terminal, false);
  assert.equal(snap.subTasks.total, 3);
  assert.equal(snap.subTasks.done, 1);
  assert.equal(snap.subTasks.running, 1);
  assert.equal(snap.subTasks.current.seq, 2);
  assert.equal(snap.cost.spentUsd, 0.42);
  assert.equal(snap.cost.budgetUsd, 3);
  // headline is a single line, no markdown tables/headings.
  assert.ok(!snap.headline.includes("\n"), "headline must be single-line");
  assert.ok(!snap.headline.includes("|"), "headline must not contain a markdown table");
  assert.ok(!snap.headline.startsWith("#"), "headline must not be a markdown heading");
  assert.match(snap.headline, /2\/3/);
  assert.match(snap.headline, /\$0\.42\/\$3\.00/);
});

test("beta37: completed_no_change counts as done (beta.35 revise path)", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s2", { status: "executing", cycles_ran: 1 });
  insertSubTask(db, "s2", 1, "completed_no_change", "Observe only");
  insertSubTask(db, "s2", 2, "done", "Edit file", { completedAt: Date.now() });
  const snap = buildProgressSnapshot(db, "s2");
  assert.equal(snap.subTasks.done, 2, "completed_no_change must count as done");
});

test("beta37: terminal done includes PR number in headline + terminal:true", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s3", { status: "done", cost_usd: 0.7, budget_usd: 3, pr_number: 42, final_pr_url: "https://github.com/o/r/pull/42" });
  const snap = buildProgressSnapshot(db, "s3");
  assert.equal(snap.terminal, true);
  assert.equal(snap.prNumber, 42);
  assert.match(snap.headline, /PR #42/);
  assert.match(snap.headline, /Done/);
});

test("beta37: failed run -> terminal:true and headline says failed", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s4", { status: "failed", cost_usd: 0.3, budget_usd: 3 });
  const snap = buildProgressSnapshot(db, "s4");
  assert.equal(snap.terminal, true);
  assert.match(snap.headline, /Failed/i);
});

test("beta37: recent events tail is newest-last and bounded by limit", { skip: !buildProgressSnapshot }, () => {
  const db = makeDb();
  insertSession(db, "s5", { status: "reviewing", cycles_ran: 1 });
  for (let i = 0; i < 20; i++) insertAudit(db, "s5", `evt.${i}`, { i });
  const snap = buildProgressSnapshot(db, "s5", 5);
  assert.equal(snap.recentEvents.length, 5);
  // newest last: the last element should be the highest-index event.
  assert.equal(snap.recentEvents[snap.recentEvents.length - 1].event, "evt.19");
  assert.ok(snap.msSinceLastEvent != null && snap.msSinceLastEvent >= 0);
});

test("beta37: TERMINAL_STATUSES covers all loop terminal states", { skip: !buildProgressSnapshot }, () => {
  for (const s of ["done", "failed", "aborted", "failed_verification"]) {
    assert.ok(TERMINAL_STATUSES.has(s), `${s} must be terminal`);
  }
  assert.ok(!TERMINAL_STATUSES.has("executing"));
  assert.ok(!TERMINAL_STATUSES.has("planning"));
});

test("beta37: buildHeadline is mrkdwn-safe for every phase", { skip: !buildProgressSnapshot }, () => {
  const phases = [
    { phase: "Planning", status: "planning" },
    { phase: "Executing", status: "executing" },
    { phase: "Adversarial review", status: "reviewing" },
    { phase: "Done", status: "done" },
    { phase: "Failed", status: "failed" },
    { phase: "Aborted", status: "aborted" },
  ];
  for (const p of phases) {
    const h = buildHeadline({
      ...p, terminal: ["done", "failed", "aborted"].includes(p.status),
      total: 3, done: 1, current: { seq: 2, title: "x" }, spentUsd: 0.5, budgetUsd: 3,
      prNumber: null, deployStatus: null,
    });
    assert.ok(typeof h === "string" && h.length > 0);
    assert.ok(!h.includes("\n"), `${p.status} headline must be single-line`);
    assert.ok(!h.includes("|"), `${p.status} headline must not contain a table`);
    assert.ok(!h.startsWith("#"), `${p.status} headline must not be a heading`);
  }
});
