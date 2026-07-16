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

// --- evaluateVerification ---

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

// --- verifySubTaskOutput with stub probes (THE smoke-test bug) ---

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

// --- runtimeBanner: local verification is treated as real runtime data ---

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
