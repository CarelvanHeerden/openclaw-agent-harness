// beta.134 (observe-handoff) — an observe sub-task's report reaches the
// sub-tasks that depend on it.
//
// The hole this closes: a plan opened with an observe probe ("map the
// architecture, report the real paths"), the probe wrote a 7k-char report, and
// the report was audited and discarded. The next sub-task's intent said "apply
// the paths reported by sub-task 1" while its prompt said "do NOT re-explore
// the repo" — findings it had never seen, and a ban on going to look. The
// worker resolved the contradiction by reporting edits it had not made.
//
// Asserts:
//   - selectObserveReports: dependsOn is authoritative; falls back to earlier
//     observes when the lead omitted it; never feeds a sub-task its own report.
//   - renderObserveReportsBlock: verbatim findings; "" when none; per-report
//     and total char budgets hold.
//   - buildWorkerSystemPrompt: the findings block lands before the lead's
//     Implementation context and before ## Rules; cold prompt unchanged.
//   - the "do NOT re-explore" instruction now carries an escape hatch, so a
//     missing fact means READ, never GUESS.
//   - loop.ts records probe reports and hands them down on a COPY of the
//     sub-task (the plan is serialised; the report must not grow it).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let selectObserveReports, renderObserveReportsBlock, recoverObserveReports, buildWorkerSystemPrompt;
try {
  ({ selectObserveReports, renderObserveReportsBlock, recoverObserveReports } = await import("../dist/orchestrator/observe-handoff.js"));
  ({ buildWorkerSystemPrompt } = await import("../dist/orchestrator/worker.js"));
} catch {
  selectObserveReports = null;
}
const skip = selectObserveReports === null;

const recorded = () =>
  new Map([
    [1, { seq: 1, title: "Map the Drive integration", report: "Tenant config lives in src/server/tenant/config.ts" }],
    [3, { seq: 3, title: "Probe the auth surface", report: "Auth middleware is src/server/auth/mw.ts" }],
  ]);

const baseBrief = {
  title: "Add tenant Drive configuration",
  motivation: "Tenants cannot configure their own Drive folder.",
  acceptanceCriteria: ["A tenant can set a Drive folder id"],
};

function subTask(extra = {}) {
  return {
    seq: 4,
    title: "Add tenant Drive configuration",
    intent: "Apply the exact paths reported by sub-task 1",
    filesLikelyTouched: ["src/server/tenant/config.ts"],
    successCriteria: ["config carries a driveFolderId"],
    estimatedTokens: 5000,
    taskMode: "mutate",
    ...extra,
  };
}

// ---- selectObserveReports ----
test("beta134: dependsOn selects exactly the named probes", { skip }, () => {
  const got = selectObserveReports({ seq: 4, dependsOn: [3] }, recorded());
  assert.deepEqual(got.map((r) => r.seq), [3]);
});

test("beta134: no dependsOn falls back to every EARLIER observe", { skip }, () => {
  const got = selectObserveReports({ seq: 4 }, recorded());
  assert.deepEqual(got.map((r) => r.seq), [1, 3]);
  // and a sub-task that runs before a probe does not get that probe's report
  assert.deepEqual(selectObserveReports({ seq: 2 }, recorded()).map((r) => r.seq), [1]);
});

test("beta134: a re-run probe is never fed its own prior report", { skip }, () => {
  assert.deepEqual(selectObserveReports({ seq: 1 }, recorded()), []);
  assert.deepEqual(selectObserveReports({ seq: 1, dependsOn: [1] }, recorded()), []);
});

test("beta134: nothing recorded means nothing handed down", { skip }, () => {
  assert.deepEqual(selectObserveReports({ seq: 4, dependsOn: [1] }, new Map()), []);
});

// ---- renderObserveReportsBlock ----
test("beta134: findings render verbatim, attributed to their sub-task", { skip }, () => {
  const block = renderObserveReportsBlock(selectObserveReports({ seq: 4 }, recorded()));
  assert.match(block, /## Findings from earlier sub-tasks/);
  assert.match(block, /### Report from sub-task 1: Map the Drive integration/);
  assert.match(block, /src\/server\/tenant\/config\.ts/);
  assert.match(block, /### Report from sub-task 3: Probe the auth surface/);
  assert.match(block, /src\/server\/auth\/mw\.ts/);
  // the escape hatch: a fact that is missing is READ, not invented
  assert.match(block, /read\s+the repo to find it/i);
  assert.match(block, /not actually made/i);
});

test("beta134: no reports renders nothing", { skip }, () => {
  assert.equal(renderObserveReportsBlock([]), "");
});

test("beta134: a runaway report is truncated, and the total budget holds", { skip }, () => {
  const huge = [
    { seq: 1, title: "a", report: "x".repeat(40000) },
    { seq: 2, title: "b", report: "y".repeat(40000) },
    { seq: 3, title: "c", report: "z".repeat(40000) },
  ];
  const block = renderObserveReportsBlock(huge);
  assert.match(block, /truncated, \d+ chars omitted/);
  assert.match(block, /total char budget reached/);
  assert.ok(block.length < 20000, `block too large: ${block.length}`);
});

// ---- buildWorkerSystemPrompt injection ----
test("beta134: the dependent's prompt carries the probe's findings", { skip }, () => {
  const prompt = buildWorkerSystemPrompt(
    baseBrief,
    subTask({ priorObserveReports: selectObserveReports({ seq: 4, dependsOn: [1] }, recorded()) }),
  );
  assert.match(prompt, /## Findings from earlier sub-tasks/);
  assert.match(prompt, /src\/server\/tenant\/config\.ts/);
  // ordering: findings first (the probe LOOKED; the lead only guessed), then
  // the lead's plan-time context, then the generic rules.
  assert.ok(prompt.indexOf("## Your sub-task") < prompt.indexOf("## Findings from earlier sub-tasks"));
  assert.ok(prompt.indexOf("## Findings from earlier sub-tasks") < prompt.indexOf("## Rules"));
  // the rule that points the worker at the block
  assert.match(prompt, /Findings from earlier sub-tasks" block is present/);
});

test("beta134: findings precede the lead's Implementation context", { skip }, () => {
  const prompt = buildWorkerSystemPrompt(
    baseBrief,
    subTask({
      priorObserveReports: selectObserveReports({ seq: 4, dependsOn: [1] }, recorded()),
      workerContext: { rationale: "plan-time guess", changeSpec: "edit the config" },
    }),
  );
  assert.ok(
    prompt.indexOf("## Findings from earlier sub-tasks") < prompt.indexOf("## Implementation context"),
    "the probe's reading of the repo must outrank the lead's plan-time guess",
  );
});

test("beta134: a plan with no observe step prompts exactly as before", { skip }, () => {
  const prompt = buildWorkerSystemPrompt(baseBrief, subTask());
  assert.doesNotMatch(prompt, /## Findings from earlier sub-tasks/);
  assert.match(prompt, /## Your sub-task/);
  assert.match(prompt, /## Rules/);
});

test("beta135: observe reports recover after a clarification restart", { skip }, () => {
  const tasks = [
    { seq: 1, title: "Map the repo", taskMode: "observe" },
    { seq: 2, title: "Implement", taskMode: "mutate" },
  ];
  const recovered = recoverObserveReports(tasks, [
    {
      event: "loop.observe_report_recorded",
      payload: JSON.stringify({ seq: 1, title: "Map the repo", report: "exact/path.ts owns the feature" }),
    },
  ]);
  assert.equal(recovered.get(1)?.report, "exact/path.ts owns the feature");
  assert.equal(recovered.has(2), false, "mutate summaries are not probe reports");
});

test("beta135: recovery uses the newest report and supports beta134 rows", { skip }, () => {
  const tasks = [{ seq: 1, title: "Map the repo", taskMode: "observe" }];
  const recovered = recoverObserveReports(tasks, [
    {
      event: "loop.observe_report_recorded",
      payload: JSON.stringify({ seq: 1, report: "new report" }),
    },
    {
      event: "loop.worker_end_turn",
      payload: JSON.stringify({ seq: 1, finalMessage: "old beta134 report" }),
    },
  ]);
  assert.equal(recovered.get(1)?.report, "new report");

  const legacy = recoverObserveReports(tasks, [{
    event: "loop.worker_end_turn",
    payload: JSON.stringify({ seq: 1, finalMessage: "legacy report" }),
  }]);
  assert.equal(legacy.get(1)?.report, "legacy report");
});

// ---- the contradiction that caused the fabrication ----
test("beta134: 'do NOT re-explore' now has an escape hatch", { skip }, () => {
  const prompt = buildWorkerSystemPrompt(
    baseBrief,
    subTask({ workerContext: { rationale: "r", changeSpec: "c" } }),
  );
  // the original instruction survives ...
  assert.match(prompt, /do NOT re-explore the repo to re-derive/i);
  // ... but no longer reads as "invent it if you were not told"
  assert.match(prompt, /READ THE REPO to find it/);
  assert.match(prompt, /never "guess"/);
});

// ---- source assertions: the loop wiring ----
test("beta134: the loop records probe reports and hands them down", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /recordObserveReport/);
  assert.match(src, /withObserveReports/);
  assert.match(src, /loop\.observe_report_recorded/);
  assert.match(src, /loop\.observe_reports_handed_down/);
  // run-level, so a skipped re-probe on a revise cycle can still hand down
  // cycle 1's report
  assert.match(src, /const observeReports = this\.hydrateObserveReports\(sessionId, plan\)/);
});

test("beta134: the overlay is a copy — the stored plan never carries a report", () => {
  const src = S("src/orchestrator/observe-handoff.ts");
  assert.doesNotMatch(S("src/orchestrator/loop.ts"), /st\.priorObserveReports\s*=/);
  assert.match(S("src/orchestrator/loop.ts"), /\{ \.\.\.st, priorObserveReports: reports \}/);
  assert.match(src, /export interface ObserveReport/);
});

test("beta134: only a PASSED observe hands its report on", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /if \(st\.taskMode !== "observe"\) return;/);
});
