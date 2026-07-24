import test from "node:test";
import assert from "node:assert/strict";

let runtimeBanner, runAdversary, buildAdversarySystemPrompt;
try {
  ({ runtimeBanner, runAdversary, buildAdversarySystemPrompt } = await import("../dist/orchestrator/fable5-adversary.js"));
} catch {
  runtimeBanner = null;
}

const inputBase = {
  crystallisedPrompt: "add a hello endpoint",
  diffPath: "/tmp/diff.txt",
  repoPath: "/tmp/repo",
  reviewChecklist: ["a", "b"],
  model: "claude-fable-5",
  timeoutSeconds: 60,
};

test("runtimeBanner: covers all statuses", { skip: runtimeBanner === null }, () => {
  assert.match(runtimeBanner({ ...inputBase }), /NO RUNTIME DATA/);
  assert.match(runtimeBanner({ ...inputBase, runtime: { provider: "vercel", status: "ok", deploymentUrl: "https://x.vercel.app", errorCount: 0 } }), /RUNTIME DATA/);
  assert.match(runtimeBanner({ ...inputBase, runtime: { provider: "vercel", status: "no_deploy_yet" } }), /NO RUNTIME DATA/);
  assert.match(runtimeBanner({ ...inputBase, runtime: { provider: "vercel", status: "build_failed" } }), /build FAILED/);
  assert.match(runtimeBanner({ ...inputBase, runtime: { provider: "vercel", status: "unavailable" } }), /NO RUNTIME DATA/);
  // Manual upload path (non-Vercel deploys)
  const manualOk = runtimeBanner({ ...inputBase, runtime: { provider: "manual", status: "ok", source: "nginx access", uploadedBy: "U1", errorCount: 2 } });
  assert.match(manualOk, /MANUAL UPLOAD/);
  assert.match(manualOk, /nginx access/);
  assert.match(manualOk, /uploaded by U1/);
  assert.match(manualOk, /2 error/);
  const manualBuildFail = runtimeBanner({ ...inputBase, runtime: { provider: "manual", status: "build_failed", deploymentUrl: "https://ci/log/42" } });
  assert.match(manualBuildFail, /build FAILED/);
  assert.match(manualBuildFail, /MANUAL UPLOAD/);
});

test("system prompt: includes runtime banner + checklist",
  { skip: runtimeBanner === null }, () => {
    const p = buildAdversarySystemPrompt({ ...inputBase, runtime: { provider: "vercel", status: "no_deploy_yet" } });
    assert.match(p, /NO RUNTIME DATA/);
    assert.match(p, /- a/);
    assert.match(p, /- b/);
  });

test("beta69: no runtime data injects a NON-blocking info finding and does NOT force-upgrade pass->revise",
  { skip: runtimeBanner === null }, async () => {
    // beta.69 (F1): the old force-upgrade of pass->revise on missing runtime is
    // DELETED (it made every un-pushed diff structurally unable to converge --
    // forensic 1f2e6642 revised 3x on this alone). The concern is now surfaced
    // as an `info` finding for the PR body, and the verdict is left alone.
    const report = await runAdversary(
      { ...inputBase, runtime: { provider: "vercel", status: "no_deploy_yet" } },
      {
        logger: { info() {}, warn() {} },
        readDiff: async () => "diff --git a b\n+hello",
        callAdversaryModel: async () => ({
          parsed: { verdict: "pass", findings: [], summary: "looks good" },
          sdkSessionId: "sdk-1",
          costUsd: 0.02,
          tokensIn: 1000,
          tokensOut: 200,
        }),
      },
    );
    assert.equal(report.verdict, "pass");
    const rf = report.findings.find((f) => f.dimension === "runtime");
    assert.ok(rf, "a runtime note is injected");
    assert.equal(rf.severity, "info", "the runtime note is non-blocking info, not medium");
  });

test("runAdversary: pass when runtime data is ok is preserved",
  { skip: runtimeBanner === null }, async () => {
    const report = await runAdversary(
      { ...inputBase, runtime: { provider: "vercel", status: "ok", errorCount: 0 } },
      {
        logger: { info() {}, warn() {} },
        readDiff: async () => "diff",
        callAdversaryModel: async () => ({
          parsed: { verdict: "pass", findings: [], summary: "shipit" },
          sdkSessionId: "sdk-1",
          costUsd: 0.02,
          tokensIn: 100,
          tokensOut: 50,
        }),
      },
    );
    assert.equal(report.verdict, "pass");
  });
