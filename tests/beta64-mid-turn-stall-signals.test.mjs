// beta.64 (P1-5 / P1-6 / P1-7) — mid-turn stall SIGNALS in harness_progress
// (the beta.63 blind spot: stalled was false during an inner-turn hang because
// it read last_progress_at, bumped only on sub-task BOUNDARIES) + a $0-cost
// leading indicator + a `cause` on recovery.auto_resuming.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let buildProgressSnapshot, Database;
try {
  ({ buildProgressSnapshot } = await import("../dist/orchestrator/progress.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  buildProgressSnapshot = null;
}
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function db() {
  const d = new Database(":memory:");
  d.exec(readFileSync(schemaPath, "utf8"));
  return d;
}

function insertExecuting(d, id, { lastProgressAt, subtaskStartedAt, subtaskCost = 0, subtaskStatus = "running" } = {}) {
  const now = Date.now();
  d.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, last_progress_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, 'T', 'C', 'U', 'u', 'o/r', 'b', '/tmp/wt', 'executing', ?, ?, ?, 50, 0, 1)`,
  ).run(id, now, now, lastProgressAt ?? now);
  d.prepare(
    `INSERT INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, cost_usd, started_at, created_at, updated_at)
     VALUES (?, ?, 1, 1, 'work', 'claude-sonnet-5', ?, ?, ?, ?, ?)`,
  ).run(`${id}-s1`, id, subtaskStatus, subtaskCost, subtaskStartedAt ?? now, now, now);
}

function audit(d, id, event, at) {
  d.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, '{}', ?)`).run(id, event, at);
}

// ---- P1-5: an inner-turn hang flips stalled:true even though last_progress_at
//      is fresh at the sub-task boundary ----
test("beta64/P1-5: mid-turn hang (no SDK activity past ~90s) flips stalled:true even with a within-window last_progress_at",
  { skip: buildProgressSnapshot === null }, () => {
    const d = db();
    const now = Date.now();
    // last_progress_at is only 60s old (bumped at subtask_start) -> the b63
    // between-transition watchdog would NOT flag it. But the last SDK ACTIVITY
    // audit (subtask_start marker) is 120s old -> mid-turn stall.
    insertExecuting(d, "M1", { lastProgressAt: now - 60_000, subtaskStartedAt: now - 120_000 });
    audit(d, "M1", "loop.progress", now - 120_000); // subtask_start marker
    const snap = buildProgressSnapshot(d, "M1", 12, 1800, 90);
    assert.equal(snap.stalled, true, "inner-turn hang must flip stalled:true");
    assert.ok(snap.msSinceLastSdkActivity >= 90_000, "msSinceLastSdkActivity crossed the 90s window");
    d.close();
  });

test("beta64/P1-5: fresh SDK activity (recent) => stalled stays false",
  { skip: buildProgressSnapshot === null }, () => {
    const d = db();
    const now = Date.now();
    insertExecuting(d, "M2", { lastProgressAt: now - 5_000, subtaskStartedAt: now - 5_000 });
    audit(d, "M2", "loop.progress", now - 5_000);
    const snap = buildProgressSnapshot(d, "M2", 12, 1800, 90);
    assert.equal(snap.stalled, false, "recent SDK activity => not stalled");
    assert.ok(snap.msSinceLastSdkActivity < 90_000);
    d.close();
  });

// ---- P1-6: a worker running > window with cost still $0 => leading indicator ----
test("beta64/P1-6: running sub-task older than the window with $0 cost => costZeroStallSuspected:true",
  { skip: buildProgressSnapshot === null }, () => {
    const d = db();
    const now = Date.now();
    insertExecuting(d, "Z1", { lastProgressAt: now - 5_000, subtaskStartedAt: now - 120_000, subtaskCost: 0, subtaskStatus: "running" });
    const snap = buildProgressSnapshot(d, "Z1", 12, 1800, 90);
    assert.equal(snap.costZeroStallSuspected, true, "long-running $0 worker is a leading stall indicator");
    d.close();
  });

test("beta64/P1-6: a running sub-task that has ALREADY billed (cost>0) is NOT flagged",
  { skip: buildProgressSnapshot === null }, () => {
    const d = db();
    const now = Date.now();
    insertExecuting(d, "Z2", { lastProgressAt: now - 5_000, subtaskStartedAt: now - 120_000, subtaskCost: 0.5, subtaskStatus: "running" });
    const snap = buildProgressSnapshot(d, "Z2", 12, 1800, 90);
    assert.equal(snap.costZeroStallSuspected, false, "a worker that produced billable tokens is not a $0 hang");
    d.close();
  });

// ---- source-assertions ----
test("beta64/P1-5+6: progress snapshot exposes msSinceLastSdkActivity + costZeroStallSuspected (source)", () => {
  const prog = S("src/orchestrator/progress.ts");
  assert.match(prog, /msSinceLastSdkActivity: number \| null/);
  assert.match(prog, /costZeroStallSuspected: boolean/);
  assert.match(prog, /SDK_ACTIVITY_EVENTS/);
  const reg = S("src/tools/registration.ts");
  assert.match(reg, /msSinceLastSdkActivity: snapshot\.msSinceLastSdkActivity/);
  assert.match(reg, /sdkActivityStallSeconds/);
});

test("beta64/P1-7: recovery.auto_resuming now carries a visible cause (source)", () => {
  const src = S("src/state/recovery.ts");
  assert.match(src, /"recovery\.auto_resuming"/);
  assert.match(src, /cause: "interrupted_non_terminal_agent_orchestrated"/);
});
