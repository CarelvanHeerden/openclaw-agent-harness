/**
 * beta.12 regression tests: verify-contract inference is negation-aware.
 *
 * The beta.10 happy-path smoke test on Staging (session
 * 6366e03d-3e14-497c-ba1c-f820db20171e) surfaced this bug: a sub-task
 * whose intent explicitly said "Do not push, do not open a PR" still had
 * `branch_pushed`, `remote_branch_exists`, `commit_sha_matches`, `pr_opened`,
 * `pr_state` inferred into its contract. Reason: the regexes matched on the
 * PRESENCE of push/PR words regardless of negation context.
 *
 * beta.12 fix: `hasPositiveMatch` iterates matches and rejects any whose
 * preceding ~30-char window contains a negation cue (`do not / don't / no /
 * without / never / avoid / skip / not to / stop after / instead of`) and
 * where there's no sentence break between the cue and the match.
 *
 * These tests lock in:
 *   1. Negated push/PR/commit language does NOT produce positive contract kinds.
 *   2. Positive push/PR language DOES still produce them (no regression).
 *   3. Mixed sentences (positive in one clause, negated in another) are
 *      resolved per-clause via sentence-boundary detection.
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
// Negated push/PR/commit MUST NOT produce positive contract kinds
// ============================================================

test(
  "beta.12: 'Do not push, do not open a PR' does NOT infer branch_pushed / pr_opened",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 2,
      title: "Make exactly one commit (no push, no PR)",
      intent: "Commit the one file created in s1 with the specified message. Do not push, do not open a PR, do not create additional commits.",
      filesLikelyTouched: ["docs/HAPPYPATH.md"],
      successCriteria: ["local branch has exactly one commit ahead of main", "no remote push occurred", "no PR opened"],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), false, `should not infer branch_pushed; got ${JSON.stringify(c)}`);
    assert.equal(contains(c, "remote_branch_exists"), false);
    assert.equal(contains(c, "commit_sha_matches"), false);
    assert.equal(contains(c, "pr_opened"), false, `should not infer pr_opened; got ${JSON.stringify(c)}`);
    assert.equal(contains(c, "pr_state"), false);
    // Commit checks SHOULD still be inferred (commit is a positive verb here).
    assert.equal(contains(c, "commit_made"), true);
  },
);

test(
  "beta.12: 'don't push' also blocks push inference",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Local edit only",
      intent: "Just write the file. Don't push anything.",
      filesLikelyTouched: ["a.md"],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), false);
  },
);

test(
  "beta.12: 'no push' blocks push inference",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Local commit",
      intent: "Commit locally. No push required.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), false);
  },
);

test(
  "beta.12: 'without opening a PR' blocks PR inference",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Local review",
      intent: "Review the diff locally without opening a PR.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "pr_opened"), false);
    assert.equal(contains(c, "pr_state"), false);
  },
);

// ============================================================
// Positive language MUST still produce the corresponding kinds
// ============================================================

test(
  "beta.12: 'Push branch to origin and open a draft PR' STILL infers push+PR (positive baseline)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 3,
      title: "Push branch to origin and open a draft PR",
      intent: "git push origin harness/smoke and then open a draft pull request against main.",
      filesLikelyTouched: [],
      successCriteria: ["branch is on remote", "draft PR is open"],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), true);
    assert.equal(contains(c, "remote_branch_exists"), true);
    assert.equal(contains(c, "commit_sha_matches"), true);
    assert.equal(contains(c, "pr_opened"), true);
    assert.equal(contains(c, "pr_state"), true);
    const prState = c.find((x) => x.kind === "pr_state");
    assert.equal(prState.state, "draft", `expected state=draft, got ${JSON.stringify(prState)}`);
  },
);

test(
  "beta.12: plain 'push branch' STILL infers push (positive baseline, no negation nearby)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Push branch",
      intent: "Push branch to origin",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), true);
  },
);

// ============================================================
// Mixed sentences: positive AND negated in the same sub-task
// ============================================================

test(
  "beta.12: 'Push the branch. Do not open a PR.' - infers push but NOT pr_opened",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Push only",
      intent: "Push the local branch to origin. Do not open a PR.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), true, `push should be positive: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "pr_opened"), false, `PR is negated: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "pr_state"), false);
  },
);

test(
  "beta.12: 'Do not push X. Open a PR.' - blocks push, infers PR",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "PR only",
      intent: "Do not push directly. Open a pull request for review.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "pr_opened"), true, `PR should be positive: ${JSON.stringify(c)}`);
  },
);

// ============================================================
// The exact Staging s2 case must produce a scoped contract
// ============================================================

test(
  "beta.12: exact Staging happy-path s2 case yields commit-only contract",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 2,
      title: "Make exactly one commit (no push, no PR)",
      intent: "Commit the one file created in s1 with the specified message. Do not push, do not open a PR, do not create additional commits.",
      filesLikelyTouched: ["docs/HAPPYPATH.md"],
      successCriteria: [
        "local branch has exactly one commit ahead of main",
        "no remote push occurred",
        "no PR opened",
      ],
      estimatedTokens: 100,
    });
    // Only commit-related kinds are permitted for this sub-task.
    const kinds = c.map((x) => x.kind).sort();
    assert.deepEqual(kinds, ["commit_made", "file_committed"], `unexpected contract kinds: ${JSON.stringify(kinds)}`);
    // Path preserved on file_committed.
    const fc = c.find((x) => x.kind === "file_committed");
    assert.equal(fc.path, "docs/HAPPYPATH.md");
  },
);
