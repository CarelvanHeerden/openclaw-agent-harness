# Harness spec: warm-worker-context (thread Fable's investigation into dev workers)

Author: Clark · 2026-07-23 · grounded against current beta.63 source

> Origin: Carel's ClaudeDevs multi-model post (2026-07-22).
> <https://platform.claude.com/docs/en/managed-agents/multi-agent>
> First-party Anthropic numbers for the orchestrator-split pattern:
> - **Fable 5 orchestrator + Sonnet 5 workers: 96% of all-Fable performance at
>   46% of cost** (BrowseComp 86.8% vs 90.8%, $18.53 vs $40.56/problem).
> - Sonnet executor + Fable advisor: ~92% at ~63% (SWE-bench Pro).
> The orchestrator split won on BOTH axes (accuracy retention AND cost).

> **STANDING DIRECTIVE still in force: build nothing new until #858 lands a
> clean end-to-end run on beta.60+.** This spec is parked, reviewed, ready.
> It is the FIRST feature to build once #858 completes, because it is the
> highest-leverage change on the board and the direct enabler of the
> sonnet-worker cost win Carel wants.

---

## The problem (the anti-pattern we've been running)

The harness already IS the orchestrator-split architecture: Fable 5 is the lead
planner (smart, expensive), sonnet/opus workers are the executors. But we get
NONE of the ClaudeDevs cost/quality win because **the workers run cold.**

Concretely, from the current source:

- `runLeadPlanner` (fable5-lead.ts) has Fable do a deep investigation, then
  distills each sub-task down to a THIN TICKET: `LeadPlanSubTask = { title,
  intent, filesLikelyTouched, successCriteria, ... }` (fable5-lead.ts:103).
- `buildWorkerSystemPrompt` (sonnet-worker.ts:149) hands the worker: the overall
  brief, OKF concepts, repo conventions, and that thin ticket. **It does NOT
  hand over anything Fable actually learned** — the code Fable read, the call
  graph it traced, the exact edit shape it decided on, the gotchas it already
  hit.
- So every worker sub-task starts cold and RE-EXPLORES the repo to re-derive
  what Fable already knew, just to write ~30-50 lines.

**Consequence (this is the "shit code" root cause):** the worker has to be smart
enough to re-investigate, because the investigation isn't handed to it. That's
why sonnet produced poor code and we escalated workers to opus to compensate.
We are paying Fable-tier reasoning to plan, then paying opus-tier reasoning AGAIN
per worker to re-discover the plan's basis. Worst of both axes — the exact
inverse of the ClaudeDevs result.

**What we want (the ClaudeDevs model):** Fable investigates deeply → emits a
rich, implementation-ready spec per sub-task → a CHEAP worker executes it almost
mechanically because the hard thinking is already done and handed forward. Once
workers are warm, sonnet becomes viable → 96%/46% instead of 100%/100%.

> Note the important asymmetry Carel called out: this is a DEV-worker fix, not an
> adversary fix. The adversarial review sub-tasks (fable5-adversary.ts) SHOULD
> start cold — an adversary that inherits the planner's framing is a compromised
> reviewer. Warm context flows lead → dev worker ONLY. The adversary stays cold
> and independent by design.

---

## Design

Thread a rich, Fable-authored context payload forward on each sub-task, and make
the worker prompt LEAD with it. Three coordinated changes, mirroring the
existing OKF-concept plumbing (beta.21) which already proves the pattern.

### 1. Schema: add `workerContext` to `LeadPlanSubTask`

`src/orchestrator/fable5-lead.ts` (~line 103). New optional field so old plans
still parse (same additive discipline as `verify`/`contractScope`/`taskMode`):

```ts
export interface WorkerContext {
  /** Fable's plain-language explanation of WHY this change is needed and
   *  HOW it should be shaped — the reasoning, not just the outcome. */
  rationale: string;
  /** Verbatim code excerpts Fable actually read, with file+line anchors, so
   *  the worker does not re-open and re-scan the repo to find them. */
  codeExcerpts?: Array<{ path: string; startLine?: number; snippet: string; note?: string }>;
  /** The precise, low-ambiguity change instruction, e.g. "in useTaxonomy()
   *  at src/hooks/useTaxonomy.ts:41, replace the hardcoded LABELS map with a
   *  call to getTaxonomyOptions() from src/lib/taxonomy-options.ts". */
  changeSpec?: string;
  /** Discovered conventions / gotchas SPECIFIC to this sub-task (distinct from
   *  the repo-wide repoConventions), e.g. "React 19.2.7 has no React.act; use
   *  renderToStaticMarkup for component tests in this repo". */
  gotchas?: string[];
  /** Related symbols/functions the worker will need but might not find:
   *  "getTaxonomyOptions is exported from src/lib/taxonomy-options.ts:12". */
  relatedSymbols?: string[];
}

export interface LeadPlanSubTask {
  // ...existing fields...
  /** warm-worker-context: Fable's investigation handed forward to the worker.
   *  Optional; absent = current cold behaviour. Dev workers only — never the
   *  adversary. */
  workerContext?: WorkerContext;
}
```

### 2. Lead prompt: instruct Fable to EMIT the context

`src/adapters/claude-sdk.ts` lead system prompt. Add a section requiring Fable,
for each sub-task, to populate `workerContext` with the reasoning, the exact code
it read (excerpts with anchors), the precise change spec, and any sub-task
gotchas. Frame it explicitly:

> "You are the orchestrator. Your workers are CHEAPER models that will NOT
>  re-investigate the repo. Everything a worker needs to implement the sub-task
>  correctly WITHOUT re-reading the codebase must be in `workerContext`. Hand
>  down your findings, not just a ticket. If a worker would have to re-derive
>  something you already know, put it in `workerContext`."

Budget guard: cap `codeExcerpts` total chars (reuse the OKF
`WORKER_CONCEPT_TOTAL_MAX_CHARS` pattern) so a verbose plan doesn't blow the
worker context window or cost.

### 3. Worker prompt: LEAD with the context

`buildWorkerSystemPrompt` (sonnet-worker.ts:149). When `subTask.workerContext`
is present, inject a `## Implementation context (from the lead investigation)`
block IMMEDIATELY after `## Your sub-task`, BEFORE the generic rules — rationale,
code excerpts, changeSpec, gotchas, relatedSymbols. Add one line to the worker
rules: "The lead already investigated this. Trust and use the implementation
context; do not re-explore the repo to re-derive it — implement the changeSpec.
Only read files the context did not already give you."

Mirror the existing char-budget truncation used for OKF concepts.

---

## Sequencing / rollout

1. Land #858 clean on beta.60+ first (standing directive). That run is the
   BENCHMARK — capture its cost + quality with opus workers.
2. Ship warm-worker-context with workers STILL on opus. Measure: same task,
   warm context → expect lower cost (less re-exploration) + same/better quality.
3. THEN flip `models.worker` to sonnet on a warm-context run. This is the
   experiment that validates the ClaudeDevs 96%/46% claim on OUR harness.
   Keep opus as the fallback tier (`config.models` already supports override).
4. Optionally add per-role effort (Anthropic's "low effort ~= prev-gen xhigh"):
   recon/mechanical sub-tasks at low effort, high-risk mutates keep higher
   effort. This is the second half of the ClaudeDevs cost lever.

## Tests (following the beta-N convention)

- `LeadPlanSubTask` parses with and without `workerContext` (additive/optional).
- `buildWorkerSystemPrompt` injects the context block when present, omits it
  when absent, and respects the char budget.
- Adversary path (fable5-adversary.ts) NEVER receives `workerContext` — assert
  the cold-adversary boundary holds.
- Behavioral: a warm sub-task prompt contains the changeSpec + excerpts; a cold
  one is unchanged from today (regression guard).

## Why this is the right first feature post-#858

It is the single change that converts the harness from "expensive orchestrator +
expensive re-investigating workers" (worst of both axes) into the actual
ClaudeDevs orchestrator-split (best of both). It directly unblocks the sonnet
worker downgrade Carel wants, and everything else (per-role effort tiers, cost
tuning) compounds on top of it.
