// beta.103 — the three defects the b102 DR/BCP smoke (session 670c8440,
// ProjectThanos PR #906) exposed. Every fixture below is real data from that
// run, not invented shapes.
//
//   1. PLAN PATH WRITEBACK. The lead planned
//      `src/app/(app)/grc/continuity-exercises/page.tsx`; the repo uses
//      `(portal)`. Verification rederived it and the sub-task passed, but the
//      correction never reached `st.filesLikelyTouched`, so on cycle 3
//      computeReviseScope could not intersect the adversary's `(portal)`
//      findings with the plan's `(app)` path and SKIPPED the one sub-task that
//      owned both of its outstanding findings.
//   2. CI `none` RACE. Covered in beta81-ci-shift.test.mjs (the grace window
//      now applies to repos that already have CI); the wiring assertions live
//      here.
//   3. LEDGER UNDER-RECORDING. A turn where the worker commits its own work AND
//      the harness commits the remainder produced two commits but recorded one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let applyPathCorrections, describePathCorrections, computeReviseScope, mapFindingsToSubTasks, parseHarnessConfig, runWorkerCore;
try {
  ({ applyPathCorrections, describePathCorrections } = await import("../dist/orchestrator/plan-path-writeback.js"));
  ({ computeReviseScope } = await import("../dist/orchestrator/revise-scope.js"));
  ({ mapFindingsToSubTasks } = await import("../dist/orchestrator/revise-mapping.js"));
  ({ parseHarnessConfig } = await import("../dist/config.js"));
  ({ runWorker: runWorkerCore } = await import("../dist/orchestrator/worker.js"));
} catch {
  applyPathCorrections = undefined;
}
const skip = applyPathCorrections === undefined;

// The real paths from PR #906.
const FICTIONAL = "src/app/(app)/grc/continuity-exercises/page.tsx";
const REAL = "src/app/(portal)/grc/continuity-exercises/page.tsx";

// ---------------------------------------------------------------------------
// 1. applyPathCorrections — pure behaviour
// ---------------------------------------------------------------------------

test("beta103: a proven correction replaces the fictional path in place", { skip }, () => {
  const r = applyPathCorrections(
    ["prisma/schema.prisma", FICTIONAL, "src/components/ui/sidebar.tsx"],
    [{ from: FICTIONAL, to: REAL }],
  );
  assert.deepEqual(r.files, ["prisma/schema.prisma", REAL, "src/components/ui/sidebar.tsx"]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].to, REAL);
});

test("beta103: correcting onto a path the list ALREADY has collapses to one entry", { skip }, () => {
  const r = applyPathCorrections([FICTIONAL, REAL], [{ from: FICTIONAL, to: REAL }]);
  assert.deepEqual(r.files, [REAL], "must not leave a duplicate behind");
});

test("beta103: a correction whose `from` is absent NEVER widens the sub-task's scope", { skip }, () => {
  const before = ["prisma/schema.prisma"];
  const r = applyPathCorrections(before, [{ from: FICTIONAL, to: REAL }]);
  assert.deepEqual(r.files, before, "an unmatched correction must not append");
  assert.equal(r.applied.length, 0);
});

test("beta103: no-op and malformed corrections are ignored", { skip }, () => {
  const before = [FICTIONAL];
  assert.deepEqual(applyPathCorrections(before, [{ from: FICTIONAL, to: FICTIONAL }]).files, before);
  assert.deepEqual(applyPathCorrections(before, [{ from: "", to: REAL }]).files, before);
  assert.deepEqual(applyPathCorrections(before, [{ from: FICTIONAL, to: "" }]).files, before);
  assert.deepEqual(applyPathCorrections(undefined, [{ from: FICTIONAL, to: REAL }]).files, []);
  assert.deepEqual(applyPathCorrections(before, []).files, before);
});

test("beta103: `./` and duplicate-slash spellings still match", { skip }, () => {
  const r = applyPathCorrections([`./${FICTIONAL}`], [{ from: FICTIONAL, to: REAL }]);
  assert.deepEqual(r.files, [REAL]);
});

test("beta103: the first correction wins when two contradict", { skip }, () => {
  const r = applyPathCorrections([FICTIONAL], [
    { from: FICTIONAL, to: REAL },
    { from: FICTIONAL, to: "src/app/(other)/page.tsx" },
  ]);
  assert.deepEqual(r.files, [REAL]);
});

test("beta103: describePathCorrections renders a readable audit line", { skip }, () => {
  assert.equal(describePathCorrections([{ from: FICTIONAL, to: REAL }]), `${FICTIONAL} -> ${REAL}`);
});

// ---------------------------------------------------------------------------
// 2. The b102 regression, end to end through the real scoper
// ---------------------------------------------------------------------------

// Sub-task 7 as the lead actually planned it, and the two findings the
// adversary actually filed against the real file on cycle 3.
const subTasks = [
  { seq: 2, filesLikelyTouched: ["prisma/schema.prisma"] },
  { seq: 7, filesLikelyTouched: [FICTIONAL] },
  { seq: 8, filesLikelyTouched: ["src/__tests__/api/grc/continuity-exercises-api.test.ts"] },
];
const findings = [
  { file: REAL, line: 366, dimension: "quality", severity: "medium", title: "Edit drawer always sends ownersSignOff" },
  { file: REAL, line: 460, dimension: "quality", severity: "low", title: "Unescaped apostrophe in JSX text" },
];

test("beta103 REGRESSION: with the fictional path, no sub-task owns either finding", { skip }, () => {
  // The b102 bug was that seq 7 -- the sub-task that actually owned both
  // findings -- got SKIPPED, because its declared path was fictional and so
  // matched nothing the adversary filed against the real file.
  //
  // beta.113 stops that specific outcome: with nobody owning the findings,
  // scoping would have selected zero sub-tasks, and a cycle that dispatches
  // nobody is now caught and falls back to running everything. So seq 7 does
  // get its worker. What remains lost is the targeting -- the whole point of
  // the optimisation -- which is what the writeback below restores.
  const r = computeReviseScope(subTasks, findings, 3);
  assert.equal(r.scoped, false, "b113: scoping to nobody is refused");
  assert.equal(r.reason, "no_subtask_owns_the_findings");
  assert.ok(!r.skipSeqs.includes(7), "seq 7 must not be skipped; it owns both findings");
  assert.equal(r.runSeqs.length, subTasks.length, "the fallback runs everything, targeting nothing");
});

test("beta103 FIX: after writeback, cycle 3 RUNS the sub-task that owns both findings", { skip }, () => {
  const corrected = subTasks.map((s) =>
    s.seq === 7 ? { ...s, filesLikelyTouched: applyPathCorrections(s.filesLikelyTouched, [{ from: FICTIONAL, to: REAL }]).files } : s,
  );
  const r = computeReviseScope(corrected, findings, 3);
  assert.ok(r.runSeqs.includes(7), "the sub-task the findings target must be re-run");
  assert.ok(!r.skipSeqs.includes(7));
});

test("beta103 FIX: after writeback, both findings MAP to the sub-task instead of becoming mapping misses", { skip }, () => {
  // The strict structural matcher the loop injects (resolveContractPath with
  // strictContract): given a sub-task's owned files and a finding file, return
  // the owned path it structurally resolves to, else falsy.
  const n = (p) => (p ?? "").trim().replace(/^\.\//, "").toLowerCase();
  const match = (owned, candidate) =>
    (owned ?? []).find((o) => n(o) === n(candidate) || n(o).endsWith("/" + n(candidate)) || n(candidate).endsWith("/" + n(o)));

  const before = mapFindingsToSubTasks(subTasks, findings, match);
  assert.equal(before.mappingMisses.length, 2, "both findings miss while the plan holds the fiction");
  assert.equal(before.assignments.find((a) => a.seq === 7).targeted.length, 0);

  const corrected = subTasks.map((s) =>
    s.seq === 7 ? { ...s, filesLikelyTouched: applyPathCorrections(s.filesLikelyTouched, [{ from: FICTIONAL, to: REAL }]).files } : s,
  );
  const after = mapFindingsToSubTasks(corrected, findings, match);
  assert.equal(after.mappingMisses.length, 0);
  assert.equal(after.assignments.find((a) => a.seq === 7).targeted.length, 2, "both findings now target seq 7");
  assert.equal(after.anyTargeted, true);
});

// ---------------------------------------------------------------------------
// 3. Wiring — the fixes are actually reachable from the loop
// ---------------------------------------------------------------------------

test("beta103: the loop collects corrections from BOTH the rederive and the test reconcile", { skip }, () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /import \{ applyPathCorrections, describePathCorrections, type PathCorrection \}/);
  assert.match(src, /pathCorrections\.push\(\{ from: v\.path, to: rd\.path \}\)/, "b76 rederive must feed the writeback");
  assert.match(src, /pathCorrections\.push\(\{ from: rc\.from, to: rc\.to \}\)/, "b100 test reconcile must feed the writeback");
  assert.match(src, /st\.filesLikelyTouched = wb\.files/, "the correction must reach the PLAN, not just the contract");
  assert.match(src, /loop\.plan_path_written_back/);
});

test("beta103: the CI none grace no longer depends on having authored a workflow", { skip }, () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /const graceActive = graceMs > 0;/, "grace must apply to every repo");
  assert.match(src, /const authoredWorkflowGrace = !!input\.workflowAuthoredThisSession && graceMs > 0;/);
  assert.match(src, /if \(authoredWorkflowGrace\) \{/, "only the authored case may return authored_workflow_never_registered");
});

// The b102 `f4b5d2e3` shape, driven through the real runWorker: the worker
// commits its own work with its git tool AND leaves more changes dirty, so the
// harness commits the remainder. Two commits, one `commitSha` column.
async function runTwoCommitTurn() {
  const BASE = "base0000";
  const WORKER_OWN = "f4b5d2e3"; // the worker's own commit -- the one b102 lost
  const HARNESS = "3bea983a"; // harness(4): ... -- the only one recorded pre-b103
  let head = WORKER_OWN; // the worker already self-committed during its turn

  return runWorkerCore(
    "/tmp/wt",
    { title: "t", motivation: "m", acceptanceCriteria: [] },
    { seq: 4, title: "Add item route", intent: "", filesLikelyTouched: [], successCriteria: [] },
    { name: "H", email: "h@t.local" },
    {
      config: {
        models: { worker: "w" },
        safety: { worker_permission_mode: "acceptEdits" },
        loop: { worker_timeout_seconds: 60 },
      },
      logger: { info() {}, warn() {}, error() {} },
      buildCanUseTool: () => async () => ({ allow: true }),
      runWorkerModel: async () => ({
        sdkSessionId: "s", stopReason: "end_turn", costUsd: 0, tokensIn: 0, tokensOut: 0,
        logsExcerpt: "", finalMessage: "done", streamOpened: true,
      }),
      gitBaseSha: async () => BASE,
      gitHeadSha: async () => head,
      // Dirty tree remains after the worker's own commit -> harness commits it.
      gitListChangedFiles: async () => ["src/app/api/grc/continuity-exercises/[id]/route.ts"],
      gitCommit: async () => { head = HARNESS; return HARNESS; },
      gitStatusPorcelain: async () => [],
      gitListCommittedFiles: async () => [],
    },
  );
}

test("beta103: a turn that commits TWICE records both tips, not just the harness one", { skip: skip || !runWorkerCore }, async () => {
  const r = await runTwoCommitTurn();
  assert.equal(r.commitSha, "3bea983a", "commitSha keeps its existing meaning (the harness commit)");
  assert.ok(Array.isArray(r.commitShas), "commitShas must be populated");
  assert.ok(
    r.commitShas.includes("f4b5d2e3"),
    "the worker's OWN commit must be recorded -- this is the b102 f4b5d2e3 that entered no ledger and so could never be reachability-checked",
  );
  assert.ok(r.commitShas.includes("3bea983a"), "the harness commit must still be recorded");
  assert.equal(new Set(r.commitShas).size, r.commitShas.length, "no duplicate tips");
});

test("beta103: a single-commit turn records exactly one tip (no phantom entries)", { skip: skip || !runWorkerCore }, async () => {
  const BASE = "base0000";
  let head = BASE; // worker did NOT self-commit
  const r = await runWorkerCore(
    "/tmp/wt",
    { title: "t", motivation: "m", acceptanceCriteria: [] },
    { seq: 2, title: "Schema", intent: "", filesLikelyTouched: [], successCriteria: [] },
    { name: "H", email: "h@t.local" },
    {
      config: { models: { worker: "w" }, safety: { worker_permission_mode: "acceptEdits" }, loop: { worker_timeout_seconds: 60 } },
      logger: { info() {}, warn() {}, error() {} },
      buildCanUseTool: () => async () => ({ allow: true }),
      runWorkerModel: async () => ({ sdkSessionId: "s", stopReason: "end_turn", costUsd: 0, tokensIn: 0, tokensOut: 0, logsExcerpt: "", finalMessage: "" }),
      gitBaseSha: async () => BASE,
      gitHeadSha: async () => head,
      gitListChangedFiles: async () => ["prisma/schema.prisma"],
      gitCommit: async () => { head = "7a715eaa"; return "7a715eaa"; },
      gitStatusPorcelain: async () => [],
      gitListCommittedFiles: async () => [],
    },
  );
  assert.deepEqual(r.commitShas, ["7a715eaa"]);
});

test("beta103: the loop threads the full tip list into the reachability guard", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /commitShas: result\.commitShas \?\? \(result\.commitSha \? \[result\.commitSha\] : \[\]\)/,
    "worker_end_turn must carry the full list for the reachability guard");
  assert.match(loop, /Array\.isArray\(p\?\.commitShas\) \? p\.commitShas : \[\]/,
    "the guard must read the list, falling back to the single sha for pre-b103 rows");
});

test("beta103: attaching a dispatch hint is now auditable", { skip }, () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /loop\.dispatch_hint_attached/);
  assert.match(src, /sources: \[/);
  assert.match(src, /plan_path_suspect/);
});

// ---------------------------------------------------------------------------
// 4. Config
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["o/*"] },
  storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt" },
};

test("beta103: plan_path_writeback_enabled defaults ON and is overridable", { skip }, () => {
  const on = parseHarnessConfig(MINIMAL_CONFIG);
  assert.equal(on.loop.plan_path_writeback_enabled, true);
  const off = parseHarnessConfig({ ...MINIMAL_CONFIG, loop: { plan_path_writeback_enabled: false } });
  assert.equal(off.loop.plan_path_writeback_enabled, false);
});

test("beta103: the new key is declared in both schemas", { skip }, () => {
  assert.match(S("src/config.schema.json"), /"plan_path_writeback_enabled"/);
  assert.match(S("openclaw.plugin.json"), /"plan_path_writeback_enabled"/);
});

test("beta103: version is at or past beta.103", { skip }, () => {
  const version = JSON.parse(S("package.json")).version;
  assert.ok(betaOrdinal(version) >= 103, `expected at or past beta.103, got ${version}`);
});
