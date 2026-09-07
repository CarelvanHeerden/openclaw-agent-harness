# SPEC — The pre-spend confirmation must survive the relay

**Status:** DESIGN (no code written). Carel: "add it as the first fix for rc3".
**Target:** v2.0.0-rc.3, first item.
**Observed:** 2026-09-07, session `112673df-68e0-4846-ae97-30121ea2c02d`,
harness v2.0.0-rc.2, repo `Stitch-Vercel/StitchGuard`.

## Problem

The b120 gate exists so a human reads the crystallised brief before any money
is spent. On the rc.2 smoke, the human never saw it.

What `renderBriefConfirmation` produced (`src/tools/brief-confirmation.ts:152`):
an opener, the title, the motivation, the acceptance criteria, the files it
expects to touch, the out-of-scope list, the repository/risk/cost line, a
`Source:` line saying whether the spec was read verbatim off disk, the reply
instructions, and the session id.

What arrived in Slack:

> Harness v2.0.0-rc.2 is loaded. Before starting, it requires Carel's confirmation:
> Repository `Stitch-Vercel/StitchGuard`. Risk medium. Estimated ~$40.00, cap $40.00.
> Reply "confirm" to start, or specify changes. You can also set the budget or time
> limit, e.g. "confirm, budget $40 with a time budget of 4 hours." Default limit is
> 3 hours.
> Session `112673df-68e0-4846-ae97-30121ea2c02d`.

One line survived byte-for-byte — the repository/risk/cost line. Everything
else was rewritten or dropped. The harness's opener ("Before I spend anything,
confirm this is what you want built") became OpenClaw's own preamble. "or tell
me what to change (your reply is folded into the brief and the corrected
version runs)" became "or specify changes". "The default wall clock is 3h, and
a run that hits it stops whether or not the budget is spent" became "Default
limit is 3 hours", which drops the consequence and keeps only the number.

An empty brief cannot produce this. The three section headings print
unconditionally, with `- (none specified)` beneath them when the lists are
empty, so `Acceptance criteria (0):` would still have appeared. All three
headings are absent, along with the title, motivation and `Source:` line.

So: the gate fired, the harness rendered the brief, and the relaying agent
dropped it. The operator was asked to approve $40 against a brief consisting of
a repository name and a risk level.

### Why instruction-hardening will not fix this

The harness already says it twice, in the two strongest places available.

`src/tools/registration.ts:1093` returns, alongside the text:

> "STOP and show `question` to the user verbatim -- it is the brief the harness
> is about to build, and this is the last cheap moment to catch a
> misunderstanding."

And `skills/harness-brief-intake/SKILL.md` Rule 3 step 1: "Show `question` to
the user verbatim." The text is returned twice in the same response, as
`content[0].text` and as `details.question`.

This is the third failure of the same class, and each previous fix was another
instruction:

- b119/b120: OpenClaw retyped a 10,710-byte spec as a ~40-line paraphrase.
  `performedAt` became `scheduledAt` and the run was worthless twice, ~$18 and
  ~2h each. Fix: read the file off disk (`readRequestFile`) — a *structural*
  fix, and the one that worked.
- b121: OpenClaw showed the operator a session id that was not the session's.
  Fix: embed the real id in the question text so a careless retelling carries
  it. An instruction-shaped fix; it survived this incident only because the id
  is one short token.
- rc.2 (this): the question text itself was paraphrased.

A fourth instruction is not a fix. The b120 lesson was that removing the hop
beats asking the hop to behave.

## What the harness can actually do

The harness is not confined to tool-response text. `SlackProgressPoster`
(`src/slack/progress-poster.ts`) posts **directly** to `chat.postMessage` with
a vault-resolved bot token, no agent turn involved. It is armed at
`src/index.ts:2423` when `slack.credential_service` resolves a token and
`slack.native_progress_delivery` is not false, and it already carries retry
handling for 429/408/5xx and network blips.

It is deliberately not used for this. The b77 hard boundary
(`src/slack/progress-poster.ts:20`):

> HARD BOUNDARY: this is OUTBOUND, one-way, best-effort. It NEVER handles
> clarifications or any inbound control -- those stay 100% agent-mediated. The
> harness still never reads a free-text Slack reply (beta.34 removed the
> listener).

The stated reason is sound but proves less than the boundary claims. The
harness cannot **read** a Slack reply, which blocks the *answer* half of a
clarification. It says nothing about the *question* half. The boundary was
drawn around "clarifications" as a unit when the constraint only binds one
direction.

The gate that does bind: `hasRealSlackBinding` requires a non-empty channel and
a thread that is not a synthetic `agent:<uuid>` or `retired:<...>` key.
Agent-orchestrated runs have `slack_channel = ""` and `slack_thread =
"agent:<uuid>"`, and would get nothing.

**Open question, decides the shape of the fix:** did the failing session have a
real binding? If it did, Option A alone would have prevented this incident.

```sql
SELECT slack_channel, slack_thread FROM sessions
WHERE id = '112673df-68e0-4846-ae97-30121ea2c02d';
```

## Options

### E. Demand OpenClaw's own echo, in the confirmation message — Carel's direction

Carel, 2026-09-07: "The harness should tell openclaw, in the same message where
it recommends the budget, it should echo the brief based on what it understood
from the prompt."

Turn the relay into a generation task. Reproducing forty lines exactly is work
a model skips; stating what it understood is work it does willingly and well.
Every fix in this family so far has asked for faithful reproduction and got
compression. This asks for something models are actually good at.

Placement is the substance of the idea. The demand exists today, but it lives
in `details.feedback.instruction` — structured metadata sitting *beside* the
payload, which a caller can drop without dropping anything it is displaying.
It was dropped. Moving it into the message body, next to the budget line, puts
it in text the caller is already relaying.

That has a second-order property worth having. In the observed incident the
cost line and the reply instructions both survived; only the brief was cut. A
demand sitting in that surviving region is likely to survive the same
compression — and then the operator reads "OpenClaw should now state what it
understood" and can see for themselves that it did not. The instruction
polices itself, because the human it reaches is the same human being deprived.

**The trap: this must be additive, never a substitute.**

The two echoes catch different failures and are not interchangeable.

- *The crystalliser misread a faithful request.* The harness's brief and
  OpenClaw's understanding diverge, and the operator sees the divergence.
  Option E catches this.
- *OpenClaw misread the user.* The corrupted `request` produces a brief that
  faithfully reflects the corruption, and OpenClaw's own echo reflects the same
  misunderstanding. Both agree. Both are wrong. Option E cannot catch this, and
  it is exactly what happened on b119 — the paraphrase was fluent, confident,
  internally consistent, and turned `performedAt` into `scheduledAt`.

So if OpenClaw's echo ends up *replacing* the harness's brief, the gate becomes
worse than it is now: the operator gets a coherent restatement of the
corruption and no way to tell. The skill already states this principle in the
other direction, Rule 2: "Never let the echo replace the verbatim `request`. It
is a receipt, not the payload."

Which means E does not stand alone. It needs the harness's own brief to arrive
as well — which is what A and B are for.

- **For:** plays to model behaviour instead of against it. No new channel, no
  Slack binding required, works for agent-orchestrated runs. Cheapest of the
  options. Gives the operator a visible cue when it has been ignored.
- **Against:** cannot catch the b119 failure on its own, and creates a false
  sense of safety if mistaken for sufficient. Adds a second block of text to a
  message that is already long — the brief, the budget, the clock, and now an
  independent restatement, which risks the operator skimming all of it.

### A. The harness posts the confirmation itself

Extend the direct poster to deliver the brief confirmation. The question
reaches the human as rendered; the answer still returns through
`harness_answer`, unchanged.

The asymmetry is the point. Delivering the question is the half that must be
faithful, because it is long, structured, and the whole basis of the decision.
The answer is a short reply, and `parseConfirmationReply` is already strict:
only a whole-answer unqualified approval starts the run, and every qualified
reply is folded in as a correction. A mangled answer degrades safely; a
mangled question does not.

- **For:** reuses shipped, exercised machinery. Removes the hop entirely rather
  than asking it to behave, which is the only fix in this family that has
  worked. Small change.
- **Against:** dead for agent-orchestrated runs with no real binding. The
  operator may see two messages — the harness's authoritative one and
  OpenClaw's paraphrase — which is confusing but not dangerous. Crosses the b77
  boundary, so that comment must be rewritten to distinguish outbound question
  from inbound answer; left as-is, a future reader will correctly re-tighten it
  and silently undo this.

### B. Attestation on the answer path

`harness_answer`, when answering a brief confirmation, also carries what the
caller displayed. The harness compares it against the question it issued, reusing
the identifier-drift machinery already written for the inbound direction
(`measureParaphraseDrift`, `src/tools/brief-source.ts:210`). Material drift
means the confirmation is refused, the full question is returned, and the
caller is told to show it properly.

- **For:** works with no Slack binding, so it covers exactly the runs Option A
  cannot. Turns a silent failure into a loud one. Makes the correct path the
  easy path: pasting back what you showed is less work than composing a
  summary.
- **Against:** does not stop deliberate deception — a caller could paste the
  real text while showing the human something else. That is a different failure
  from the one observed; every instance so far has been lazy compression, not
  lying. Also a protocol change to `harness_answer`, which needs a
  compatibility story for callers that do not send the field.

### C. Token challenge — not recommended

Embed a short token in the question and require it in the confirming reply.
Proves a token travelled, not that the brief did; a paraphrase that keeps the
token passes. Adds operator friction ("confirm A7X2") for a guarantee that does
not hold.

### D. Outbound drift measurement alone — dead end

There is no outbound equivalent of `measureParaphraseDrift` and there cannot be
one without B. The harness never observes what OpenClaw posted, and no feedback
channel exists to tell it.

## Recommendation

E first, then A, with B as the fallback where A cannot reach.

E is Carel's direction and the cheapest change, and it is the only one that
improves matters on every run regardless of configuration. Build it first. But
ship it understanding what it does not do: it is a cross-check on the
crystalliser, not a substitute for the operator seeing the actual brief. On its
own it would have caught nothing in b119.

A supplies the missing half — the harness's own text, delivered without a hop
that can compress it — wherever a real Slack binding exists, which is the
configuration the smoke tests run in.

B covers agent-orchestrated runs, where A is dead by design, and converts the
residual exposure from silent to noisy.

Resolve the open question above first. If the failing session had no real
binding, B moves ahead of A.

### Sequencing note

E and A interact and should be designed together, not bolted on in sequence. If
the harness posts the confirmation directly *and* OpenClaw posts its own echo,
the operator sees two messages. That is acceptable and arguably desirable —
they are meant to be compared — but only if it is deliberate, the two are
visually distinguishable, and the authoritative one is obvious. Two similar
blocks of prose with no indication of which one the harness will build against
is a worse outcome than either alone.

## Non-goals

- Reinstating the Slack listener. The harness still must not read free-text
  Slack replies; b34 stands.
- Weakening `hasRealSlackBinding`. Posting into a synthetic thread was the
  pre-b37 failure that this gate was written to stop.
- Changing what `renderBriefConfirmation` produces. The text is correct; only
  its delivery is broken.
