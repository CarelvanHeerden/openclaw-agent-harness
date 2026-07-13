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
});

test("system prompt: includes runtime banner + checklist",
  { skip: runtimeBanner === null }, () => {
    const p = buildAdversarySystemPrompt({ ...inputBase, runtime: { provider: "vercel", status: "no_deploy_yet" } });
    assert.match(p, /NO RUNTIME DATA/);
    assert.match(p, /- a/);
    assert.match(p, /- b/);
  });

test("runAdversary: silent pass without runtime data becomes revise + injected finding",
  { skip: runtimeBanner === null }, async () => {
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
    assert.equal(report.verdict, "revise");
    assert.ok(report.findings.find((f) => f.dimension === "runtime" && f.severity === "medium"));
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
