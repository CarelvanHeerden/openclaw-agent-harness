// beta.91 — the efficiency epic: (Fix 1) revise-cycle scoping, (Fix 2) safe
// parallel independent sub-tasks, (Fix 3) cheaper model for mechanical
// sub-tasks. Born from Staging's beta.90 DR/BCP smoke (session baa8ba08): a
// revise cycle re-ran ALL 12 sub-tasks even though 8 were subtask_revise_no_change,
// sub-tasks ran strictly serial, and mechanical scaffolding ran on the strong
// worker model. All three fixes are pure/behavioural + wired conservatively.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const S = (p) => readFileSync(resolve(root, p), "utf8");
const betaNum = (v) => Number(/0\.1\.0-beta\.(\d+)/.exec(v)?.[1] ?? -1);

const { computeReviseScope, subTaskIntersectsFindings } = await import("../dist/orchestrator/revise-scope.js");
const { selectWorkerModel, isMechanicalSubTask } = await import("../dist/orchestrator/worker-model-select.js");
const { canDispatchConcurrently, fileScopesOverlap, resolveEffectiveConcurrency } = await import("../dist/orchestrator/parallel-safety.js");
const { requiresFile, isUnfiledDiffAddressable, findingsMissingFile, buildFileAttributionRetryNudge } = await import("../dist/orchestrator/adversary-file-attribution.js");

// ---------------------------------------------------------------------------
// Fix 1: revise-cycle scoping
// ---------------------------------------------------------------------------

// Model the exact DR/BCP smoke shape: 12 sub-tasks, a revise with findings that
// only touch 2 files -> the other sub-tasks should be skipped.
const drbcpSubTasks = [
  { seq: 1, filesLikelyTouched: [], taskMode: "observe" }, // probe (unscopable-for-itself -> keep)
  { seq: 2, filesLikelyTouched: ["prisma/schema.prisma"] },
  { seq: 3, filesLikelyTouched: ["prisma/migrations/xxx/migration.sql"] },
  { seq: 4, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/route.ts"] },
  { seq: 5, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/[id]/route.ts"] },
  { seq: 6, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/[id]/files/route.ts"] },
  { seq: 7, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/[id]/files/[fileId]/download/route.ts"] },
  { seq: 8, filesLikelyTouched: ["src/components/ui/sidebar.tsx"] },
  { seq: 9, filesLikelyTouched: ["src/components/grc/poi-attachment-upload.tsx"] },
  { seq: 10, filesLikelyTouched: ["src/app/(portal)/grc/continuity-resilience/page.tsx"] },
];

test("Fix1: revise-scoping skips sub-tasks not targeted by any finding", () => {
  // Findings only flag the list/POST route + the page.
  const findings = [
    { file: "src/app/api/grc/continuity-exercises/route.ts" },
    { file: "src/app/(portal)/grc/continuity-resilience/page.tsx" },
  ];
  const r = computeReviseScope(drbcpSubTasks, findings, 2);
  assert.equal(r.scoped, true);
  // seq 1 kept (unscopable-for-itself), seq 4 (exact route.ts) + seq 10 (page) kept.
  assert.ok(r.runSeqs.includes(4) && r.runSeqs.includes(10) && r.runSeqs.includes(1));
  // full-path findings do NOT over-match the route.ts SIBLINGS (seq 5/6/7) -> skipped.
  assert.ok(r.skipSeqs.includes(5) && r.skipSeqs.includes(6) && r.skipSeqs.includes(7), `siblings should skip: ${r.skipSeqs}`);
  // the untouched scaffolding (models/migration/sidebar/generalise/etc) skipped.
  assert.ok(r.skipSeqs.includes(2) && r.skipSeqs.includes(3) && r.skipSeqs.includes(8) && r.skipSeqs.includes(9));
  assert.ok(r.skipSeqs.length >= 7, `expected many skips, got ${r.skipSeqs.length}`);
});

test("Fix1: cycle 1 is never scoped (runs everything)", () => {
  const r = computeReviseScope(drbcpSubTasks, [{ file: "x.ts" }], 1);
  assert.equal(r.scoped, false);
  assert.equal(r.reason, "not_revise_cycle");
  assert.equal(r.skipSeqs.length, 0);
});

test("Fix1: an UNFILED finding makes the cycle unscopable -> run everything (conservative)", () => {
  const findings = [
    { file: "src/app/api/grc/continuity-exercises/route.ts" },
    { file: "" }, // finding with no resolvable file
  ];
  const r = computeReviseScope(drbcpSubTasks, findings, 2);
  assert.equal(r.scoped, false);
  assert.equal(r.reason, "unscopable_findings");
  assert.equal(r.skipSeqs.length, 0);
});

test("Fix1: never skips a sub-task a KEPT sub-task depends on (transitive)", () => {
  const subs = [
    { seq: 1, filesLikelyTouched: ["a.ts"] },              // NOT targeted, but seq 2 depends on it
    { seq: 2, filesLikelyTouched: ["b.ts"], dependsOn: [1] }, // targeted
  ];
  const r = computeReviseScope(subs, [{ file: "b.ts" }], 2);
  // seq 2 targeted -> kept; seq 1 is a dep of a kept -> also kept -> nothing to skip.
  assert.equal(r.scoped, false);
  assert.equal(r.reason, "all_relevant");
  assert.equal(r.skipSeqs.length, 0);
});

test("Fix1: no findings -> not scoped", () => {
  assert.equal(computeReviseScope(drbcpSubTasks, [], 2).reason, "no_findings");
  assert.equal(computeReviseScope(drbcpSubTasks, undefined, 2).reason, "no_findings");
});

test("Fix1: path-structural match; full-path finding does NOT over-match a same-basename sibling", () => {
  const norm = ["src/app/api/grc/continuity-exercises/route.ts"];
  // full-path finding -> NO bare basenames contribute
  const noBare = new Set();
  // partial adversary path that is a suffix of the plan path -> match
  assert.equal(subTaskIntersectsFindings(["src/app/api/grc/continuity-exercises/route.ts"], norm, noBare), true);
  // a DIFFERENT sibling sharing only the basename route.ts must NOT match a full-path finding
  assert.equal(subTaskIntersectsFindings(["src/app/api/grc/continuity-exercises/[id]/route.ts"], norm, noBare), false);
  // a BARE-filename finding (route.ts) DOES contribute a basename match (adversary gave only a name)
  assert.equal(subTaskIntersectsFindings(["src/app/api/grc/continuity-exercises/[id]/route.ts"], ["route.ts"], new Set(["route.ts"])), true);
});

// ---------------------------------------------------------------------------
// F1 companion: adversary file attribution (makes F1 non-inert)
// ---------------------------------------------------------------------------

test("F1c: diff-addressable dimensions at >=medium require a file", () => {
  assert.equal(requiresFile({ dimension: "quality", severity: "medium" }), true);
  assert.equal(requiresFile({ dimension: "security", severity: "high" }), true);
  assert.equal(requiresFile({ dimension: "spec", severity: "critical" }), true);
  // low severity -> not required
  assert.equal(requiresFile({ dimension: "quality", severity: "low" }), false);
  // meta dimensions -> not required even at high
  assert.equal(requiresFile({ dimension: "fit", severity: "high" }), false);
  assert.equal(requiresFile({ dimension: "runtime", severity: "high" }), false);
});

test("F1c: isUnfiledDiffAddressable flags only the offenders", () => {
  assert.equal(isUnfiledDiffAddressable({ dimension: "quality", severity: "medium", file: "" }), true);
  assert.equal(isUnfiledDiffAddressable({ dimension: "quality", severity: "medium", file: null }), true);
  assert.equal(isUnfiledDiffAddressable({ dimension: "quality", severity: "medium", file: "src/x.ts" }), false);
  // meta finding without a file is fine
  assert.equal(isUnfiledDiffAddressable({ dimension: "runtime", severity: "high", file: null }), false);
});

test("F1c: findingsMissingFile + retry nudge names offenders", () => {
  const findings = [
    { dimension: "quality", severity: "medium", title: "typecheck error", file: null },
    { dimension: "security", severity: "high", title: "missing tenant scope", file: "ok.ts" },
    { dimension: "fit", severity: "medium", title: "convention", file: null }, // meta -> ok
  ];
  const missing = findingsMissingFile(findings);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].title, "typecheck error");
  const nudge = buildFileAttributionRetryNudge(missing);
  assert.match(nudge, /FILE ATTRIBUTION \(RETRY/);
  assert.match(nudge, /typecheck error/);
});

test("F1c: adversary prompt REQUIRES file + runAdversary re-prompts once + ReviewFinding.file allows null", () => {
  const adv = S("src/orchestrator/fable5-adversary.ts");
  assert.match(adv, /File attribution \(REQUIRED for diff-addressable findings\)/);
  assert.match(adv, /from "\.\/adversary-file-attribution\.js"/);
  assert.match(adv, /findingsMissingFile\(result\.parsed\.findings\)/);
  assert.match(adv, /buildFileAttributionRetryNudge\(missing\)/);
  assert.match(adv, /file\?: string \| null/);
  // pass-2 nit: retry observability hook + index wiring
  assert.match(adv, /onFileAttributionRetry\?:/);
  assert.match(S("src/index.ts"), /loop\.file_attribution_retry/);
});

test("F1c behavioural: runAdversary re-prompts once + fires onFileAttributionRetry (worse retry rejected)", async () => {
  const { runAdversary } = await import("../dist/orchestrator/fable5-adversary.js");
  let calls = 0;
  const events = [];
  // call 1: one file-less quality/medium finding. retry: WORSE (two file-less).
  const report = await runAdversary(
    { crystallisedPrompt: "p", diffPath: "/d", repoPath: "/r", reviewChecklist: [], model: "m", timeoutSeconds: 10, priorFindings: [{ dimension: "quality", severity: "medium", title: "prior" }] },
    {
      logger: { info() {}, warn() {} },
      readDiff: async () => "diff",
      onFileAttributionRetry: (info) => events.push(info),
      callAdversaryModel: async () => {
        calls++;
        const findings = calls === 1
          ? [{ dimension: "quality", severity: "medium", title: "a", detail: "", file: null }]
          : [{ dimension: "quality", severity: "medium", title: "a", detail: "", file: null },
             { dimension: "security", severity: "high", title: "b", detail: "", file: null }];
        return { parsed: { verdict: "revise", findings, summary: "" }, sdkSessionId: "s", costUsd: 0, tokensIn: 0, tokensOut: 0 };
      },
    },
  );
  assert.equal(calls, 2, "should re-prompt exactly once");
  assert.equal(events.length, 1);
  assert.equal(events[0].before, 1);
  assert.equal(events[0].after, 2);
  assert.equal(events[0].applied, false, "worse retry must be rejected");
  assert.equal(events[0].hadPriorFindings, true);
  // rejected retry -> original (1 file-less) findings kept, not the worse 2
  assert.equal(report.findings.filter((f) => !(f.file)).length >= 1, true);
});

// ---------------------------------------------------------------------------
// Fix 3: cheaper model for mechanical sub-tasks
// ---------------------------------------------------------------------------

const models = { worker: "claude-opus", worker_mechanical: "claude-haiku" };

test("Fix3: lead complexity hint is authoritative", () => {
  assert.equal(isMechanicalSubTask({ complexity: "mechanical", intent: "anything" }), true);
  assert.equal(isMechanicalSubTask({ complexity: "complex", intent: "add sidebar entry" }), false);
  assert.equal(isMechanicalSubTask({ complexity: "standard", intent: "prisma model" }), false);
});

test("Fix3: heuristic classifies scaffolding mechanical, judgment work not", () => {
  assert.equal(isMechanicalSubTask({ title: "Add Continuity & Resilience sidebar entry", filesLikelyTouched: ["src/components/ui/sidebar.tsx"] }), true);
  assert.equal(isMechanicalSubTask({ title: "Add ContinuityExercise prisma models and back-relations", filesLikelyTouched: ["prisma/schema.prisma"] }), true);
  assert.equal(isMechanicalSubTask({ title: "Create the continuity_resilience migration", filesLikelyTouched: ["prisma/migrations/x/migration.sql"] }), true);
  // API/route/auth/upload work is NOT mechanical even if a boilerplate word appears
  assert.equal(isMechanicalSubTask({ title: "Add multipart upload route with authz", filesLikelyTouched: ["route.ts"] }), false);
  assert.equal(isMechanicalSubTask({ title: "Add GET/PUT/DELETE route", intent: "api endpoint handler", filesLikelyTouched: ["route.ts"] }), false);
  assert.equal(isMechanicalSubTask({ title: "Write route tests", filesLikelyTouched: ["x.test.ts"] }), false);
});

test("NIT-5: generalise/extract-prop cues classify mechanical when no non-mechanical cue present", () => {
  // clean generalise (no endpoint/upload/auth cue) -> mechanical
  assert.equal(isMechanicalSubTask({ title: "Minimally generalise the attachment component", filesLikelyTouched: ["src/components/attachment.tsx"] }), true);
  assert.equal(isMechanicalSubTask({ title: "Extract a props interface", filesLikelyTouched: ["src/components/x.tsx"] }), true);
  // the b90 actual sub-task carries "upload" + "endpoint" -> correctly NOT auto-downgraded (lead-hint path covers it)
  assert.equal(isMechanicalSubTask({ title: "Minimally generalise poi-attachment-upload.tsx with endpoint + kinds props", filesLikelyTouched: ["src/components/grc/poi-attachment-upload.tsx"] }), false);
});

test("NIT-6: loop.revise_scope_skipped audit carries unfiledFindingCount", () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /loop\.revise_scope_skipped/);
  assert.match(loop, /unfiledFindingCount/);
});

test("Fix3: heuristic is conservative on broad file scope", () => {
  // >2 files -> not treated as mechanical even with a boilerplate cue
  assert.equal(isMechanicalSubTask({ title: "add sidebar entry", filesLikelyTouched: ["a.ts", "b.ts", "c.ts"] }), false);
});

test("Fix3: selectWorkerModel returns mechanical model only when mechanical + configured", () => {
  assert.equal(selectWorkerModel({ complexity: "mechanical" }, models), "claude-haiku");
  assert.equal(selectWorkerModel({ complexity: "complex" }, models), "claude-opus");
  // feature OFF (no worker_mechanical) -> always the strong worker model
  assert.equal(selectWorkerModel({ complexity: "mechanical" }, { worker: "claude-opus" }), "claude-opus");
  // non-mechanical -> strong model
  assert.equal(selectWorkerModel({ title: "Add upload route" }, models), "claude-opus");
});

// ---------------------------------------------------------------------------
// Fix 2: safe parallel independent sub-tasks
// ---------------------------------------------------------------------------

test("Fix2: effective concurrency is serial unless enabled AND >1", () => {
  assert.equal(resolveEffectiveConcurrency({ subtaskConcurrency: 4, parallelEnabled: false }), 1);
  assert.equal(resolveEffectiveConcurrency({ subtaskConcurrency: 1, parallelEnabled: true }), 1);
  assert.equal(resolveEffectiveConcurrency({ subtaskConcurrency: 4, parallelEnabled: true }), 4);
  assert.equal(resolveEffectiveConcurrency({ subtaskConcurrency: 0, parallelEnabled: true }), 1);
});

test("Fix2: fileScopesOverlap detects shared files (normalised)", () => {
  assert.equal(fileScopesOverlap(["src/a.ts"], ["./src/a.ts"]), true);
  assert.equal(fileScopesOverlap(["src/a.ts"], ["src/b.ts"]), false);
  assert.equal(fileScopesOverlap(["src/A.ts"], ["src/a.ts"]), true); // case-insensitive
});

test("Fix2: canDispatchConcurrently only allows known-disjoint scopes", () => {
  const a = { seq: 2, filesLikelyTouched: ["prisma/schema.prisma"] };
  const b = { seq: 8, filesLikelyTouched: ["src/components/ui/sidebar.tsx"] };
  const c = { seq: 2, filesLikelyTouched: ["prisma/schema.prisma"] };
  // first one always dispatches
  assert.equal(canDispatchConcurrently(a, []), true);
  // disjoint -> allowed
  assert.equal(canDispatchConcurrently(b, [a]), true);
  // overlapping (same file) -> forced serial
  assert.equal(canDispatchConcurrently(c, [a]), false);
  // unknown candidate scope -> forced serial
  assert.equal(canDispatchConcurrently({ seq: 9, filesLikelyTouched: [] }, [a]), false);
  // unknown in-flight scope -> forced serial
  assert.equal(canDispatchConcurrently(b, [{ seq: 1, filesLikelyTouched: [] }]), false);
});

// ---------------------------------------------------------------------------
// Wiring source-asserts
// ---------------------------------------------------------------------------

test("wiring: loop.ts imports and uses all three modules", () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /from "\.\/revise-scope\.js"/);
  assert.match(loop, /from "\.\/worker-model-select\.js"/);
  assert.match(loop, /from "\.\/parallel-safety\.js"/);
  // Fix 1: computes scope on a revise cycle, gated on revise_scoping_enabled, and skips in runOne
  assert.match(loop, /computeReviseScope\(plan\.subTasks, lastReview\.findings, cycle\)/);
  assert.match(loop, /revise_scoping_enabled !== false/);
  assert.match(loop, /reviseScopeSkip\.has\(st\.seq\)/);
  assert.match(loop, /loop\.subtask_revise_scoped_skip/);
  assert.match(loop, /loop\.revise_scoped/);
  // Fix 2: effective concurrency + overlap guard in the dispatcher
  assert.match(loop, /resolveEffectiveConcurrency\(/);
  assert.match(loop, /parallel_independent_subtasks === true/);
  assert.match(loop, /canDispatchConcurrently\(ordered\[idx\]!, \[\.\.\.inFlightSubTasks\.values\(\)\]\)/);
  assert.match(loop, /inFlightSubTasks\.set\(p, st\)/);
  // Fix 3: model override threaded to both runWorker call sites
  const overrides = loop.match(/modelOverride: selectWorkerModel\(st, this\.deps\.config\.models\)/g) ?? [];
  assert.ok(overrides.length >= 2, `expected >=2 modelOverride call sites, got ${overrides.length}`);
});

test("wiring: sonnet-worker + index thread modelOverride to the SDK model", () => {
  const worker = S("src/orchestrator/sonnet-worker.ts");
  assert.match(worker, /modelOverride\?: string/);
  assert.match(worker, /model: modelOverride\?\.trim\(\) \|\| deps\.config\.models\.worker/);
  const index = S("src/index.ts");
  assert.match(index, /runWorker: async \(\{ brief, subTask, plan, resumeSessionId, requester, dispatchHint, modelOverride, onStreamSlow \}\)/);
  assert.match(index, /onStreamSlow,\s*modelOverride,/);
});

test("wiring: config + manifest declare all new keys with conservative defaults", () => {
  const cfg = S("src/config.ts");
  assert.match(cfg, /revise_scoping_enabled\?: boolean/);
  assert.match(cfg, /parallel_independent_subtasks\?: boolean/);
  assert.match(cfg, /worker_mechanical\?: string/);
  // complexity lives on LeadPlanSubTask (fable5-lead.ts), not config.ts
  assert.match(S("src/orchestrator/fable5-lead.ts"), /complexity\?: "mechanical" \| "standard" \| "complex"/);
  // defaults: scoping ON, parallel OFF
  assert.match(cfg, /revise_scoping_enabled: true/);
  assert.match(cfg, /parallel_independent_subtasks: false/);

  const man = JSON.parse(S("openclaw.plugin.json"));
  const loopProps = man.configSchema.properties.loop.properties;
  assert.equal(loopProps.revise_scoping_enabled.default, true);
  assert.equal(loopProps.parallel_independent_subtasks.default, false);
  assert.ok(man.configSchema.properties.models.properties.worker_mechanical, "worker_mechanical declared in manifest models");
  // manifest models block is additionalProperties:false -> undeclared key would reject config (beta.34)
  assert.equal(man.configSchema.properties.models.additionalProperties, false);
});

test("beta91: version >= beta.91", () => {
  assert.ok(betaNum(JSON.parse(S("package.json")).version) >= 91, "package.json >= beta.91");
  assert.ok(betaNum(S("src/version.ts").match(/pluginVersion: "([^"]+)"/)[1]) >= 91, "version.ts >= beta.91");
});
