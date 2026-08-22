/**
 * beta.111 regression suite.
 *
 * Two defects, both first seen on ProjectThanos PR #932.
 *
 * 1. A contract mismatch paused the run for a human on evidence the harness
 *    already held. The b109 run's sub-task 2 and the b110 run's sub-task 5
 *    were the same shape: a conditionally-worded finding, a worker that read
 *    the code and found the condition already handled, a commit carrying only
 *    the new test. The b110 one idled forty minutes at $2.99 waiting for
 *    someone to type "skip", while `route.ts` had been changed for that exact
 *    finding by an earlier commit on the same branch.
 *
 * 2. The branch head does not typecheck and three revise runs did not notice,
 *    because the adversary reads the diff and not the compiler.
 *
 * Tests run against dist/ so they also cover the build.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  missingFromCommit,
  autoResolveContract,
  buildContractClarification,
} from "../dist/orchestrator/contract-clarify.js";
import {
  parseTscErrors,
  errorsInChangedFiles,
  buildTypecheckFinding,
} from "../dist/orchestrator/typecheck-gate.js";
import { isBlockingFinding, classifyFinding } from "../dist/orchestrator/finding-classify.js";
import { deriveMergeRecommendation } from "../dist/orchestrator/merge-recommendation.js";
import { parseHarnessConfig } from "../dist/config.js";
import { readFileSync } from "node:fs";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const MIN = { slack: { authorised_users: ["U1"] }, repos: { allowed: ["a/*"], default_base_branch: "main" } };

// The real b110 sub-task 5, as the ledger recorded it.
const SUBTASK_5 = {
  seq: 5,
  title: "Gate `to` end-of-day extension + tests",
  commitSha: "eff8908c1d2e3f405162738495a6b7c8d9e0f1a2",
  expected: [
    "src/app/api/grc/continuity-exercises/route.ts",
    "src/app/api/grc/__tests__/continuity-exercises.test.ts",
  ],
  actual: ["src/app/api/grc/__tests__/continuity-exercises.test.ts"],
  statedReason:
    "the route's gated +24h-1ms extension already exists from a prior cycle (f2104246); the regex " +
    "/^\\d{4}-\\d{2}-\\d{2}$/ already restricts it to date-only input",
};

// ---------------------------------------------------------------------------
// 1. auto-resolution
// ---------------------------------------------------------------------------

test("beta111: the b110 pause is resolved from branch history instead of asking", () => {
  const res = autoResolveContract({
    ...SUBTASK_5,
    // An earlier commit on the branch (f2104246) changed the route.
    changedOnBranch: [
      "src/app/api/grc/continuity-exercises/route.ts",
      "src/app/api/grc/__tests__/continuity-exercises.test.ts",
      "prisma/schema.prisma",
    ],
  });
  assert.equal(res.resolved, true, "should not have needed a human");
  assert.deepEqual(res.coveredEarlier, ["src/app/api/grc/continuity-exercises/route.ts"]);
});

test("beta111: still asks when an expected path was never touched on the branch", () => {
  const res = autoResolveContract({
    ...SUBTASK_5,
    changedOnBranch: ["src/app/api/grc/__tests__/continuity-exercises.test.ts"],
  });
  assert.equal(res.resolved, false, "no evidence the route was ever changed -- must ask");
  assert.deepEqual(res.coveredEarlier, []);
  assert.match(res.reason, /never changed on this branch/);
});

test("beta111: partial coverage does not auto-resolve", () => {
  const res = autoResolveContract({
    seq: 3,
    title: "two files",
    commitSha: "abc1234",
    expected: ["src/a.ts", "src/b.ts", "src/c.test.ts"],
    actual: ["src/c.test.ts"],
    changedOnBranch: ["src/a.ts", "src/c.test.ts"],
  });
  assert.equal(res.resolved, false, "b.ts was never touched; one missing path is enough to ask");
  assert.deepEqual(res.coveredEarlier, ["src/a.ts"], "partial evidence is still reported");
});

test("beta111: no branch history means no auto-resolution (never guess a green)", () => {
  for (const changedOnBranch of [[], undefined]) {
    const res = autoResolveContract({ ...SUBTASK_5, changedOnBranch });
    assert.equal(res.resolved, false);
    // The reason has to say the history was MISSING, not that the route was
    // never touched -- "we could not look" and "we looked and it isn't there"
    // are different states, and only the second is evidence about the code.
    assert.match(res.reason, /no branch history/);
  }
});

test("beta111: a commit satisfying its whole contract is not a mismatch", () => {
  const m = { ...SUBTASK_5, actual: SUBTASK_5.expected, changedOnBranch: SUBTASK_5.expected };
  assert.deepEqual(missingFromCommit(m), []);
  assert.equal(autoResolveContract(m).resolved, false);
});

test("beta111: auto-resolution defaults on and is switchable off", () => {
  assert.equal(parseHarnessConfig(MIN).loop.auto_resolve_satisfied_contract, true);
  assert.equal(
    parseHarnessConfig({ ...MIN, loop: { auto_resolve_satisfied_contract: false } }).loop
      .auto_resolve_satisfied_contract,
    false,
  );
});

// ---------------------------------------------------------------------------
// 2. the question a human reads
// ---------------------------------------------------------------------------

test("beta111: the clarification drops the jargon that made b110 unanswerable", () => {
  const q = buildContractClarification({ ...SUBTASK_5, changedOnBranch: [] });
  for (const jargon of [
    "do not match its contract",
    "the plan's path wrong",
    "worker's placement",
    "path convention this repo should use",
    "re-derived",
  ]) {
    assert.ok(!q.includes(jargon), `should not say "${jargon}"`);
  }
  assert.match(q, /did not change\s+everything the plan expected/);
  assert.match(q, /How should I proceed\?/);
});

test("beta111: every answer the resume path accepts is still offered", () => {
  const q = buildContractClarification({ ...SUBTASK_5, changedOnBranch: [] });
  assert.match(q, /\bskip\b/);
  assert.match(q, /\babort\b/);
  assert.match(q, /a file path/);
  // beta.122: `accept` is a fourth answer the resume path now handles, so it
  // has to be offered too -- an operator cannot choose what they are not shown.
  assert.match(q, /\baccept\b/);
});

test("beta111: a recommendation is made only on evidence, and carries it", () => {
  const withEvidence = buildContractClarification({
    ...SUBTASK_5,
    changedOnBranch: ["src/app/api/grc/continuity-exercises/route.ts"],
  });
  // beta.122: the recommendation moved from "skip" to "accept". The evidence
  // is that an earlier commit already made the change, which argues for
  // KEEPING the work -- while "skip" now writes "never do this" into the brief.
  // Recommending it here was recommending the opposite of what the evidence
  // supports, which is how the b121 migration sub-task got dropped.
  assert.match(withEvidence, /Suggestion: "accept" looks right/);
  assert.ok(
    !/Suggestion: "skip"/.test(withEvidence),
    "must not recommend the drop-it answer on evidence that the work is already present",
  );
  assert.match(withEvidence, /already changed by an earlier commit/);
  assert.match(withEvidence, /route\.ts/);

  const without = buildContractClarification({ ...SUBTASK_5, changedOnBranch: [] });
  assert.ok(!without.includes("Suggestion:"), "no evidence, no recommendation");
});

test("beta111: the worker's reason and the raw contract detail both survive", () => {
  const q = buildContractClarification({ ...SUBTASK_5, changedOnBranch: [] });
  assert.match(q, /f2104246/, "the worker's explanation is quoted");
  assert.ok(
    q.indexOf("How should I proceed?") < q.indexOf("Detail -- contract expected:"),
    "options come before the technical detail",
  );
  assert.match(q, /continuity-exercises\/route\.ts/);
});

// ---------------------------------------------------------------------------
// 3. typecheck gate
// ---------------------------------------------------------------------------

// The error that survived three revise runs on PR #932.
const THANOS_TSC = `
> thanos@0.1.0 typecheck
> tsc --noEmit

src/app/api/grc/continuity-exercises/[id]/route.ts(124,14): error TS2551: Property 'ownerUserId' does not exist on type 'ContinuityExerciseUpdateInput'. Did you mean 'ownerUser'?
src/legacy/unrelated.ts(9,3): error TS2304: Cannot find name 'foo'.
`;

test("beta111: tsc output parses to file, position and code", () => {
  const errs = parseTscErrors(THANOS_TSC);
  assert.equal(errs.length, 2);
  assert.deepEqual(
    { ...errs[0] },
    {
      file: "src/app/api/grc/continuity-exercises/[id]/route.ts",
      line: 124,
      column: 14,
      code: "TS2551",
      message:
        "Property 'ownerUserId' does not exist on type 'ContinuityExerciseUpdateInput'. Did you mean 'ownerUser'?",
    },
  );
});

test("beta111: parsing survives colour and duplicate lines, ignores non-errors", () => {
  const noisy =
    "\u001B[96msrc/a.ts\u001B[0m(1,2): error TS1000: boom.\n" +
    "src/a.ts(1,2): error TS1000: boom.\n" +
    "src/a.ts(3,4): warning TS9999: not an error.\n" +
    "Found 1 error.\n";
  const errs = parseTscErrors(noisy);
  assert.equal(errs.length, 1, "deduped, and a warning is not an error");
  assert.equal(errs[0].file, "src/a.ts");
});

test("beta111: only errors in files this branch changed are reported", () => {
  const errs = parseTscErrors(THANOS_TSC);
  const mine = errorsInChangedFiles(errs, [
    "src/app/api/grc/continuity-exercises/[id]/route.ts",
    "prisma/schema.prisma",
  ]);
  assert.equal(mine.length, 1, "the untouched legacy file's error is pre-existing, not ours");
  assert.equal(mine[0].code, "TS2551");
});

test("beta111: a branch touching nothing relevant raises nothing", () => {
  assert.deepEqual(errorsInChangedFiles(parseTscErrors(THANOS_TSC), ["README.md"]), []);
  assert.deepEqual(errorsInChangedFiles([], ["src/a.ts"]), []);
});

test("beta111: the typecheck finding blocks both the cycle and the merge", () => {
  const finding = buildTypecheckFinding(parseTscErrors(THANOS_TSC).slice(0, 1), "typecheck");
  assert.equal(finding.severity, "high");
  assert.equal(classifyFinding(finding), "diff_addressable", "a type error is fixable in the diff");
  assert.ok(
    isBlockingFinding(finding, classifyFinding(finding)),
    "must be blocking, or the b109 no-blocking-findings gate ships a branch that will not compile",
  );

  const rec = deriveMergeRecommendation({
    review: { verdict: "revise", summary: "", findings: [finding] },
    blockingFindings: 1,
    ciStatus: "success",
  });
  assert.equal(rec.recommendation, "do_not_merge");
});

test("beta111: the finding names the error and bounds the dump", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    file: `src/f${i}.ts`,
    line: i + 1,
    column: 1,
    code: "TS2551",
    message: "nope",
  }));
  const finding = buildTypecheckFinding(many, "typecheck");
  assert.match(finding.title, /25 error\(s\)/);
  assert.match(finding.detail, /and 15 more/);
  assert.ok(finding.detail.split("\n").length < 25, "bounded, so it cannot blow the review prompt");
  assert.match(finding.detail, /not pre-existing breakage/);
});

test("beta111: the gate defaults on and is switchable off", () => {
  assert.equal(parseHarnessConfig(MIN).verify.typecheck_gate, true);
  assert.equal(
    parseHarnessConfig({ ...MIN, verify: { typecheck_gate: false } }).verify.typecheck_gate,
    false,
  );
});

test("beta111: both keys are declared where operators look for them", () => {
  const schema = readFileSync("src/config.schema.json", "utf8");
  const plugin = readFileSync("openclaw.plugin.json", "utf8");
  assert.match(schema, /auto_resolve_satisfied_contract/);
  assert.match(plugin, /auto_resolve_satisfied_contract/);
  assert.match(plugin, /typecheck_gate/);
});

test("beta111: pluginVersion and package.json agree at >= beta.111", () => {
  const betaNum = betaOrdinal;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
  assert.ok(betaNum(pkg) >= 111, `expected >= beta.111, got ${pkg}`);
  assert.ok(readFileSync("src/version.ts", "utf8").includes(pkg));
});
