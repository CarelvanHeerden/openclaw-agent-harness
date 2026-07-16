import test from "node:test";
import assert from "node:assert/strict";

let verify;
try {
  verify = await import("../dist/orchestrator/verify.js");
} catch {
  verify = null;
}

let adversary;
try {
  adversary = await import("../dist/orchestrator/fable5-adversary.js");
} catch {
  adversary = null;
}

// ============================================================
// evaluateVerification
// ============================================================

test("evaluateVerification: empty checks trusts SDK signal",
  { skip: verify === null }, () => {
    const r = verify.evaluateVerification([]);
    assert.equal(r.ok, true);
    assert.match(r.summary, /no observable checks/);
  });

test("evaluateVerification: all-pass is ok",
  { skip: verify === null }, () => {
    const r = verify.evaluateVerification([
      { kind: "branch_pushed", passed: true, detail: "HTTP 200" },
      { kind: "commit_made", passed: true, detail: "new commit" },
    ]);
    assert.equal(r.ok, true);
    assert.match(r.summary, /2 observable check\(s\) passed/);
  });

test("evaluateVerification: any fail flips to not-ok and names the failed kind",
  { skip: verify === null }, () => {
    const r = verify.evaluateVerification([
      { kind: "branch_pushed", passed: false, detail: "HTTP 404" },
      { kind: "commit_made", passed: true, detail: "new commit" },
    ]);
    assert.equal(r.ok, false);
    assert.match(r.summary, /branch_pushed/);
    assert.match(r.summary, /HTTP 404/);
  });

// ============================================================
// beta.8 backward-compat probe shapes (THE smoke-test bug)
// ============================================================

const probesAllFail = {
  remoteBranchExists: async () => ({ exists: false, detail: "HTTP 404" }),
  prUrlPresent: async () => ({ present: false, detail: "no PR URL persisted" }),
  fileWrittenSince: async () => ({ written: false, detail: "not in diff" }),
  commitMadeSince: async () => ({ made: false, detail: "no new commit" }),
};

const probesAllPass = {
  remoteBranchExists: async () => ({ exists: true, detail: "HTTP 200" }),
  prUrlPresent: async () => ({ present: true, url: "https://github.com/x/y/pull/1", detail: "final_pr_url set" }),
  fileWrittenSince: async () => ({ written: true, detail: "file changed vs base + mtime fresh" }),
  commitMadeSince: async () => ({ made: true, detail: "HEAD != base" }),
};

test("verifySubTaskOutput: SDK 'completed' push+PR that never happened FAILS verification (beta.6 repro)",
  { skip: verify === null }, async () => {
    const out = await verify.verifySubTaskOutput(
      [{ kind: "branch_pushed", branch: "harness/smoke" }, { kind: "pr_opened" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probesAllFail,
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /branch_pushed|pr_opened/);
  });

test("verifySubTaskOutput: real observable output passes",
  { skip: verify === null }, async () => {
    const out = await verify.verifySubTaskOutput(
      [{ kind: "branch_pushed", branch: "harness/smoke" }, { kind: "pr_opened" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probesAllPass,
    );
    assert.equal(out.ok, true);
  });

test("verifySubTaskOutput: undefined verify contract = trust SDK (no probes called)",
  { skip: verify === null }, async () => {
    let called = false;
    const spy = {
      ...probesAllFail,
      remoteBranchExists: async () => { called = true; return { exists: false, detail: "" }; },
    };
    const out = await verify.verifySubTaskOutput(undefined, { defaultBranch: "", subTaskStartMs: 0, baseSha: "" }, spy);
    assert.equal(out.ok, true);
    assert.equal(called, false);
  });

// ============================================================
// beta.9 FIX: file_written uses fs.stat (not git diff)
// ============================================================

test("verifySubTaskOutput: file_written PASSES when fileExistsOnDisk returns exists=true (beta.9 fix)",
  { skip: verify === null }, async () => {
    // This is the core beta.8 bug fix: untracked file (not committed) must pass.
    const probes = {
      ...probesAllFail,
      fileExistsOnDisk: async (path) => ({ exists: true, nonEmpty: true, detail: `${path} stat OK` }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_written", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, `expected pass, got: ${out.summary}`);
    assert.match(out.results[0].detail, /stat/i);
  });

test("verifySubTaskOutput: file_written FAILS when fileExistsOnDisk returns exists=false",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllPass,
      fileExistsOnDisk: async () => ({ exists: false, nonEmpty: false, detail: "file not found" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_written", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /file_written/);
  });

test("verifySubTaskOutput: file_written FAILS when file exists but is empty",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllPass,
      fileExistsOnDisk: async () => ({ exists: true, nonEmpty: false, detail: "file exists but is empty (0 bytes)" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_written", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false, "empty file should fail file_written");
  });

test("verifySubTaskOutput: file_written falls back to fileWrittenSince when fileExistsOnDisk absent (backward compat)",
  { skip: verify === null }, async () => {
    // Existing beta.8 test doubles don't have fileExistsOnDisk; they must still work.
    let fileWrittenSinceCalled = false;
    const probes = {
      ...probesAllFail,
      fileWrittenSince: async () => { fileWrittenSinceCalled = true; return { written: true, detail: "in git diff" }; },
      // NO fileExistsOnDisk
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_written", path: "src/foo.ts" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true);
    assert.equal(fileWrittenSinceCalled, true, "should have called fileWrittenSince as fallback");
  });

// ============================================================
// file_committed (beta.9)
// ============================================================

test("verifySubTaskOutput: file_committed PASSES when file appears in git log since base",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      fileCommittedSince: async (path, baseSha) => ({ committed: true, detail: `${path} in git log since ${baseSha.slice(0,8)}` }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_committed", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc123" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
  });

test("verifySubTaskOutput: file_committed FAILS when file not in git log",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      fileCommittedSince: async () => ({ committed: false, detail: "not in git log since base" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_committed", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /file_committed/);
  });

test("verifySubTaskOutput: file_committed skips gracefully when probe absent",
  { skip: verify === null }, async () => {
    // No fileCommittedSince probe — must not throw, must pass (graceful skip).
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_committed", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probesAllFail, // no fileCommittedSince
    );
    assert.equal(out.ok, true, "graceful skip should pass when probe absent");
    assert.match(out.results[0].detail, /skipped/i);
  });

// ============================================================
// remote_branch_exists (beta.9)
// ============================================================

test("verifySubTaskOutput: remote_branch_exists PASSES when remoteBranchSha returns a sha",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      remoteBranchSha: async (branch) => ({ sha: "deadbeef1234", detail: `${branch} tip: deadbeef1234` }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "remote_branch_exists", branch: "harness/smoke" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
  });

test("verifySubTaskOutput: remote_branch_exists FAILS when remoteBranchSha returns undefined",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      remoteBranchSha: async () => ({ sha: undefined, detail: "branch not found: HTTP 404" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "remote_branch_exists", branch: "harness/smoke" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /remote_branch_exists/);
  });

test("verifySubTaskOutput: remote_branch_exists falls back to remoteBranchExists when remoteBranchSha absent",
  { skip: verify === null }, async () => {
    let rbeCalled = false;
    const probes = {
      ...probesAllFail,
      remoteBranchExists: async (branch) => { rbeCalled = true; return { exists: true, detail: `${branch} HTTP 200` }; },
      // no remoteBranchSha
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "remote_branch_exists", branch: "harness/smoke" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true);
    assert.equal(rbeCalled, true, "should fall back to remoteBranchExists");
  });

// ============================================================
// file_pushed (beta.9)
// ============================================================

test("verifySubTaskOutput: file_pushed PASSES when file exists on remote branch",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      remoteFileExists: async (path, branch) => ({ exists: true, detail: `${path} @ ${branch}: HTTP 200` }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_pushed", path: "docs/SMOKE.md", branch: "harness/smoke" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
  });

test("verifySubTaskOutput: file_pushed FAILS when file missing on remote branch",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      remoteFileExists: async () => ({ exists: false, detail: "HTTP 404 contents not found" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_pushed", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /file_pushed/);
  });

test("verifySubTaskOutput: file_pushed skips gracefully when probe absent",
  { skip: verify === null }, async () => {
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_pushed", path: "docs/SMOKE.md" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probesAllFail,
    );
    assert.equal(out.ok, true, "graceful skip");
    assert.match(out.results[0].detail, /skipped/i);
  });

// ============================================================
// pr_opened with prForBranch probe (beta.9 richer version)
// ============================================================

test("verifySubTaskOutput: pr_opened PASSES when prForBranch returns count >= 1",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prForBranch: async (branch) => ({
        count: 1,
        prs: [{ number: 42, state: "open", draft: false, url: `https://github.com/o/r/pull/42` }],
        detail: `1 PR found for ${branch}`,
      }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "pr_opened" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
    assert.match(out.results[0].detail, /42/);
  });

test("verifySubTaskOutput: pr_opened FAILS when prForBranch returns count 0",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prForBranch: async () => ({ count: 0, prs: [], detail: "no PRs found for branch" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "pr_opened" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /pr_opened/);
  });

// ============================================================
// pr_state (beta.9)
// ============================================================

test("verifySubTaskOutput: pr_state=draft PASSES when PR is draft",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prForBranch: async () => ({
        count: 1,
        prs: [{ number: 7, state: "open", draft: true, url: "https://github.com/o/r/pull/7" }],
        detail: "1 draft PR",
      }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "pr_state", state: "draft" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
    assert.match(out.results[0].detail, /draft/);
  });

test("verifySubTaskOutput: pr_state=draft FAILS when PR is open (not draft)",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prForBranch: async () => ({
        count: 1,
        prs: [{ number: 8, state: "open", draft: false, url: "https://github.com/o/r/pull/8" }],
        detail: "1 open PR",
      }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "pr_state", state: "draft" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false, "expected failure when PR is open but state=draft required");
    assert.match(out.results[0].detail, /expected draft/i);
  });

test("verifySubTaskOutput: pr_state=open PASSES when PR is open",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prForBranch: async () => ({
        count: 1,
        prs: [{ number: 9, state: "open", draft: false, url: "https://github.com/o/r/pull/9" }],
        detail: "1 open PR",
      }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "pr_state", state: "open" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
  });

test("verifySubTaskOutput: pr_state FAILS when no PR found",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prForBranch: async () => ({ count: 0, prs: [], detail: "no PRs" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "pr_state", state: "open" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.results[0].detail, /no PR found/i);
  });

test("verifySubTaskOutput: pr_state skips gracefully when prForBranch probe absent",
  { skip: verify === null }, async () => {
    const out = await verify.verifySubTaskOutput(
      [{ kind: "pr_state", state: "open" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probesAllFail,
    );
    assert.equal(out.ok, true, "graceful skip");
    assert.match(out.results[0].detail, /skipped/i);
  });

// ============================================================
// file_in_pr (beta.9)
// ============================================================

test("verifySubTaskOutput: file_in_pr PASSES when file in PR files (explicit prNumber)",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prFiles: async (prNum) => ({
        files: [{ filename: "docs/SMOKE.md" }, { filename: "README.md" }],
        detail: `PR #${prNum} has 2 files`,
      }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_in_pr", path: "docs/SMOKE.md", prNumber: 5 }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
    assert.match(out.results[0].detail, /SMOKE.md/);
  });

test("verifySubTaskOutput: file_in_pr FAILS when file NOT in PR files",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      prFiles: async () => ({
        files: [{ filename: "README.md" }],
        detail: "PR has 1 file",
      }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_in_pr", path: "docs/SMOKE.md", prNumber: 5 }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /file_in_pr/);
  });

test("verifySubTaskOutput: file_in_pr skips gracefully when probe absent",
  { skip: verify === null }, async () => {
    const out = await verify.verifySubTaskOutput(
      [{ kind: "file_in_pr", path: "docs/SMOKE.md", prNumber: 5 }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probesAllFail,
    );
    assert.equal(out.ok, true, "graceful skip");
    assert.match(out.results[0].detail, /skipped/i);
  });

// ============================================================
// commit_sha_matches (beta.9)
// ============================================================

test("verifySubTaskOutput: commit_sha_matches PASSES when local == remote SHA",
  { skip: verify === null }, async () => {
    const sha = "deadbeef12345678";
    const probes = {
      ...probesAllFail,
      localHeadSha: async () => ({ sha, detail: `local HEAD: ${sha}` }),
      remoteBranchSha: async (branch) => ({ sha, detail: `${branch} tip: ${sha}` }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "commit_sha_matches", branch: "harness/smoke" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, true, out.summary);
    assert.match(out.results[0].detail, /SHA matches/i);
  });

test("verifySubTaskOutput: commit_sha_matches FAILS when local != remote SHA",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      localHeadSha: async () => ({ sha: "local1234567890", detail: "local HEAD: local1234567890" }),
      remoteBranchSha: async () => ({ sha: "remote9876543210", detail: "remote tip: remote9876543210" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "commit_sha_matches" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.results[0].detail, /mismatch/i);
    assert.match(out.results[0].detail, /local/i);
    assert.match(out.results[0].detail, /remote/i);
  });

test("verifySubTaskOutput: commit_sha_matches FAILS when remote branch not found",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      localHeadSha: async () => ({ sha: "local1234", detail: "ok" }),
      remoteBranchSha: async () => ({ sha: undefined, detail: "branch not found: HTTP 404" }),
    };
    const out = await verify.verifySubTaskOutput(
      [{ kind: "commit_sha_matches" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    assert.match(out.results[0].detail, /not found/i);
  });

test("verifySubTaskOutput: commit_sha_matches skips gracefully when probes absent",
  { skip: verify === null }, async () => {
    const out = await verify.verifySubTaskOutput(
      [{ kind: "commit_sha_matches" }],
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probesAllFail,
    );
    assert.equal(out.ok, true, "graceful skip");
    assert.match(out.results[0].detail, /skipped/i);
  });

// ============================================================
// composite: multiple kinds in one call
// ============================================================

test("verifySubTaskOutput: composite 5-kind plan (file_written, file_committed, remote_branch_exists, pr_opened, commit_sha_matches) all pass",
  { skip: verify === null }, async () => {
    const sha = "cafebabe12345678";
    const probes = {
      remoteBranchExists: async () => ({ exists: true, detail: "HTTP 200" }),
      prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "ok" }),
      fileWrittenSince: async () => ({ written: true, detail: "in diff" }),
      commitMadeSince: async () => ({ made: true, detail: "HEAD changed" }),
      fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "stat OK 2048 bytes" }),
      fileCommittedSince: async () => ({ committed: true, detail: "in git log" }),
      remoteBranchSha: async () => ({ sha, detail: `tip: ${sha}` }),
      remoteFileExists: async () => ({ exists: true, detail: "HTTP 200" }),
      prForBranch: async () => ({
        count: 1,
        prs: [{ number: 1, state: "open", draft: false, url: "https://github.com/o/r/pull/1" }],
        detail: "1 PR",
      }),
      localHeadSha: async () => ({ sha, detail: `local: ${sha}` }),
    };
    const contract = [
      { kind: "file_written", path: "docs/SMOKE.md" },
      { kind: "file_committed", path: "docs/SMOKE.md" },
      { kind: "remote_branch_exists", branch: "harness/smoke" },
      { kind: "pr_opened" },
      { kind: "commit_sha_matches", branch: "harness/smoke" },
    ];
    const out = await verify.verifySubTaskOutput(
      contract,
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "base123" },
      probes,
    );
    assert.equal(out.ok, true, `expected all pass, got: ${out.summary}`);
    assert.equal(out.results.length, 5);
  });

test("verifySubTaskOutput: composite fails fast on first failure, records all results",
  { skip: verify === null }, async () => {
    const probes = {
      ...probesAllFail,
      fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "stat OK" }),
      fileCommittedSince: async () => ({ committed: false, detail: "not in git log — not committed yet" }),
    };
    const contract = [
      { kind: "file_written", path: "docs/SMOKE.md" },
      { kind: "file_committed", path: "docs/SMOKE.md" },
      { kind: "remote_branch_exists" },
    ];
    const out = await verify.verifySubTaskOutput(
      contract,
      { defaultBranch: "harness/smoke", subTaskStartMs: 0, baseSha: "abc" },
      probes,
    );
    assert.equal(out.ok, false);
    // file_written should pass, file_committed should fail, remote_branch_exists fallback to remoteBranchExists (fail)
    assert.equal(out.results[0].passed, true, "file_written should pass");
    assert.equal(out.results[1].passed, false, "file_committed should fail");
    assert.match(out.summary, /file_committed/);
  });

// ============================================================
// runtimeBanner: local verification treated as real runtime data
// ============================================================

test("runtimeBanner: local verification failure is CRITICAL, not 'no runtime data'",
  { skip: adversary === null || !adversary.runtimeBanner }, () => {
    const banner = adversary.runtimeBanner({
      crystallisedPrompt: "x", diffPath: "d", repoPath: "r", reviewChecklist: [], model: "m", timeoutSeconds: 1,
      runtime: {
        provider: "local",
        status: "unavailable",
        errorCount: 1,
        localVerification: [{ seq: 3, ok: false, summary: "branch_pushed (HTTP 404)" }],
      },
    });
    assert.match(banner, /LOCAL VERIFICATION/);
    assert.match(banner, /CRITICAL/);
    assert.doesNotMatch(banner, /NO RUNTIME DATA AVAILABLE/);
  });

test("runtimeBanner: local verification all-pass reads as verified runtime data",
  { skip: adversary === null || !adversary.runtimeBanner }, () => {
    const banner = adversary.runtimeBanner({
      crystallisedPrompt: "x", diffPath: "d", repoPath: "r", reviewChecklist: [], model: "m", timeoutSeconds: 1,
      runtime: {
        provider: "local",
        status: "ok",
        errorCount: 0,
        localVerification: [{ seq: 1, ok: true, summary: "all 1 observable check(s) passed" }],
      },
    });
    assert.match(banner, /verified against git\/provider\/disk/);
  });
