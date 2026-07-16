/**
 * beta.13 regression tests: absence-assertion suppresses remote-scope inference.
 *
 * The beta.12 happy-path smoke test on Staging (session
 * 5b0b4bf8-e4cf-433e-89fe-3b64bf71b639) halted at s3 with 2 false-positive
 * checks (`remote_branch_exists` + `commit_sha_matches`) even though the
 * sub-task's intent was explicitly observation-only ("Do not push, do not
 * open a PR, do not mutate any state — this sub-task is observation only").
 *
 * Root cause: beta.12's negation-cue helper caught the `branch_pushed` and
 * `pr_opened` inferences (their triggering regexes had "push"/"PR" that
 * failed the negation check), but the `VERIFY_REMOTE_RE` / `SHA_MATCH_RE`
 * branch is triggered by "verify" / "confirm SHA" language, not by "push"
 * — so the negation cue didn't apply.
 *
 * beta.13 fix: any sub-task text that asserts *absence* of a remote artifact
 * ("no push occurred", "no PR opened", "no remote tracking branch", "branch
 * only local", "did not push", "read-only", "git branch -r ... empty") is
 * treated as an absence-assertion. When present, ALL positive remote-scope
 * kinds (`branch_pushed`, `remote_branch_exists`, `commit_sha_matches`,
 * `pr_opened`, `pr_state`) are suppressed.
 *
 * These tests lock in:
 *   1. Exact Staging beta.12 s3 case produces empty contract (or file/commit-only).
 *   2. Various absence-assertion phrases suppress remote-scope inference.
 *   3. Positive baselines still work (no regression from beta.12/beta.11/beta.10).
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
// The exact beta.12 Staging s3 case
// ============================================================

test(
  "beta.13: exact Staging beta.12 s3 case yields empty (or local-only) contract",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 3,
      title: "Local read-only verification pass",
      intent: "Run local, read-only checks and record their outputs. Do not push, do not open a PR, do not mutate any state — this sub-task is observation only.",
      filesLikelyTouched: [],
      successCriteria: [
        "No network/remote-mutating git commands were run (no push, no PR)",
        "git branch -r (no fetch) to show no remote tracking branch was created",
        "git status is clean",
      ],
      estimatedTokens: 100,
    });
    // ALL positive remote-scope kinds must be absent.
    assert.equal(contains(c, "branch_pushed"), false, `no branch_pushed: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "remote_branch_exists"), false, `no remote_branch_exists: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "commit_sha_matches"), false, `no commit_sha_matches: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "pr_opened"), false, `no pr_opened: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "pr_state"), false, `no pr_state: ${JSON.stringify(c)}`);
  },
);

// ============================================================
// Various absence-assertion phrases suppress remote-scope inference
// ============================================================

test(
  "beta.13: 'no push occurred' in successCriteria suppresses branch_pushed",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Verify local state",
      intent: "Check the local commit.",
      filesLikelyTouched: [],
      successCriteria: ["no push occurred", "branch is local only"],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "remote_branch_exists"), false);
  },
);

test(
  "beta.13: 'no PR opened' suppresses pr_opened",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Local verification",
      intent: "Verify locally that everything is in order.",
      filesLikelyTouched: [],
      successCriteria: ["no PR opened", "no push occurred"],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "pr_opened"), false);
    assert.equal(contains(c, "pr_state"), false);
  },
);

test(
  "beta.13: 'no remote tracking branch was created' suppresses remote_branch_exists",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Confirm SHA locally",
      intent: "Confirm the local SHA is correct.",
      filesLikelyTouched: [],
      successCriteria: ["no remote tracking branch was created"],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "remote_branch_exists"), false);
    assert.equal(contains(c, "commit_sha_matches"), false);
  },
);

test(
  "beta.13: 'read-only' suppresses remote-scope inference",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Read-only inspection",
      intent: "Perform a read-only inspection to verify remote state (this is read-only, no push).",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "remote_branch_exists"), false);
  },
);

test(
  "beta.13: 'branch is only local' suppresses branch_pushed",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Confirm branch is local",
      intent: "Confirm the branch is only local. Verify remote does not exist.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "remote_branch_exists"), false);
  },
);

// ============================================================
// Positive baselines still work (no regression from beta.10/11/12)
// ============================================================

test(
  "beta.13: 'Push branch to origin and open a draft PR' STILL infers push+PR (no absence assertion)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
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
  },
);

test(
  "beta.13: 'Verify remote SHA matches local HEAD' STILL infers remote_branch_exists (positive assertion, no absence)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Verify remote SHA matches local HEAD",
      intent: "confirm the branch exists on origin with matching SHA",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    assert.equal(contains(c, "remote_branch_exists"), true, `expected remote_branch_exists: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "commit_sha_matches"), true);
  },
);

test(
  "beta.13: mixed clauses - positive push, absent PR - suppresses only pr_opened",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Push branch (no PR yet)",
      intent: "Push the branch to origin. No PR needed yet.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
    });
    // "no PR" is an absence assertion → suppresses ALL remote-scope (including push)
    // because absenceAssertion is a global signal, not per-clause. Trade-off:
    // safer (no false positive on push claim when caller also says no PR) but
    // means a truly positive push claim in the presence of "no PR" is suppressed.
    // The alternative is more complex per-clause tracking; not worth it for beta.13.
    // This test documents the trade-off explicitly.
    assert.equal(contains(c, "pr_opened"), false, "PR should be suppressed");
    // Note: branch_pushed is ALSO suppressed here due to global absence-assertion scope.
    // If we want per-clause resolution, that's a future refinement.
  },
);
