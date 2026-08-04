#!/usr/bin/env node
// beta.102 — VACUITY CHECK for the b101/b102 safety tests.
//
// A passing test suite proves nothing unless the tests would FAIL when the
// behaviour they describe is removed. That is not a theoretical concern here:
// the b100 defect survived because three comments and a CHANGELOG entry all
// asserted a behaviour that no test executed. Tests that assert the same thing
// but pass regardless would be the identical failure in a new costume.
//
// So: for each safety mechanism, break it in the BUILT output, re-run the tests
// that are supposed to catch it, and require them to fail. If they still pass,
// the test is decorative and this script fails the build.
//
// Two properties keep this honest over time:
//   1. A mutation whose anchor text is no longer present is a HARD FAILURE, not
//      a skip. A refactor that renames the code silently disarms the check
//      otherwise -- exactly the rot this exists to prevent.
//   2. Files are restored from an in-memory copy in a finally block, so an
//      interrupted run cannot leave a sabotaged dist/ behind.
//
// Run: node scripts/mutation-check.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each mutation names a safety mechanism, the exact built code implementing it,
 * and the test files that MUST fail once it is gone.
 */
const MUTATIONS = [
  {
    name: "preserveLocalBranch (b101): resume keeps the branch at its own tip",
    file: "dist/adapters/git-worktree.js",
    find: "if (ctx.preserveLocalBranch && (await this.localBranchExists(bare, ctx.sessionBranch))) {",
    replace: "if (false) {",
    tests: ["tests/beta101-branch-preservation.test.mjs", "tests/beta102-clarification-resume-integration.test.mjs"],
  },
  {
    name: "rescueBranchIfAhead (b101): a destructive reset parks the doomed tip",
    file: "dist/adapters/git-worktree.js",
    find: "async rescueBranchIfAhead(bare, branch, startPoint) {",
    replace: "async rescueBranchIfAhead(bare, branch, startPoint) { return;",
    tests: ["tests/beta101-branch-preservation.test.mjs"],
  },
  {
    name: "ledger reachability guard (b101): a branch that lost work cannot ship",
    file: "dist/orchestrator/loop.js",
    find: "if (this.deps.config.loop.ledger_reachability_guard_enabled !== false && this.deps.unreachableCommits) {",
    replace: "if (false) {",
    tests: ["tests/beta102-clarification-resume-integration.test.mjs"],
  },
  {
    name: "plan path writeback (b103): a proven correction reaches the plan",
    file: "dist/orchestrator/plan-path-writeback.js",
    // Neutered to the identity function: corrections are computed and then
    // thrown away, which is precisely the pre-b103 behaviour that let cycle 3
    // skip the sub-task owning both of its findings.
    find: "export function applyPathCorrections(files, corrections) {",
    replace: "export function applyPathCorrections(files, corrections) { return { files: files ?? [], applied: [] };",
    tests: ["tests/beta103-plan-path-writeback.test.mjs"],
  },
  {
    name: "CI none grace (b103): a not-yet-registered check is not read as no-CI",
    file: "dist/orchestrator/loop.js",
    find: "const graceActive = graceMs > 0;",
    replace: "const graceActive = !!input.workflowAuthoredThisSession && graceMs > 0;",
    tests: ["tests/beta81-ci-shift.test.mjs"],
  },
  {
    name: "full commit-tip recording (b103): a two-commit turn records both",
    file: "dist/orchestrator/sonnet-worker.js",
    find: "if (headBefore && headBefore !== baseSha)",
    replace: "if (false && headBefore !== baseSha)",
    tests: ["tests/beta103-plan-path-writeback.test.mjs"],
  },
  {
    name: "lead repo scout (b104): the report reaches the planning call",
    file: "dist/orchestrator/fable5-lead.js",
    // Neutered to the pre-b104 blind plan: the scout still runs and still
    // costs a turn, but nothing it found reaches the lead. This is the exact
    // shape of the b102 defect -- seven fictional paths in one plan -- so the
    // b104 tests must notice.
    find: "brief.repoScoutReport = report;",
    replace: "/* mutated */;",
    tests: ["tests/beta104-lead-repo-scout.test.mjs"],
  },
  {
    name: "scout read-only (b104): the scout cannot write to the worktree",
    file: "dist/orchestrator/lead-scout.js",
    find: 'export const SCOUT_ALLOWED_TOOLS = ["Read", "Glob", "Grep"];',
    replace: 'export const SCOUT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "Bash"];',
    tests: ["tests/beta104-lead-repo-scout.test.mjs"],
  },
  {
    name: "scout failure is non-fatal (b104): a throw plans blind, it does not kill the run",
    file: "dist/orchestrator/fable5-lead.js",
    // Re-throwing turns a best-effort investigation into a new way to lose a
    // whole session -- the b98 failure class, which is why every path here
    // degrades instead of failing.
    find: 'skippedReason: "error",',
    replace: 'skippedReason: (() => { throw err; })(),',
    tests: ["tests/beta104-lead-repo-scout.test.mjs"],
  },
  {
    name: "full scout report (b104): a multi-message report is not cut to its last chunk",
    file: "dist/adapters/claude-sdk.js",
    find: "allText: opts.accumulateAllText ? allText.join(\"\\n\\n\") : undefined,",
    replace: "allText: undefined,",
    tests: ["tests/beta104-lead-repo-scout.test.mjs"],
  },
];

function runTests(files) {
  const r = spawnSync(process.execPath, ["--test", ...files], { cwd: root, encoding: "utf8" });
  return r.status === 0;
}

let failures = 0;
for (const m of MUTATIONS) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");

  if (!original.includes(m.find)) {
    console.error(`FAIL  ${m.name}`);
    console.error(`      anchor not found in ${m.file}. The code was renamed or removed, so this`);
    console.error(`      mutation no longer tests anything. Update scripts/mutation-check.mjs.`);
    console.error(`      looking for: ${m.find}`);
    failures++;
    continue;
  }

  try {
    writeFileSync(path, original.replace(m.find, m.replace), "utf8");
    const stillPasses = runTests(m.tests);
    if (stillPasses) {
      console.error(`FAIL  ${m.name}`);
      console.error(`      Broke it in ${m.file} and ${m.tests.join(", ")} STILL PASSED.`);
      console.error(`      Those tests do not actually verify this mechanism.`);
      failures++;
    } else {
      console.log(`ok    ${m.name}`);
    }
  } finally {
    writeFileSync(path, original, "utf8");
  }
}

if (failures > 0) {
  console.error(`\n${failures} mutation(s) survived. The suite is not protecting these mechanisms.`);
  process.exit(1);
}
console.log(`\nAll ${MUTATIONS.length} mutations were caught.`);
