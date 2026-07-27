---
name: harness-pr-steward
description: >-
  Close the review loop on an openclaw-agent-harness PR so a human's ONE prompt
  yields a merge-ready PR. Use this skill after a harness_run / harness_revise
  session reaches a terminal state with a PR, or when a harness PR shipped with
  self-flagged, in-scope follow-ups (e.g. the PR author itself said "this needs
  a test" / "add audit logging"). The steward reads the adversary findings and
  the author's own notes, auto-fires ONE follow-up harness_revise per
  mechanically-actionable item (bounded iteration budget), and then surfaces the
  single human decision: merge or not. It NEVER auto-merges and NEVER pushes
  code by hand — the harness does the work; the human owns the merge.
---

# Harness PR Steward

The harness's job ends at **"PR shipped + adversary verdict + findings."** It
deliberately does *not* decide "is this actually done enough to merge" — that is
an orchestration judgment one layer up, in the OpenClaw agent. Right now that
layer is the human: they read the review, notice the PR author flagged its own
missing test, and re-prompt the harness by hand. **This skill is that noticing,
automated.** The goal: the human gives one prompt ("build X"), and later gets
one decision ("PR #N is merge-ready — merge?").

This skill lives in the agent/skill layer, NOT in harness code, because it:

- composes **multiple** harness sessions (run → revise → revise),
- reads GitHub/PR state and makes a merge-readiness call,
- enforces the human-in-the-loop **merge gate** (SOUL rule: nothing
  external/irreversible without approval).

## When to run

Trigger the steward when **any** of these is true for a harness PR:

1. A `harness_run` / `harness_revise` session just reached a terminal state
   (`done` or `failed`) **and produced a PR** (or a recoverable commit on a
   branch — see the beta.73 D3 notes below).
2. The adversary verdict was `pass`/`revise` but the review or the PR author's
   own end-turn notes contain a **self-flagged, in-scope follow-up** ("needs a
   test", "should add X", "the author flagged this themselves").
3. The human explicitly asks to "get PR #N merge-ready" / "close out the
   findings on #N".

Do **not** run the steward for a PR the human has already merged, or one whose
only open items are human-judgment calls (see the classifier below).

## The loop (bounded, progress-gated)

```
1. READ    the terminal harness session for PR #N:
             - harness_session_get / harness_progress for the adversary
               findings + verdict + the worker's end-turn notes.
             - the PR's own body / review comments (GitHub) for author
               self-flags.
2. EXTRACT the open follow-ups. Each item: {text, source, severity}.
3. CLASSIFY each into:
     - AUTO-ACTIONABLE: mechanical, in-scope, unambiguous. The strongest
       signal is the PR author flagging it about its OWN work
       ("I did not add a test for the export branch"). Examples: add the
       flagged test, add the missing null-check the review named, wire the
       obvious error branch.
     - HUMAN-JUDGMENT: design/architecture/opinion. Examples: "consider an
       ActivityLog audit entry", "a $transaction snapshot would be cleaner",
       "payload size may matter as the table grows". These are NOTED, never
       auto-fired.
4. IF there are AUTO-ACTIONABLE items AND the iteration budget is not spent:
     - fire ONE `harness_revise prNumber:N` with a tight, test-only-or-scoped
       brief for those items (do NOT widen scope; forbid touching approved
       source unless the item requires it).
     - wait for that session to terminate (poll harness_progress).
     - go to step 1 (re-read; the set of open items must STRICTLY shrink).
5. ELSE (no auto-actionable items left, or budget spent):
     - STOP and surface ONE decision to the human:
         "PR #N is merge-ready. Auto-resolved: <list>. Human-judgment items
          noted (non-blocking): <list>. Merge? (I will not merge without your
          go-ahead.)"
```

### Hard guardrails (do not skip)

- **Iteration budget: max 2–3 revise passes.** Each pass MUST strictly reduce
  the count of open auto-actionable items. If a pass does not reduce them (the
  harness couldn't resolve a finding, or it re-flags the same thing), STOP and
  escalate to the human with what's stuck — never loop on a stubborn finding.
  We have burned enough time on near-infinite loops; the budget is a hard cap.
- **Never auto-merge.** The final merge is ALWAYS the human's explicit prompt.
  The steward proposes and prepares; the human decides. Use `harness_merge_pr`
  only after the human says merge, and only if its hard gate allows it.
- **Never hand-push / hand-edit code.** If the harness produced a good commit
  that failed only to open/push (see beta.73 D3), report that to the human and
  let them decide whether to re-fire or push — do not `git push` yourself
  during a steward loop.
- **Scope discipline.** A follow-up revise brief must be as narrow as the item
  (e.g. "test-only, do NOT touch route.ts"). Do not let the steward turn a
  one-test follow-up into a refactor.
- **In-scope only.** Only auto-fire items that are within the original PR's
  scope + the review's own findings. A new feature idea in a comment is a
  human-judgment item, not an auto-action.

## Classifier heuristic (AUTO-ACTIONABLE vs HUMAN-JUDGMENT)

AUTO-ACTIONABLE when ALL hold:
- the item is stated as a concrete, mechanical change ("add a test that asserts
  X", "handle the empty-array case", "remove the unused import");
- it is within the files/behaviour the PR already touches;
- it does not require a product/architecture decision;
- **bonus-strong signal:** the PR author flagged it about its own work, or the
  human's review used the phrase "the author flagged this themselves" / "trivial
  here" / "should ship with tests".

**OUT-OF-SCOPE / STRAY CHANGE = ALWAYS AUTO-ACTIONABLE (do not sit on it).**
A `do_not_merge`/`block` finding of the form "out-of-scope modification to
<file>", "touched <file> despite the brief forbidding it", "stray change to
<X>", or "change outside the stated scope" is the CLEAREST auto-fix there is:
the fix is deterministic — **revert that file/hunk to its pre-PR state**, keeping
only the in-scope work. Do NOT surface a scope-violation `do_not_merge` to the
human as a decision; fire a scoped `harness_revise` that says exactly "revert
all changes to <file> (out of scope per the original brief); keep only <the
in-scope work>; do NOT touch <file> again", then loop to a clean pass. The
harness sitting on a `do_not_merge` for a stray change is the exact anti-pattern
this skill exists to kill (Carel, #876: "why are we sitting on a do_not_merge?
if something is out of scope, OpenClaw should fix it"). Only escalate to the
human if the revert itself keeps failing (the 2–3 pass budget) OR reverting the
file would break the in-scope work (scopes entangled = a genuine judgment call).

HUMAN-JUDGMENT (note, never auto-fire) when ANY holds:
- it starts with "consider" / "might" / "worth being aware" / "as it grows";
- it proposes a new subsystem, schema change, or audit/telemetry design;
- it trades off correctness vs performance vs complexity;
- it is explicitly marked non-blocking / minor in the review.

When unsure, treat it as HUMAN-JUDGMENT. A missed auto-fix costs one extra human
prompt; a wrong auto-fix costs a bad commit + churn.

## Worked example (the case this skill was born from)

Human's ONE prompt shipped PR #876 (change-register export mode). Adversary
`pass`, 4 non-blocking findings. The PR author itself said *"I did not add a test
for the export branch."* The human's review: "Add a test for the export branch …
the PR author flagged this themselves, and it's trivial here."

Steward behaviour:
- EXTRACT: 1 self-flagged item ("add export-branch test") + 3 human-judgment
  minors (ActivityLog audit entry, `$transaction` snapshot, payload-size
  awareness).
- CLASSIFY: the export-branch test = AUTO-ACTIONABLE (author flagged own work,
  mechanical, in-scope, "trivial"). The 3 minors = HUMAN-JUDGMENT (all start
  "consider" / design calls).
- ACT: one `harness_revise prNumber:876` with a tight test-only brief (the exact
  two cases, "do NOT touch route.ts").
- STOP + surface: "PR #876 is merge-ready — export-branch test added (16/16
  pass, adversary pass). Non-blocking design notes for your call: ActivityLog
  audit entry, transactional count+findMany, payload size. Merge?"

That converts the human's earlier THREE manual prompts (notice → paste brief →
re-fire after infra hiccups) into ZERO — the steward does the noticing and the
re-fire, and the human's only remaining input is the merge decision.

## Interaction with the harness (tools used)

- `harness_progress` / `harness_session_get` — read verdict, findings, author
  notes, terminal state.
- `harness_list_revisable` — find the session/PR to steward when not given one.
- `harness_revise prNumber:N` — fire the scoped follow-up (D-B/beta.72 makes the
  auto-brief non-empty; but for a PRECISE item prefer an explicit brief).
- `harness_merge_pr` — ONLY after the human's explicit merge go-ahead.

## Notes / known harness behaviours the steward must account for

- **beta.73 D3 (PR-open observability):** a session can end `failed` with the
  work already good (adversary passed, commit exists) if the PR-open/push step
  failed. Check for `loop.pr_open_failed` / `loop.failed{reason}` in the audit;
  if the failure was environmental (missing token, branch collision, a `noexec`
  convention 126), the deliverable commit is recoverable — report it to the
  human, don't treat `failed` as "no work done".
- **beta.73 D2 (base sha):** a follow-up `harness_revise` on an existing PR
  correctly reuses that branch's HEAD. Prefer `harness_revise` over
  `harness_run` for follow-ups so the base is the PR branch, not main.
- **Env failures are not quality failures:** exit-127/126 convention-check
  failures are env (beta.69/beta.73), not code defects — do not treat them as
  auto-actionable review findings.
