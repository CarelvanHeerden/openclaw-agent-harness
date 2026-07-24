// beta.70: the 10-minute-ceiling release.
//
// Targets PR #870: a +33/-1 change took 59m44s and ended `needs_human_review`.
// Root causes fixed here:
//   F1 worker-slim  -- worker ran `npm run okf` (1436 files) + repo-wide tsc IN-TURN.
//   F2 okf-nonblock -- the OKF-regen finding force-revised a clean pass (cycle-2).
//   F3 adversary fmt-- cycle-2 adversary emitted a bash tool-call, not a verdict.
//   F4 oom-blocker  -- typecheck OOM'd at 4GB, silently swallowed -> false green.
//   F5 skip-reprobe -- cycle-2 re-ran the seq-1 observe probe for 58s/$0.29.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const S = (p) => readFileSync(join(ROOT, p), "utf8");

let classify = null;
try { classify = await import("../dist/orchestrator/finding-classify.js"); } catch { /* build first */ }
let conventions = null;
try { conventions = await import("../dist/orchestrator/repo-conventions.js"); } catch { /* build first */ }
let adversary = null;
try { adversary = await import("../dist/orchestrator/fable5-adversary.js"); } catch { /* build first */ }

const F = (over = {}) => ({
  dimension: over.dimension ?? "quality",
  severity: over.severity ?? "medium",
  title: over.title ?? "",
  detail: over.detail ?? "",
});

// ---------------------------------------------------------------------------
// F2: OKF-regen / generated-artifact findings classify as non-blocking `process`
// ---------------------------------------------------------------------------
test("beta70 F2: OKF-bundle-regen findings classify as process (non-blocking)", { skip: classify === null }, () => {
  const { classifyFinding, isBlockingFinding } = classify;
  const cases = [
    "The OKF bundle was not regenerated after this change",
    "Run `npm run okf` to regenerate the bundle",
    "keep-okf-current: bundle is stale",
    "Generated bundle is out of date",
    "okf:check reports the bundle must be regenerated",
  ];
  for (const title of cases) {
    const cls = classifyFinding(F({ dimension: "fit", severity: "medium", title }));
    assert.equal(cls, "process", `"${title}" should be process, got ${cls}`);
    assert.equal(isBlockingFinding(F({ dimension: "fit", severity: "medium", title }), cls), false, `"${title}" must be non-blocking`);
  }
});

test("beta70 F2: a REAL code defect that merely mentions okf stays diff_addressable", { skip: classify === null }, () => {
  const { classifyFinding } = classify;
  // Genuine logic defect in a source file; must NOT be demoted just for the word.
  assert.equal(
    classifyFinding(F({ dimension: "quality", severity: "high", title: "orderBy is duplicated between the list and export branches" })),
    "diff_addressable",
  );
});

test("beta70 F2: env-127 still wins over generated-artifact (okf:check exit 127 -> env)", { skip: classify === null }, () => {
  const { classifyFinding } = classify;
  // An okf:check that could not run (missing binary) is an ENV gap, not a
  // process concern about a stale bundle.
  assert.equal(
    classifyFinding(F({ dimension: "fit", title: "Repo check script 'okf:check' failed (exit 127)", detail: "okf: not found" })),
    "env",
  );
});

test("beta70 F2: gateVerdict keeps a clean pass when the only findings are OKF-regen", { skip: classify === null }, () => {
  const { gateVerdict } = classify;
  const gated = gateVerdict({
    verdict: "revise",
    findings: [
      F({ dimension: "fit", severity: "medium", title: "OKF bundle not regenerated" }),
      F({ dimension: "runtime", severity: "info", title: "No runtime data" }),
      F({ dimension: "quality", severity: "low", title: "skip: 0 is redundant" }),
    ],
    ctx: { repoHasTestScript: true, runtimeUnavailable: true },
  });
  assert.equal(gated.verdict, "pass", "no NEW blocking finding -> converged pass");
  assert.equal(gated.newBlocking.length, 0);
});

// ---------------------------------------------------------------------------
// F3: adversary format-guard + retry
// ---------------------------------------------------------------------------
test("beta70 F3: isAdversaryFormatError detects the #870 missing-keys crash", { skip: adversary === null }, () => {
  const { isAdversaryFormatError } = adversary;
  assert.equal(isAdversaryFormatError(new Error("[adversary] JSON missing required keys: verdict, findings, summary")), true);
  assert.equal(isAdversaryFormatError(new Error("[adversary] JSON.parse failed: Unexpected token")), true);
  assert.equal(isAdversaryFormatError(new Error("[adversary] extractJson failed: no JSON found")), true);
  // A timeout or generic SDK error is NOT a format error (must propagate).
  assert.equal(isAdversaryFormatError(new Error("worker timed out after 900s")), false);
  assert.equal(isAdversaryFormatError(new Error("ECONNRESET")), false);
});

test("beta70 F3: runAdversary retries ONCE on a format error and succeeds", { skip: adversary === null }, async () => {
  const { runAdversary, ADVERSARY_FORMAT_RETRY_NUDGE } = adversary;
  let calls = 0;
  const nudged = [];
  const report = await runAdversary(
    {
      crystallisedPrompt: "brief", diffPath: "/tmp/d.diff", repoPath: "/tmp/r",
      reviewChecklist: ["c1"], model: "claude-fable-5", timeoutSeconds: 30,
      runtime: { provider: "local", status: "ok", localVerification: [{ seq: 1, ok: true, summary: "ok" }], errorCount: 0 },
    },
    {
      logger: { info: () => {}, warn: () => {} },
      readDiff: async () => "diff --git ...",
      callAdversaryModel: async ({ systemPrompt }) => {
        calls += 1;
        nudged.push(systemPrompt.includes("RETRY -- your previous response was rejected"));
        if (calls === 1) {
          // Simulate the #870 crash: parser rejected a bash tool-call.
          throw new Error("[adversary] JSON missing required keys: verdict, findings, summary\n--- extracted ---\n{ \"command\": \"ls\" }");
        }
        return { parsed: { verdict: "pass", findings: [], summary: "ok" }, sdkSessionId: "s", costUsd: 0.01, tokensIn: 1, tokensOut: 1 };
      },
    },
  );
  assert.equal(calls, 2, "must retry exactly once");
  assert.equal(nudged[0], false, "first call has no retry nudge");
  assert.equal(nudged[1], true, "retry call carries the format nudge");
  assert.equal(report.verdict, "pass");
  assert.ok(ADVERSARY_FORMAT_RETRY_NUDGE.includes("verdict"), "nudge names the verdict");
});

test("beta70 F3: runAdversary does NOT retry a non-format error (propagates)", { skip: adversary === null }, async () => {
  const { runAdversary } = adversary;
  let calls = 0;
  await assert.rejects(
    runAdversary(
      { crystallisedPrompt: "b", diffPath: "/tmp/d", repoPath: "/tmp/r", reviewChecklist: [], model: "m", timeoutSeconds: 30 },
      {
        logger: { info: () => {}, warn: () => {} },
        readDiff: async () => "diff",
        callAdversaryModel: async () => { calls += 1; throw new Error("worker timed out after 900s"); },
      },
    ),
    /timed out/,
  );
  assert.equal(calls, 1, "a non-format error must NOT be retried");
});

// ---------------------------------------------------------------------------
// F4: heap-OOM retry + blocking classification
// ---------------------------------------------------------------------------
test("beta70 F4: HEAP_OOM_RE matches the #870 tsc OOM signature", { skip: conventions === null }, () => {
  const { HEAP_OOM_RE } = conventions;
  assert.match("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed", HEAP_OOM_RE);
  assert.match("JavaScript heap out of memory", HEAP_OOM_RE);
  assert.doesNotMatch("2 problems (2 errors, 0 warnings)", HEAP_OOM_RE);
});

test("beta70 F4: runCheckScripts retries a heap OOM with a larger heap and passes", { skip: conventions === null }, () => {
  const { runCheckScripts } = conventions;
  let runs = 0;
  const heaps = [];
  const results = runCheckScripts({
    repoRoot: "/tmp/r",
    discovered: [{ name: "typecheck", command: "tsc --noEmit" }],
    allowlist: ["typecheck"],
    timeoutSeconds: 60,
    heapRetryMb: 8192,
    runScript: (name, cwd, timeoutMs, heapMb) => {
      runs += 1;
      heaps.push(heapMb);
      if (runs === 1) return { status: 134, stdout: "", stderr: "FATAL ERROR: Ineffective mark-compacts near heap limit" };
      return { status: 0, stdout: "OK", stderr: "" }; // larger heap succeeds
    },
  });
  assert.equal(runs, 2, "OOM triggers exactly one retry");
  assert.equal(heaps[0], undefined, "first run uses repo default heap");
  assert.equal(heaps[1], 8192, "retry forces the larger heap");
  assert.equal(results[0].ran, true);
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[0].heapRetried, true);
  assert.ok(!results[0].oom, "recovered OOM is not flagged oom");
});

test("beta70 F4: a PERSISTED OOM after retry is a blocking (oom:true) failure", { skip: conventions === null }, () => {
  const { runCheckScripts } = conventions;
  const results = runCheckScripts({
    repoRoot: "/tmp/r",
    discovered: [{ name: "typecheck", command: "tsc --noEmit" }],
    allowlist: ["typecheck"],
    timeoutSeconds: 60,
    runScript: () => ({ status: 134, stdout: "", stderr: "Ineffective mark-compacts near heap limit" }),
  });
  assert.equal(results[0].oom, true, "still-OOM after retry -> oom:true (blocking)");
  assert.equal(results[0].ran, true, "it DID run (and failed) -- not a soft skip");
  assert.equal(results[0].heapRetried, true);
});

// ---------------------------------------------------------------------------
// Source-assertion wiring (the pieces that live in loop.ts / prompts)
// ---------------------------------------------------------------------------
test("beta70 F1: worker prompt forbids repo-wide generators/typecheck in-turn", () => {
  const w = S("src/orchestrator/sonnet-worker.ts");
  assert.match(w, /DO NOT run repo-wide generators/);
  assert.match(w, /npm run okf/);
  assert.match(w, /convention-check phase/);
});

test("beta70 F1: worker convention guidance defers regeneration to the harness", () => {
  const c = S("src/orchestrator/repo-conventions.ts");
  assert.match(c, /do NOT run regenerators yourself/);
  // adversary guidance no longer raises a bare bundle-not-regenerated finding
  assert.match(c, /do NOT raise a finding merely because a generated bundle/);
});

test("beta70 F2: loop convention-fold only force-revises on a BLOCKING finding", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /import \{ classifyFinding, isBlockingFinding \} from "\.\/finding-classify\.js"/);
  assert.match(src, /const blockingConvention = conventionFindings\.filter/);
  assert.match(src, /report\.verdict === "pass" && blockingConvention\.length > 0/);
});

test("beta70 F3: runAdversary wires the format-error retry", () => {
  const a = S("src/orchestrator/fable5-adversary.ts");
  assert.match(a, /isAdversaryFormatError/);
  assert.match(a, /ADVERSARY_FORMAT_RETRY_NUDGE/);
  assert.match(a, /retrying once with a format nudge/);
});

test("beta70 F4: loop threads heapRetryMb + treats persisted OOM as blocking finding", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /heapRetryMb: vcfg\.check_script_heap_retry_mb \?\? 8192/);
  assert.match(src, /if \(r\.oom\)/);
  assert.match(src, /loop\.convention_check_oom/);
});

test("beta70 F5: loop skips observe re-probe on revise only when reviseSpecApplied", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /st\.taskMode === "observe" &&\s*\n\s*reviseSpecApplied &&/);
  assert.match(src, /priorObserveCompleted\(sessionId, cycle, st\.seq\)/);
  assert.match(src, /loop\.observe_reprobe_skipped/);
});

test("beta70: config defaults + manifest declare the new keys", () => {
  const cfg = S("src/config.ts");
  assert.match(cfg, /skip_observe_reprobe_on_revise: true/);
  assert.match(cfg, /check_script_heap_retry_mb: 8192/);
  const man = JSON.parse(S("openclaw.plugin.json"));
  const loop = man.configSchema.properties.loop.properties;
  const verify = man.configSchema.properties.verify.properties;
  assert.equal(loop.skip_observe_reprobe_on_revise.default, true);
  assert.equal(verify.check_script_heap_retry_mb.default, 8192);
});

test("beta70: version bumped to beta.70", () => {
  assert.match(S("package.json"), /"version": "0\.1\.0-beta\.70"/);
  assert.match(S("src/version.ts"), /0\.1\.0-beta\.70/);
});
