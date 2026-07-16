/**
 * beta.15 regression tests: authoritative `taskMode` on sub-tasks.
 *
 * Beta.14 closed the LOCAL/REMOTE scope class with `contractScope`. Beta.14's
 * happy-path smoke exposed a second scope class: OBSERVATION vs MUTATION.
 * A pure observation sub-task ("verify local state, do not mutate") had
 * `commit_made` and `file_committed` inferred, then failed verification
 * because the observation-only worker (correctly) produced no new commit
 * relative to sub-task start SHA.
 *
 * Same architectural pattern as beta.14: promote scope to a first-class
 * field the lead planner emits directly.
 *
 * New enum: `type TaskMode = "observe" | "mutate" | "mixed"`.
 *
 * Semantics:
 * - `observe` → sub-task is read-only. Mutation-scope kinds are filtered
 *               out (file_written, commit_made, file_committed,
 *               branch_pushed, file_pushed, pr_opened).
 * - `mutate`  → sub-task produces new artifacts. Full inference.
 * - `mixed`   → both. Full inference.
 * - absent    → fallback to beta.14 inference (backward compat).
 *
 * Precedence (updated):
 *   1. Explicit `verify` array on sub-task → authoritative.
 *   2. Regex inference produces candidates.
 *   3. `contractScope: "local"` → filter out remote-scope kinds.
 *   4. `taskMode: "observe"` → filter out mutation-scope kinds.
 *      Filters COMPOSE: both apply.
 *   5. Otherwise no filtering.
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
// taskMode='observe' filters out mutation-scope kinds
// ============================================================

test(
  "beta.15: taskMode='observe' + write+commit language filters out file_written / commit_made / file_committed",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 4,
      title: "Verify state after commit",
      intent: "Read the committed file, verify its content matches spec, verify HEAD advanced.",
      filesLikelyTouched: ["docs/HAPPYPATH.md"],
      successCriteria: ["file exists at HEAD", "content byte-exact"],
      estimatedTokens: 100,
      taskMode: "observe",
    });
    // Even though language mentions "commit" and "file", mutation-scope
    // kinds must be filtered out.
    assert.equal(contains(c, "commit_made"), false, `no commit_made: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "file_committed"), false);
    assert.equal(contains(c, "file_written"), false);
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "file_pushed"), false);
    assert.equal(contains(c, "pr_opened"), false);
  },
);

test(
  "beta.15: taskMode='observe' preserves state-check kinds (remote_branch_exists, commit_sha_matches, pr_state, file_in_pr)",
  skipAll,
  () => {
    // State/existence kinds are legitimate for observation tasks — they
    // check the state of the world, not whether this sub-task caused it.
    const c = verifyContract.inferVerifyContract({
      seq: 4,
      title: "Check remote state",
      intent: "Verify remote SHA matches local. Confirm PR is in draft state.",
      filesLikelyTouched: [],
      successCriteria: ["remote is in expected state"],
      estimatedTokens: 100,
      contractScope: "remote",  // remote scope allowed
      taskMode: "observe",
    });
    // State-check kinds preserved.
    assert.equal(contains(c, "commit_sha_matches"), true, `commit_sha_matches should stay: ${JSON.stringify(c)}`);
    assert.equal(contains(c, "remote_branch_exists"), true, `remote_branch_exists should stay: ${JSON.stringify(c)}`);
    // Mutation kinds filtered.
    assert.equal(contains(c, "branch_pushed"), false);
  },
);

// ============================================================
// taskMode='mutate' applies full inference (beta.14 behaviour preserved)
// ============================================================

test(
  "beta.15: taskMode='mutate' + write language infers file_written",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Write file",
      intent: "Write docs/X.md with the spec content.",
      filesLikelyTouched: ["docs/X.md"],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "local",
      taskMode: "mutate",
    });
    assert.equal(contains(c, "file_written"), true);
  },
);

test(
  "beta.15: taskMode='mutate' + commit language infers commit_made + file_committed",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 2,
      title: "Commit the file",
      intent: "Commit docs/X.md locally with message 'docs: add X'.",
      filesLikelyTouched: ["docs/X.md"],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "local",
      taskMode: "mutate",
    });
    assert.equal(contains(c, "commit_made"), true);
    assert.equal(contains(c, "file_committed"), true);
  },
);

// ============================================================
// Backward compat: absent taskMode = beta.14 behaviour
// ============================================================

test(
  "beta.15: absent taskMode falls back to beta.14 inference (write+commit sub-task still infers mutation kinds)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Write and commit",
      intent: "Write docs/X.md and commit it.",
      filesLikelyTouched: ["docs/X.md"],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "local",
      // taskMode NOT set
    });
    assert.equal(contains(c, "file_written"), true);
    assert.equal(contains(c, "commit_made"), true);
    assert.equal(contains(c, "file_committed"), true);
  },
);

// ============================================================
// Composition: contractScope + taskMode filters compose
// ============================================================

test(
  "beta.15: contractScope='local' + taskMode='observe' -> purest read-only local (empty or state-check only)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 4,
      title: "Final verification",
      intent: "Final pass: verify everything is correct locally.",
      filesLikelyTouched: [],
      successCriteria: ["all previous sub-tasks succeeded"],
      estimatedTokens: 100,
      contractScope: "local",
      taskMode: "observe",
    });
    // No remote-scope (contractScope='local'), no mutation-scope (taskMode='observe').
    // For this language, no state-check kinds are inferred either -> empty.
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "remote_branch_exists"), false);
    assert.equal(contains(c, "commit_sha_matches"), false);
    assert.equal(contains(c, "pr_opened"), false);
    assert.equal(contains(c, "pr_state"), false);
    assert.equal(contains(c, "file_pushed"), false);
    assert.equal(contains(c, "file_in_pr"), false);
    assert.equal(contains(c, "file_written"), false);
    assert.equal(contains(c, "commit_made"), false);
    assert.equal(contains(c, "file_committed"), false);
  },
);

test(
  "beta.15: contractScope='remote' + taskMode='observe' -> remote read-only (state kinds only)",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 4,
      title: "Verify remote state",
      intent: "Confirm remote SHA matches local. Confirm PR is in draft state.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
      contractScope: "remote",
      taskMode: "observe",
    });
    // State kinds allowed (remote scope + not mutation).
    // No mutation kinds (branch_pushed, file_pushed, pr_opened suppressed).
    assert.equal(contains(c, "branch_pushed"), false);
    assert.equal(contains(c, "file_pushed"), false);
    assert.equal(contains(c, "pr_opened"), false);
    // State kinds preserved.
    assert.equal(contains(c, "commit_sha_matches"), true);
    assert.equal(contains(c, "remote_branch_exists"), true);
  },
);

// ============================================================
// Explicit verify wins over both scope axes (precedence check)
// ============================================================

test(
  "beta.15: explicit verify:[] wins over taskMode filter",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 4,
      title: "Verify",
      intent: "Verify locally.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
      taskMode: "observe",
      verify: [],  // explicit empty = "no observable checks, trust SDK"
    });
    // Explicit verify:[] is authoritative and returns empty.
    assert.equal(c.length, 0);
  },
);

test(
  "beta.15: explicit verify populated wins even with taskMode='observe'",
  skipAll,
  () => {
    const c = verifyContract.inferVerifyContract({
      seq: 4,
      title: "Verify state",
      intent: "Verify.",
      filesLikelyTouched: [],
      successCriteria: [],
      estimatedTokens: 100,
      taskMode: "observe",
      verify: [{ kind: "commit_made" }],  // explicit override
    });
    // Explicit verify beats taskMode filter.
    assert.equal(c.length, 1);
    assert.equal(contains(c, "commit_made"), true);
  },
);

// ============================================================
// The exact beta.14 s4 case with beta.15 taskMode='observe' yields empty
// ============================================================

test(
  "beta.15: exact beta.14 s4 case + taskMode='observe' yields empty contract (final verification pass)",
  skipAll,
  () => {
    // Reconstructing the beta.14 s4 sub-task from Staging's smoke report.
    const c = verifyContract.inferVerifyContract({
      seq: 4,
      title: "Final verification pass",
      intent: "Verify that s1-s3 completed correctly: file exists, commit was made, no push, no PR. Read-only observation.",
      filesLikelyTouched: [],
      successCriteria: [
        "docs/HAPPYPATH.md exists with expected content",
        "HEAD advanced by exactly one commit vs main",
        "no remote-tracking branch was created (git branch -r shows only origin/main)",
      ],
      estimatedTokens: 100,
      contractScope: "local",
      taskMode: "observe",
    });
    // Both scope axes filter — empty contract expected.
    assert.equal(c.length, 0, `expected empty for final verification pass, got ${JSON.stringify(c)}`);
  },
);
