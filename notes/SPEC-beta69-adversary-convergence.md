# SPEC — beta.69: adversary convergence gate + env-127 bootstrap hardening

**Target source:** `openclaw-agent-harness@0.1.0-beta.68` (`3323468`), grounded against
`src/orchestrator/fable5-adversary.ts`, `src/orchestrator/loop.ts`, `src/adapters/git-worktree.ts`.

**Motivating run:** forensic `1f2e6642` (`grc-changes ?all=true` export). Cycle-1 shipped a
correct 30-LOC diff in 9 min (`34ed01d1`). Adversary voted `revise` 3× — twice on all-green
convention passes — burning $4.54/1h29m with **no PR**. The loop argued with itself.

The whole failure collapses into **one root cause**: findings are counted toward the verdict
without asking *"can a diff-cycle worker legitimately fix this?"* Three finding classes did all
the damage and none was ever a valid `revise` reason:
- **"No runtime data"** — structurally unsatisfiable without a push the harness never makes.
- **"No tests / tests not wired"** — repo has no test script *by design*; workerContext *forbids*
  adding one; flagged anyway, then the workaround got re-flagged (D3 spiral).
- **Recycled prior-cycle findings** — cycle-2 had **0 convention findings** and still revised.

---

## Root-cause evidence (beta.68 source)

### R1 — the harness force-upgrades `pass`→`revise` on missing runtime
`fable5-adversary.ts:196-213` (`runAdversary`):
```ts
const wantsRuntimeGuard =
  input.runtime && ["no_deploy_yet", "unavailable"].includes(input.runtime.status);
...
if (wantsRuntimeGuard) {
  if (!hasRuntimeFinding) findings.push({ dimension:"runtime", severity:"medium", title:"No runtime data", ... });
  if (verdict === "pass") verdict = "revise";
}
```
On any un-pushed diff `runtime.status` is `no_deploy_yet`/`unavailable`, so a green `pass` is
*mechanically* converted to `revise` + a synthetic MEDIUM. The adversary's actual verdict is
overridden. This is D4, and it alone means an un-pushed diff can **never** converge to `pass`.

### R2 — local verification is present but the prompt still won't sign off
`loop.ts:1760-1770`: when convention checks are all green, the snapshot is
`{ provider:"local", status:"ok", localVerification:[...] }`. So `wantsRuntimeGuard` is *false*
in cycle 2 — yet the model **still** emitted a "no runtime data" finding, because the system
prompt (`fable5-adversary.ts:130`) says *"If banner says NO RUNTIME DATA, you MUST NOT sign off
on runtime"* and does not tell the model that **passing local verification IS acceptable runtime
evidence for a non-UI/API-logic change.** `runtimeBanner()` (line 87-96) does render a
`RUNTIME DATA (local): ... N failed` line for `provider:"local"`, but the verdict/prompt rules
never say "local-green ⇒ runtime dimension satisfied for this change class."

### R3 — no cross-cycle finding provenance
`buildReviseDispatchHint` (loop.ts:268) feeds the prior verdict/findings *to the worker*, but the
adversary is **not** told which findings are recycled, so it re-emits them and re-counts them
(D1/D3). `runAdversary` receives no prior-review input at all.

### R4 — env-127 poisoning of cycle 1 (regression of beta.53)
`git-worktree.ts:313` calls `bootstrapWorktreeDeps` only when `bootstrapDeps !== false`, and
`bootstrapWorktreeDeps` (line 326) skips if `node_modules` is non-empty. In `1f2e6642` the
worktree had a **partial/stale** `node_modules` (non-empty but missing `eslint`/`tsx` binaries),
so bootstrap was skipped and cycle-1 lint/okf:check died `exit 127`. The loop then scored those
as **convention failures** rather than **env-unavailable**, poisoning the cycle-1 review tone.

### R5 — post-cancel adversary persists (D5) + no adversary cost circuit-breaker (D6)
Cycle-3 review landed 2s *after* `tool.cancel` and was persisted ($0.58 wasted). And there is no
guard that trips when adversary spend rivals worker spend on repeated all-green cycles.

---

## Fixes (ranked; F1+F2 are the convergence fix, ship together)

### F1 — finding classifiability gate (collapses D1+D3+D4)
Add a pure classifier + a verdict gate. **One principled change replaces five patches.**

New `src/orchestrator/finding-classify.ts` (pure, unit-tested), exported:
```ts
export type FindingClass = "diff_addressable" | "process" | "env" | "architectural" | "unproven_runtime";
export function classifyFinding(f: ReviewFinding, ctx: ClassifyCtx): FindingClass;
export function isBlockingFinding(f: ReviewFinding, cls: FindingClass): boolean;
```
Rules (deterministic, keyword+dimension based, mirrors `finding-hygiene.ts` style):
- `dimension==="runtime"` AND runtime unavailable/local-only ⇒ `unproven_runtime` (NON-blocking).
- title/detail matches test-wiring shapes (`/no (automated |unit )?tests?|test script|not (executed|run|wired) by/i`)
  when `repoConventions` shows **no declared test script** ⇒ `process` (NON-blocking).
- env shapes (`/not found|exit 127|eslint: |tsx: |command not found/i`) ⇒ `env` (NON-blocking).
- platform/size/deploy-architecture shapes ⇒ `architectural` (NON-blocking).
- everything else ⇒ `diff_addressable` (blocking iff `severity>=medium`).

**Verdict gate** in `runAdversary` (replaces the R1 block):
- Compute `blocking = findings.filter(f => isBlockingFinding(f, classifyFinding(f, ctx)))`.
- A `revise` verdict **requires ≥1 blocking finding that is NEW this cycle** (see F3 provenance).
- If the model says `revise` but `blocking.length===0` (all findings are non-blocking or recycled)
  ⇒ downgrade verdict to `pass`. Emit audit `adversary.verdict_downgraded {from:"revise", to:"pass", reason}`.
- Keep `block` untouched (genuine redesign still hard-stops).
- **DELETE the `if (verdict==="pass") verdict="revise"` force-upgrade.** Replace with: if runtime
  is unproven, inject the `unproven_runtime` finding as **`severity:"info"`** (non-blocking) and
  leave the verdict alone. The `reachedCleanPass=false`/`do_not_merge` gate (loop.ts:531 tail +
  merge-recommendation) already ensures a human approves the merge — the runtime concern is
  surfaced on the PR body, not used to block convergence.

### F2 — local-green counts as runtime evidence (prompt + banner)
In `buildAdversarySystemPrompt`: when `input.runtime?.provider==="local"` and `status==="ok"`, the
verdict rules must state: *"Local verification (lint/typecheck/declared check scripts) passed with
0 failures. For a change with no user-facing/deploy-observable surface, treat the runtime dimension
as SATISFIED by local verification; do NOT emit a 'no runtime data' finding."* Tighten line 130 so
the "MUST NOT sign off" clause applies only when `runtime` is genuinely `no_deploy_yet`/`unavailable`,
not when local verification is green.

### F3 — cross-cycle finding provenance (feeds F1's "NEW this cycle" test)
Thread the prior `ReviewReport` into `runAdversary` (`input.priorFindings?: ReviewFinding[]`).
- Prompt: *"These findings were raised in a PRIOR cycle and the worker attempted a fix. Do NOT
  repeat a finding unless you can state specifically why the attempted fix is insufficient."*
- Mark each output finding `recycled:true` when it fuzzy-matches a prior finding (reuse the
  token-overlap helper style from `finding-hygiene.ts`). F1's gate treats `recycled` findings as
  non-new ⇒ they can't sustain a `revise`.

### F4 — env-127 ≠ convention failure (fixes R4/D2)
Two parts:
1. `bootstrapWorktreeDeps` (git-worktree.ts:326): change the "node_modules non-empty ⇒ skip" guard
   to also verify the **declared check-script binaries resolve** (probe `node_modules/.bin/eslint`,
   `.bin/tsx`, or `npx --no-install <bin>`); if a declared binary is missing, run
   `npm ci --ignore-scripts` (fallback `npm install --include=dev --ignore-scripts`). The
   `--ignore-scripts` avoids the puppeteer-postinstall crash the cycle-2 worker hit manually.
2. `runCheckScripts` (repo-conventions.ts): classify **exit 127 / "command not found"** as
   `env_unavailable`, distinct from a convention failure, so it maps to `runtime.status` in a way
   F1 treats as non-blocking (not a red convention signal).

### F5 — post-cancel + cost circuit-breaker (D5/D6, hygiene)
- In the loop's review await: after `runAdversary` resolves, if the session abort flag is set,
  **discard** the report (don't persist, don't transition on it). Cheapest correct version of D5;
  aborting the in-flight SDK call is a nice-to-have, not required.
- Cost breaker: when `cyclesRan>=2` AND the last two cycles were both all-green convention with
  `blocking.length===0`, short-circuit to `pass` (the F1 gate already yields this, but add an
  explicit audit `adversary.converged_on_green` + skip a further adversary call to save the spend).

---

## Non-goals / boundaries
- **Adversary stays a single cold pass over the full diff** (MEMORY hard rule, Carel 2026-07-23).
  F1-F5 change *verdict interpretation + env + provenance*, NOT the adversary's independence or
  fan-out. `fable5-adversary.ts` reviews the whole diff in one call as today.
- Do NOT touch worker/lead warm-context (beta.66/67) or adaptive decomposition (beta.68).
- Runtime-guard is *demoted*, not deleted — the concern still appears (as `info`) on the PR body,
  and `reachedCleanPass`/`do_not_merge` still forces human merge approval.

## Test plan (tests/ currently 96 files; add `beta69-adversary-convergence.test.mjs`)
- classifyFinding: each class from real `1f2e6642` finding titles (no-runtime⇒unproven_runtime,
  no-tests-with-no-test-script⇒process, exit-127⇒env, 5000-row-platform⇒architectural,
  orderBy-dup⇒diff_addressable).
- verdict gate: model `revise` + all-non-blocking ⇒ downgraded to `pass` (+audit); `revise` + 1 new
  diff_addressable medium ⇒ stays `revise`; `block` untouched; **the exact cycle-2 all-green,
  0-convention-findings case ⇒ `pass`.**
- F1 regression: DELETE-force-upgrade — local-green `pass` is NOT converted to revise.
- F3: recycled finding does not sustain a revise; a prior finding with a stated
  fix-insufficiency reason does.
- F4: exit-127 classified env_unavailable not convention_fail; bootstrap re-runs when a declared
  bin is missing from a non-empty node_modules.
- F5: abort-flag-set ⇒ post-adversary report discarded.

## Rollout
Land beta.69 clean (typecheck+build+tests+smoke, CI green pre-merge). Install to Staging. Re-run
the SAME `grc-changes ?all=true` brief as a vanilla request. **Expected:** cycle-1 ships the diff,
convention checks green (env bootstrapped), adversary emits the runtime concern as `info`, verdict
gate returns `pass`, PR opens with `do_not_merge`/needs-human annotation. First convergent PR from
a trivial diff in the series.
