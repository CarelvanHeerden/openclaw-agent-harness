// beta.69: adversary convergence gate + env-127 bootstrap hardening.
//
// Targets the forensic 1f2e6642 failure: cycle-1 shipped a correct 30-LOC diff,
// then the adversary voted `revise` 3x -- twice on all-green convention passes --
// burning $4.54/1h29m with no PR. Root cause: findings counted toward the verdict
// without asking "can a diff-cycle worker fix this?".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const S = (p) => readFileSync(join(ROOT, p), "utf8");

let classify;
try {
  classify = await import("../dist/orchestrator/finding-classify.js");
} catch {
  classify = null;
}
let adversary;
try {
  adversary = await import("../dist/orchestrator/fable5-adversary.js");
} catch {
  adversary = null;
}

const F = (over = {}) => ({
  dimension: over.dimension ?? "quality",
  severity: over.severity ?? "medium",
  title: over.title ?? "",
  detail: over.detail ?? "",
});

// ---- F1: classifyFinding ----
test("beta69: classifyFinding buckets the real 1f2e6642 findings", { skip: classify === null }, () => {
  const { classifyFinding } = classify;
  // "No runtime data" -> unproven_runtime
  assert.equal(
    classifyFinding(F({ dimension: "runtime", title: "No runtime data", detail: "no preview deploy" }), { runtimeUnavailable: true }),
    "unproven_runtime",
  );
  // no-tests when repo has no test script -> process
  assert.equal(
    classifyFinding(F({ dimension: "quality", title: "Behaviour change ships with zero test changes" }), { repoHasTestScript: false }),
    "process",
  );
  assert.equal(
    classifyFinding(F({ dimension: "quality", title: "New unit tests are not executed by any declared check script" }), { repoHasTestScript: false }),
    "process",
  );
  // exit 127 / command not found -> env
  assert.equal(
    classifyFinding(F({ dimension: "fit", title: "Repo check script 'lint' failed (exit 127)", detail: "eslint: not found" })),
    "env",
  );
  // platform size limit -> architectural
  assert.equal(
    classifyFinding(F({ dimension: "runtime", title: "5000-row response may exceed platform payload size limit" })),
    "architectural",
  );
  // a real code concern -> diff_addressable
  assert.equal(
    classifyFinding(F({ dimension: "quality", title: "orderBy is duplicated between the list and export branches" })),
    "diff_addressable",
  );
});

test("beta69: no-tests is diff_addressable when the repo DOES declare a test script", { skip: classify === null }, () => {
  const { classifyFinding } = classify;
  assert.equal(
    classifyFinding(F({ dimension: "quality", title: "no tests added for the new export path" }), { repoHasTestScript: true }),
    "diff_addressable",
  );
});

test("beta69: isBlockingFinding only for diff_addressable medium+", { skip: classify === null }, () => {
  const { isBlockingFinding } = classify;
  assert.equal(isBlockingFinding(F({ severity: "medium" }), "diff_addressable"), true);
  assert.equal(isBlockingFinding(F({ severity: "high" }), "diff_addressable"), true);
  assert.equal(isBlockingFinding(F({ severity: "low" }), "diff_addressable"), false);
  assert.equal(isBlockingFinding(F({ severity: "info" }), "diff_addressable"), false);
  assert.equal(isBlockingFinding(F({ severity: "critical" }), "unproven_runtime"), false);
  assert.equal(isBlockingFinding(F({ severity: "critical" }), "process"), false);
  assert.equal(isBlockingFinding(F({ severity: "critical" }), "env"), false);
});

// ---- F3: recycled findings ----
test("beta69: isRecycledFinding matches a prior-cycle finding on dimension+title overlap", { skip: classify === null }, () => {
  const { isRecycledFinding } = classify;
  const prior = [F({ dimension: "runtime", title: "No runtime verification of acceptance criteria" })];
  assert.equal(isRecycledFinding(F({ dimension: "runtime", title: "No runtime verification available at review time" }), prior), true);
  // different dimension -> not recycled
  assert.equal(isRecycledFinding(F({ dimension: "quality", title: "No runtime verification of acceptance criteria" }), prior), false);
  // unrelated title -> not recycled
  assert.equal(isRecycledFinding(F({ dimension: "runtime", title: "Build failed with a stack overflow" }), prior), false);
  // no prior -> not recycled
  assert.equal(isRecycledFinding(F({ dimension: "runtime", title: "anything at all here" }), []), false);
});

// ---- F1: gateVerdict ----
test("beta69: gateVerdict downgrades revise->pass when all findings are non-blocking (the cycle-2 all-green case)", { skip: classify === null }, () => {
  const { gateVerdict } = classify;
  const findings = [
    F({ dimension: "runtime", severity: "medium", title: "No runtime data" }),
    F({ dimension: "quality", severity: "medium", title: "no tests are wired into a declared check script" }),
    F({ dimension: "runtime", severity: "low", title: "5000-row response vs platform limit" }),
  ];
  const out = gateVerdict({ verdict: "revise", findings, ctx: { repoHasTestScript: false, runtimeUnavailable: true } });
  assert.equal(out.verdict, "pass");
  assert.equal(out.downgraded, true);
  assert.equal(out.newBlocking.length, 0);
});

test("beta69: gateVerdict keeps revise when there is a NEW diff-addressable medium+ finding", { skip: classify === null }, () => {
  const { gateVerdict } = classify;
  const findings = [
    F({ dimension: "runtime", severity: "medium", title: "No runtime data" }),
    F({ dimension: "quality", severity: "medium", title: "SQL injection via unsanitised orderBy param" }),
  ];
  const out = gateVerdict({ verdict: "revise", findings, ctx: { repoHasTestScript: false, runtimeUnavailable: true } });
  assert.equal(out.verdict, "revise");
  assert.equal(out.downgraded, false);
  assert.equal(out.newBlocking.length, 1);
});

test("beta69: gateVerdict does NOT sustain revise on a RECYCLED blocking finding", { skip: classify === null }, () => {
  const { gateVerdict } = classify;
  const prior = [F({ dimension: "quality", severity: "medium", title: "orderBy duplicated between branches" })];
  const findings = [F({ dimension: "quality", severity: "medium", title: "orderBy duplicated between the two branches" })];
  const out = gateVerdict({ verdict: "revise", findings, ctx: {}, priorFindings: prior });
  assert.equal(out.verdict, "pass");
  assert.equal(out.downgraded, true);
});

test("beta69: gateVerdict never downgrades block; leaves pass alone", { skip: classify === null }, () => {
  const { gateVerdict } = classify;
  const block = gateVerdict({ verdict: "block", findings: [F({ severity: "info" })], ctx: {} });
  assert.equal(block.verdict, "block");
  const pass = gateVerdict({ verdict: "pass", findings: [], ctx: {} });
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.downgraded, false);
});

// ---- F1 behavioural via runAdversary ----
test("beta69: runAdversary downgrades a model 'revise' with only non-blocking findings to 'pass'", { skip: adversary === null }, async () => {
  const { runAdversary } = adversary;
  const report = await runAdversary(
    {
      crystallisedPrompt: "add ?all=true export",
      diffPath: "/tmp/x.diff",
      repoPath: "/tmp/repo",
      runtime: { provider: "local", status: "ok", errorCount: 0, localVerification: [{ seq: 1, ok: true, summary: "lint/typecheck green" }] },
      reviewChecklist: ["export uncapped when all=true"],
      model: "m",
      timeoutSeconds: 10,
      repoHasTestScript: false,
    },
    {
      logger: { info() {}, warn() {} },
      readDiff: async () => "diff",
      callAdversaryModel: async () => ({
        parsed: {
          verdict: "revise",
          findings: [
            { dimension: "runtime", severity: "medium", title: "No runtime data", detail: "no preview deploy" },
            { dimension: "quality", severity: "medium", title: "no tests wired into a declared check script", detail: "" },
          ],
          summary: "green but wants tests+runtime",
        },
        sdkSessionId: "s", costUsd: 0.01, tokensIn: 10, tokensOut: 10,
      }),
    },
  );
  assert.equal(report.verdict, "pass");
});

test("beta69: runAdversary keeps 'revise' when a NEW diff-addressable medium+ finding exists", { skip: adversary === null }, async () => {
  const { runAdversary } = adversary;
  const report = await runAdversary(
    {
      crystallisedPrompt: "x", diffPath: "/tmp/x.diff", repoPath: "/tmp/repo",
      runtime: { provider: "local", status: "ok", errorCount: 0, localVerification: [{ seq: 1, ok: true, summary: "green" }] },
      reviewChecklist: [], model: "m", timeoutSeconds: 10, repoHasTestScript: false,
    },
    {
      logger: { info() {}, warn() {} },
      readDiff: async () => "diff",
      callAdversaryModel: async () => ({
        parsed: { verdict: "revise", findings: [{ dimension: "spec", severity: "high", title: "export ignores the where filter, leaking all rows", detail: "" }], summary: "real bug" },
        sdkSessionId: "s", costUsd: 0.01, tokensIn: 10, tokensOut: 10,
      }),
    },
  );
  assert.equal(report.verdict, "revise");
});

// ---- source-assertion wiring ----
test("beta69: force-upgrade pass->revise is DELETED from runAdversary (source)", () => {
  const src = S("src/orchestrator/fable5-adversary.ts");
  assert.doesNotMatch(src, /if \(verdict === "pass"\) verdict = "revise";/);
  assert.match(src, /gateVerdict\(\{/);
  // the injected missing-runtime finding is now info, not medium
  const block = src.slice(src.indexOf("runtimeUnavailable && !findings.some"), src.indexOf("beta.69 (F1): the verdict gate"));
  assert.match(block, /severity: "info"/);
});

test("beta69: index.ts wires priorFindings + repoHasTestScript into runAdversaryCore (source)", () => {
  const src = S("src/index.ts");
  assert.match(src, /runAdversary: async \(\{ brief, plan, runtime, baseSha, priorFindings \}\)/);
  assert.match(src, /priorFindings,/);
  assert.match(src, /repoHasTestScript:/);
  assert.match(src, /discoverCheckScripts\(plan\.worktreePath\)\.some\(\(s\) => s\.name === "test"\)/);
});

test("beta69 (F4): runCheckScripts classifies exit 127 / command-not-found as unrunnable env, not a finding (source)", () => {
  const src = S("src/orchestrator/repo-conventions.ts");
  assert.match(src, /out\.status === 127 \|\| \/\\b\(command not found/);
  assert.match(src, /env_unavailable: check-script binary missing/);
});

test("beta69 (F4): worktree bootstrap re-installs when a declared check-script binary is missing + uses --ignore-scripts (source)", () => {
  const src = S("src/adapters/git-worktree.ts");
  assert.match(src, /declaredCheckBinsPresent\(worktreePath\)/);
  assert.match(src, /"ci", "--ignore-scripts"/);
  assert.match(src, /"install", "--include=dev", "--ignore-scripts"/);
});

test("beta69 (F5): loop discards a post-cancel adversary review + audits converged_on_green (source)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /"loop\.review_discarded_post_cancel"/);
  assert.match(src, /postReviewReactions\.abort/);
  assert.match(src, /"loop\.converged_on_green"/);
  // priorFindings threaded from the prior cycle's review
  assert.match(src, /priorFindings: lastReview\?\.findings/);
});
