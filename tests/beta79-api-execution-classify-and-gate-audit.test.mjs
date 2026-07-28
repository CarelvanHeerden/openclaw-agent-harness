// beta.79: API-execution AC classification (F1) + loop.gate_decision audit (F2).
//
// F1 origin: the beta.77 DR/BCP smoke (session 95b341cb, PR #881). The lead
// silently pivoted an API-execution task (every AC a live-system side-effect)
// into markdown docs, because it has no execute-against-external-API mode. The
// crystalliser now detects that class on the crystallised brief and returns a
// `clarify` instead of a brief.
//
// F2 origin: Staging's forensic had to re-implement finding-classify in python
// to answer "was cycle N churn or a legit new finding?". A per-cycle
// loop.gate_decision {newBlocking, recycled, downgraded} audit event makes it a
// one-query answer.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const S = (p) => readFileSync(join(ROOT, p), "utf8");

let detect;
try {
  detect = await import("../dist/crystallise/api-execution-detect.js");
} catch {
  detect = null;
}
let refiner;
try {
  ({ crystallisePrompt: refiner } = await import("../dist/crystallise/prompt-refiner.js"));
} catch {
  refiner = null;
}
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

const noopLogger = { info() {}, warn() {} };

// The actual DR/BCP smoke acceptance criteria (paraphrased from the brief that
// produced PR #881) -- an API-EXECUTION task end to end.
const DR_BCP_ACS = [
  "POST /api/security/night-agents/upload with the PDF and keep the returned internal url",
  "POST /api/grc/evidence with controlId and the internal fileUrl; on success returns 201 { data: { id } }",
  "GET /api/grc/evidence?controlId=cmo2vp8me01k0y4itwr2nmnir confirms the new evidence row exists",
  "Verify the token scope then DELETE /api/grc/policies/cmn7y3cc30028slit8q55dbnk which returns { ok: true }",
  "GET /api/grc/policies?limit=500 no longer lists GD-STITCH-04",
];

// ---- F1: detector ----

test("beta79: the DR/BCP acceptance criteria are detected as API-execution", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief(
    { acceptanceCriteria: DR_BCP_ACS, title: "File DR evidence and de-list GD-STITCH-04", motivation: "Migrate the misfiled policy into evidence" },
  );
  assert.equal(r.isApiExecution, true, r.reason);
  assert.ok(r.matchedCriteria.length >= 2);
  assert.ok(r.ratio >= 0.4);
});

test("beta79: a normal repo task that merely mentions an endpoint does NOT trip", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief({
    acceptanceCriteria: [
      "Add a route handler in src/routes/hello.ts",
      "Write a unit test asserting the handler returns 201 for a valid body",
      "Refactor the shared validation util",
    ],
    title: "Add hello endpoint",
    motivation: "smoke endpoint",
  });
  assert.equal(r.isApiExecution, false, r.reason);
});

test("beta79: a pure-docs task does NOT trip", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief({
    acceptanceCriteria: [
      "Document the governed-vs-evidence boundary rule in docs/grc/governed-vs-evidence.md",
      "Add a runbook at runbooks/grc/dr-bcp-test-evidence-filing.md",
    ],
    title: "Document the boundary rule",
    motivation: "clarify policy vs evidence",
  });
  assert.equal(r.isApiExecution, false, r.reason);
});

test("beta79: min-criteria gate -- a single API-execution AC among many does NOT fire", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief({
    acceptanceCriteria: [
      "Refactor the taxonomy hook",
      "Add tests for the dropdown",
      "Update the docs page",
      "POST /api/grc/evidence with the file to seed one example row",
    ],
    title: "Taxonomy dropdown",
    motivation: "populate from real source",
  });
  // 1 matched of 4 => below both min-criteria (2) and ratio (0.25 < 0.4)
  assert.equal(r.isApiExecution, false, r.reason);
});

test("beta79: dominance ratio gate -- 2 matched of 6 is below 0.4 and does NOT fire", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief({
    acceptanceCriteria: [
      "POST /api/foo returns { ok: true }",
      "DELETE /api/bar returns 200",
      "Refactor module A",
      "Add tests for module B",
      "Update docs",
      "Bump the changelog",
    ],
    title: "mixed",
    motivation: "mixed",
  });
  // 2 matched of 6 => ratio 0.33 < 0.4
  assert.equal(r.isApiExecution, false, r.reason);
});

test("beta79: master switch off => never fires even on the DR/BCP ACs", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief(
    { acceptanceCriteria: DR_BCP_ACS, title: "x", motivation: "y" },
    { enabled: false },
  );
  assert.equal(r.isApiExecution, false, r.reason);
});

test("beta79: thresholds are honoured (lowering ratio+criteria fires on a smaller share)", { skip: detect === null }, () => {
  const acs = [
    "POST /api/foo returns { ok: true }",
    "Refactor module A",
    "Add tests for module B",
  ];
  const strict = detect.detectApiExecutionBrief({ acceptanceCriteria: acs, title: "x", motivation: "y" });
  assert.equal(strict.isApiExecution, false, strict.reason);
  const loose = detect.detectApiExecutionBrief(
    { acceptanceCriteria: acs, title: "x", motivation: "y" },
    { minCriteria: 1, minRatio: 0.3 },
  );
  assert.equal(loose.isApiExecution, true, loose.reason);
});

test("beta79: empty acceptanceCriteria never fires", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief({ acceptanceCriteria: [], title: "x", motivation: "y" });
  assert.equal(r.isApiExecution, false);
});

test("beta79: buildApiExecutionClarification names the choice", { skip: detect === null }, () => {
  const r = detect.detectApiExecutionBrief({ acceptanceCriteria: DR_BCP_ACS, title: "x", motivation: "y" });
  const q = detect.buildApiExecutionClarification(r);
  assert.match(q, /live external system/i);
  assert.match(q, /repo code/i);
  assert.match(q, /out of scope/i);
});

// ---- F1: crystallise wiring ----

test("beta79: crystallisePrompt returns clarify on an API-execution brief", { skip: refiner === null }, async () => {
  const brief = {
    title: "File DR evidence and de-list GD-STITCH-04",
    motivation: "Migrate the misfiled policy into evidence and remove it",
    acceptanceCriteria: DR_BCP_ACS,
    filesLikelyTouched: [],
    outOfScope: [],
    riskLevel: "high",
  };
  const result = await refiner("file the DR report as evidence and delete GD-STITCH-04", {
    config: { brief: { api_execution_detection: true, api_execution_min_criteria: 2, api_execution_min_ratio: 0.4 } },
    logger: noopLogger,
    callClassifier: async () => ({ intent: "dev_task", reason: "dev-shaped" }),
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "clarify");
  assert.match(result.question, /live external system/i);
});

test("beta79: crystallisePrompt returns a brief on a normal repo task", { skip: refiner === null }, async () => {
  const brief = {
    title: "Add hello endpoint",
    motivation: "We need a /hello endpoint for smoke tests",
    acceptanceCriteria: [
      "Add a route handler in src/routes/hello.ts",
      "Write a unit test asserting the handler returns 200",
    ],
    filesLikelyTouched: ["src/routes/hello.ts"],
    outOfScope: [],
    riskLevel: "low",
  };
  const result = await refiner("add a /hello endpoint", {
    config: { brief: { api_execution_detection: true } },
    logger: noopLogger,
    callClassifier: async () => ({ intent: "dev_task", reason: "code change" }),
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "brief");
  assert.deepEqual(result.brief, brief);
});

test("beta79: detection off => an API-execution brief passes through as a brief", { skip: refiner === null }, async () => {
  const brief = {
    title: "File DR evidence",
    motivation: "migrate the policy to evidence",
    acceptanceCriteria: DR_BCP_ACS,
    filesLikelyTouched: [],
    outOfScope: [],
    riskLevel: "high",
  };
  const result = await refiner("do the API dance", {
    config: { brief: { api_execution_detection: false } },
    logger: noopLogger,
    callClassifier: async () => ({ intent: "dev_task", reason: "dev-shaped" }),
    callCrystalliser: async () => brief,
  });
  assert.equal(result.kind, "brief");
});

test("beta79: a partial config (no brief block) does not throw and detection defaults on", { skip: refiner === null }, async () => {
  const brief = {
    title: "x",
    motivation: "migrate the policy to evidence",
    acceptanceCriteria: DR_BCP_ACS,
    filesLikelyTouched: [],
    outOfScope: [],
    riskLevel: "high",
  };
  const result = await refiner("do the API dance", {
    config: {},
    logger: noopLogger,
    callClassifier: async () => ({ intent: "dev_task", reason: "dev-shaped" }),
    callCrystalliser: async () => brief,
  });
  // defaults on => the DR/BCP brief is caught
  assert.equal(result.kind, "clarify");
});

// ---- F2: gateVerdict returns recycled ----

const CTX = { repoHasTestScript: true, runtimeUnavailable: false };

test("beta79: gateVerdict returns the recycled set", { skip: classify === null }, () => {
  const { gateVerdict } = classify;
  const prior = [{ dimension: "spec", severity: "medium", title: "handler missing null guard", detail: "" }];
  const findings = [
    { dimension: "spec", severity: "medium", title: "handler missing null guard", detail: "" }, // recycled
    { dimension: "quality", severity: "medium", title: "new dead code path introduced", detail: "" }, // new blocking
  ];
  const g = gateVerdict({ verdict: "revise", findings, ctx: CTX, priorFindings: prior });
  assert.equal(g.recycled.length, 1);
  assert.equal(g.newBlocking.length, 1);
  assert.equal(g.downgraded, false);
  assert.equal(g.verdict, "revise");
});

test("beta79: gateVerdict downgrades a revise with only recycled findings and reports them", { skip: classify === null }, () => {
  const { gateVerdict } = classify;
  const prior = [{ dimension: "spec", severity: "medium", title: "handler missing null guard", detail: "" }];
  const findings = [
    { dimension: "spec", severity: "medium", title: "handler missing null guard", detail: "" }, // recycled -> not new
  ];
  const g = gateVerdict({ verdict: "revise", findings, ctx: CTX, priorFindings: prior });
  assert.equal(g.downgraded, true);
  assert.equal(g.verdict, "pass");
  assert.equal(g.recycled.length, 1);
  assert.equal(g.newBlocking.length, 0);
});

// ---- F2: runAdversary threads the gate breakdown onto the report ----

test("beta79: runAdversary populates gateNewBlocking/gateRecycled/gateDowngraded", { skip: adversary === null }, async () => {
  const { runAdversary } = adversary;
  const report = await runAdversary(
    {
      crystallisedPrompt: "brief",
      diffPath: "/tmp/x.diff",
      repoPath: "/tmp/repo",
      reviewChecklist: ["c1"],
      model: "m",
      repoHasTestScript: true,
      priorFindings: [{ dimension: "spec", severity: "medium", title: "handler missing null guard", detail: "" }],
    },
    {
      logger: noopLogger,
      readDiff: async () => "diff --git a b",
      callAdversaryModel: async () => ({
        parsed: {
          verdict: "revise",
          findings: [
            { dimension: "spec", severity: "medium", title: "handler missing null guard", detail: "" }, // recycled
          ],
          summary: "s",
        },
        sdkSessionId: "sess",
        costUsd: 0.1,
        tokensIn: 1,
        tokensOut: 1,
      }),
    },
  );
  assert.equal(typeof report.gateNewBlocking, "number");
  assert.equal(report.gateRecycled, 1);
  assert.equal(report.gateDowngraded, true);
  assert.equal(report.verdict, "pass"); // downgraded (only recycled)
});

// ---- F2: loop emits loop.gate_decision (source assertions) ----

test("beta79: loop.ts emits loop.gate_decision guarded on the gate fields", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /loop\.gate_decision/);
  assert.match(src, /typeof report\.gateNewBlocking === "number"/);
  assert.match(src, /newBlocking: report\.gateNewBlocking/);
  assert.match(src, /recycled: report\.gateRecycled \?\? 0/);
  assert.match(src, /downgraded: report\.gateDowngraded === true/);
});

test("beta79: prompt-refiner wires the api-execution detector before validateBrief", () => {
  const src = S("src/crystallise/prompt-refiner.ts");
  assert.match(src, /detectApiExecutionBrief/);
  assert.match(src, /buildApiExecutionClarification/);
  // detection must run BEFORE validateBrief (it returns clarify, not a brief)
  const detIdx = src.indexOf("detectApiExecutionBrief(brief");
  const valIdx = src.indexOf("validateBrief(brief)");
  assert.ok(detIdx > 0 && valIdx > 0 && detIdx < valIdx, "detection must precede validateBrief");
});

// ---- config + manifest ----

test("beta79: config defaults declare the three api_execution keys", () => {
  const src = S("src/config.ts");
  assert.match(src, /api_execution_detection: true/);
  assert.match(src, /api_execution_min_criteria: 2/);
  assert.match(src, /api_execution_min_ratio: 0\.4/);
});

test("beta79: manifest declares the three api_execution keys under brief", () => {
  const manifest = JSON.parse(S("openclaw.plugin.json"));
  // walk to the brief config schema
  const json = JSON.stringify(manifest);
  assert.match(json, /"api_execution_detection"/);
  assert.match(json, /"api_execution_min_criteria"/);
  assert.match(json, /"api_execution_min_ratio"/);
});

test("beta79: version.ts pluginVersion matches package.json (beta.77 miss lesson)", () => {
  const ver = S("src/version.ts");
  const pkg = JSON.parse(S("package.json"));
  assert.match(ver, new RegExp(`pluginVersion: "${pkg.version.replace(/\./g, "\\.")}"`));
});
