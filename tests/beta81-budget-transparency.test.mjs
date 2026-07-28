// beta.81 Track A — budget transparency.
//   A1: session estimate persisted up front + surfaced in the harness_run ack.
//   A2: terminal totals + explicit "% of cap" in the progress headline; estimate
//       + pctOfCap on the snapshot cost block.
//   A3: an UNCONDITIONAL `tool.run.budget_estimate` audit fires on EVERY run
//       (no longer if(rec.note)-gated).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let buildProgressSnapshot = null, buildHeadline = null, Database = null;
try {
  ({ buildProgressSnapshot, buildHeadline } = await import("../dist/orchestrator/progress.js"));
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
function insert(d, id, { status = "executing", cost = 3, budget = 20, estimated = 5 } = {}) {
  d.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, estimated_usd)
     VALUES (?, ?, 'C1', 'U1', 'u1', 'o/r', 'harness/x', '', ?, ?, ?, ?, ?, 1, ?)`,
  ).run(id, `T-${id}`, status, Date.now(), Date.now(), budget, cost, estimated);
}

// ---- A3: unconditional budget_estimate audit ----
test("beta81/A3: tool.run.budget_estimate is emitted UNCONDITIONALLY (not if(rec.note)-gated)", () => {
  const src = S("src/tools/registration.ts");
  // The estimate audit must fire OUTSIDE the `if (rec.note)` block.
  assert.match(src, /liveState\(\)\.audit\("tool\.run\.budget_estimate"/);
  const estIdx = src.indexOf('audit("tool.run.budget_estimate"');
  const noteGateIdx = src.indexOf("if (rec.note) {");
  assert.ok(estIdx > 0 && noteGateIdx > 0, "both anchors present");
  assert.ok(estIdx < noteGateIdx, "budget_estimate audit must precede (be outside) the if(rec.note) gate");
  // carries the required fields.
  assert.match(src, /estimated: rec\.recommended/);
  assert.match(src, /cap: effectiveBudget/);
  assert.match(src, /dailySoFar: rec\.dailySoFar/);
  assert.match(src, /dailyMax: rec\.dailyMax/);
});

// ---- A1: estimate persisted + surfaced ----
test("beta81/A1: estimate persisted on the session row + surfaced up front in the ack", () => {
  const src = S("src/tools/registration.ts");
  // INSERT persists estimated_usd.
  assert.match(src, /cycles_ran, estimated_usd/);
  assert.match(src, /rec\.recommended,/);
  // ack surfaces an unconditional estimate line.
  assert.match(src, /Estimated ~\$\$\{res\.estimatedUsd\.toFixed\(2\)\} for this change; session cap/);
  // schema + migration declare the column.
  assert.match(S("src/state/schema.sql"), /estimated_usd\s+REAL/);
  assert.match(S("src/state/store.ts"), /column: "estimated_usd"/);
});

// ---- A2: %-of-cap in headline + snapshot ----
test("beta81/A2: buildHeadline includes an explicit % of cap in the cost fragment", { skip: buildHeadline === null }, () => {
  const executing = buildHeadline({
    phase: "Executing", status: "executing", terminal: false, total: 3, done: 1,
    current: { title: "edit" }, spentUsd: 5, budgetUsd: 20, prNumber: null, deployStatus: null,
  });
  assert.match(executing, /\$5\.00\/\$20\.00, 25% of cap/);
  // terminal 'done' line carries totals + % of cap.
  const done = buildHeadline({
    phase: "Done", status: "done", terminal: true, total: 3, done: 3,
    current: null, spentUsd: 12.5, budgetUsd: 25, prNumber: 42, deployStatus: null,
  });
  assert.match(done, /PR #42/);
  assert.match(done, /\$12\.50\/\$25\.00, 50% of cap/);
});

test("beta81/A2: a budget/reserve abort adds an actionable 're-run at a higher cap' hint", { skip: buildHeadline === null }, () => {
  const failed = buildHeadline({
    phase: "Executing", status: "failed", terminal: true, total: 3, done: 2, current: null,
    spentUsd: 20, budgetUsd: 20, prNumber: null, deployStatus: null,
    failureDetail: "budget reserve projection would exceed cap",
  });
  assert.match(failed, /Re-run at a higher cap to finish\./);
  // a NON-budget failure does NOT get the hint.
  const other = buildHeadline({
    phase: "Executing", status: "failed", terminal: true, total: 3, done: 2, current: null,
    spentUsd: 3, budgetUsd: 20, prNumber: null, deployStatus: null,
    failureDetail: "verifier path check: file missing",
  });
  assert.doesNotMatch(other, /Re-run at a higher cap/);
});

test("beta81/A2: snapshot cost block carries estimatedUsd + pctOfCap", { skip: buildProgressSnapshot === null }, () => {
  const d = db();
  insert(d, "A2", { cost: 3, budget: 20, estimated: 5 });
  const snap = buildProgressSnapshot(d, "A2");
  assert.equal(snap.cost.estimatedUsd, 5);
  assert.equal(snap.cost.pctOfCap, 15); // 3/20 = 15%
  assert.match(snap.headline, /15% of cap/);
  d.close();
});
