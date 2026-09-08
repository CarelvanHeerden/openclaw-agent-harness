// rc.3 -- an environment fault is not a code defect, and an unowned finding
// needs somebody who is allowed to fix it.
//
// Two more of StitchGuard PR #1168's loops.
//
// The missing `tsc` binary became a high-severity application finding. Nothing
// a worker could edit would produce a compiler, so every repair cycle spent on
// it changed nothing, and the next review raised it again because the binary
// was still missing. The harness already files its OWN tooling facts as `env`
// via `source: "harness_env"`; the gap was the finding the MODEL authored,
// which `isNonDemotable` protects from keyword demotion -- correctly in
// general, and exactly wrong for the one class of high-severity finding that no
// diff can resolve.
//
// And findings about the integration UI, credentials, authorization, OpenAPI,
// help content, the schema and the migration were routed into sub-tasks like
// "Declare SAST workflow routes". Those workers refused, correctly, to edit
// files they did not own. The finding survived, was re-raised, and was routed
// to the same people again.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");
const skip = existsSync(join(root, "dist", "orchestrator", "verification-blocker.js")) ? false : "dist not built";
const skipDist = { skip };
const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

const TSC = {
  dimension: "quality",
  severity: "high",
  title: "The typecheck could not run",
  detail: "Running `npm run typecheck` failed: sh: tsc: not found. No type errors could be established for this diff.",
  file: null,
};

// ---------------------------------------------------------------------------
// 20. ONE VERIFICATION BLOCKER, NEVER ASSIGNED TO A WORKER
// ---------------------------------------------------------------------------

test("20: a missing tsc is detected as an environment blocker with a human action", skipDist, async () => {
  const { detectVerificationBlocker } = await import("../dist/orchestrator/verification-blocker.js");
  const b = detectVerificationBlocker(TSC);
  assert.ok(b, "a compiler that is not installed is not a defect in the branch");
  assert.equal(b.kind, "missing_binary");
  assert.equal(b.subject, "tsc");
  assert.match(b.humanAction, /PATH|install/i, "a blocker with no action is just a stuck run with better wording");
});

test("20: the whole family of environment faults is recognised", skipDist, async () => {
  const { detectVerificationBlocker } = await import("../dist/orchestrator/verification-blocker.js");
  const cases = [
    ["Cannot find module 'react' -- node_modules is missing", "missing_dependency"],
    ["eslint: not found, so lint could not run", "missing_binary"],
    ["Playwright browsers are not installed, so no screenshot could be captured", "runtime_evidence_unavailable"],
    ["npm install failed: getaddrinfo ENOTFOUND registry.npmjs.org", "network_failure"],
    ["The worktree is corrupt: package.json is missing", "broken_worktree"],
  ];
  for (const [detail, kind] of cases) {
    const b = detectVerificationBlocker({ ...TSC, detail });
    assert.ok(b, `not detected: ${detail}`);
    assert.equal(b.kind, kind, detail);
  }
});

test("20: a real defect that merely MENTIONS tooling is untouched", skipDist, async () => {
  const { detectVerificationBlocker } = await import("../dist/orchestrator/verification-blocker.js");
  // The bar has to be high. A false positive here silently stops a genuine
  // defect driving repair cycles, which is precisely what isNonDemotable exists
  // to prevent.
  const notBlockers = [
    "The build script should run tsc in strict mode; it currently passes --noCheck",
    "This route calls npm audit output into a shell without escaping it",
    "The eslint config disables no-explicit-any for the whole src tree",
    "A stale request overwrites a newer filter result",
  ];
  for (const detail of notBlockers) {
    assert.equal(detectVerificationBlocker({ ...TSC, detail, title: detail }), null, detail);
  }
  // The blocker has to be what the finding is ABOUT. A critical defect that
  // explains, in passing, why nothing caught it is still a critical defect.
  assert.equal(
    detectVerificationBlocker({
      ...TSC,
      severity: "critical",
      title: "RCE in the upload handler",
      detail: "eslint: not found in this repo, so nothing caught it.",
    }),
    null,
    "a tooling aside must not demote the defect the finding is actually about",
  );
  // And CI is never an environment blocker, whatever its log contains.
  assert.equal(
    detectVerificationBlocker({ ...TSC, source: "ci", detail: "FAIL src/a.test.ts — Cannot find module './missing'" }),
    null,
    "a red build is the repo's own suite running against this commit",
  );
});

test("20: the blocker keeps do_not_merge but stops buying repair cycles", skipDist, async () => {
  const { classifyFinding, isBlockingFinding, blocksMerge } = await import("../dist/orchestrator/finding-classify.js");
  const cls = classifyFinding(TSC, { repoHasTestScript: true });
  assert.equal(cls, "env", "high severity used to keep this diff_addressable, and so blocking");
  assert.equal(isBlockingFinding(TSC, cls), false, "no cycle can install a compiler");
  assert.equal(blocksMerge(TSC, cls), true, "but 'we could not verify this' is not a clean bill of health");
});

test("20: it is one blocker, in one lifecycle state, and it is never routed", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const { mapFindingsToSubTasks } = await import("../dist/orchestrator/revise-mapping.js");

  // Raised in cycle 1 and again in cycle 2, as it would be while the binary is
  // still missing.
  const c1 = reconcileFindings({ cycle: 1, current: [{ ...TSC, file: "src/a.ts" }], prior: [], changedThisCycle: [] });
  assert.equal(c1.findings[0].lifecycleState, "environment_blocked");
  const c2 = reconcileFindings({ cycle: 2, current: [{ ...TSC, file: "src/a.ts" }], prior: c1.records, changedThisCycle: ["src/a.ts"] });
  assert.equal(c2.records.length, 1, "one row, however many cycles re-observe it");
  assert.equal(c2.records[0].state, "environment_blocked");
  assert.equal(c2.transitions.length, 0, "and it only transitions once, so the audit is not a drum roll");

  const mapped = mapFindingsToSubTasks(
    [{ seq: 1, filesLikelyTouched: ["src/a.ts"] }],
    c2.findings,
    (owned, candidate) => (owned.includes(candidate) ? candidate : undefined),
  );
  assert.deepEqual(mapped.assignments[0].targeted, [], "a worker cannot install a compiler");
  assert.deepEqual(mapped.assignments[0].broadcast, [], "and telling them about it every cycle is not context, it is noise");
});

test("25: the ship note tells a human what would clear the blocker", skipDist, async () => {
  const { detectVerificationBlocker, describeVerificationBlocker } = await import("../dist/orchestrator/verification-blocker.js");
  const note = describeVerificationBlocker(TSC, detectVerificationBlocker(TSC));
  assert.match(note, /Verification blocked/);
  assert.match(note, /not a defect in the branch/);
  assert.match(note, /not assigned to a code worker/);
  assert.match(note, /merge recommendation stays do_not_merge/);
  assert.match(note, /Action required:/);
  // And the loop actually appends it, or the operator reads "do not merge: the
  // typecheck could not run" with nothing to act on but the log.
  assert.match(S("src/orchestrator/loop.ts"), /describeVerificationBlocker\(f, b\)/);
});

test("25: do_not_merge survives while the automated loop stops", skipDist, async () => {
  const { deriveMergeRecommendation } = await import("../dist/orchestrator/merge-recommendation.js");
  const r = deriveMergeRecommendation({
    review: { verdict: "pass", findings: [TSC] },
    // What the loop counts with isBlockingFinding: nothing to do another cycle for.
    blockingFindings: 0,
    // What it counts with blocksMerge: the blocker.
    mergeBlockingFindings: 1,
    mergeBlockingTitles: [TSC.title],
    reachedCleanPass: true,
  });
  assert.equal(r.recommendation, "do_not_merge", "unverified is not verified");
});

// ---------------------------------------------------------------------------
// 21. AN UNOWNED FINDING GETS A SUB-TASK THAT MAY ACTUALLY FIX IT
// ---------------------------------------------------------------------------

const ORPHAN = {
  dimension: "security",
  severity: "high",
  title: "Connection testing is authorised with read rather than admin permission",
  detail: "The route checks `can('read')` before performing an administrative probe.",
  file: "src/app/api/integrations/connections/test/route.ts",
  relatedFiles: ["src/lib/authz/permissions.ts"],
};

test("21: an unowned finding becomes a repair group carrying every file its fix needs", skipDist, async () => {
  const { groupUnownedFindingsForRepair } = await import("../dist/orchestrator/revise-mapping.js");
  const groups = groupUnownedFindingsForRepair([ORPHAN]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files, [ORPHAN.file, "src/lib/authz/permissions.ts"]);
});

test("21: two findings that share a file become ONE repair task, not two", skipDist, async () => {
  const { groupUnownedFindingsForRepair } = await import("../dist/orchestrator/revise-mapping.js");
  const groups = groupUnownedFindingsForRepair([
    ORPHAN,
    { ...ORPHAN, title: "The OpenAPI schema rejects a field the route accepts", file: "openapi/security.yaml", relatedFiles: ["src/lib/authz/permissions.ts"] },
    { ...ORPHAN, title: "Help content has no entry for the new surface", file: "src/lib/help/help-content.ts", relatedFiles: [] },
  ]);
  assert.equal(groups.length, 2, "the two that share src/lib/authz/permissions.ts belong together");
  assert.ok(groups[0].files.includes("openapi/security.yaml"));
  assert.deepEqual(groups[1].files, ["src/lib/help/help-content.ts"]);
  // Two workers editing the same file in one cycle is a merge conflict the
  // harness would then have to explain to somebody.
});

test("21: a finding with no file stays broadcast; there is no scope to grant", skipDist, async () => {
  const { groupUnownedFindingsForRepair } = await import("../dist/orchestrator/revise-mapping.js");
  assert.deepEqual(groupUnownedFindingsForRepair([{ ...ORPHAN, file: null, relatedFiles: [] }]), []);
});

test("21: the repair brief grants the files and names the findings", skipDist, async () => {
  const { groupUnownedFindingsForRepair, renderRepairIntent, repairSubTaskTitle } = await import("../dist/orchestrator/revise-mapping.js");
  const [group] = groupUnownedFindingsForRepair([ORPHAN]);
  const intent = renderRepairIntent(group);
  assert.match(intent, /no sub-task in this plan\s+declared/, "the worker is told why this task exists");
  assert.ok(intent.includes(`  - ${ORPHAN.file}`));
  assert.ok(intent.includes("  - src/lib/authz/permissions.ts"));
  assert.ok(intent.includes(ORPHAN.title));
  assert.match(intent, /BLOCKED: <finding title>/, "and how to say it cannot be done here, rather than going quiet");
  assert.match(repairSubTaskTitle(group), /^Repair reviewer findings in src\/app\/api/);
});

test("21: the loop creates the sub-task with those files granted and a contract over them", skipDist, async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES ('S1','T','C','U1','u1','o/r','b','/w','executing', ?, ?, 50, 0, 1)`,
  ).run(now, now);
  const loop = new OrchestratorLoop({
    state, logger: QUIET, config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
  });

  const plan = {
    repo: "o/r", branch: "b", worktreePath: "/w", riskLevel: "low", reviewChecklist: [], approxCostUsd: 0,
    subTasks: [{ seq: 1, title: "Declare SAST workflow routes", intent: "i", filesLikelyTouched: ["src/lib/workflow-manifest.ts"], successCriteria: [], estimatedTokens: 10, taskMode: "mutate" }],
  };
  const seqs = loop.addFindingRepairSubTasks("S1", 2, plan, {
    assignments: [], mappingMisses: [ORPHAN], metaBroadcast: [], anyTargeted: false,
    orphanAdoptions: [], orphanRefusals: [], coFixRoutings: [],
  });

  assert.equal(seqs.length, 1);
  const created = plan.subTasks.find((s) => s.seq === seqs[0]);
  assert.deepEqual(created.filesLikelyTouched, [ORPHAN.file, "src/lib/authz/permissions.ts"]);
  assert.deepEqual(
    created.verify.map((v) => `${v.kind}:${v.path}`),
    [`file_committed:${ORPHAN.file}`, "file_committed:src/lib/authz/permissions.ts"],
    "the paths the repair was authorised for are the paths it has to land in",
  );
  assert.equal(
    plan.subTasks[0].filesLikelyTouched.length, 1,
    "and the workflow-routes task is not quietly widened to cover somebody else's finding",
  );

  const event = audits.find((a) => a.event === "loop.repair_subtask_created");
  assert.ok(event);
  assert.deepEqual(event.payload.files, created.filesLikelyTouched);
  // The plan on the row is what the progress UI reads; a sub-task that exists
  // only in memory is one nobody can see running.
  const persisted = JSON.parse(db.prepare(`SELECT lead_plan_json FROM sessions WHERE id='S1'`).get().lead_plan_json);
  assert.equal(persisted.subTasks.length, 2);
});

test("21: a second repair cycle refreshes the sub-task rather than stacking another", skipDist, async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES ('S1','T','C','U1','u1','o/r','b','/w','executing', ?, ?, 50, 0, 1)`,
  ).run(now, now);
  const loop = new OrchestratorLoop({
    state, logger: QUIET, config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
  });
  const plan = { repo: "o/r", branch: "b", worktreePath: "/w", riskLevel: "low", reviewChecklist: [], approxCostUsd: 0, subTasks: [] };
  const miss = { assignments: [], mappingMisses: [ORPHAN], metaBroadcast: [], anyTargeted: false, orphanAdoptions: [], orphanRefusals: [], coFixRoutings: [] };

  loop.addFindingRepairSubTasks("S1", 2, plan, miss);
  loop.addFindingRepairSubTasks("S1", 3, plan, miss);
  assert.equal(plan.subTasks.length, 1, "the same unfixed finding is the same sub-task");
  assert.ok(audits.some((a) => a.event === "loop.repair_subtask_refreshed"));
});

test("21: an orphan the nearest sub-task already adopted is left alone", skipDist, async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state } = await makeState();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES ('S1','T','C','U1','u1','o/r','b','/w','executing', ?, ?, 50, 0, 1)`,
  ).run(now, now);
  const loop = new OrchestratorLoop({
    state, logger: QUIET, config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
  });
  const plan = { repo: "o/r", branch: "b", worktreePath: "/w", riskLevel: "low", reviewChecklist: [], approxCostUsd: 0, subTasks: [] };
  const seqs = loop.addFindingRepairSubTasks("S1", 2, plan, {
    assignments: [], mappingMisses: [ORPHAN], metaBroadcast: [], anyTargeted: true,
    // b107 gave it to the nearest owner, who has the context. A fresh worker
    // starting cold on the same file is worse.
    orphanAdoptions: [{ finding: ORPHAN, file: ORPHAN.file, seq: 1, reason: "prefix", score: 3 }],
    orphanRefusals: [], coFixRoutings: [],
  });
  assert.deepEqual(seqs, []);
  assert.equal(plan.subTasks.length, 0);
});

// ---------------------------------------------------------------------------
// 38. THE MERGE SAFETY GATES ARE UNCHANGED
// ---------------------------------------------------------------------------

test("38: a live blocking finding still blocks the merge and still buys a cycle", skipDist, async () => {
  const { classifyFinding, isBlockingFinding, blocksMerge } = await import("../dist/orchestrator/finding-classify.js");
  const real = {
    dimension: "security", severity: "high",
    title: "Connection testing is authorised with read rather than admin permission",
    detail: "The route checks can('read') before performing an administrative probe.",
    file: "src/app/api/integrations/connections/test/route.ts",
  };
  const cls = classifyFinding(real, { repoHasTestScript: true });
  assert.equal(cls, "diff_addressable");
  assert.equal(isBlockingFinding(real, cls), true);
  assert.equal(blocksMerge(real, cls), true);
});

test("38: block is never downgraded, and an unreviewed session never merges", skipDist, async () => {
  const { deriveMergeRecommendation } = await import("../dist/orchestrator/merge-recommendation.js");
  assert.equal(
    deriveMergeRecommendation({ review: { verdict: "block", findings: [] }, blockingFindings: 0, reachedCleanPass: true }).recommendation,
    "do_not_merge",
  );
  assert.equal(
    deriveMergeRecommendation({ review: undefined, reachedCleanPass: true }).recommendation,
    "do_not_merge",
  );
  assert.equal(
    deriveMergeRecommendation({ review: { verdict: "pass", findings: [] }, blockingFindings: 0, mergeBlockingFindings: 0, reachedCleanPass: false }).recommendation,
    "do_not_merge",
    "shipping at the ceiling is not a sign-off",
  );
});

test("38: the repair sub-task can be turned off, and then nothing changes", skipDist, async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { state } = await makeState();
  const base = makeConfig();
  const loop = new OrchestratorLoop({
    state, logger: QUIET,
    config: { ...base, loop: { ...base.loop, finding_repair_subtasks_enabled: false } },
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
  });
  const plan = { repo: "o/r", branch: "b", worktreePath: "/w", riskLevel: "low", reviewChecklist: [], approxCostUsd: 0, subTasks: [] };
  assert.deepEqual(
    loop.addFindingRepairSubTasks("S1", 2, plan, {
      assignments: [], mappingMisses: [ORPHAN], metaBroadcast: [], anyTargeted: false,
      orphanAdoptions: [], orphanRefusals: [], coFixRoutings: [],
    }),
    [],
  );
  assert.equal(plan.subTasks.length, 0);
});

test("the new option is declared everywhere an option has to be declared", () => {
  assert.match(S("src/config.ts"), /finding_repair_subtasks_enabled\?: boolean;/);
  assert.match(S("src/config.ts"), /finding_repair_subtasks_enabled: true,/);
  assert.match(S("src/config.schema.json"), /"finding_repair_subtasks_enabled"/);
  assert.match(S("openclaw.plugin.json"), /"finding_repair_subtasks_enabled"/);
  assert.match(S("docs/CONFIGURATION.md"), /finding_repair_subtasks_enabled/);
});
