# SPEC — beta.67 P0d: Fable-in-the-loop (workerContext enforcement + revise-spec turn)

Status: APPROVED (Carel greenlit 2026-07-23, dual-reviewed with Staging in #openclaw-staging).
Built on top of the beta.67 3-P0 tree (Bug A external stall-sweep, Bug B adversary
fork-point diff, Bug C revise-no-change task-mode demotion) — those are already in the
working tree; this is the fourth, more architecturally significant P0.

## Origin

The harness's founding goal (Anthropic's orchestrator-split numbers: Fable orchestrator +
cheaper workers = 96% of all-Fable quality at 46% of cost) requires the smart planner to
hand its investigation DOWN to cheap workers so they implement mechanically instead of
re-scanning the repo. beta.66 built the mechanism (`WorkerContext` type + `workerContext?`
field + `renderWorkerContextBlock()` injection in the worker prompt) — but the live smoke
showed workers still receiving BARE intents (878/1434/763-char strings), i.e. Fable returned
empty/undefined `workerContext`. The pipe exists; Fable isn't filling it.

Two gaps, one shared fix path (both reuse beta.66's `renderWorkerContextBlock` rendering,
so the adversary-cold boundary is untouched):

- **P0a — plan-time enforcement.** Fable drops the optional `workerContext` field under load
  (same non-determinism that made beta.33 add `sanitizeRemoteSubTasks`: the prompt forbids /
  asks, but only the validator can enforce). Enforce at the `validatePlan` gate in
  `runLeadPlanner`, not the prompt.
- **P0b — revise-path Fable turn.** On an `adversary_revise` verdict the cycle loop today reuses
  `plan.subTasks` verbatim and hands workers the RAW adversary findings via
  `buildReviseDispatchHint`. Workers then no-op on findings they can't parse (the beta.63/64
  revise-cycle regression). Insert ONE Fable revise-spec turn between adversary and cycle-2
  workers that reads the findings, investigates, and refreshes each affected sub-task's
  `workerContext` — workers stop seeing raw findings entirely.

## Hard boundary (locked, Carel 2026-07-23)

`workerContext` flows lead → DEV WORKER ONLY. The adversary stays COLD + independent and is
NOT touched by this spec. `fable5-adversary.ts` is not modified. A test asserts the adversary
never references `workerContext`. On the revise path, the Fable revise-spec turn reads the
adversary's OUTPUT (findings) — it does NOT feed anything back into the adversary; the
adversary keeps judging the diff against the original spec + reality.

## P0a — validator-enforced substantive workerContext

### The substance predicate (the reviewed shape)

A shallow `workerContext != null` check is theatrical — Fable can return
`{ rationale:"", codeExcerpts:[], changeSpec:null, gotchas:[] }` (schema-valid, functionally
the beta.66 regression). The predicate requires SUBSTANCE:

```
hasSubstantiveWorkerContext(wc?: WorkerContext): boolean
  = wc present
    AND rationale is a non-empty string
    AND at least one of:
        - changeSpec: trim().length >= CHANGESPEC_MIN_CHARS (40)
                      AND matches a path-shaped token (a file ref)
        - codeExcerpts: at least one entry with a non-empty snippet AND a `path`
```

Path-token regex (kills the length-only hole where
`"refactor the thing to be better and also fix the bug"` (56 chars) passes on length):

```
/\S+\.(ts|tsx|js|jsx|py|go|rs|md|json|ya?ml)\b|\S+\/\S+/
```

Verified: Fable's own reference changeSpec (the `useTaxonomy()`/`getTaxonomyOptions()`
example, 150 chars, two path tokens) passes; the weak filler fails on the path check.
`gotchas`/`relatedSymbols` stay genuinely optional garnish — they help but are not the
substance that stops re-exploration.

### Gate scope

`taskMode === "mutate" || taskMode === "mixed"` require substantive workerContext.
`observe` is exempt (a probe/read sub-task legitimately investigates, does not implement).
`mixed` is gated same as `mutate` — a mixed sub-task that mutates without context is the
beta.63/64 failure mode wearing a hat; if Fable can't produce context, the sub-task is either
mis-scoped (should split observe+mutate) or Fable under-investigated. Both are conditions the
validator should surface, not paper over.

### Enforcement posture (matches `sanitizeRemoteSubTasks` precedent)

- The check lands in `validatePlan(raw, config)` inside `runLeadPlanner` (fable5-lead.ts:236),
  right where `sanitizeRemoteSubTasks` already coerces pre-validation.
- On the FIRST plan attempt, a missing/insubstantive workerContext on a mutate/mixed sub-task
  triggers ONE bounded re-ask of the lead model (`callLeadModel` becomes re-callable) with an
  explicit corrective note listing which seqs lack substantive context.
- If the SECOND attempt STILL comes back insubstantive → hard-throw
  (`LeadPlanValidationError`), surfaced as a plan failure. Better a loud fail at planning than
  another silent workers-no-op'd cycle downstream.
- The lead prompt keeps its beta.66 WARM WORKER CONTEXT instruction as belt-not-suspenders.
- Retry is bounded to exactly one (no unbounded loop): attempts = [initial, one re-ask].

### Config

`loop.enforce_worker_context` (default true). When false, the gate degrades to a WARN-only
audit (`loop.worker_context_insufficient`) and does not retry/throw — an operator escape hatch
for a repo where Fable genuinely can't excerpt (e.g. binary-only change). Added to config.ts
LoopConfig + DEFAULTS + parseHarnessConfig + openclaw.plugin.json (manifest
`additionalProperties:false` rejects undeclared keys — beta.34 lesson).

## P0b — Fable revise-spec turn

### Today (the gap)

`loop.ts` cycle loop: on `adversary_revise`, `advance()` returns `nextStatus:"executing"`, the
outer `while` re-runs, and `runOne` builds `buildReviseDispatchHint(lastReview)` — raw findings
verbatim + "if none apply, change nothing". `runLeadPlanner` is called ONCE at `planning`,
never again. Workers see raw adversary output and no-op on findings they don't understand.

### The change

Add `runLeadReviseSpec` (a new Fable adapter call) invoked at the TOP of a revise cycle
(cycle > 1) BEFORE `topoSortSubTasks`. It takes `{brief, plan, lastReview}` and returns updated
`subTasks` with REFRESHED per-sub-task `workerContext` (rationale scoped to the finding being
addressed + concrete changeSpec/excerpts for the fix) and a possibly-narrowed set of sub-tasks
(findings mapped to the sub-tasks whose files they touch). The loop then:

1. replaces `plan.subTasks` with the revise-spec's refreshed sub-tasks for this cycle;
2. persists the refreshed plan (`lead_plan_json`) so a resume sees it;
3. SUPPRESSES `buildReviseDispatchHint` when a revise-spec turn produced context (workers now
   get the warm `workerContext` block via beta.66's `renderWorkerContextBlock`, never the raw
   findings). If the revise-spec turn FAILS (SDK error / timeout / empty), FALL BACK to the
   existing `buildReviseDispatchHint` behaviour — never worse than beta.66.

### Loop-shape footprint

One new adapter dep (`runLeadReviseSpec?`) + one branch in the cycle loop (top of cycle>1).
`buildReviseDispatchHint` is retained as the fallback. No worker-prompt change (beta.66's
render path already handles `workerContext`). Adversary untouched.

### Config

`loop.revise_spec_turn_enabled` (default true). When false → beta.66 raw-findings behaviour.
Same manifest/config wiring rules.

## Tests (beta67 fable-in-loop test file)

- `hasSubstantiveWorkerContext`: rationale+changeSpec-with-path PASS; rationale+real-excerpt
  PASS; all-empty FAIL; rationale-only FAIL; changeSpec-without-path FAIL (the length-only
  hole); short-changeSpec FAIL; the exact Fable reference changeSpec PASS.
- validator gate: mutate w/o substance → one re-ask; mixed w/o substance → gated same;
  observe w/o context → PASS (exempt); second empty → throws; `enforce_worker_context:false`
  → warn-only no-throw.
- one bounded re-ask: `callLeadModel` called exactly twice on a bad-then-good sequence; exactly
  twice (not more) on bad-then-bad before throw.
- P0b: revise cycle calls `runLeadReviseSpec`; workers get refreshed `workerContext` and the
  raw `buildReviseDispatchHint` is suppressed; revise-spec failure → falls back to
  `buildReviseDispatchHint` (never worse than beta.66).
- boundary: adversary path never references `workerContext` (source-assert on
  fable5-adversary.ts).
- config + manifest wiring for both new keys.

## Sequencing

Lands as beta.67 alongside the 3 existing P0s (A/B/C already in tree). typecheck + build +
full suite + smoke must be green before ship. Adversary cold + untouched throughout.
