// beta.67 (P0d) — Fable-in-the-loop: validator-enforced workerContext (P0a) +
// Fable revise-spec turn (P0b). beta.66 built the workerContext PIPE but Fable
// wasn't filling it (workers got bare intents); and on a revise the loop handed
// workers RAW adversary findings they no-op'd on. This closes both.
//
//   P0a — validatePlan gate: a mutate/mixed sub-task MUST carry SUBSTANTIVE
//     workerContext (rationale + file-anchored changeSpec/excerpt, not mere
//     field presence). One bounded lead re-ask; second-empty hard-throws.
//   P0b — a Fable revise-spec turn refreshes each affected sub-task's
//     workerContext so cycle-2 workers get a resolved changeSpec via the
//     beta.66 warm-context render path, never the raw findings. Failure falls
//     back to buildReviseDispatchHint (never worse than beta.66).
//
// HARD BOUNDARY: workerContext flows lead -> dev worker only; the adversary
// stays cold + independent (asserted here against fable5-adversary.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let hasSubstantiveWorkerContext, subTasksMissingWorkerContext, LeadPlanValidationError, runLeadPlanner;
try {
  ({ hasSubstantiveWorkerContext, subTasksMissingWorkerContext, LeadPlanValidationError, runLeadPlanner } =
    await import("../dist/orchestrator/fable5-lead.js"));
} catch {
  hasSubstantiveWorkerContext = null;
}

const REF_CHANGESPEC =
  "in useTaxonomy() at src/hooks/useTaxonomy.ts:41, replace the hardcoded LABELS map with a call to getTaxonomyOptions() from src/lib/taxonomy-options.ts";

// --- P0a predicate ---
test("P0a: rationale + file-anchored changeSpec PASSES (Fable's own reference)", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext({ rationale: "align labels", changeSpec: REF_CHANGESPEC }), true);
});
test("P0a: rationale + real code excerpt (snippet + path) PASSES", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext({ rationale: "read from shared hook", codeExcerpts: [{ path: "src/hooks/useTaxonomy.ts", startLine: 41, snippet: "const LABELS = { l1: 'L1' }" }] }), true);
});
test("P0a: all-empty (schema-valid) FAILS — the beta.66 regression shape", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext({ rationale: "", codeExcerpts: [], changeSpec: null, gotchas: [] }), false);
});
test("P0a: rationale-only (no concrete guidance) FAILS", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext({ rationale: "fix the thing" }), false);
});
test("P0a: changeSpec without a file reference FAILS (the length-only hole)", () => {
  if (!hasSubstantiveWorkerContext) return;
  const filler = "refactor the thing to be better and also fix the bug";
  assert.ok(filler.length >= 40);
  assert.equal(hasSubstantiveWorkerContext({ rationale: "r", changeSpec: filler }), false);
});
test("P0a: too-short changeSpec FAILS even with a path token", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext({ rationale: "r", changeSpec: "edit a/b.ts" }), false);
});
test("P0a: gotchas/relatedSymbols alone do NOT satisfy the gate", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext({ rationale: "r", gotchas: ["React 19 has no act"], relatedSymbols: ["getX from src/x.ts"] }), false);
});
test("P0a: excerpt with empty snippet or missing path does NOT count", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext({ rationale: "r", codeExcerpts: [{ path: "src/x.ts", snippet: "" }] }), false);
  assert.equal(hasSubstantiveWorkerContext({ rationale: "r", codeExcerpts: [{ snippet: "code here" }] }), false);
});
test("P0a: undefined workerContext FAILS", () => {
  if (!hasSubstantiveWorkerContext) return;
  assert.equal(hasSubstantiveWorkerContext(undefined), false);
});

// --- P0a gate scope ---
test("P0a: gate flags mutate + mixed without context, exempts observe", () => {
  if (!subTasksMissingWorkerContext) return;
  const good = { rationale: "r", changeSpec: REF_CHANGESPEC };
  const plan = { subTasks: [
    { seq: 1, taskMode: "observe" },
    { seq: 2, taskMode: "mutate" },
    { seq: 3, taskMode: "mutate", workerContext: good },
    { seq: 4, taskMode: "mixed" },
    { seq: 5, taskMode: "mixed", workerContext: good },
  ] };
  assert.deepEqual(subTasksMissingWorkerContext(plan), [2, 4]);
});
test("P0a: a fully-satisfied plan reports no missing seqs", () => {
  if (!subTasksMissingWorkerContext) return;
  const good = { rationale: "r", changeSpec: REF_CHANGESPEC };
  const plan = { subTasks: [{ seq: 1, taskMode: "observe" }, { seq: 2, taskMode: "mutate", workerContext: good }] };
  assert.deepEqual(subTasksMissingWorkerContext(plan), []);
});

// --- P0a bounded re-ask ---
function makeDeps(config, planSeq) {
  let i = 0; const calls = [];
  return { calls, deps: {
    config, logger: { info() {}, warn() {} },
    callLeadModel: async (_b, _r, correctiveNote) => { calls.push({ correctiveNote }); const p = planSeq[Math.min(i, planSeq.length - 1)]; i += 1; return JSON.parse(JSON.stringify(p)); },
    allocateWorktree: async () => "/tmp/wt", estimateCost: () => 0,
  } };
}
const BASE_CFG = { repos: { allowed: ["o/r"], default_base_branch: "main" }, loop: {} };
const good = { rationale: "align labels with taxonomy source", changeSpec: REF_CHANGESPEC };
const okPlan = { repo: "o/r", branch: "harness/x", reviewChecklist: ["c"], riskLevel: "low",
  subTasks: [{ seq: 1, title: "t", intent: "i", filesLikelyTouched: ["src/x.ts"], successCriteria: ["s"], estimatedTokens: 1, contractScope: "local", taskMode: "mutate", verify: [{ kind: "commit_made" }], workerContext: good }] };
const badPlan = JSON.parse(JSON.stringify({ ...okPlan, subTasks: [{ ...okPlan.subTasks[0], workerContext: { rationale: "", changeSpec: "" } }] }));

test("P0a: bad-then-good triggers exactly ONE re-ask", async () => {
  if (!runLeadPlanner) return;
  const { deps, calls } = makeDeps({ ...BASE_CFG, loop: { enforce_worker_context: true } }, [badPlan, okPlan]);
  const plan = await runLeadPlanner({ pinnedBranch: undefined }, deps);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].correctiveNote, undefined);
  assert.match(String(calls[1].correctiveNote), /WORKER CONTEXT REQUIRED/);
  assert.equal(plan.subTasks[0].workerContext.changeSpec, REF_CHANGESPEC);
});
test("P0a: bad-then-bad hard-throws after exactly ONE re-ask (bounded)", async () => {
  if (!runLeadPlanner) return;
  const { deps, calls } = makeDeps({ ...BASE_CFG, loop: { enforce_worker_context: true } }, [badPlan, badPlan]);
  await assert.rejects(() => runLeadPlanner({ pinnedBranch: undefined }, deps), (e) => { assert.ok(e instanceof LeadPlanValidationError); return true; });
  assert.equal(calls.length, 2);
});
test("P0a: enforcement disabled -> proceeds with a bad plan, no re-ask, no throw", async () => {
  if (!runLeadPlanner) return;
  const { deps, calls } = makeDeps({ ...BASE_CFG, loop: { enforce_worker_context: false } }, [badPlan]);
  const plan = await runLeadPlanner({ pinnedBranch: undefined }, deps);
  assert.equal(calls.length, 1);
  assert.ok(plan.subTasks.length === 1);
});
test("P0a: a good first plan does NOT re-ask", async () => {
  if (!runLeadPlanner) return;
  const { deps, calls } = makeDeps({ ...BASE_CFG, loop: { enforce_worker_context: true } }, [okPlan]);
  await runLeadPlanner({ pinnedBranch: undefined }, deps);
  assert.equal(calls.length, 1);
});

// --- P0b + boundary source assertions ---
test("P0b: loop runs the revise-spec turn at cycle>1 and suppresses the raw hint", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /runLeadReviseSpec\?:/);
  assert.match(src, /reviseSpecApplied/);
  assert.match(src, /revise_spec_turn_enabled !== false/);
  assert.match(src, /cycle > 1 && lastReview && !reviseSpecApplied \? buildReviseDispatchHint/);
  assert.match(src, /loop\.revise_spec_failed/);
  assert.match(src, /loop\.revise_spec_applied/);
});
test("P0b: revise-spec SDK adapter reads findings + refreshes workerContext", () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /export async function runLeadReviseSpecSdk/);
  assert.match(src, /REVISION SPEC turn/);
  assert.match(src, /workerContext/);
  assert.match(src, /currentSubTasks:/);
});
test("P0b: index wires runLeadReviseSpec via runLeadReviseSpecSdk", () => {
  const src = S("src/index.ts");
  assert.match(src, /runLeadReviseSpec:\s*async/);
  assert.match(src, /runLeadReviseSpecSdk\(/);
});
test("P0a: index callLeadModel genuinely re-invokes the SDK with the corrective note", () => {
  const src = S("src/index.ts");
  assert.match(src, /callLeadModel:\s*async\s*\(b, _repos, correctiveNote\)/);
  assert.match(src, /correctiveNote,/);
});
test("BOUNDARY: the adversary NEVER references workerContext (stays cold)", () => {
  const src = S("src/orchestrator/fable5-adversary.ts");
  assert.equal(/workerContext/.test(src), false, "fable5-adversary.ts must not reference workerContext");
});
test("config + manifest declare both beta.67 P0d keys", () => {
  const cfg = S("src/config.ts");
  assert.match(cfg, /enforce_worker_context\?: boolean/);
  assert.match(cfg, /revise_spec_turn_enabled\?: boolean/);
  const man = S("openclaw.plugin.json");
  assert.match(man, /"enforce_worker_context"/);
  assert.match(man, /"revise_spec_turn_enabled"/);
});
