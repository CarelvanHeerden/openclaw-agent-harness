---
name: harness-brief-intake
description: >-
  Hand a coding request to openclaw-agent-harness without corrupting it. Use this
  skill BEFORE every harness_run / harness_start_session call. It covers the two
  things that decide whether a run is worth its money: pass the user's
  specification VERBATIM (never a summary you wrote), and echo the premise back
  to the user in one short paragraph so a misreading surfaces in seconds rather
  than after a two-hour run. Also covers the beta.120 pre-spend confirmation
  pause and how to relay it.
---

# Harness brief intake

Everything the harness builds is downstream of the string you put in `request`.
The harness will crystallise that string into a structured brief, plan against
the brief, and build against the plan — faithfully, and at a cost of tens of
dollars and one to two hours. **It cannot detect that the string you gave it is
not what the user asked for.** Nothing later in the pipeline recovers from a
corrupted intake: the adversary reviews the code against the brief, so a wrong
brief produces a clean review of the wrong feature.

## The failure this skill exists to prevent

On the b119 take-2 smoke a user handed OpenClaw a 10,710-byte markdown spec for
a **BCP/DR artefact library** — a store for dated reports of disaster-recovery
tests that had *already been run*. OpenClaw passed the harness a ~40-line
summary it had composed itself. In the summary:

- `performedAt` (the date the test was run) had become `scheduledAt`;
- the status vocabulary `DRAFT | FINAL | SUPERSEDED` had become
  `planned | in_progress | completed | cancelled`;
- `exerciseType`, `nextDueAt`, `period`, `results` and `relatedControlId` were
  gone, along with the whole storage section and the out-of-scope block;
- the file model had lost `kind`, `title` and `fileSize`.

The harness built that summary correctly: a system for **planning upcoming
exercises**. Two runs, ~$18 and ~2 hours each, both worthless. Worse, the
summary was internally inconsistent (it kept `kind`/`title` in the upload UI but
dropped them from the data model), so one finding could never be resolved and
burned every revise cycle.

The same file, read off disk and passed as bytes, crystallises with every field
intact. **The harness's crystalliser was never the problem. The retelling was.**

## Rule 1 — pass the user's words verbatim

`request` must be the user's text **in full, byte for byte**.

- **Do not summarise it.** Not even "helpfully". Not into bullet points, not
  into acceptance criteria, not into a tidier structure.
- **Do not rename anything.** Field names, table names, route paths, status
  values and file paths are load-bearing. `performedAt` and `scheduledAt` are
  different features.
- **Do not drop sections** you judge to be background — the storage model, the
  reference implementations to copy and the out-of-scope list are the parts that
  keep a run inside its lane.
- **Length is not a problem.** A 10KB spec is normal and welcome. Turning it
  into 40 lines is not efficiency, it is data loss.

Condensing the request into a brief is the harness's own job, done by a model
with the repo's conventions in context. Doing it yourself first means it happens
twice, and the first pass is the lossy one.

### If the request came from a file, pass the path

When the user's spec exists as a file, pass `requestPath` (absolute) instead of
retyping it:

```
harness_run({ requester, requestPath: "/path/to/the-spec.md" })
```

The harness reads the bytes itself, which removes the hop where meaning is lost.
This is strongly preferred whenever a path exists. You may pass both `request`
and `requestPath`; the file wins, and the harness records how far your text
drifted from it.

If the read is refused, the error says why (the path must sit inside a
configured `brief.request_file_roots` directory). Fix the path or ask the
operator to configure the root — do **not** work around it by pasting a summary.

## Rule 2 — echo the premise back before you spend anything

In the same message where you fire the run, state in **two to four sentences**
what you understood the change to be. Not a restatement of the whole spec — the
*premise*, in the user's domain terms, plus the handful of identifiers that
would be catastrophic to get backwards.

Then say the run has started and that they can correct you.

> I read this as: a new GRC section that stores **artefacts of DR/BCP tests that
> have already been run** — dated reports, tabletop write-ups, sign-off sheets —
> with the files in private blob storage and only metadata in Postgres. Key
> fields `performedAt`, `exerciseType`, `nextDueAt`; explicitly not the policy
> register and not `/api/grc/evidence`. Starting the run now — if I've got the
> premise wrong, say so and I'll stop it.

This costs one paragraph and catches the class of error no downstream gate can:
if OpenClaw had written *"a module for scheduling upcoming DR exercises"*, the
user would have corrected it in five seconds.

Guidance for the echo:

- Lead with **what the thing is for**, in the user's words, not a feature list.
- Name the few identifiers that encode the premise (a date field that means
  "when it ran" vs "when it's due" is exactly this).
- State what you understood to be **out of scope** — misread scope is the second
  most expensive error after a misread premise.
- Keep it short. A long echo is skimmed; a short one is read.
- **Never** let the echo replace the verbatim `request`. It is a receipt, not
  the payload.

If the user's request is genuinely ambiguous, ask **before** calling
`harness_run` rather than guessing and echoing a guess.

## Rule 3 — relay the harness's own confirmation, do not answer it

Since beta.120 the harness runs its own gate. When a brief is high-risk it
crystallises (cents), then **pauses before any planning or worker spend** and
returns:

```
{ ok: true, awaitingConfirmation: true, sessionId, question }
```

When that happens:

1. **Show `question` to the user verbatim.** It is the crystallised brief — the
   acceptance criteria the harness is about to build against. This is the last
   cheap moment to catch a misunderstanding, and it is a *different* check from
   your own echo: yours catches "I misread the user", this one catches "the
   crystalliser misread the text".
2. **Do not confirm on the user's behalf.** Not even when it looks obviously
   right. The entire value of the gate is that a human's eyes cross it.
3. **Do not** start polling `harness_progress` yet, and do not fire another
   run — nothing is executing.
4. When the user replies, pass their reply **verbatim** to `harness_answer`:

```
harness_answer({ sessionId, answer: "<the user's reply, exactly>", invokedBy })
```

An unqualified approval ("confirm", "yes", "go ahead") starts the run unchanged.
**Anything else** — including "confirm, but use `performedAt`" — is folded into
the brief as an authoritative correction first. That is deliberate: passing a
qualified reply through as an approval would start a run that ignores the
correction.

Once the run is going, resume the normal duty: poll `harness_progress` every
~45s and relay `headline` until `terminal`.

## Anti-patterns

| Don't | Do |
|---|---|
| Rewrite a spec into your own acceptance criteria | Paste the spec; let the harness crystallise it |
| Trim a "long" brief to save tokens | Pass all of it; 10KB is fine |
| Rename fields to something you find clearer | Preserve every identifier exactly |
| Drop the out-of-scope section as boilerplate | Pass it; it is what keeps the run in its lane |
| Read a spec file, then retype it from memory | Pass `requestPath` |
| Answer the confirmation pause yourself | Relay it and wait |
| Skip the echo because the request seemed clear | Echo anyway; it is one paragraph |

## Checklist before every harness_run

- [ ] Is `request` the user's text **in full**, or did I write it?
- [ ] If a spec file exists, am I passing `requestPath`?
- [ ] Have I preserved every field name, path and status value?
- [ ] Is the out-of-scope section still in there?
- [ ] Have I echoed the premise back in 2–4 sentences?
- [ ] If it paused for confirmation, did I relay it verbatim and wait?
