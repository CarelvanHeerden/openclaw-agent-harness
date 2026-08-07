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
    find: "const score = (mentioned ? 1000 : 0) + depth;",
    replace: "const score = depth;",
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
