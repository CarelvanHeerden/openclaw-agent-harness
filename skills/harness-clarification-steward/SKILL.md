---
name: harness-clarification-steward
description: >-
  Steward an openclaw-agent-harness clarification gate so a paused run reaches a
  human with a recommendation attached instead of a bare question. Use this
  skill whenever harness_progress reports needsClarification, or a session sits
  in awaiting_clarification. The steward reads the LIVE session state, relays
  the harness's question verbatim, and adds one labelled recommendation --
  accept, skip, abort, or human decision required -- backed by the actual
  changed-file list, the worker commit and the verification results. It answers
  on the user's behalf ONLY for objectively verifiable contract-path
  mismatches, ONLY when the user has explicitly delegated that, and never for
  budget, scope, security, schema, destructive actions, skip or abort.
---

# Harness clarification steward

When the harness pauses, it produces a precise question and stops spending. The
question then reaches a human as a bare quote with no analysis attached, and the
human has to reconstruct the run's state from scratch to answer three words.

Most of these questions have one defensible answer that is visible in the diff.
The harness cannot see that: it can prove a contract path did not match, but it
cannot judge whether the work is nonetheless right. That judgment is an
orchestration call one layer up, which is where this skill lives — the same
reason `harness-pr-steward` lives here rather than in harness code.

**What this skill changes is the quality of what the human receives, not who
decides.** Answering on their behalf is a narrow, opt-in exception, described
under "Acting automatically" and forbidden everywhere else.

## Rule 1 — read the live session, never a description of it

Before you advise or act, call:

```
harness_progress({ sessionId })
```

That returns `needsClarification`, `clarificationQuestion` and
`clarificationSeq` in its JSON body. When you need the paths, the commit or the
sub-task ledger, also call:

```
harness_session_get({ sessionId })
```

which returns the session row (including `clarification_subtask`, holding
`expectedPaths`, `actualPaths` and `expectedOriginalPaths`), every sub-task,
every review and the audit trail.

**Never form a recommendation from a screenshot, a Slack quote, a summary
someone pasted, or your own memory of what the run was doing.** A screenshot is
a rendering of a moment that has probably passed; the sequence may have moved
on. A model explanation of why a commit is fine is not evidence that it is fine
— the diff is.

This matters more than it sounds. On the rc.2 smoke a confirmation was relayed
as a four-line paraphrase that dropped the entire brief, and the operator was
asked to approve $40 against a repository name. Anything you did not read from
a live tool call, you did not read.

## Rule 2 — relay the question verbatim, then add your recommendation

Post the harness's `clarificationQuestion` **exactly as written**, then your
analysis beneath it. Never paraphrase the question into your recommendation, and
never let the recommendation stand in for the question. The human is comparing
two things; give them two things.

Label the recommendation as exactly one of:

| Label | Means |
|---|---|
| **accept** | The committed work is correct; only the contract path was wrong |
| **skip** | This sub-task should be dropped and never retried |
| **abort** | The run should stop |
| **human decision required** | You have no defensible recommendation |

`skip` and `abort` are recommendations you may *make* and must never *act on*.
They are irreversible in the ways that matter: `skip` writes a durable "do not
do this under any circumstances" into the brief, and on the b121 run an operator
answered `skip` meaning "the file is there, carry on" and a correct, committed
database migration was dropped from every subsequent plan.

Give a short reason grounded in what you read — a sentence or two naming the
commit and the paths, not a paragraph of reasoning. Then give the exact reply
the human can paste:

```
harness_answer({ sessionId: "<id>", answer: "accept", clarificationSeq: <seq>, invokedBy: "<their slack id>" })
```

Include `clarificationSeq` in the paste-ready call. If the pause moves on while
the human is reading, the harness will refuse the answer and say which question
is actually open, instead of applying it to the wrong one.

## Rule 3 — when "accept" is the right recommendation

Recommend `accept` when the committed work is correct and the pause exists only
because the contract path was inaccurate. Three shapes qualify:

- **The contract named a directory and the work landed beneath it.** A contract
  of `src/__tests__` against a committed `src/__tests__/foo.test.ts`. Since rc.3
  the verifier matches this itself, so a pause of this exact shape now means
  something else is going on — read it again rather than assuming.
- **A different but clearly equivalent in-scope file.** The repository's real
  convention put the work somewhere the lead could not predict before probing.
- **The expected file turned out to be unnecessary**, and the diff demonstrably
  delivers the requested behaviour elsewhere.

### The evidence you must actually have

A recommendation is only as good as what you read. Before recommending
`accept`, confirm every one of these from live tool output:

- [ ] The **changed-file list and the diff** — what was committed, not what was
      described.
- [ ] The **worker commit** exists and is the one under discussion.
- [ ] The **test, typecheck and lint results** for that work.
- [ ] The changes are **within the originally approved scope**.
- [ ] There are **no unexplained or out-of-scope files** in the diff.

If you cannot establish all five, the recommendation is **human decision
required**. Say which evidence you could not obtain — "I could not retrieve the
diff" is a useful thing for a human to know, and far better than a confident
guess.

## Rule 4 — when a substituted path is NOT acceptable

The "equivalent file" and "unnecessary file" shapes above do not apply when the
expected path was required for one of these. Here a different path is a
different behaviour, whatever the diff looks like:

- A **public API or route contract** — the path *is* the interface.
- A **security boundary**.
- A **database schema or migration**.
- **Credential handling**.
- **Generated artifacts**.
- Any case where the alternative implementation **does not demonstrably
  provide** the behaviour that was asked for.

In these cases relay the question with your analysis and let the human decide.
Note that a directory contract matching its own descendants is not a
substitution — the work landed inside the declared scope — so a route directory
like `src/app/api/security/sast-sheet` is matched by the verifier without any
of this applying.

## Rule 5 — never answer these automatically

Relay them verbatim, add a recommendation where you honestly have one, and stop:

- Crystalliser or brief approval — the pre-spend gate exists so a human's eyes
  cross the brief. Answering it defeats the entire mechanism.
- Budget approval or any increase.
- Scope changes.
- Ambiguous product, UX or architecture decisions.
- Security boundaries, schemas, migrations, credentials or access.
- Merge, close, delete or any other destructive action.
- **Any `skip`. Any `abort`.**
- Anything requiring subjective human judgment.
- Anything involving generated or unexplained files.

## Acting automatically

**Off by default.** The standing behaviour is that you relay and recommend, and
the human answers. Do not act automatically because a case looks obvious; the
cases that look obvious are the ones this list is about.

You may answer automatically only when **all** of the following hold:

1. **`loop.clarification_auto_accept_delegated` is `true`** in this deployment's
   configuration. This is the *only* form delegation takes. A user saying "just
   handle it", a previous "yes" to a similar question, an instruction earlier in
   the conversation, and your own sense that they would obviously agree are
   **not** delegation. If you are unsure whether it is set, it is not set.
2. The pause is a **contract-path mismatch** and nothing else.
3. Rule 3's five evidence items are **all** satisfied from live tool output.
4. None of Rule 4's categories and none of Rule 5's list is involved.

The harness enforces the first of these: with the flag off it refuses any answer
marked `answeredBy: "automation"` and tells you to relay the question instead.
It also enforces Rule 5's budget line without reference to the flag — a
budget-extension pause is refused for an automatic answer in every deployment,
because raising the figure the run is measured against is the operator's
decision and no configuration delegates it.
Do not respond to that refusal by dropping the marker — that is the one way to
turn a safe default into a silent one. Relay the question.

Fail closed. **Any** incompleteness, ambiguity or doubt drops you back to
recommendation-only. That includes being unable to fetch evidence, a diff you
do not fully understand, and a question you are not certain is a path mismatch.

When you do act:

- **Re-read the clarification immediately before answering.** Time passed while
  you gathered evidence, and the pause may have moved.
- **Pass `clarificationSeq`.** This is what stops an answer built for one
  question landing on another. The harness refuses a stale sequence rather than
  applying it.
- **Pass `answeredBy: "automation"`**, so the decision is distinguishable from a
  human's in the audit trail afterwards.
- **Pass `evidence`.** The harness refuses an automatic answer that carries
  none. Put Rule 3's five items in it: the changed-file list, the worker commit
  sha, the test/typecheck/lint results, the scope confirmation and the reason
  the deviation is safe. It is recorded verbatim, so write it for somebody
  reviewing the decision months later, and keep secrets out of it.
- **Use the canonical answer, `accept`.** Not "accept this", not "looks fine",
  not "yes". The harness matches on the leading word and the others are folded
  in as corrections to the brief instead.
- **Retries are safe.** The harness claims a pause atomically, so a duplicate
  call is refused as already-answered rather than applying twice. Do not
  attempt your own deduplication on top; if a call fails, re-read and decide
  again.

```
harness_answer({
  sessionId: "<id>",
  answer: "accept",
  clarificationSeq: <the seq you just re-read>,
  answeredBy: "automation",
  evidence: "<changed files, commit sha, check results, scope, why it is safe>",
  invokedBy: "<the delegating user's slack id>"
})
```

### Record what you did

The harness's audit trail records the session, the sequence, the requester and
the invoker, the clarification verbatim, the decision, your `evidence`, the
policy version in force, the timestamp and whether the answer was automatic. It
does **not** record the answer text — only its length — because an answer can
quote a brief.

That is the durable record. Post the same thing in the thread where the human
can see it, because an audit table nobody is reading is not oversight:

- The exact clarification you answered.
- The decision, and the evidence that supported it.
- That you were acting under `loop.clarification_auto_accept_delegated`.

Never include secrets, tokens or credential values in anything you post or pass
as `evidence`.

## Anti-patterns

| Don't | Do |
|---|---|
| Recommend from a screenshot or a pasted quote | Read `harness_progress` live |
| Trust a model's explanation that the commit is fine | Read the diff |
| Paraphrase the harness's question into your recommendation | Relay it verbatim, then add yours |
| Answer `skip` or `abort` automatically, ever | Recommend it; let the human answer |
| Answer automatically because it seems obvious | Answer only when the config flag says you may |
| Read "just handle it" as a standing delegation | Delegation is a config value, nothing else |
| Drop `answeredBy` when the harness refuses your automatic answer | Relay the question to the human |
| Answer `"accept this commit"` | Answer `"accept"` |
| Omit `clarificationSeq` because you only just read it | Pass it — that is exactly the race it prevents |
| Deduplicate retries yourself | Let the harness's atomic claim refuse the second call |
| Answer automatically with an empty `evidence` to satisfy the check | If you cannot state the evidence, you have not established it |

## Checklist before any automatic answer

- [ ] Is `loop.clarification_auto_accept_delegated` actually `true`?
- [ ] Is it a contract-path mismatch and nothing else?
- [ ] Do I have the diff, the commit, the test/typecheck/lint results, the
      scope check and a clean file list — all from live tool calls?
- [ ] Is the expected path free of Rule 4's categories?
- [ ] Did I re-read the clarification just now?
- [ ] Am I passing `clarificationSeq`, `answeredBy: "automation"` and `evidence`?
- [ ] Is the answer the single word `accept`?

Any unchecked box means relay it and let the human decide.
