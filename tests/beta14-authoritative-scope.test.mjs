/**
 * beta.14 regression tests: authoritative `contractScope` on sub-tasks.
 *
 * Beta.11 / 12 / 13 fixed three separate NLP-derived contract inference
 * bugs. All three had the same root cause: the harness was trying to
 * REVERSE-ENGINEER scope from natural-language patterns, when the lead
 * planner already understands scope directly.
 *
 * beta.14 promotes scope to a first-class field on LeadPlanSubTask:
 *   contractScope?: "local" | "remote" | "mixed"
 *
 * Semantics:
 * - `local`: sub-task only touches worktree fs + git. All remote-scope
 *   contract kinds (branch_pushed, remote_branch_exists, commit_sha_matches,
 *   pr_opened, pr_state, file_pushed, file_in_pr) are filtered out of the
 *   inferred contract regardless of ambient wording. This makes beta.13's
 *   NLP heuristics unnecessary for correctly-tagged sub-tasks.
 * - `remote`: sub-task pushes / opens PRs / verifies remote state. Regex
 *   inference applies as before.
 * - `mixed`: both. Full inference.
 * - absent: fallback to beta.13 inference (backward compat).
 *
 * Precedence:
 *   1. Explicit `verify` on sub-task wins (unchanged from beta.9).
 *   2. Regex inference produces candidates.
 *   3. `contractScope: "local"` FILTERS OUT remote-scope kinds.
 *   4. Otherwise no filtering.
 */
import test from "node:test";
import assert from "node:assert/strict";

let verifyContract;
try {
  verifyContract = await import("../dist/orchestrator/verify-contract.js");
} catch {
  verifyContract = null;
}

const skipAll = { skip: verifyContract === null };

function contains(contract, kind) {
  return contract.some((c) => c.kind === kind);
}

// ============================================================
// contractScope: "local" filters out remote-scope kinds
// ============================================================

test(
  "beta.14: contractScope='local' + push-language filters out ALL remote-scope kinds",
  skipAll,
  () => {
    // The lead marks this sub-task 'local' even though its language mentions
    // "push" in a directive ("do not push"). The scope filter kicks in
    // regardless of what regex inference produces.
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Push",
      // Deliberately ambiguous language that could trip up regex inference.
      intent: "verify push status locally. verify remote SHA.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "local",
    });
    assert.equal(contains(c, "branch_pushed"), false, `no branch_pushed: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "remote_branch_exists"), false);
    assert.equal(contains(c, "commit_sha_matches"), false);
    assert.equal(contains(c, "pr_opened"), false);
    assert.equal(contains(c, "pr_state"), false);
    assert.equal(contains(c, "file_pushed"), false);
    assert.equal(contains(c, "file_in_pr"), false);
  },
);

test(
  "beta.14: contractScope='local' + explicit push/PR wording still filters (authoritative override)",
  skipAll,
  () => {
    // Even though "push branch" and "open a draft PR" would normally
    // trigger positive inference, the local scope tag suppresses them.
    // This is the KEY use case: the harness trusts the lead's scope
    // declaration over its own NLP heuristics.
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Local dry-run of push and PR",
      intent: "Verify push branch and open a draft PR mechanics WITHOUT actually pushing or opening. This is a dry-run.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "local",
    });
    assert.equal(contains(c, "branch_pushed"), false, `authoritative local scope filter: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "pr_opened"), false);
  },
);

test(
  "beta.14: contractScope='local' preserves LOCAL kinds (file_written, file_committed, commit_made)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Write and commit",
      intent: "Write docs/X.md and commit locally.",
      filesLikelyTouched: ["docs/X.md"],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "local",
    });
    // Local kinds must still be inferred.
    assert.equal(contains(c, "file_written"), true, `file_written should stay: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "commit_made"), true, `commit_made should stay: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "file_committed"), true, `file_committed should stay: ${JSON.stringify(c)}`);
  },
);

// ============================================================
// contractScope: "remote" applies full inference (beta.13 behaviour)
// ============================================================

test(
  "beta.14: contractScope='remote' + push language infers full remote-scope contract",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Push branch to origin and open a draft PR",
      intent: "git push origin harness/smoke and then open a draft pull request against main.",
      filesLikelyTouched: [],
      successCriteria: ["branch on remote", "draft PR open"],
      estimatedTokens: 100,
      contractScope: "remote",
    });
    assert.equal(contains(c, "branch_pushed"), true);
    assert.equal(contains(c, "remote_branch_exists"), true);
    assert.equal(contains(c, "commit_sha_matches"), true);
    assert.equal(contains(c, "pr_opened"), true);
    assert.equal(contains(c, "pr_state"), true);
  },
);

test(
  "beta.14: contractScope='remote' still honours negation cues (beta.12 still active on remote-scoped subtasks)",
  skipAll,
  () => {
    // remote scope doesn't DISABLE beta.12/13 inference \u2014 it just doesn't FILTER OUT remote kinds.
    // If the sub-task's own language explicitly negates the push, the regex
    // still respects that.
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Local commit (mistakenly tagged remote)",
      intent: "Commit locally. Do not push. Do not open a PR.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "remote",
    });
    // Even though scope is "remote", negation still applies. This is
    // defensive: if the lead mis-tags a sub-task, the NLP layer still
    // protects the smoke test from false positives.
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "pr_opened"), false);
  },
);

// ============================================================
// Backward compat: absent contractScope = beta.13 behaviour
// ============================================================

test(
  "beta.14: absent contractScope falls back to beta.13 inference (absence-assertion still works)",
  skipAll,
  () => {
    // The exact Staging beta.12 s3 case with NO scope tag. Beta.13's
    // absence-assertion gate should still produce an empty contract.
    const c = verifyContract.inferVerifyContract({
      seq: 3,
      title: "Local read-only verification pass",
      intent: "Run local, read-only checks and record their outputs. Do not push, do not open a PR, do not mutate any state.",
      filesLikelyTouched: [],
      successCriteria: [
        "No network/remote-mutating git commands were run (no push, no PR)",
        "git branch -r (no fetch) to show no remote tracking branch was created",
      ],
      estimatedTokens: 100,
      // contractScope NOT set
    });
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "remote_branch_exists"), false);
    assert.equal(contains(c, "commit_sha_matches"), false);
    assert.equal(contains(c, "pr_opened"), false);
  },
);

// ============================================================
// Precedence: explicit verify beats contractScope
// ============================================================

test(
  "beta.14: explicit verify on sub-task overrides both inference AND contractScope",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Push and PR",
      intent: "Push branch and open PR.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
      // scope says local (would filter remote), but explicit verify wins
      contractScope: "local",
      verify: [{ kind: "branch_pushed" }, { kind: "pr_opened" }],
    });
    // Explicit verify is authoritative \u2014 the local scope filter should NOT apply.
    assert.equal(c.length, 2);
    assert.equal(contains(c, "branch_pushed"), true);
    assert.equal(contains(c, "pr_opened"), true);
  },
);

// ============================================================
// The full beta.10/11/12/13 happy-path s3 case with beta.14 tag
// ============================================================

test(
  "beta.14: exact Staging happy-path s3 case + contractScope='local' yields empty contract",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 3,
      title: "Local read-only verification pass",
      intent: "Run local, read-only checks and record their outputs. Do not push, do not open a PR, do not mutate any state \u2014 this sub-task is observation only.",
      filesLikelyTouched: [],
      successCriteria: [
        "No network/remote-mutating git commands were run (no push, no PR)",
        "git branch -r (no fetch) to show no remote tracking branch was created",
        "git status is clean",
      ],
      estimatedTokens: 100,
      contractScope: "local",
    });
    // With scope tag, we do NOT need to rely on beta.13's absence assertion.
    // The filter unconditionally drops remote kinds.
    assert.equal(c.length, 0, `expected empty contract, got ${JSON.stringify(c)}`);
  },
);

test(
  "beta.14: exact Staging happy-path s2 (commit only) + contractScope='local' yields commit_made + file_committed",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 2,
      title: "Make exactly one commit",
      intent: "Commit the one file created in s1 with the specified message.",
      filesLikelyTouched: ["docs/HAPPYPATH.md"],
      successCriteria: ["one commit exists"],
      estimatedTokens: 100,
      contractScope: "local",
    });
    const kinds = c.map((x) => x.kind).sort();
    // commit_made + file_committed are local-scope, so they remain.
    // No file_written because we didn't say \"write X\" verb + path in this sub-task language.
    assert.deepEqual(kinds, ["commit_made", "file_committed"], JSON.stringify(kinds));
  },
);

// ============================================================
// contractScope: "mixed" doesn't filter (rare case, applies full inference)
// ============================================================

test(
  "beta.14: contractScope='mixed' applies full inference (like absent)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Write, commit, push",
      intent: "Write docs/X.md, commit it, and push to origin. All in one sub-task.",
      filesLikelyTouched: ["docs/X.md"],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "mixed",
    });
    // Both local AND remote kinds should be inferred. Note: commit_made is
    // suppressed when push is also inferred (legacy: push already implies
    // commit_made). See COMMIT block in verify-contract.ts (hasPushInContract
    // check). This is expected behaviour, not a regression.
    assert.equal(contains(c, "file_written"), true);
    assert.equal(contains(c, "branch_pushed"), true);
    assert.equal(contains(c, "remote_branch_exists"), true);
    assert.equal(contains(c, "commit_sha_matches"), true);
  },
);
