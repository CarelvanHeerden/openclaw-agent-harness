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
const FILTER = process.argv[2] ?? "";
let ran = 0;

const MUTATIONS = [
  {
    name: "preserveLocalBranch (b101): resume keeps the branch at its own tip",
    file: "dist/adapters/git-worktree.js",
    // b105 split the condition into named locals for the decision audit.
    find: "if (preserveRequested && localExists) {",
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
    // b105 extracted the guard into a shared method with two call sites; the
    // probe dependency is what makes it able to answer at all.
    find: "if (!this.deps.unreachableCommits)",
    replace: "if (true)",
    tests: [
      "tests/beta102-clarification-resume-integration.test.mjs",
      "tests/beta105-resume-integrity-and-rescue.test.mjs",
    ],
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
  {
    name: "resume ledger guard (b105): a resume that lost commits stops before the first worker turn",
    file: "dist/orchestrator/loop.js",
    // Restores the b101/b103 behaviour exactly: the guard exists, but only
    // review reaches it, so a run that stalls first never checks itself.
    find: 'this.checkLedgerReachability(sessionId, plan.worktreePath, 1, "resume")',
    replace: '({ failed: false, unreachable: [], headSha: "", detail: "" })',
    tests: ["tests/beta105-resume-integrity-and-rescue.test.mjs"],
  },
  {
    name: "branch allocation decision (b105): the checkout path taken is reported",
    file: "dist/adapters/git-worktree.js",
    find: "ctx.onBranchDecision?.({",
    replace: "((() => {})())?.({",
    tests: ["tests/beta105-resume-integrity-and-rescue.test.mjs"],
  },
  {
    name: "basename rescue (b105): a single-file basename mismatch resolves itself",
    file: "dist/orchestrator/basename-rescue.js",
    find: "export function proposeBasenameRescue(input) {",
    replace: "export function proposeBasenameRescue(input) { return undefined;",
    tests: ["tests/beta105-resume-integrity-and-rescue.test.mjs"],
  },
  {
    name: "basename rescue guards (b105): a multi-file or fictional-target mismatch still escalates",
    file: "dist/orchestrator/basename-rescue.js",
    // Strips every safety condition, keeping only the basename anchor. If the
    // suite still passes, the guards are decoration.
    find: "if (expected.length !== 1 || actual.length !== 1)",
    replace: "if (expected.length < 1 || actual.length < 1)",
    tests: ["tests/beta105-resume-integrity-and-rescue.test.mjs"],
  },
  {
    name: "file_written rename fallback (b105): a git mv is authorship, not staleness",
    file: "dist/orchestrator/verify.js",
    find: "if (!passed && r.exists && r.stale && ctx.acceptRenameAsWrite && probes.filePathIntroducedSince)",
    replace: "if (false)",
    tests: ["tests/beta105-resume-integrity-and-rescue.test.mjs"],
  },
  {
    name: "rename fallback stays scoped (b105): a merely pre-existing file still fails",
    file: "dist/orchestrator/verify.js",
    // Accept staleness outright instead of asking git. If nothing fails, the
    // fallback is a blanket relaxation rather than an authorship check.
    find: "const introduced = await probes.filePathIntroducedSince(v.path, ctx.baseSha);",
    replace: 'const introduced = { introduced: true, changeType: "renamed", detail: "" };',
    tests: ["tests/beta105-resume-integrity-and-rescue.test.mjs"],
  },
  {
    name: "pathIntroducedSince (b105): only additions and renames count",
    file: "dist/adapters/git-worktree.js",
    find: '"--diff-filter=AR"',
    replace: '"--diff-filter=AMR"',
    tests: ["tests/beta105-resume-integrity-and-rescue.test.mjs"],
  },
  {
    name: "lead budget covers the scout (b106): planning keeps its own full ceiling",
    file: "dist/orchestrator/loop.js",
    // Restores b104's nesting exactly: one budget for two turns, which is what
    // killed the b105 smoke at 900s with the lead mid-plan.
    find: "this.deps.config.loop.lead_timeout_seconds + scoutBudget",
    replace: "this.deps.config.loop.lead_timeout_seconds",
    tests: ["tests/beta106-lead-budget-and-scout-bounds.test.mjs"],
  },
  {
    name: "timeout errors name their own knob (b106): a lead timeout is not reported as a worker one",
    file: "dist/orchestrator/loop.js",
    find: 'super(`worker exceeded ${limit} (${seconds}s) with no result`);',
    replace: 'super(`worker exceeded worker_timeout_seconds (${seconds}s) with no result`);',
    tests: ["tests/beta106-lead-budget-and-scout-bounds.test.mjs"],
  },
  {
    name: "scout turn cap (b106): the wall clock alone cannot bound a tool call in flight",
    file: "dist/adapters/claude-sdk.js",
    find: "...(params.maxTurns && params.maxTurns > 0 ? { maxTurns: params.maxTurns } : {}),",
    replace: "...({}),",
    tests: ["tests/beta106-lead-budget-and-scout-bounds.test.mjs"],
  },
  {
    name: "scout hard stop (b106): the harness stops waiting and keeps the partial report",
    file: "dist/adapters/claude-sdk.js",
    find: "const hardStopMs = params.timeoutSeconds * 1000 + 30_000;",
    replace: "const hardStopMs = 24 * 60 * 60 * 1000;",
    tests: ["tests/beta106-lead-budget-and-scout-bounds.test.mjs"],
  },
  {
    name: "streamed scout text (b106): a caller that gives up can still salvage prose",
    file: "dist/adapters/claude-sdk.js",
    find: "opts.onText?.(text);",
    replace: "void text;",
    tests: ["tests/beta106-lead-budget-and-scout-bounds.test.mjs"],
  },
  {
    name: "scout budget prompt (b106): the model is told what it may spend",
    file: "dist/orchestrator/lead-scout.js",
    find: '"## Your budget",',
    replace: '"## Notes",',
    tests: ["tests/beta106-lead-budget-and-scout-bounds.test.mjs"],
  },
  {
    // b106 truncated a real report and the trail said nothing; head-only
    // truncation is what removed the traps section.
    name: "middle-out truncation (b107): the scout's traps section survives the ceiling",
    file: "dist/orchestrator/lead-scout.js",
    find: "const tail = Math.floor(maxChars * SCOUT_REPORT_TAIL_SHARE);",
    replace: "const tail = 0;",
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "truncation is reported (b107): reportChars 20049 must not need decoding",
    file: "dist/orchestrator/fable5-lead.js",
    find: "truncated: bounds.truncated ? true : undefined,",
    replace: "truncated: undefined,",
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    // The b106 defect exactly: the live-runner question asked too late, after
    // the breaker has already counted an attempt that never happened.
    name: "recovery skips live runners (b107): a healthy run is not counted toward a hard stop",
    file: "dist/state/recovery.js",
    find: "if (opts.isLiveRunner?.(s.id)) {",
    replace: "if (false) {",
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "orphan adoption (b107): a finding nobody owns still gets an owner",
    file: "dist/orchestrator/revise-mapping.js",
    find: "const orphanAdoptions = opts.adoptOrphans",
    replace: "const orphanAdoptions = false",
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "adoption prefers the named sub-task (b107): not an arbitrary prefix tie",
    file: "dist/orchestrator/revise-mapping.js",
    // beta.118 rewrote this expression to add the depth floor; the mechanism
    // under test is unchanged -- a path the finding NAMES must outrank mere
    // directory adjacency.
    find: "const score = mentioned ? 1000 + depth : depth >= MIN_NEAREST_PATH_DEPTH ? depth : 0;",
    replace: "const score = depth >= MIN_NEAREST_PATH_DEPTH ? depth : 0;",
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "adoption stays conservative (b107): an unrelated finding gets no arbitrary owner",
    file: "dist/orchestrator/revise-mapping.js",
    find: "if (score <= 0)\n                continue;",
    replace: "if (false)\n                continue;",
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "scratch-file sweep (b107): the file the sandbox will not let a worker rm",
    file: "dist/adapters/git-worktree.js",
    find: "await this.sweepCommitMsgScratch(worktreePath);",
    replace: "void worktreePath;",
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "sweep reaches committed scratch files (b107): the PR diff, not just the worktree",
    file: "dist/adapters/git-worktree.js",
    find: 'const tracked = await this.run(["-C", worktreePath, "ls-files"]);',
    replace: 'const tracked = "";',
    tests: ["tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "adoption skips info (b108): the adversary's 'verified resolved, no action' entries",
    file: "dist/orchestrator/revise-mapping.js",
    find: 'if (!ADOPTABLE_SEVERITIES.has((f.severity ?? "").toLowerCase()))',
    replace: 'if (false && !ADOPTABLE_SEVERITIES.has((f.severity ?? "").toLowerCase()))',
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "adoption cap (b108): 21 mapping misses must not become 21 adoptions",
    file: "dist/orchestrator/revise-mapping.js",
    find: "if (adoptions.length >= (limits.maxPerCycle ?? Infinity))",
    replace: "if (false)",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "the cap sheds the LEAST important (b108): severity ordering before the cap",
    file: "dist/orchestrator/revise-mapping.js",
    find: "const ordered = [...misses].sort((a, b) => severityRank(b) - severityRank(a));",
    replace: "const ordered = [...misses];",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "the loop passes the cap (b108): a default of Infinity would be uncapped",
    file: "dist/orchestrator/loop.js",
    find: "maxAdoptionsPerCycle: this.deps.config.loop.revise_max_adoptions_per_cycle ?? 3,",
    replace: "maxAdoptionsPerCycle: undefined,",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "session-scoped branches (b108): two threads must not collide on one PR",
    file: "dist/orchestrator/fable5-lead.js",
    find: "raw.branch = sessionScopedBranch(raw.branch, deps.sessionId);",
    replace: "raw.branch = raw.branch;",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "branch suffix is idempotent (b108): a clarification re-plan must not stack it",
    file: "dist/orchestrator/fable5-lead.js",
    find: "if (b.endsWith(`-${suffix}`))\n        return b;",
    replace: "if (false)\n        return b;",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "live-branch refusal (b108): a second session sharing a branch shares its PR",
    file: "dist/adapters/git-worktree.js",
    find: "if (holder && holder !== ctx.sessionId) {",
    replace: "if (false) {",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "no-change early exit (b108): re-reviewing an unchanged diff is pure cost",
    file: "dist/orchestrator/loop.js",
    find: "if (tipNow && tipNow === cycleBaseSha) {",
    replace: "if (false) {",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "phase timing (b108): the unmeasured third of every run",
    file: "dist/orchestrator/loop.js",
    find: '"loop.phase_timing"',
    replace: '"loop.phase_timing_disabled"',
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "terminal merge advice (b108): 'Done' alone got do_not_merge PRs merged",
    file: "dist/orchestrator/progress.js",
    find: "return `Done${pr}${cost}.${mergeAdvice(input.mergeRecommendation, input.mergeRecommendationReason)}`;",
    replace: "return `Done${pr}${cost}.`;",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "the revise hint (b108): knowing a PR is bad is not knowing what to do",
    file: "dist/orchestrator/progress.js",
    find: 'const next = /harness_revise/i.test(reason ?? "") ? " Ask me to revise it to continue." : "";',
    replace: 'const next = "";',
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "the work log (b108): phase tells you it is alive, not that it is right",
    file: "dist/orchestrator/progress.js",
    find: "worklog: renderWorklog(stRows, all.length),",
    replace: "worklog: [],",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "help stays in sync (b108): the README drifted to 9 of 19 tools unnoticed",
    file: "dist/tools/help-content.js",
    find: '"harness_revise",',
    replace: "",
    tests: ["tests/beta108-bounds-isolation-and-surface.test.mjs"],
  },
  {
    name: "the merge gate (b109): a revise carrying only lows is mergeable",
    file: "dist/orchestrator/merge-recommendation.js",
    find: "if (blockingCount === 0) {",
    replace: "if (false) {",
    tests: ["tests/beta109-blocking-severity-gate.test.mjs"],
  },
  {
    name: "block is never overridable (b109): an explicit withhold is not a severity tally",
    file: "dist/orchestrator/merge-recommendation.js",
    find: 'if (review.verdict === "block") {',
    replace: "if (false) {",
    tests: ["tests/beta109-blocking-severity-gate.test.mjs"],
  },
  {
    name: "the cycling gate (b109): three cycles of nits on PR #932 bought nothing",
    file: "dist/orchestrator/loop.js",
    find: "input.blockingFindings === 0) {",
    replace: "false) {",
    tests: ["tests/beta109-blocking-severity-gate.test.mjs"],
  },
  {
    name: "the gate respects medium (b109): shipping open mediums would be a real loosening",
    file: "dist/orchestrator/finding-classify.js",
    find: 'return f.severity === "medium" || f.severity === "high" || f.severity === "critical";',
    replace: 'return f.severity === "high" || f.severity === "critical";',
    tests: ["tests/beta109-blocking-severity-gate.test.mjs"],
  },
  {
    name: "the loop counts what it gates on (b109): an uncounted review never ships early",
    file: "dist/orchestrator/loop.js",
    find: "blockingFindings: this.countBlockingFindings(lastReview.findings),",
    replace: "blockingFindings: undefined,",
    tests: ["tests/beta109-blocking-severity-gate.test.mjs"],
  },
  {
    name: "harness excludes (b110): the npm cache that killed session 9217236c",
    file: "dist/adapters/git-worktree.js",
    find: "await this.applyHarnessExcludes(worktreePath);",
    replace: "",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "the .npm-cache-tmp pattern (b110): the exact tree that killed session 9217236c",
    file: "dist/adapters/git-worktree.js",
    find: 'HARNESS_EXCLUDE_PATTERNS = [\n    ".npm-cache-tmp/",',
    replace: 'HARNESS_EXCLUDE_PATTERNS = [\n    "__never_matches__/",',
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "linked-worktree git dir (b110): every harness commit happens in one",
    file: "dist/adapters/git-worktree.js",
    find: '["-C", worktreePath, "rev-parse", "--git-path", "info/exclude"]',
    replace: '["-C", worktreePath, "rev-parse", "--git-common-dir"]',
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "the blowout tripwire (b110): 12,423 stray files must not reach the adversary",
    file: "dist/orchestrator/loop.js",
    find: "if (blowoutAt > 0 && outOfScope.length >= blowoutAt) {",
    replace: "if (false) {",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "the blowout threshold (b110): ordinary scope creep must stay a finding",
    file: "dist/orchestrator/loop.js",
    find: "const blowoutAt = this.deps.config.loop.scope_blowout_file_threshold ?? 500;",
    replace: "const blowoutAt = 1;",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "review timing on failure (b110): the 15 lost minutes had no number against them",
    file: "dist/orchestrator/loop.js",
    find: 'this.emitPhaseTiming(sessionId, "review", cycle, reviewStart, {\n                    verdict: null,',
    replace: 'this.noSuchTiming(sessionId, "review", cycle, reviewStart, {\n                    verdict: null,',
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "exclude idempotence (b110): a re-append grows info/exclude on every commit",
    file: "dist/adapters/git-worktree.js",
    find: "const missing = patterns.filter((x) => !have.has(x));",
    replace: "const missing = [...patterns];",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "runaway guard (b110): the cache dir name was a model's free choice",
    file: "dist/adapters/git-worktree.js",
    find: "await this.excludeRunawayUntracked(worktreePath);",
    replace: "",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "runaway threshold (b110): a 126-file OKF regen is real work",
    file: "dist/adapters/git-worktree.js",
    find: ".filter(([, n]) => n >= threshold)",
    replace: ".filter(([, n]) => n >= 1)",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "runaway counts UNTRACKED only (b110): regeneration modifies tracked files",
    file: "dist/adapters/git-worktree.js",
    find: 'if (!line.startsWith("??"))',
    replace: "if (!line.trim())",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "harness commits never sign (b110): a bot identity has no key",
    file: "dist/adapters/git-worktree.js",
    find: '"-c", "commit.gpgsign=false",',
    replace: "",
    tests: ["tests/beta110-scope-blowout.test.mjs"],
  },
  {
    name: "auto-resolve needs FULL coverage (b111): one untouched path still asks a human",
    file: "dist/orchestrator/contract-clarify.js",
    find: "if (covered.length !== missing.length)",
    replace: "if (covered.length === missing.length + 1)",
    tests: ["tests/beta111-clarify-and-typecheck.test.mjs"],
  },
  {
    name: "auto-resolve needs branch history (b111): empty history must never read as a green",
    file: "dist/orchestrator/contract-clarify.js",
    find: "if (changed.length === 0)",
    replace: "if (changed.length === -1)",
    tests: ["tests/beta111-clarify-and-typecheck.test.mjs"],
  },
  {
    name: "the recommendation is evidence-gated (b111): no branch evidence, no suggestion",
    file: "dist/orchestrator/contract-clarify.js",
    find: "if (auto.coveredEarlier.length > 0)",
    replace: "if (auto.coveredEarlier.length >= 0)",
    tests: ["tests/beta111-clarify-and-typecheck.test.mjs"],
  },
  {
    name: "typecheck errors are scoped to changed files (b111): otherwise pre-existing breakage blocks every run",
    file: "dist/orchestrator/typecheck-gate.js",
    find: "return errors.filter((e) => changedFiles.some((c) => pathMatches(c, e.file)));",
    replace: "return errors;",
    tests: ["tests/beta111-clarify-and-typecheck.test.mjs"],
  },
  {
    name: "a non-compiling branch is blocking (b111): `low` would let the b109 gate ship it",
    file: "dist/orchestrator/typecheck-gate.js",
    find: 'severity: "high",',
    replace: 'severity: "low",',
    tests: ["tests/beta111-clarify-and-typecheck.test.mjs"],
  },
  {
    // The exact code that shipped PR #952 with "no blocking findings" while the
    // audit log recorded blockingFindings=1.
    name: "one definition of blocking (b112): the medium-blind set denies a finding the loop counted",
    file: "dist/orchestrator/merge-recommendation.js",
    find: "const blocking = review.findings.filter((f) => AT_LEAST_MEDIUM.has((f.severity || \"\").toLowerCase()));",
    replace: "const blocking = review.findings.filter((f) => BLOCKING_SEVERITIES.has((f.severity || \"\").toLowerCase()));",
    tests: ["tests/beta112-local-run-defects.test.mjs"],
  },
  {
    name: "the reason reflects the loop's count (b112): not just what the severity scan found",
    file: "dist/orchestrator/merge-recommendation.js",
    find: "const n = Math.max(blockingCount, blocking.length);",
    replace: "const n = blocking.length;",
    tests: ["tests/beta112-local-run-defects.test.mjs"],
  },
  {
    // Repo-wide precedent would let a stray `utils/` anywhere vouch for any
    // `utils/`, which is how a hallucinated path gets blessed.
    name: "precedent is scoped to the ancestor (b112): a directory far away must not vouch for a path",
    file: "dist/orchestrator/plan-path-validate.js",
    find: "if (d === dir || !d.startsWith(prefix))",
    replace: "if (d === dir)",
    tests: ["tests/beta112-local-run-defects.test.mjs"],
  },
  {
    name: "precedent decides the wording (b112): without it the b100 path reads as an expected new directory",
    file: "dist/orchestrator/plan-path-validate.js",
    find: "const shallow = suspects.filter((s) => !!s.precedent);",
    replace: "const shallow = suspects.filter(() => true);",
    tests: ["tests/beta112-local-run-defects.test.mjs"],
  },
  {
    name: "git beats prose (b112): a file in the commit cannot have been skipped",
    file: "dist/orchestrator/worker-confab-detect.js",
    find: "if (committed.has(b))",
    replace: "if (false)",
    tests: ["tests/beta112-local-run-defects.test.mjs"],
  },
  {
    name: "an info finding cannot force a full re-run (b113): the DR/BCP run re-ran all 8 sub-tasks twice on two of them",
    file: "dist/orchestrator/revise-scope.js",
    find: "&& !isBelowActionable(f)",
    replace: "",
    tests: ["tests/beta113-drbcp-run-defects.test.mjs"],
  },
  {
    name: "medium is still actionable (b113): widening the floor would scope away real work",
    file: "dist/orchestrator/revise-scope.js",
    find: 'const BELOW_ACTIONABLE = new Set(["info", "informational", "low", "nit", "note"]);',
    replace: 'const BELOW_ACTIONABLE = new Set(["info", "informational", "low", "nit", "note", "medium", "high", "critical"]);',
    tests: ["tests/beta113-drbcp-run-defects.test.mjs"],
  },
  {
    name: "scoping never selects nobody (b113): a cycle that dispatches no worker changes nothing",
    file: "dist/orchestrator/revise-scope.js",
    find: "if (runSeqs.length === 0) {",
    replace: "if (false) {",
    tests: ["tests/beta113-drbcp-run-defects.test.mjs", "tests/beta103-plan-path-writeback.test.mjs", "tests/beta107-scout-bounds-recovery-and-orphans.test.mjs"],
  },
  {
    name: "the retry window widens (b113): retrying against the same deadline is the same experiment twice",
    file: "dist/orchestrator/loop.js",
    find: "return Math.min(cap, Math.round(base * Math.pow(mult, Math.max(0, attempt - 1))));",
    replace: "return base;",
    tests: ["tests/beta113-drbcp-run-defects.test.mjs"],
  },
  {
    name: "the escalation is capped (b113): unbounded growth hands one stalled sub-task the whole turn budget",
    file: "dist/orchestrator/loop.js",
    find: "return Math.min(cap, Math.round(base * Math.pow(mult, Math.max(0, attempt - 1))));",
    replace: "return Math.round(base * Math.pow(mult, Math.max(0, attempt - 1)));",
    tests: ["tests/beta113-drbcp-run-defects.test.mjs"],
  },
  {
    name: "a declared directory covers files beneath it (b113): a generated migration has no name to declare",
    file: "dist/orchestrator/loop.js",
    find: "if (!looksLikeDir)",
    replace: "if (true)",
    tests: ["tests/beta113-drbcp-run-defects.test.mjs"],
  },
  {
    name: "a declared directory does not cover the world (b113): prefix matching must respect the separator",
    file: "dist/orchestrator/loop.js",
    find: "return f.startsWith(`${d}/`);",
    replace: "return f.startsWith(d);",
    tests: ["tests/beta113-drbcp-run-defects.test.mjs"],
  },
  {
    name: "an ambiguous allow-list is not scouted (b113): scouting one of two candidates primes the plan for the wrong repo",
    file: "dist/orchestrator/fable5-lead.js",
    find: "if (entries.length !== 1)",
    replace: "if (false)",
    tests: ["tests/beta113-drbcp-run-defects.test.mjs"],
  },
  {
    name: "the generated tree is actually dropped (b114): 141 of PR #961's 154 files were regenerated bundle",
    file: "dist/adapters/git-worktree.js",
    find: "await this.revertNeverCommitPaths(worktreePath);",
    replace: "",
    tests: ["tests/beta114-never-commit-paths.test.mjs"],
  },
  {
    name: "unstaging is not enough (b114): a file left dirty is swept back in by the next sub-task's add -A",
    file: "dist/adapters/git-worktree.js",
    find: 'await this.run(["-C", worktreePath, "restore", "--worktree", "--", ...globs]).catch(() => undefined);',
    replace: "",
    tests: ["tests/beta114-never-commit-paths.test.mjs"],
  },
  // NOT a mutation: removing the `globs.length === 0` early return in
  // revertNeverCommitPaths is an EQUIVALENT mutant. With an empty pathspec git
  // lists every staged file for the diff but then fails the restore outright
  // ("you must specify path(s) to restore"), the method's catch swallows it,
  // and the commit proceeds byte-identically. There is no observable
  // difference for a test to detect, so a mutation there reports a gap that
  // does not exist. The opt-in property itself IS covered, behaviourally, by
  // "with no configuration the behaviour is exactly as before".

  // --- beta.115: an unrunnable typecheck gate must not read as a pass -------
  {
    name: "the direct route is really tried (b115): PR #964's TS2551 was reachable via tsc, just not via npm run",
    file: "dist/orchestrator/typecheck-fallback.js",
    find: '    if (existsSync(local))\n        attempts.push({ via: "node_modules_bin", cmd: local, args: ["--noEmit"] });\n',
    replace: "",
    tests: ["tests/beta115-typecheck-gate-unavailable.test.mjs"],
  },
  {
    name: "a 127 from the fallback is not a run (b115): 'command not found' must not be parsed as a clean typecheck",
    file: "dist/orchestrator/typecheck-fallback.js",
    find: "        if (res.status === 127 || res.status === 126)\n            continue;\n",
    replace: "",
    tests: ["tests/beta115-typecheck-gate-unavailable.test.mjs"],
  },
  {
    name: "no route means null (b115): the gate must never be handed a fabricated result",
    file: "dist/orchestrator/typecheck-fallback.js",
    find: "    return null;\n}",
    replace: '    return { via: "npx", status: 0, stdout: "", stderr: "" };\n}',
    tests: ["tests/beta115-typecheck-gate-unavailable.test.mjs"],
  },
  {
    name: "npx stays --no-install (b115): a review gate must not mutate the worktree to make itself runnable",
    file: "dist/orchestrator/typecheck-fallback.js",
    find: 'args: ["--no-install", "tsc", "--noEmit"]',
    replace: 'args: ["tsc", "--noEmit"]',
    tests: ["tests/beta115-typecheck-gate-unavailable.test.mjs"],
  },
  // NOT a mutation: a dangling-symlink guard in diagnoseCheckEnv. The first
  // draft stat'd the path after accessSync to catch links pointing at nothing.
  // Mutation testing showed the stat could be deleted with no test noticing,
  // and the reason is that it was dead code: accessSync FOLLOWS the symlink, so
  // a dangling one throws ENOENT there and already lands in the
  // not-executable bucket. The stat has been removed rather than shipped with a
  // mutation that can never be caught; the behaviour it was meant to protect is
  // still covered by "a dangling symlink is not reported as an executable
  // compiler".

  // --- beta.116: a finding that names a file must reach its owner -----------
  {
    name: "the alias table is consulted (b116): 'correctness' and 'conventions' share no substring with their target",
    file: "dist/orchestrator/finding-dimension.js",
    find: "    const alias = ALIASES[s];\n    if (alias)\n        return alias;\n",
    replace: "",
    tests: ["tests/beta116-finding-routing.test.mjs"],
  },
  {
    name: "routing follows the file (b116): gating on dimension is what orphaned 5 findings in the b115 run",
    file: "dist/orchestrator/finding-dimension.js",
    find: "    if (!hasFile(f))\n        return false;",
    replace: "",
    tests: ["tests/beta116-finding-routing.test.mjs"],
  },
  // --- beta.117: parallel sub-tasks work in isolation ----------------------
  {
    name: "slots are siblings (b117): a child ref cannot coexist with the session branch, so git refuses to create it",
    file: "dist/orchestrator/worktree-pool.js",
    find: "return `${(sessionBranch ?? \"\").replace(/[/\\-]+$/, \"\")}-w${slot}`;",
    replace: "return `${(sessionBranch ?? \"\").replace(/[/\\-]+$/, \"\")}/w${slot}`;",
    tests: ["tests/beta117-parallel-isolation.test.mjs"],
  },
  {
    name: "a reused slot is repositioned (b117): a stale tree diffs against the wrong base",
    file: "dist/orchestrator/worktree-pool.js",
    find: "            await this.deps.reset(existing, sha);",
    replace: "",
    tests: ["tests/beta117-parallel-isolation.test.mjs"],
  },
  {
    name: "a released slot goes to the longest waiter (b117): otherwise a third sub-task blocks forever",
    file: "dist/orchestrator/worktree-pool.js",
    find: "        const next = this.waiters.shift();",
    replace: "        const next = undefined;",
    tests: ["tests/beta117-parallel-isolation.test.mjs"],
  },
  {
    name: "a failed create is retryable (b117): one transient disk error must not shrink the pool for the run",
    file: "dist/orchestrator/worktree-pool.js",
    find: "                this.uncreated.unshift(slot);",
    replace: "",
    tests: ["tests/beta117-parallel-isolation.test.mjs"],
  },
  {
    name: "a conflicted merge is aborted (b117): a repo left mid-merge fails every later sub-task in the cycle",
    file: "dist/orchestrator/merge-back.js",
    find: '        await git.run(req.sessionWorktree, ["merge", "--abort"]).catch(() => undefined);',
    replace: "",
    tests: ["tests/beta117-parallel-isolation.test.mjs"],
  },
  {
    name: "merge-back reports conflicts (b117): swallowing one silently drops a sub-task's work from the branch",
    file: "dist/orchestrator/merge-back.js",
    find: '            reason: paths.length > 0 ? "conflict" : "error",',
    replace: '            reason: "error",',
    tests: ["tests/beta117-parallel-isolation.test.mjs"],
  },
  {
    name: "clean -fd keeps ignored files (b117): adding -x deletes the node_modules the slot paid 25s to install",
    file: "dist/adapters/git-worktree.js",
    find: '        await this.run(["-C", worktreePath, "clean", "-fd"]);',
    replace: '        await this.run(["-C", worktreePath, "clean", "-fdx"]);',
    tests: ["tests/beta117-slot-reset.test.mjs"],
  },
  // --- beta.117: parallel sub-tasks work in isolation ----------------------
  {
    name: "runtime stays a broadcast (b116): its file is where behaviour was seen, not a defect to edit",
    file: "dist/orchestrator/finding-dimension.js",
    find: 'return normaliseDimension(f.dimension) !== "runtime";',
    replace: "return true;",
    tests: ["tests/beta116-finding-routing.test.mjs"],
  },
  {
    name: "an unknown label is not guessed at (b116): inventing a dimension would act on the invention",
    file: "dist/orchestrator/finding-dimension.js",
    find: '    for (const key of ["security", "runtime", "quality", "spec", "fit"]) {\n        if (s.includes(key))\n            return key;\n    }\n',
    replace: '    return "fit";\n',
    tests: ["tests/beta116-finding-routing.test.mjs"],
  },
  {
    name: "orphan adoption accepts fit (b116): b107 could not fix its own worked example without this",
    file: "dist/orchestrator/revise-mapping.js",
    find: "        if (!isRoutable(f))\n            continue;",
    replace: "        if (!isRoutable(f) || true)\n            continue;",
    tests: ["tests/beta116-finding-routing.test.mjs"],
  },
  {
    name: "the typecheck finding names its file (b116): unfiled, it forced 6 sub-tasks to re-run in b115 cycle 2",
    file: "dist/orchestrator/typecheck-gate.js",
    find: "        file: errors[0]?.file,",
    replace: "",
    tests: ["tests/beta116-finding-routing.test.mjs"],
  },
  {
    name: "the scope gate normalises too (b116): a private copy of the vocabulary is how the modules drifted apart",
    file: "dist/orchestrator/revise-scope.js",
    find: "return META_DIMENSIONS.has(normaliseDimension(f.dimension));",
    replace: 'return META_DIMENSIONS.has(((f.dimension ?? "")).trim().toLowerCase());',
    tests: ["tests/beta116-finding-routing.test.mjs"],
  },
  // --- beta.118: an owner must actually have a claim -----------------------
  {
    name: "a bare source-root overlap is no claim (b118): depth 1 gave a UI finding to the CRUD-API worker in b117",
    file: "dist/orchestrator/revise-mapping.js",
    find: "const score = mentioned ? 1000 + depth : depth >= MIN_NEAREST_PATH_DEPTH ? depth : 0;",
    replace: "const score = (mentioned ? 1000 : 0) + depth;",
    tests: ["tests/beta118-orphan-routing.test.mjs"],
  },
  {
    name: "the depth floor is 2 (b118): at 1 every sub-task under src/ qualifies again",
    file: "dist/orchestrator/revise-mapping.js",
    find: "const MIN_NEAREST_PATH_DEPTH = 2;",
    replace: "const MIN_NEAREST_PATH_DEPTH = 1;",
    tests: ["tests/beta118-orphan-routing.test.mjs"],
  },
  {
    name: "a named path outranks the floor (b118): suppressing it would drop the one explicit signal we have",
    file: "dist/orchestrator/revise-mapping.js",
    find: "const score = mentioned ? 1000 + depth : depth >= MIN_NEAREST_PATH_DEPTH ? depth : 0;",
    replace: "const score = depth >= MIN_NEAREST_PATH_DEPTH ? (mentioned ? 1000 + depth : depth) : 0;",
    tests: ["tests/beta118-orphan-routing.test.mjs"],
  },
  {
    name: "a shallow refusal is recorded (b118): silence makes it look like nobody was adjacent, which needs a different fix",
    file: "dist/orchestrator/revise-mapping.js",
    find: 'refusals?.push({ finding: f, file, reason: "prefix_too_shallow", score: bestDepth, seqs });',
    replace: "",
    tests: ["tests/beta118-orphan-routing.test.mjs"],
  },
  {
    name: "the slot count is read before drain (b118): after it, the pool is empty and the audit always says zero",
    file: "dist/orchestrator/loop.js",
    find: "                const slots = pool.createdCount;\n                await pool.drain();",
    replace: "                await pool.drain();\n                const slots = pool.createdCount;",
    tests: ["tests/beta118-orphan-routing.test.mjs"],
  },
  {
    name: "the adversary must name the trigger (b118): without it the registry finding has no owner to route to",
    file: "src/orchestrator/fable5-adversary.ts",
    find: "- REGISTRY findings",
    replace: "- Registry findings",
    tests: ["tests/beta118-orphan-routing.test.mjs"],
  },

  // --- beta.119 fix 1: the CI gate fails closed ----------------------------
  {
    name: "an unreadable signal is not evidence (b119): `&&` here is the exact b118 false green -- green Vercel, invisible Actions",
    file: "dist/adapters/github.js",
    find: "if (!snap.statusReadable || !snap.checksReadable) {",
    replace: "if (!snap.statusReadable && !snap.checksReadable) {",
    tests: ["tests/beta119-ci-gate-fails-closed.test.mjs"],
  },
  {
    name: "a truncated check list is unjudgeable (b119): page 2 could hold the only red check",
    file: "dist/adapters/github.js",
    find: "            if ((cj.total_count ?? runs.length) > runs.length) {",
    replace: "            if (false) {",
    tests: ["tests/beta119-ci-gate-fails-closed.test.mjs"],
  },
  {
    name: "success needs every check to PASS (b119): absence of red is not presence of green",
    file: "dist/adapters/github.js",
    find: "const allChecksGood = snap.checkPassed === snap.checkTotal;",
    replace: "const allChecksGood = snap.checkFailed === 0;",
    tests: ["tests/beta119-ci-gate-fails-closed.test.mjs"],
  },
  {
    name: "the fall-through is unknown, not success (b119): the pre-b119 default is what shipped a red PR as green",
    file: "dist/adapters/github.js",
    find: '    snap.state = "unknown";\n    snap.reason = `unclassified:',
    replace: '    snap.state = "success";\n    snap.reason = `unclassified:',
    tests: ["tests/beta119-ci-gate-fails-closed.test.mjs"],
  },
  {
    name: "`stale` is a failing conclusion (b119): a stale check has not passed",
    file: "dist/adapters/github.js",
    find: 'const FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "stale"];',
    replace: 'const FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required"];',
    tests: ["tests/beta119-ci-gate-fails-closed.test.mjs"],
  },
  {
    name: "a shrinking check list cannot end the wait (b119): the Checks API is eventually consistent and briefly returns none",
    file: "dist/orchestrator/loop.js",
    find: 'else if (checkTotal < maxChecksSeen && (status === "success" || status === "none")) {',
    replace: "else if (false) {",
    tests: ["tests/beta119-ci-gate-fails-closed.test.mjs"],
  },
  {
    name: "an unresolved read ends INDETERMINATE (b119): waiting out the budget and then calling it green is the same bug with extra steps",
    file: "dist/orchestrator/loop.js",
    find: 'return { outcome: "indeterminate", sha, waitedSeconds, reason: lastIndeterminateReason };',
    replace: 'return { outcome: "success" };',
    tests: ["tests/beta119-ci-gate-fails-closed.test.mjs"],
  },

  // --- beta.119 fix 2: a fix no single owner can make ----------------------
  {
    name: "co-fix routing recruits the other owners (b119): b118 told sub-task 5 three times to change files it does not own",
    file: "dist/orchestrator/revise-mapping.js",
    find: "    if (opts.routeCoFixOwners) {",
    replace: "    if (false) {",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },
  {
    name: "declared relatedFiles are used (b119): the adversary was asked for them precisely because prose extraction is lossy",
    file: "dist/orchestrator/cross-cutting-findings.js",
    find: "    const declared = (Array.isArray(f.relatedFiles) ? f.relatedFiles : [])",
    replace: "    const declared = (Array.isArray(null) ? f.relatedFiles : [])",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },
  {
    name: "a finding never co-fixes its own file (b119): the owner is already on it; listing it manufactures a self-recruit",
    file: "dist/orchestrator/cross-cutting-findings.js",
    find: "        if (!p || p === own)",
    replace: "        if (!p)",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },
  {
    name: "the overlap threshold recognises a rewrite (b119): b118's three titles for one defect score 0.55-0.62",
    file: "dist/orchestrator/cross-cutting-findings.js",
    find: "const SAME_FINDING_OVERLAP = 0.5;",
    replace: "const SAME_FINDING_OVERLAP = 0.95;",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },
  {
    name: "two shared tokens minimum (b119): below it, short titles on one file match each other by coincidence",
    file: "dist/orchestrator/cross-cutting-findings.js",
    find: "const MIN_SHARED_TOKENS = 2;",
    replace: "const MIN_SHARED_TOKENS = 0;",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },
  {
    name: "stuck means CONSECUTIVE (b119): a finding fixed in c2 and reintroduced in c3 is a new problem, not an unfixable one",
    file: "dist/orchestrator/cross-cutting-findings.js",
    find: "    const previous = history[history.length - 1] ?? [];",
    replace: "    const previous = history.flat();",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },

  // --- beta.119 fixes 3-5: cycles, push failures, token scope --------------
  {
    name: "an extension needs budget headroom (b119): a converging run with no money left must still stop",
    file: "dist/orchestrator/loop.js",
    find: "                    const canExtend = (input.cycleExtensionsGranted ?? 0) < (input.maxCycleExtensions ?? 0) &&\n                        input.budgetHeadroomOk === true &&",
    replace: "                    const canExtend = (input.cycleExtensionsGranted ?? 0) < (input.maxCycleExtensions ?? 0) &&",
    tests: ["tests/beta119-cycles-push-scope.test.mjs"],
  },
  {
    name: "granted extensions raise the ceiling (b119): without this the grant is issued every cycle and never spent",
    file: "dist/orchestrator/loop.js",
    find: "if (input.cyclesRan >= input.maxCycles + (input.cycleExtensionsGranted ?? 0)) {",
    replace: "if (input.cyclesRan >= input.maxCycles) {",
    tests: ["tests/beta119-cycles-push-scope.test.mjs"],
  },
  {
    name: "a regressing last cycle is not converging (b119): 13 -> 8 -> 12 is the arc we refuse to buy a fourth cycle for",
    file: "dist/orchestrator/loop.js",
    find: "    return last <= prev; // and the most recent cycle did not regress",
    replace: "    return true;",
    tests: ["tests/beta119-cycles-push-scope.test.mjs"],
  },
  {
    name: "a failed push preserves the worktree (b119): the commits exist ONLY on local disk at this terminal",
    // Source-side: the guard is a pin against src/orchestrator/loop.ts, so a
    // dist mutation would be invisible to it by construction.
    file: "src/orchestrator/loop.ts",
    find: "      return this.finaliseFailedPreserveWorktree(\n        sessionId,\n        `pr_error (${diagnosis.kind}; worktree preserved): ${describePreservedPushFailure({",
    replace: "      return this.finaliseFailed(\n        sessionId,\n        `pr_error (${diagnosis.kind}): ${describePreservedPushFailure({",
    tests: ["tests/beta119-cycles-push-scope.test.mjs"],
  },
  {
    name: "an unclassified push failure is still recoverable (b119): deleting the work to save a worktree is never the right trade",
    file: "dist/orchestrator/push-failure.js",
    find: "        kind: \"unknown\",\n        // Unknown does NOT mean unrecoverable. The work is on disk either way, and\n        // deleting it to save a worktree is never the right trade.\n        recoverable: true,",
    replace: '        kind: "unknown",\n        recoverable: false,',
    tests: ["tests/beta119-cycles-push-scope.test.mjs"],
  },
  {
    name: "only a PROVEN missing scope stops the run (b119): fine-grained PATs report no scope header and are perfectly capable",
    file: "src/orchestrator/loop.ts",
    find: "        if (verdict === false) {",
    replace: "                if (!verdict) {",
    tests: ["tests/beta119-cycles-push-scope.test.mjs"],
  },
  {
    name: "an absent scope header is unknown, not a refusal (b119): App installation tokens return it empty",
    file: "dist/orchestrator/workflow-scope.js",
    find: "    if (!scopes || scopes.length === 0)\n        return null;",
    replace: "    if (!scopes || scopes.length === 0)\n        return false;",
    tests: ["tests/beta119-cycles-push-scope.test.mjs"],
  },

  // --- beta.120 fix 1: an abort must never destroy work --------------------
  {
    name: "a user abort is not a resource ceiling (b120): shipping a PR someone asked you to stop is an override, not a rescue",
    file: "dist/orchestrator/abort-salvage.js",
    find: '    "ship_time_reserved",\n]);',
    replace: '    "ship_time_reserved",\n    "user_abort_reaction",\n]);',
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    name: "a salvaged PR must not read as approved (b120): it carries no verdict and 27 commits of unreviewed work",
    file: "dist/orchestrator/abort-salvage.js",
    find: "`NOT machine-approved -- ",
    replace: "`Reviewed and ready -- ",
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    name: "the salvage gate is the only way in (b120): one raw finaliseAbort call is one worktree deleted",
    file: "src/orchestrator/loop.ts",
    find: 'if (failed.err === "hard_timeout") return await this.finaliseAbortSalvaging(sessionId, "hard_timeout", cycle, totalCost);',
    replace: 'if (failed.err === "hard_timeout") return this.finaliseAbort(sessionId, "hard_timeout", cycle, totalCost);',
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    name: "a failed salvage push preserves (b120): falling through to release turns a bad push into lost work",
    file: "dist/orchestrator/loop.js",
    find: 'this.deps.state.audit("loop.abort_worktree_preserved"',
    replace: 'this.scheduleWorktreeReleaseForSession(sessionId, "aborted"), this.deps.state.audit("loop.abort_worktree_preserved"',
    tests: ["tests/beta16-worktree-release.test.mjs"],
  },
  // NOT a mutation any more: the OUTER catch of abortHasSalvageableCommits.
  //
  // b120 mutated its `return true` and b16's suite caught it, because back then
  // the probe called out to commitMadeSince and that call could throw. b129
  // replaced that call with a comparison against a sha already on the session
  // row, and gave the two remaining fallible steps their own handlers: the HEAD
  // read has its `catch (probeErr)`, and planBaseSha swallows its own DB error.
  // Nothing inside the try can now reach the outer catch, so mutating it proves
  // nothing and only asserts that a defensive net is unreachable -- which is
  // the point of a defensive net.
  //
  // The property it used to guard ("cannot tell" means "protect it") did not go
  // away; it moved, and is mutated in two sharper places under b129: the
  // `if (!head)` guard and the `head !== baseSha` comparison.

  // --- beta.120 fix 2: co-fix grants are not ownership ----------------------
  {
    name: "a granted path is not an owned path (b120): conflating them is what took the fan-out from 1.9 to 5.0 per finding",
    file: "dist/orchestrator/revise-mapping.js",
    find: ".filter((p) => p.length > 0 && !granted.has(p));",
    replace: ".filter((p) => p.length > 0);",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },
  {
    name: "the grant is recorded separately (b120): without its own field the router cannot tell a grant from an owner next cycle",
    file: "src/orchestrator/loop.ts",
    find: "if (!st.coFixGrantedFiles.includes(p)) st.coFixGrantedFiles.push(p);",
    replace: "if (false) st.coFixGrantedFiles.push(p);",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },

  // --- beta.120 fix 3: one finding, one answerable owner --------------------
  {
    name: "supporting owners are not told to drive (b120): nine equal 'fix this' messages produced zero fixes across two cycles",
    file: "dist/orchestrator/revise-mapping.js",
    find: "        else {\n                    a.assisting = a.assisting ?? [];",
    replace: "        else if (a.targeted.includes(f)) {\n                    a.assisting = a.assisting ?? [];",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },
  {
    name: "the file's own owner is the primary (b120): picking a recruit instead hands the fix to someone who can only assist",
    file: "dist/orchestrator/revise-mapping.js",
    find: "const primarySeq = priorOwners.length > 0 ? Math.min(...priorOwners) : Math.min(...recruited);",
    replace: "const primarySeq = Math.min(...recruited);",
    tests: ["tests/beta119-cross-cutting-findings.test.mjs"],
  },

  // --- beta.120 fix 4: reserve time to land ---------------------------------
  {
    name: "the reserve is clamped (b120): unclamped, a session shorter than the reserve ships after cycle 1 and never revises",
    file: "dist/orchestrator/abort-salvage.js",
    find: "    if (totalMs > 0)\n        reserveMs = Math.min(reserveMs, totalMs * MAX_RESERVE_FRACTION);",
    replace: "    if (false)\n        reserveMs = Math.min(reserveMs, totalMs * MAX_RESERVE_FRACTION);",
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    name: "a passed deadline is the abort path's job (b120): treating it as a reserve would ship instead of salvaging",
    file: "dist/orchestrator/abort-salvage.js",
    find: "    if (remaining <= 0)\n        return false;",
    replace: "    if (remaining <= 0)\n        return true;",
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    name: "the reserve fires only when explicitly ON (b120): a loose truthiness check would end every run at cycle 1",
    file: "dist/orchestrator/loop.js",
    find: '                if (input.shipTimeReserved === true) {',
    replace: '                if (input.shipTimeReserved !== false) {',
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },

  // --- beta.120 fix 5 + 6: silence and unauthorised spend -------------------
  {
    name: "an absent releaseWorktree dep still audits (b120): the b119 take-2 worktree vanished with no event explaining it",
    file: "src/orchestrator/loop.ts",
    find: '        { sessionId, reason, reason_skipped: "no releaseWorktree dependency wired", path: worktreePath },',
    replace: '        { sessionId, reason, path: worktreePath },',
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    name: "an extension may not spend past the SESSION budget (b120): the operator ceiling is not the number the requester agreed to",
    file: "src/orchestrator/loop.ts",
    find: "      if (typeof sessionBudgetUsd === \"number\" && sessionBudgetUsd > 0 && spentUsd + projected > sessionBudgetUsd) return false;",
    replace: "      if (false) return false;",
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    // The probe that decides whether an abort may delete the worktree. Collapsing
    // a thrown HEAD read into "" reads as "no commits" and releases -- fail-OPEN,
    // and the precise shape of the b119 take-2 loss.
    name: "the abort commit probe fails CLOSED (b120): an unanswerable probe must protect the work, not delete it",
    file: "src/orchestrator/loop.ts",
    // b129 moved the `if (!head)` line this used to sit against, so the anchor
    // is now the catch block's own audit call, which cannot drift without the
    // handler itself changing.
    find:
      '          { sessionId, worktreePath: row.worktree_path, probe: "worktreeHeadSha", error: String((probeErr as Error)?.message ?? probeErr) },\n' +
      "          sessionId,\n        );\n        return true;",
    replace:
      '          { sessionId, worktreePath: row.worktree_path, probe: "worktreeHeadSha", error: String((probeErr as Error)?.message ?? probeErr) },\n' +
      "          sessionId,\n        );\n        return false;",
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    // Preserving the branch is only half the fix; the operator has to be told.
    // Behavioural test => mutate the compiled file the suite actually loads.
    name: "a preserved abort SAYS so (b120): work saved but never mentioned is work the operator redoes",
    file: "dist/orchestrator/progress.js",
    find: "                if (ev.event === \"loop.abort_worktree_preserved\")\n                    worktreePreserved = true;",
    replace: "                if (false)\n                    worktreePreserved = true;",
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },
  {
    name: "an abort headline names its cause (b120): 'Aborted $18.46.' was the entire account of a two-hour run",
    file: "dist/orchestrator/progress.js",
    find: "    if (input.status === \"aborted\") {\n        const why = input.failureDetail ? ` — ${input.failureDetail}` : \"\";",
    replace: "    if (input.status === \"aborted\") {\n        const why = \"\";",
    tests: ["tests/beta120-abort-salvage-and-routing.test.mjs"],
  },

  // --- beta.122: the b121 smoke lost two correct commits to a rename ---
  {
    // The root cause. Without this the lead renames the branch on every
    // re-plan and b101's preservation looks up a name that no longer exists.
    name: "the session's branch is pinned (b122): a re-plan that renames the branch orphans everything committed to it",
    file: "src/orchestrator/fable5-lead.ts",
    find: "        raw.branch = deps.pinnedSessionBranch;",
    replace: "        raw.branch = raw.branch;",
    tests: ["tests/beta122-branch-identity-and-clarify.test.mjs"],
  },
  {
    // The fail-safe. This alone would have saved the b121 run even with the
    // naming bug intact, so it has to be independently protected.
    name: "allocation re-attaches to the ledger tip (b122): 'no branch by that name' must not resolve to 'reset over the work'",
    file: "src/adapters/git-worktree.ts",
    find: "      if (preserveRequested && !localExists && recoverSha) {",
    replace: "      if (false) {",
    tests: ["tests/beta122-branch-identity-and-clarify.test.mjs"],
  },
  {
    // Behavioural: the rescue is a pure function the suite calls directly.
    name: "a directory contract resolves itself (b122): escalating a 1:1 mapping cost the run that asked the question",
    file: "dist/orchestrator/basename-rescue.js",
    find: "    if (under.length !== 1)\n        return undefined;",
    replace: "    if (under.length !== 1)\n        return undefined;\n    return undefined;",
    tests: ["tests/beta122-branch-identity-and-clarify.test.mjs"],
  },
  {
    // The prompt promised the gentler reading and delivered the harsher one.
    name: "accept and skip read differently (b122): 'accept that this sub-task is done' deleted a committed migration",
    file: "dist/orchestrator/contract-clarify.js",
    find: '    lines.push(bullet("accept", "the commit is fine and the contract path was wrong -- keep the work and carry on"));',
    replace: "",
    tests: ["tests/beta122-branch-identity-and-clarify.test.mjs", "tests/beta111-clarify-and-typecheck.test.mjs"],
  },
  {
    name: "a budget at the gate is applied (b122): 'Confirm, Budget $40' became an acceptance criterion and the run stayed at $10",
    file: "dist/tools/brief-confirmation.js",
    // beta.123: the anchor moved from `raw` to `working` when the time clause
    // started being cut out before money is matched.
    find: "    const m = BUDGET_CLAUSE.exec(working);",
    replace: "    const m = null;",
    tests: ["tests/beta122-branch-identity-and-clarify.test.mjs", "tests/beta123-confirmation-clauses.test.mjs"],
  },
  {
    // Fail the OTHER way too: a parser that swallows the whole reply would
    // approve corrections it should have surfaced.
    name: "a budget plus a correction is still a correction (b122): approving on a stripped clause would start the wrong build",
    file: "dist/tools/brief-confirmation.js",
    find: "        approves: remainder.length === 0 || isBriefConfirmation(remainder),",
    replace: "        approves: true,",
    tests: ["tests/beta122-branch-identity-and-clarify.test.mjs"],
  },
  {
    name: "the sub-task counter counts the plan (b122): 'Executing sub-task 1/1' described a ten-part plan",
    file: "dist/orchestrator/progress.js",
    find: "    const plannedOrStarted = Math.max(all.length, plannedTotal);",
    replace: "    const plannedOrStarted = all.length;",
    tests: ["tests/beta122-branch-identity-and-clarify.test.mjs"],
  },

  // ---- beta.123 -------------------------------------------------------------
  // These four are the point of the release. Each names a mechanism that WAS
  // already covered by unit and structural tests, and each was broken anyway,
  // because nothing asked what the RUN did afterwards. The mutations therefore
  // point at the scenario suite: if breaking the mechanism does not change a
  // terminal outcome somewhere, the coverage is decorative again.
  {
    name: "a rescue retracts its failure (b123): both self-heal paths marked the sub-task fixed and killed the run anyway",
    file: "dist/orchestrator/loop.js",
    find: "                    retractFailure(st.seq, `basename_rescue:${rescue.kind}`);",
    replace: "                    ;",
    tests: ["tests/beta123-scenario-terminal-outcomes.test.mjs"],
  },
  {
    name: "the auto-resolve retracts its failure (b123): 'the branch satisfies the contract' still ended in subtask_N_failed_verification",
    file: "dist/orchestrator/loop.js",
    find: '                retractFailure(st.seq, "contract_auto_resolved");',
    replace: "                ;",
    tests: ["tests/beta123-scenario-contract-recovery.test.mjs"],
  },
  {
    name: "a pure rename satisfies file_committed (b123): 0 changed lines is what a git mv IS, not evidence of no work",
    file: "dist/orchestrator/verify-probes.js",
    find: "                const movedUnmatched = await renamedAway(path, files);",
    replace: "                const movedUnmatched = null;",
    tests: ["tests/beta123-verify-probes.test.mjs"],
  },
  {
    name: "a rename must SURVIVE the window (b123): renamed-then-deleted is work that is gone, not work that moved",
    file: "dist/orchestrator/verify-probes.js",
    find: "                        if (!st.isFile() || st.size === 0)\n                            return null;",
    replace: "                        if (false)\n                            return null;",
    tests: ["tests/beta123-verify-probes.test.mjs"],
  },
  // NOT a mutation: `failed.seq !== seq` in the b123 retraction guard.
  //
  // The guard stops a rescue on one sub-task from clearing a DIFFERENT
  // sub-task's genuine failure -- possible only under b117 parallelism, where
  // several sub-tasks share the one `failed` slot. Reproducing it needs a
  // rescue to be mid-flight at the moment another seq records a failure, and
  // the scenario harness can force that interleaving with a gate but cannot
  // reliably make the pooled slot produce a rescuable mismatch: the b100
  // reconciler settles the path first, so no rescue fires and there is nothing
  // to retract. A mutation here would therefore survive for want of a fixture,
  // reporting a coverage gap that is really a harness limitation.
  //
  // What IS covered: "the retraction is recorded against the seq that recorded
  // the failure" pins the audit payload, and "a rescue on one sub-task cannot
  // bury another's real failure" pins the outcome under concurrency 2. Neither
  // distinguishes a targeted clear from a blanket one. Left deliberately, and
  // named here so the gap is visible rather than assumed closed.
  {
    name: "time and money are parsed separately (b123): 'a time budget of 3 hours' read as a $3 cap",
    file: "dist/tools/brief-confirmation.js",
    find: "    const t = TIME_CLAUSE.exec(working);",
    replace: "    const t = null;",
    tests: ["tests/beta123-confirmation-clauses.test.mjs"],
  },

  {
    name: "a granted cycle is actually RUN (b124): b119's extension was authorised and discarded on every run for four releases",
    file: "dist/orchestrator/loop.js",
    // The pre-b124 bound. `advance()` still decides to extend, the counter is
    // still incremented and audited -- and the driver still stops, which is
    // exactly the shape of the shipped bug. A test that only watches the
    // decision or greps for the increment survives this untouched.
    // b127 added `+ ciRepairCyclesGranted` to the same bound, so the anchor is
    // the whole expression. Dropping only `cycleExtensionsGranted` keeps this
    // aimed at b124's grant and leaves b127's alone.
    // b129 added `+ timeExtensionCyclesGranted` for the same reason.
    find: "while (cycle < this.deps.config.loop.max_cycles + cycleExtensionsGranted + ciRepairCyclesGranted + timeExtensionCyclesGranted) {",
    replace: "while (cycle < this.deps.config.loop.max_cycles + ciRepairCyclesGranted + timeExtensionCyclesGranted) {",
    tests: ["tests/beta124-scenario-cycle-extension.test.mjs"],
  },
  {
    name: "a denial stops the poll (b124): 44 polls over 896s re-asking a 403 that answered on the first call",
    file: "dist/orchestrator/loop.js",
    find: "if (consecutivePermanentDenials >= denialCeiling) {",
    replace: "if (false) {",
    tests: ["tests/beta124-ci-permanent-denial.test.mjs"],
  },
  {
    name: "401/403/404 are told apart from 5xx (b124): treating a permission denial as transient is what cost the 896s",
    file: "dist/adapters/github.js",
    find: "const PERMANENT_HTTP = new Set([401, 403, 404]);",
    replace: "const PERMANENT_HTTP = new Set([]);",
    tests: ["tests/beta124-ci-permanent-denial.test.mjs"],
  },
  // --- beta.126 -----------------------------------------------------------
  // Every rung of the b81/b97/b99 lead ladder was correct on b125 and the run
  // died in planning regardless, because the signal that PICKS a rung was
  // wrong. These pin the signal.
  {
    name: "truncation is read off the DOCUMENT (b126): b125 waited for a stop_reason the SDK never sent",
    file: "dist/adapters/claude-sdk.js",
    find: 'const wasTruncated = stopReason === "max_tokens" || looksTruncatedJson(raw);',
    replace: 'const wasTruncated = stopReason === "max_tokens";',
    tests: ["tests/beta126-lead-retry-ladder.test.mjs", "tests/beta126-truncation-by-shape.test.mjs"],
  },
  {
    name: "an unclosed container is truncation, not prose (b126): the sentence that sent an operator after tools: []",
    file: "dist/adapters/claude-sdk.js",
    find: "if (looksTruncatedJson(text)) {",
    replace: "if (false) {",
    tests: ["tests/beta126-truncation-by-shape.test.mjs", "tests/beta97-blocker-fixes.test.mjs"],
  },
  {
    name: "the shape check respects string state (b126): a brace inside a string would fake every truncation",
    file: "dist/adapters/claude-sdk.js",
    find: "if (!/[{[]/.test(text))",
    replace: "if (false)",
    tests: ["tests/beta126-truncation-by-shape.test.mjs"],
  },
  {
    name: "a failed attempt is still billed (b126): two Opus calls were recorded as $0.00",
    file: "dist/adapters/claude-sdk.js",
    find: "err.costUsd = costUsd;",
    replace: "err.costUsd = 0;",
    tests: ["tests/beta126-lead-retry-ladder.test.mjs"],
  },
  {
    name: "a retry bills for BOTH attempts (b126): attempt 1's spend vanished on every retried plan",
    file: "dist/adapters/claude-sdk.js",
    find: "costUsd: spentSoFar + r2.costUsd,",
    replace: "costUsd: r2.costUsd,",
    tests: ["tests/beta126-lead-retry-ladder.test.mjs"],
  },
  {
    name: "the declared default is really applied (b126): three files promised 64000 and DEFAULTS did not carry it",
    file: "dist/config.js",
    find: "max_output_tokens: 64000,",
    replace: "",
    tests: ["tests/beta126-declared-defaults-are-applied.test.mjs"],
  },

  // --- beta.125 -----------------------------------------------------------
  // b124 detected the denial and stopped. It then told the operator to grant a
  // permission that does not exist for the token class they were using, so the
  // fast answer was fast and unusable. These pin the fallback that turns the
  // denial into a verdict, and the honesty that keeps it from becoming b118.
  {
    name: "the fallback actually fires (b125): without it a fine-grained PAT can never read CI on an Actions repo",
    file: "dist/adapters/github.js",
    find: "if (!snap.checksReadable && denials.length > 0 && input.workflowRunsFallback !== false) {",
    replace: "if (false) {",
    tests: ["tests/beta125-workflow-runs-fallback.test.mjs"],
  },
  {
    name: "the fallback only fires on a PERMANENT denial (b125): routing around a 503 hides a real check-runs read",
    file: "dist/adapters/github.js",
    find: "if (!snap.checksReadable && denials.length > 0 && input.workflowRunsFallback !== false) {",
    replace: "if (!snap.checksReadable && input.workflowRunsFallback !== false) {",
    tests: ["tests/beta125-workflow-runs-fallback.test.mjs"],
  },
  {
    name: "a truncated workflow-runs page is refused (b125): 100 green of 140 is exactly the b118 false green",
    file: "dist/adapters/github.js",
    find: "if ((body.total_count ?? runs.length) > runs.length) {",
    replace: "if (false) {",
    tests: ["tests/beta125-workflow-runs-fallback.test.mjs"],
  },
  {
    name: "a fallback green admits its source (b125): claiming to have read check runs we never read is how b118 read",
    file: "dist/adapters/github.js",
    find: 'snap.reason = snap.checksSource === "workflow_runs"',
    replace: 'snap.reason = false',
    tests: ["tests/beta125-workflow-runs-fallback.test.mjs"],
  },
  {
    name: "the remedy no longer names a permission that does not exist (b125)",
    file: "dist/adapters/github.js",
    find: "cannot call the Checks API at all",
    replace: 'needs the "Checks: read" repository permission',
    tests: ["tests/beta125-workflow-runs-fallback.test.mjs"],
  },
  {
    name: "an unreadable gate is still never a pass (b119, re-pinned by b124's denial path)",
    file: "dist/adapters/github.js",
    find: "if (!snap.statusReadable || !snap.checksReadable) {",
    replace: "if (false) {",
    tests: [
      "tests/beta119-ci-gate-fails-closed.test.mjs",
      "tests/beta124-ci-permanent-denial.test.mjs",
    ],
  },

  // NOT a mutation: the `cycleExtensionsGranted < maxCycleExtensions` cap in
  // `advance()`. Neutering it to `true` does not make the b124 tests fail --
  // it makes them HANG. Now that the driver honours a grant, every cycle would
  // grant another and raise its own bound, and a converging arc keeps
  // qualifying forever; the run never terminates and the harness never gets to
  // report anything. A mutation that hangs the suite tells us less than the
  // test already does, and costs four minutes to find out. "the extension is
  // spent once, not compounded into an unbounded run" pins the property
  // directly by counting cycles on an arc that qualifies at every ceiling.
  //
  // NOT a mutation: the emitted finding's `severity: "high"` in loop.ts. Every
  // mutation here rewrites a `dist/` file, but the assertion that guards this
  // property is a SOURCE pin against `src/orchestrator/loop.ts`, so a dist-side
  // mutation is invisible to it by construction and would always survive --
  // reporting a coverage gap that is really a harness limitation. The property
  // that actually matters, "a >= medium unavailable-gate finding stops the
  // merge recommendation", is covered behaviourally by "an unavailable gate
  // blocks the merge but does not drive revise cycles", which exercises the
  // real deriveMergeRecommendation.

  // ---------------------------------------------------------------- beta.127
  {
    // THE b124 SHAPE, ON A NEW COUNTER. b119 through b123 all granted an extra
    // cycle correctly, audited it correctly, and never ran it, because the
    // loop bound did not include the grant. If this mutation survives, the
    // repair cycle is decorative in exactly the same way.
    name: "a granted CI repair cycle is one the loop bound knows about (b127)",
    file: "dist/orchestrator/loop.js",
    find: "this.deps.config.loop.max_cycles + cycleExtensionsGranted + ciRepairCyclesGranted",
    replace: "this.deps.config.loop.max_cycles + cycleExtensionsGranted",
    tests: ["tests/beta127-scenario-ci-repair.test.mjs"],
  },
  {
    name: "a red build actually buys the cycle rather than only auditing it (b127)",
    file: "dist/orchestrator/loop.js",
    // b129 added `&& clockOk`; b130 lifted the ceiling test out to `ceilingOk`
    // so the ask above it could read the same answer.
    find: "const canRepair = wantsRepair && ceilingOk && budgetOk && clockOk;",
    replace: "const canRepair = false;",
    tests: ["tests/beta127-scenario-ci-repair.test.mjs"],
  },
  // NOT a mutation: removing the repair ceiling (`ciRepairCyclesGranted <
  // repairCeiling`). This is the same trap the b124 note above describes, and
  // it was walked into anyway while writing b127 -- the run hung for 56
  // minutes before it was killed. Without the ceiling, a permanently-red build
  // grants itself a cycle at every ship gate and each grant raises the loop's
  // own bound, so the mutation does not fail the test, it makes the test never
  // terminate. A mutation that hangs the suite tells us strictly less than the
  // test already does and costs an hour to find out. The property is pinned
  // directly by "the ceiling holds: a build that stays red does not buy cycles
  // forever", which counts grants on a build that never goes green.
  {
    // A timeout or an unreadable verdict means we do not know what to fix, and
    // a worker sent after an unknown produces plausible noise for a full cycle.
    name: "only a PARSEABLE failure buys a cycle, never a bare timeout (b127)",
    file: "dist/orchestrator/loop.js",
    find: "const wantsRepair = ciOverride !== null && lastCiFindings.length > 0;",
    replace: "const wantsRepair = ciOverride !== null;",
    tests: ["tests/beta127-scenario-ci-repair.test.mjs"],
  },
  {
    // The exact b126 defect: a check run that answers with a name and no
    // output is non-empty, so any fallback keyed on emptiness never fires and
    // the PR ships "- Tests [failure]" as its diagnosis.
    name: "a check-runs answer with no diagnosis does not block the job-log fallback (b127)",
    file: "dist/adapters/github.js",
    // Anchored on the condition alone: tsc puts the `return` on its own line.
    find: "if (viaChecks.hasDetail)",
    replace: "if (viaChecks.text)",
    tests: ["tests/beta127-failing-logs.test.mjs"],
  },
  {
    name: "a CI finding is never downgraded by keywords in the log it quotes (b127)",
    file: "dist/orchestrator/finding-classify.js",
    find: 'if (f.source === "ci")',
    replace: "if (false)",
    tests: ["tests/beta127-ci-findings.test.mjs"],
  },
  {
    name: "CI findings carry the source marker that keeps them blocking (b127)",
    file: "dist/orchestrator/ci-findings.js",
    find: 'source: "ci",\n            dimension: "quality",',
    replace: 'dimension: "quality",',
    tests: ["tests/beta127-ci-findings.test.mjs"],
  },
  {
    // #157. The planner's spend is what the budget ceiling is checked against,
    // so dropping it does not merely under-report -- it under-bounds.
    name: "the lead's spend reaches the ledger (b127 / #157)",
    file: "dist/orchestrator/loop.js",
    find: "let totalCost = row.cost_usd + leadPlanningCostUsd;",
    replace: "let totalCost = row.cost_usd;",
    tests: ["tests/beta127-lead-cost.test.mjs"],
  },
  {
    name: "every lead attempt is billed, including the ones whose plan we discard (b127 / #157)",
    file: "dist/orchestrator/fable5-lead.js",
    find: "leadCallCostUsd += raw.costUsd ?? 0;",
    replace: "leadCallCostUsd += 0;",
    tests: ["tests/beta127-lead-cost.test.mjs"],
  },

  // -------------------------------------------------------------------------
  // beta.128. A complete plan spoiled by one JavaScript literal, and the two
  // places f75f7db6's spend went missing.
  // -------------------------------------------------------------------------
  {
    // Without the rung the run dies holding a plan that is one token from
    // usable -- which is exactly what f75f7db6 did.
    name: "a complete-but-invalid plan gets its re-ask (b128): the seq_note:undefined death",
    file: "dist/adapters/claude-sdk.js",
    find: "if (fault && params.leadSyntaxRetryEnabled !== false) {",
    replace: "if (false) {",
    tests: ["tests/beta128-invalid-json-rung.test.mjs"],
  },
  {
    // The whole point is telling the model WHAT is wrong. A correction that
    // does not name the fault is the b127 message that gave it nothing to act
    // on, dressed up as a new rung.
    name: "the re-ask names the offending literal (b128): a correction with no fault in it is noise",
    file: "dist/adapters/claude-sdk.js",
    find: "lines.push(`The token \\`${located.token}\\` is a JavaScript literal, not a JSON value. JSON has no ` +",
    replace: "lines.push(``.slice(0) +",
    tests: ["tests/beta128-invalid-json-rung.test.mjs"],
  },
  {
    // String-awareness. Blaming an `undefined` that lives inside a string
    // sends the model to rewrite a healthy field.
    name: "the fault scan respects string state (b128): prose is allowed to say 'undefined'",
    file: "dist/adapters/claude-sdk.js",
    find: "if (inString)\n            continue;\n        for (const token of NON_JSON_LITERALS) {",
    replace: "if (false)\n            continue;\n        for (const token of NON_JSON_LITERALS) {",
    tests: ["tests/beta128-invalid-json-rung.test.mjs"],
  },
  {
    name: "every attempt is reported, not just the fatal one (b128): a recovered truncation left no trace",
    file: "dist/adapters/claude-sdk.js",
    find: "params.onAttempt?.(info);",
    replace: "void info;",
    tests: ["tests/beta128-invalid-json-rung.test.mjs"],
  },
  {
    name: "a FAILED plan is billed (b128 / #157): ten minutes of Opus reported as $0.00",
    file: "dist/orchestrator/loop.js",
    find: "const failedPlanCostUsd = e?.costUsd ?? 0;",
    replace: "const failedPlanCostUsd = 0;",
    tests: ["tests/beta128-failed-plan-cost.test.mjs"],
  },
  {
    // b127 fixed the in-memory total and left the ROW alone, so every report
    // that reads sessions.cost_usd still billed the lead at zero.
    name: "the lead's cost reaches the session ROW (b128 / #157): the half b127 missed",
    file: "dist/orchestrator/loop.js",
    find: "this.addCost(sessionId, leadPlanningCostUsd);",
    replace: "void leadPlanningCostUsd;",
    tests: ["tests/beta128-failed-plan-cost.test.mjs"],
  },
  {
    name: "the planner carries its spend out on the throw (b128 / #157): the loop can only bank what it is handed",
    file: "dist/orchestrator/fable5-lead.js",
    find: "failed.costUsd = Number((leadCallCostUsd + (scoutOutcome?.costUsd ?? 0) + (failed.costUsd ?? 0)).toFixed(6));",
    replace: "failed.costUsd = failed.costUsd ?? 0;",
    tests: ["tests/beta128-failed-plan-cost.test.mjs"],
  },

  // -------------------------------------------------------------------------
  // beta.129. Session d48ba433 needed four separate defects to line up: a
  // salvage probe that could not say yes, a wiring that fed it silence, a
  // ceiling that outranked a passing verdict, and two grant paths that priced
  // cycles in dollars while the clock ran out. Each gets a mutant.
  // -------------------------------------------------------------------------
  {
    name: "the salvage probe compares against a REAL base (b129): an empty base can only answer 'delete it'",
    file: "dist/orchestrator/loop.js",
    find: "return head !== baseSha;",
    replace: "return false;",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs", "tests/beta16-worktree-release.test.mjs"],
  },
  {
    name: "an unreadable HEAD protects the work (b129): b120 read silence as 'nothing committed'",
    file: "dist/orchestrator/loop.js",
    find: "if (!head) {",
    replace: "if (false) {",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "a preserved worktree survives the self-heal (b129): the promise expired at the next restart",
    file: "dist/state/worktree-heal.js",
    find: "if (row?.worktree_preserved) {",
    replace: "if (false) {",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "a pass verdict outranks the clock (b129): d48ba433 was aborted 2ms after earning one",
    file: "dist/orchestrator/loop.js",
    find: "if (!terminalVerdictInHand) {",
    replace: "if (true) {",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "the reserve is sized against a MEASURED cycle (b129): reserving a constant answers the wrong question",
    file: "dist/orchestrator/abort-salvage.js",
    find: "return remaining < reserveMs + cycleMs;",
    replace: "return remaining < reserveMs;",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "one slow cycle cannot disable revising (b129): the allowance needs its clamp",
    file: "dist/orchestrator/abort-salvage.js",
    find: "cycleMs = Math.min(cycleMs, totalMs * MAX_CYCLE_ALLOWANCE_FRACTION);",
    replace: "cycleMs = cycleMs;",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "the CI repair grant pays for the clock (b129): b127 priced it in dollars only",
    file: "dist/orchestrator/loop.js",
    // b130 renamed the ceiling term; the property under test is unchanged --
    // dropping `clockOk` must still be caught.
    find: "const canRepair = wantsRepair && ceilingOk && budgetOk && clockOk;",
    replace: "const canRepair = wantsRepair && ceilingOk && budgetOk;",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "a bare 'no' with a duration in it is still a grant (b129): 'no more than 20 minutes' is 20 minutes",
    file: "dist/orchestrator/time-extension.js",
    find: "if (!d && SOFT_NEGATIVE.test(raw))",
    replace: "if (SOFT_NEGATIVE.test(raw))",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "an unreadable reply lands the work (b129): guessing 'keep spending' is the unrecoverable direction",
    file: "dist/orchestrator/time-extension.js",
    find: 'return { approved: false, seconds: 0, interpretation: "unrecognised" };\n}',
    replace: 'return { approved: true, seconds: opts.defaultSeconds, interpretation: "unrecognised" };\n}',
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "the extension cycle joins the loop bound (b129): a grant the bound ignores is not a grant",
    file: "dist/orchestrator/loop.js",
    find: "+ ciRepairCyclesGranted + timeExtensionCyclesGranted)",
    replace: "+ ciRepairCyclesGranted)",
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "the PR is recorded when it is OPENED (b129): d48ba433 reported 'PR (none)' about its own PR",
    file: "dist/orchestrator/loop.js",
    find: 'this.deps.state.audit("loop.pr_opened"',
    replace: 'void 0 && this.deps.state.audit("loop.pr_opened"',
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },
  {
    name: "the confirmation gate names the clock (b129): b123 parsed the time clause and told nobody",
    file: "dist/tools/brief-confirmation.js",
    find: `"confirm, budget $40 with a time budget of 4 hours"`,
    replace: `"confirm, budget $40"`,
    tests: ["tests/beta129-wall-clock-and-salvage.test.mjs"],
  },

  // --- beta.130: the refusal that never asked -------------------------------
  {
    // Delete the ask and b129's behaviour returns exactly: a correct refusal,
    // silently, over a red build with the budget untouched. PR #1058 shipped
    // do-not-merge for want of one assertion and $30 of unspent cap.
    name: "a clock-only refusal ASKS first (b130): #1058 shipped red with $30 unspent and no question",
    file: "dist/orchestrator/loop.js",
    find: "trigger: \"ci_repair\",",
    replace: "trigger: \"review\",",
    tests: ["tests/beta130-ci-repair-ask.test.mjs"],
  },
  {
    // The ask must be reachable at all. Flipping the clock test makes the
    // branch dead, which is the b129 status quo wearing b130's code.
    name: "the b130 ask fires when the clock is the ONLY thing missing",
    file: "dist/orchestrator/loop.js",
    find: "budgetOk &&\n            !clockOk &&",
    replace: "budgetOk &&\n            clockOk &&",
    tests: ["tests/beta130-ci-repair-ask.test.mjs"],
  },
  {
    // shouldReserveTimeToShip answers "no need to reserve" once the deadline
    // is behind us. Without this guard a run that earned its pass late reads
    // a dead clock as unlimited and buys a cycle it cannot run.
    name: "a dead clock cannot fund a repair (b130): remaining <= 0 is not 'plenty of time'",
    file: "dist/orchestrator/loop.js",
    find: "remainingMs > 0 &&",
    replace: "true &&",
    tests: ["tests/beta130-ci-repair-ask.test.mjs"],
  },
  // NOT a mutation: bumping `timeExtensionCyclesGranted` in the CI-repair ask.
  //
  // The intent is real -- the repair grant raises the while-loop bound by one
  // on its own, so counting the extension as well would ask for two. But it
  // cannot be observed, because the bound is not what stops the run: at the
  // next review `advance()` independently caps on `cyclesRan >= maxCycles +
  // cycleExtensionsGranted`, which knows nothing about either the repair or
  // the extension counter. Inflating the bound therefore changes no outcome,
  // and a mutation that changes no outcome tests the test, not the code.
  //
  // Kept correct in the source with a comment saying why, and the cycle count
  // is still asserted by "granting time for a repair buys ONE cycle, not two"
  // -- which guards the property against a future change that DOES make the
  // bound load-bearing (b124 is exactly that shape, on a different counter).
  {
    // Without this the report cannot tell "the clock said no" from "the clock
    // said no and the operator agreed", which is the difference between a
    // working feature and a silent one.
    name: "the decline records whether the operator was ASKED (b130)",
    file: "dist/orchestrator/loop.js",
    find: "askedForTime: timeExtensionRefused,",
    replace: "askedForTime: false,",
    tests: ["tests/beta130-ci-repair-ask.test.mjs"],
  },
  {
    // shipStart is set outside the ship-attempt loop, so it spans every cycle.
    // The live run reported 25 minutes of shipping for 6 minutes of pushing.
    name: "the ship phase times SHIPPING (b130): anchored outside the loop it swallows every cycle",
    file: "dist/orchestrator/loop.js",
    find: 'this.emitPhaseTiming(sessionId, "ship", cycle, shipPhaseStart',
    replace: 'this.emitPhaseTiming(sessionId, "ship", cycle, shipStart',
    tests: ["tests/beta130-ci-repair-ask.test.mjs"],
  },

  // --- beta.131: the repair cycle that could never have worked --------------
  {
    // The one line. Restoring it restores four releases of a CI-repair feature
    // that could only ever spend a cycle guessing, and b127's own tests stay
    // green throughout -- their fixture says the run concluded "failure", which
    // is real but never true at the moment this code runs.
    name: "a still-running workflow is read (b131): run-level conclusion lags the job that woke us",
    file: "dist/adapters/github.js",
    find: 'const candidateRuns = (rj.workflow_runs ?? []).filter((r) => !settledGreen.includes(r.conclusion ?? ""));',
    replace: 'const candidateRuns = (rj.workflow_runs ?? []).filter((r) => ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? ""));',
    tests: ["tests/beta131-ci-repair-routing.test.mjs"],
  },
  {
    // Only two runs are ever read. Reading the green ones spends that budget on
    // runs that cannot contain a failing job, and on a sha with three runs that
    // is how the failing one goes unread.
    name: "green runs are not scanned (b131): the two-run budget must not be spent on runs that passed",
    file: "dist/adapters/github.js",
    find: 'const settledGreen = ["success", "skipped", "neutral"];',
    replace: "const settledGreen = [];",
    tests: ["tests/beta131-ci-repair-routing.test.mjs"],
  },
  {
    // With the cap at two, ordering decides whether a definite failure listed
    // third is reached at all.
    name: "a definite failure is read before one still in flight (b131)",
    file: "dist/adapters/github.js",
    find: "candidateRuns.sort((a, b) => definite(a.conclusion) - definite(b.conclusion));",
    replace: "candidateRuns.sort(() => 0);",
    tests: ["tests/beta131-ci-repair-routing.test.mjs"],
  },
  {
    // Testing the clock before the ceiling is what made a correct refusal read
    // as "shipped red without asking" on b130's very first live run.
    name: "an exhausted ceiling outranks a short clock in the decline reason (b131)",
    file: "dist/orchestrator/loop.js",
    find: ': !ceilingOk ? "ceiling"',
    replace: ': !clockOk ? "wall_clock"',
    tests: ["tests/beta131-ci-repair-routing.test.mjs"],
  },
  {
    // A finding that names a file already has an owner holding the context to
    // fix it. Adding a cold worker as well splits one failure across two
    // mechanisms, which is how fan-out starts.
    name: "only an UNROUTABLE failure gets its own sub-task (b131)",
    file: "dist/orchestrator/loop.js",
    find: 'if (ciFindings.some((f) => (f.file ?? "").trim()))\n            return;',
    replace: "if (false)\n            return;",
    tests: ["tests/beta131-ci-repair-routing.test.mjs"],
  },
  {
    // Without the sub-task the finding is broadcast to everyone and owned by
    // nobody: 03a8a7b6 spent a cycle and ~$3 that way and stayed red.
    name: "an unroutable red build actually gets an owner (b131), not just an audit line",
    file: "dist/orchestrator/loop.js",
    find: "this.addCiRepairSubTask(sessionId, cycle, plan, lastCiFindings);",
    replace: "void 0;",
    tests: ["tests/beta131-ci-repair-routing.test.mjs"],
  },
];

/**
 * beta.130: every mutation gets a wall clock.
 *
 * Without one, a mutation that makes a test HANG rather than fail stalls the
 * whole run. b130 shipped one: CI sat on this step for 90 minutes against a
 * 4-to-7 minute baseline before anyone looked. We had already met this failure
 * once and paid for it by RETIRING the mutation (see the ceiling note above) --
 * which is backwards, because a hang and a failure both mean the tests did not
 * pass under the mutation, and only the harness was unable to say so.
 *
 * So a timeout counts as caught, and is reported separately: a hang is a
 * legitimate catch but a slow, uninformative one, and the test that hangs is
 * worth fixing even though it did its job.
 */
const TEST_TIMEOUT_MS = Number(process.env.MUTATION_TEST_TIMEOUT_MS ?? 180_000);

function runTests(files) {
  const r = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    // SIGTERM leaves the node test runner's workers behind often enough that
    // the next mutation inherits them; take the whole tree down.
    killSignal: "SIGKILL",
  });
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  return { passed: !timedOut && r.status === 0, timedOut };
}

/**
 * beta.127: find an anchor whose INDENTATION may have moved.
 *
 * Anchors are matched against `dist/`, which tsc re-indents from the AST, so
 * nesting a block anywhere above an anchor shifts every line inside it. b127
 * wrapped the cycle loop in a ship-attempt loop and broke three unrelated
 * multi-line anchors that way -- b110, b118 and b124 -- all reported as "the
 * code was renamed or removed", none of which had been touched. It cost a full
 * CI round trip to find out.
 *
 * So: exact match first, and if that misses, retry with the leading whitespace
 * of each continuation line treated as elastic. Only leading whitespace is
 * relaxed; everything else, including which lines follow which, still has to
 * match exactly, so an anchor cannot silently start matching different code.
 */
function locate(src, find) {
  const at = src.indexOf(find);
  if (at >= 0) return { text: find, elastic: false };
  if (!find.includes("\n")) return null;

  const pattern = find
    .split("\n")
    .map((line, i) => {
      const body = line.replace(/^[ \t]+/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return i === 0 ? body : `[ \\t]*${body}`;
    })
    .join("\n");
  const re = new RegExp(pattern, "g");
  const hits = [...src.matchAll(re)];
  if (hits.length !== 1) return null; // ambiguous or absent: refuse to guess
  return { text: hits[0][0], elastic: true };
}

/**
 * beta.128: restore the mutated file even when this process does not get to
 * run its `finally`.
 *
 * The try/finally below is correct and was still not enough. Piping this
 * script into `head` closes stdout early; the next `console.log` raises EPIPE,
 * node tears the process down, and `dist/` is left holding a deliberate bug.
 * Every subsequent run then reads a corrupted tree -- anchors "not found" in
 * files nobody touched, mutations "surviving" tests that would have caught
 * them. The signal that tells us the suite is honest was itself dishonest, and
 * it took three full runs to notice.
 *
 * So the restore is registered as a process-level obligation the moment a file
 * is mutated, not only as a lexical one.
 */
let inFlight = null;
const restoreInFlight = () => {
  if (!inFlight) return;
  writeFileSync(inFlight.path, inFlight.original, "utf8");
  inFlight = null;
};

/**
 * beta.130: the per-mutation restore above is necessary and was not sufficient.
 *
 * It leaked again -- a b129 mutation that strips `timeExtensionCyclesGranted`
 * from the loop bound survived a run and sat in dist/ afterwards. The next run
 * then reported that same mutation's anchor as "renamed or removed", because
 * the mutation had eaten the text its own anchor was looking for. That reads
 * exactly like a real regression and cost an hour to tell apart from one.
 *
 * Chasing the specific escape route is the wrong move; the previous two fixes
 * were both correct and both incomplete. So the invariant is enforced instead
 * of the mechanism: snapshot every mutable file up front, and refuse to finish
 * without proving each one is byte-identical to how we found it. Anything that
 * gets past the handlers is still caught here, and said out loud.
 */
const PRISTINE = new Map();
for (const m of MUTATIONS) {
  const p = join(root, m.file);
  if (!PRISTINE.has(p)) PRISTINE.set(p, readFileSync(p, "utf8"));
}

const restoreAll = () => {
  restoreInFlight();
  const dirty = [];
  for (const [p, original] of PRISTINE) {
    let now;
    try {
      now = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    if (now !== original) {
      writeFileSync(p, original, "utf8");
      dirty.push(p);
    }
  }
  return dirty;
};

process.on("exit", () => {
  const dirty = restoreAll();
  if (dirty.length) {
    // Deliberately loud. A silent repair here would hide the fact that some
    // run in this session was working against a sabotaged tree.
    console.error(`\nWARNING: restored ${dirty.length} file(s) left mutated: ${dirty.join(", ")}`);
    console.error("Any result printed above may have been measured against a sabotaged tree. Re-run.");
  }
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    restoreAll();
    process.exit(130);
  });
}
process.on("uncaughtException", (e) => {
  restoreAll();
  console.error(e);
  process.exit(1);
});
// A closed stdout must not be the thing that corrupts the tree -- and neither
// must a closed stderr, which the previous version left unguarded even though
// every failure this script reports is written there.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE") {
      restoreAll();
      process.exit(0);
    }
  });
}

let failures = 0;
let timeouts = 0;
for (const m of MUTATIONS) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");

  // Optional substring filter: `node scripts/mutation-check.mjs b117` runs only
  // the mutations whose name matches. The full set takes ~40 minutes, which is
  // fine in CI and far too slow to iterate against while writing a release.
  if (FILTER && !m.name.includes(FILTER)) continue;
  ran++;

  const found = locate(original, m.find);
  if (!found) {
    console.error(`FAIL  ${m.name}`);
    console.error(`      anchor not found in ${m.file}. The code was renamed or removed, so this`);
    console.error(`      mutation no longer tests anything. Update scripts/mutation-check.mjs.`);
    console.error(`      looking for: ${m.find}`);
    failures++;
    continue;
  }
  if (found.elastic) {
    // Not a failure -- the anchor still identifies exactly one site -- but say
    // so, because a drifting anchor is worth noticing before it drifts onto
    // something else.
    console.error(`note  ${m.name}`);
    console.error(`      anchor matched with relaxed indentation; the code around it moved.`);
  }

  try {
    // Replace the text as it appears on disk, so an elastic match rewrites the
    // real indentation rather than the anchor's stale copy of it.
    inFlight = { path, original };
    writeFileSync(path, original.replace(found.text, m.replace), "utf8");
    const { passed, timedOut } = runTests(m.tests);
    if (passed) {
      console.error(`FAIL  ${m.name}`);
      console.error(`      Broke it in ${m.file} and ${m.tests.join(", ")} STILL PASSED.`);
      console.error(`      Those tests do not actually verify this mechanism.`);
      failures++;
    } else if (timedOut) {
      // Caught, but by exhaustion rather than by an assertion. Worth naming:
      // whichever test hangs here is a test that cannot explain itself.
      console.log(`slow  ${m.name}`);
      console.log(`      caught by TIMEOUT after ${Math.round(TEST_TIMEOUT_MS / 1000)}s, not by an assertion.`);
      console.log(`      ${m.tests.join(", ")} hangs under this mutation instead of failing.`);
      timeouts++;
    } else {
      console.log(`ok    ${m.name}`);
    }
  } finally {
    writeFileSync(path, original, "utf8");
    inFlight = null;
  }
}

if (failures > 0) {
  console.error(`\n${failures} mutation(s) survived. The suite is not protecting these mechanisms.`);
  process.exit(1);
}
console.log(`\nAll ${ran} mutations were caught${FILTER ? ` (filter: ${FILTER})` : ""}.`);
if (timeouts > 0) {
  console.log(`${timeouts} of them by timeout rather than by an assertion -- see the "slow" lines above.`);
}
