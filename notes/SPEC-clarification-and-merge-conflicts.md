# Harness specs: (B) mid-run clarification & (C) merge-conflict handling

Author: Clark · 2026-07-20 · grounded against beta.51 source (`a14f017`)

> **STANDING DIRECTIVE (Carel, 2026-07-20 17:59 UTC): DO NOT BUILD ANY OF THIS
> YET.** #858 revise must actually COMPLETE end-to-end (adversary review + 422
> PR endgame) for the first time before we add ANY new features. These specs are
> parked, reviewed and ready, but frozen until #858 lands. When #858 completes,
> revisit sequencing: C3 → B1+B3 → B2 → C1+C2.


Two independent features Carel asked for while #858 revise runs. Both share one
architectural theme: **the harness runs async/detached, so anything that needs a
human decision must be a resumable pause surfaced through the tool layer — never
a silent guess and never a hard fail.**

---

## Feature B — Mid-run clarification ("the harness asks a question")

### Problem

Cursor pauses and asks when a request is ambiguous. The harness never does. Two
distinct clarification moments exist:

1. **Crystallisation-time** (before planning). *Exists in code but dormant.*
   `crystallise()` already returns a union `{kind:"brief"} | {kind:"clarify",
   question} | {kind:"reject"}`. It rarely picks `clarify` because the
   crystalliser prompt biases hard toward emitting a brief, AND `harness_revise`
   builds the brief directly from stored findings, bypassing crystallisation
   entirely. So on the revise path it *cannot* fire.

2. **Mid-run** (lead planning or a worker hits genuine ambiguity). *No path
   today.* The worker makes a judgment call and records it in `finalMessage`
   (e.g. #858 sub-task 2 refusing to delete non-empty `grc/` dirs). It never
   pauses to ask. `loop.worker_refusal` (beta.48) is terminal-ish, not a
   question-and-resume.

### Design principle

Guess-and-document is *defensible* for an async harness (no human at the
terminal), but only if the guess is **surfaced** and **reversible**. So B is not
"make the worker block on every doubt" — it's "give the harness a first-class
resumable CLARIFY channel for the rare high-stakes ambiguity, and make ordinary
judgment-call deviations *visible*."

### Two-part build

#### B1 — Surface the DORMANT crystallisation clarify (cheap, do first)

- The `{kind:"clarify"}` branch already exists; wire it to the tool return.
- `harness_run` already can return it — verify it propagates `clarify.question`
  to the tool result as `{ needsClarification: true, question }` (same shape as
  `harness_revise`'s existing `needsSelection` picker). The calling agent
  (OpenClaw/Staging) relays the question to the user and re-invokes `harness_run`
  with the appended answer.
- Prompt nudge: the crystalliser system prompt currently over-rewards producing
  a brief. Add: "If the request is genuinely ambiguous on a decision that would
  change WHICH files or WHAT behaviour, return `clarify` with ONE specific
  question rather than guessing." Keep the bias toward briefs — clarify is the
  exception, not the default.

#### B2 — NEW mid-run resumable clarification state

- New terminal-but-resumable session status: `awaiting_clarification`
  (parallels the existing `resumable`/`interrupted` states recovery already
  understands — add it to the NON_TERMINAL / resumable set).
- New lead/worker escape hatch: instead of failing or guessing on a genuinely
  blocking ambiguity, emit a structured `{ needsClarification: true, question,
  seq, context }`. Loop transitions to `awaiting_clarification`, persists the
  question + the sub-task index it paused at, releases NOTHING (worktree stays,
  so resume continues in place — do NOT reap the worktree on this transition;
  add `awaiting_clarification` to the worktree-protect set from beta.45).
- **Surface it** (harness is Slack-silent post-beta.34): the question rides
  `harness_progress.headline` → `Awaiting clarification: <question>` AND a
  `needsClarification` field on the progress snapshot. The polling agent relays
  it to the requester's channel in its own voice (same poll-relay contract as
  beta.37/41).
- **Resume**: extend `harness_resume` (or a dedicated `harness_answer`) to take
  `{ sessionId, answer }`. The answer is folded into the paused sub-task's
  context (append to the worker brief / lead note) and the loop re-drives from
  the paused seq — NOT a restart. Reuses the beta.30 auto-resume re-drive
  machinery.
- Audit: `loop.clarification_requested {seq, question}` +
  `loop.clarification_answered {seq, answer_len}`.

#### B3 — `loop.worker_deviation` audit event (pairs naturally, Staging-recommended)

- When a worker's `finalMessage` indicates it deviated from the literal sub-task
  wording but still passed verification (the #858 sub-task-2 grc case), emit
  `loop.worker_deviation {seq, summary}` so the judgment call is a first-class
  audit signal, not buried in prose. Low priority; cheap; makes "guess-and-
  document" auditable, which is the precondition for trusting it over B2's
  heavier pause.

### Why B2 pairs with B3

B2 = "pause and ASK when the guess is too costly to make." B3 = "make the guess
VISIBLE when the worker proceeds anyway." Together they close the "agent that
pretends certainty" gap: the harness either asks, or it acts and tells you
exactly what it decided. The threshold between them is the lead/worker's call,
disciplined by the prompt (ask only when the decision changes files/behaviour).

### Scope call

B1 is small (wire an existing branch + one prompt line). B2 is the real feature
(new state + resume + surfacing). B3 is a one-event add. Recommend B1+B3 together
as a quick win, B2 as its own release after #858 lands — B2's resume machinery is
where the risk is (a mis-wired resume could wedge a session mid-run), so it wants
its own test pass.

---

## Feature C — Merge conflicts

### Current behavior (GROUNDED in beta.51 source, not guessed)

Three places conflicts can arise; here's exactly what happens today:

1. **Revise checkout (`git-worktree.ts` allocate, `reuseExistingBranch`)**: on a
   revise, the harness does `worktree add <wt> origin/<branch>` — checks out the
   PR head at its OWN tip. It **never rebases onto latest `main`**. So if `main`
   moved since the PR branch was cut, the harness works on a **stale base** and
   never even detects the drift. The conflict only materialises later, at merge.

2. **`mergePr` (index.ts ~1521)**: fetches `pr.mergeable` (github.ts returns it)
   but **NEVER checks it**. It gates on CI (`getCombinedStatus`) then calls
   `mergePullRequest(... method:"squash")`. A conflicted PR (`mergeable:false`,
   `mergeable_state:"dirty"`) hits the merge API and fails with a raw error
   string in the tool return — no diagnosis, no remediation.

3. **Deploy-repair revert (`git-worktree.ts` revertCommits, beta.36/38)**: this
   one is handled well — a `git revert` that conflicts is ABORTED and surfaces a
   clear error (`revert of <sha> conflicted; aborting ... main left untouched`).
   Good pattern to mirror elsewhere.

So: **the deploy-repair path handles conflicts correctly; the primary revise +
merge path does not detect or handle them at all.**

### Design principle

The harness must NEVER attempt to auto-resolve a content conflict (that's
inventing code to reconcile two intents — exactly the confabulation risk we've
spent 50 betas hardening against). It must: (a) DETECT drift early, (b) do the
SAFE mechanical resolution (rebase/merge when there's no content overlap), and
(c) when there IS overlap, either run the conflict as a first-class SUB-TASK the
worker resolves with full verification, or PAUSE for a human (ties into B2).

### Three-part build

#### C1 — Detect drift EARLY (rebase-onto-base at revise checkout)

- In `allocate()` `reuseExistingBranch` path: after checking out
  `origin/<branch>`, attempt `git rebase origin/<baseBranch>` (or a merge of
  base into the branch) in the worktree.
- **No conflict** → fast-forward/clean rebase, branch is now current, force-push
  with lease at endgame. Drift silently handled.
- **Conflict** → `git rebase --abort` (leave the branch pristine), record
  `conflictFiles` (from `git diff --name-only --diff-filter=U`), and set a flag
  on the plan so the lead knows base has drifted with overlap. Emit
  `loop.base_drift_conflict {files}`.

#### C2 — Conflict resolution as a first-class SUB-TASK (preferred over pause)

- When C1 detects an overlapping conflict, the lead injects a **conflict-
  resolution sub-task at seq 1** (before the revise work): a `mutate` sub-task
  whose brief is "rebase <branch> onto <base>; resolve conflicts in <files>
  preserving BOTH the PR's intent (<original goal>) and the incoming changes;
  the resolution must build + typecheck." Contract: `commit_made` +
  `file_committed` on the conflict files + a build/typecheck observe check.
- This reuses everything: the worker writes real code, the verifier (now with
  beta.51 path resolution) confirms it, the adversary reviews it. A conflict
  resolution is just another mutate the harness already knows how to verify.
- If the worker can't cleanly resolve (its own judgment, surfaced via B3
  deviation or a refusal), it escalates via B2 `awaiting_clarification`.

#### C3 — `mergePr` pre-check + honest refusal (do this one FIRST, it's cheap)

- Before the CI gate in `mergePr`, check `pr.mergeable`:
  - `mergeable === false` (or `mergeable_state` in `dirty`/`behind`) → refuse
    with a clear message: `Refusing to merge PR #N: branch has conflicts with
    <base> (mergeable_state: dirty). Re-run harness_revise to rebase + resolve,
    or resolve in the GitHub UI.` Emit `tool.merge_refused {reason:"conflict"}`.
  - `mergeable === null` (GitHub still computing) → poll `getPullRequest` a few
    times with backoff before deciding; don't merge on unknown.
  - `mergeable_state === "behind"` (no content conflict, just base moved) →
    safe mechanical case: update the branch from base (`PUT /pulls/{n}/
    update-branch` or a rebase-push) then re-check, rather than refusing.
- Same hard-gate philosophy as the CI refusal already there: the harness never
  force-merges; it either merges cleanly or tells the human exactly why not.

### How C ties into B

C2's "resolution sub-task" is the guess-and-verify path (worker resolves, gets
reviewed). C's escalation-when-stuck is exactly B2's `awaiting_clarification`.
So C is best built AFTER B2 exists — C3 (the cheap merge-gate) can ship
immediately and independently; C1+C2 want B2's pause channel as their safety net.

### Scope call

- **C3 (merge-gate pre-check)**: ship now, standalone, ~30 lines + a refused
  path. Immediately stops the raw-error-on-conflict behavior.
- **C1 (rebase-detect at checkout)**: medium; needs real-git conflict fixtures.
- **C2 (resolution sub-task)**: depends on C1 + ideally B2. Biggest piece.

---

## Recommended sequencing (after #858 revise lands)

1. **C3** — merge-gate `mergeable` pre-check. Cheap, standalone, high value.
2. **B1 + B3** — wire dormant crystallisation clarify to the tool return +
   `loop.worker_deviation` event. Small, makes existing behavior honest.
3. **B2** — mid-run `awaiting_clarification` resumable state + resume path.
   The real clarification feature; own release + test pass.
4. **C1 + C2** — rebase-detect + conflict-resolution sub-task, using B2 as the
   escalation safety net. The real merge-conflict feature.
