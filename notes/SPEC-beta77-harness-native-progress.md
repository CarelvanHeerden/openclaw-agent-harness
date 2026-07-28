# SPEC — beta.77: harness-native progress delivery (decouple the outbound firehose from the wedge-prone agent turn)

## Problem (the DR/BCP wedge, 2026-07-27)

In agent-orchestrated mode the harness surfaces progress/terminal ONLY via the
poll model: the loop writes audit rows (`reportProgress` → `loop.progress`) and
the calling OpenClaw agent POLLS `harness_progress` and relays headlines to Slack
in its own voice, through its own embedded agent turn (`api.sendMessage`).

When that channel-agent poller wedges (`embedded_run:started`, `recovery=none` —
the `d47c8686` blackout on the DR/BCP run), the harness LOOP keeps running fine
(it terminated cleanly at 21:01:51), but NO progress or terminal announcement
reaches the human. The run looks hung though it isn't. A single wedge in the
agent turn BLINDS the entire run.

## Fix

Give the harness a SECOND, INDEPENDENT outbound path for **progress + terminal
announcements only** that does NOT go through `api.sendMessage`: a direct
`chat.postMessage` to Slack, authenticated by the SAME vault-resolved bot token
the reactions poller already uses. A wedge in the agent turn can no longer blind
the informational stream.

## Hard boundary (settled with Carel + Staging, source-verified)

- Decouple ONLY the OUTBOUND, one-way informational stream (progress ticks +
  terminal). These need no reply.
- CLARIFICATIONS / human-in-the-loop decisions stay 100% agent-mediated and
  UNCHANGED: the loop pauses into `awaiting_clarification`, sets the DB question,
  `harness_progress` exposes `needsClarification`, the agent relays it in its own
  voice and resumes via the `harness_answer` TOOL. The harness NEVER direct-posts
  a question, and NEVER reads a free-text Slack reply (beta.34 removed the
  listener deliberately). The answer always arrives through a tool call.
- Do NOT touch: `harness_run` / `harness_progress` / `harness_answer` schemas,
  the reactions poller, the dispatcher/listener (listener mode), the crystalliser.

## Design

### 1. `src/slack/progress-poster.ts` (new)

- `hasRealSlackBinding(channel, thread): boolean` — PURE gate. True iff `channel`
  is non-empty AND `thread` is non-empty AND `thread` does NOT start with
  `agent:` (agent-orchestrated runs default `slack_thread = "agent:<uuid>"`) NOR
  `retired:` (reclaimed tombstone). This is why the pre-beta.37 direct-post died:
  agent runs had `""`/`agent:<uuid>` so every post was rejected + swallowed. We
  only fire when a REAL Slack channel+thread was passed on `harness_run`.
- `SlackProgressPoster` — mirrors `SlackReactionsReader`: `{ slackToken,
  fetchImpl?, logger }`. Method `post(channel, threadTs, text): Promise<{ ok,
  ts?, error? }>` → direct `POST https://slack.com/api/chat.postMessage` with
  `Authorization: Bearer <slackToken>`. BEST-EFFORT: never throws (returns
  `{ok:false, error}` on any failure); 429 / `ratelimited` are swallowed (logged
  warn) — a failed progress post must NEVER fail the run. Posts into the thread
  (`thread_ts: threadTs`).

### 2. Loop hook — `deliverProgress` dep, fired from `setStatus`

- New optional `OrchestratorDeps.deliverProgress?(sessionId, status): void`
  (fire-and-forget; the loop stays Slack-agnostic — pure dep injection, no Slack
  import in loop.ts).
- Called from inside `setStatus(sessionId, status)` — the SINGLE choke point that
  every phase transition (`planning`/`executing`/`reviewing`) AND every terminal
  transition (`done`/`aborted`/`failed`/`awaiting_clarification`) already flows
  through. One hook = full coverage, no need to touch every `finalise*` site.
- Invoked AFTER the status DB write, wrapped so a throw can never escape
  `setStatus` (which is sync and on the hot path).
- `awaiting_clarification` is delivered too (so the human SEES the pause landed
  even if the agent poller is wedged) — but this is only the ANNOUNCEMENT; the
  actual answer still comes back via `harness_answer` (unchanged). The headline
  for that status already says "answer via harness_answer sessionId=…".

### 3. index.ts wiring

- In `bootstrapHarnessAsync`, inside the existing `if (config.slack.credential_service)`
  block (reuse the already-resolved `slackToken`), build a `SlackProgressPoster`
  and stash it on `runtime.progressPoster` (a new mutable slot, null until async
  bootstrap runs — the loop is constructed synchronously earlier, so
  `deliverProgress` must read the slot lazily).
- Wire `deliverProgress` into the loop deps (synchronously, at construction):
  it reads the session's `slack_channel`/`slack_thread`, and IF
  `runtime.progressPoster` is set AND `config.slack.native_progress_delivery !== false`
  AND `hasRealSlackBinding(channel, thread)`, it builds the headline via
  `buildProgressSnapshot(...).headline` and best-effort `post`s it. Otherwise
  no-op (graceful fallback to the poll model — exactly today's behaviour).
- Gate summary (ALL must hold, else fall back to poll model):
  1. `config.slack.credential_service` set (⇒ poster built, token available)
  2. `config.slack.native_progress_delivery !== false` (default on)
  3. session has a REAL Slack binding (`hasRealSlackBinding`)

### 4. Config

- Reuse existing `slack.credential_service` (no new token plumbing).
- New optional `slack.native_progress_delivery?: boolean`, default `true`. When
  the plumbing exists it auto-lights-up; operator can force-off. Add to
  `SlackConfig`, DEFAULTS, AND `openclaw.plugin.json` manifest (`additionalProperties:false`
  ⇒ an undeclared key REJECTS the whole config — beta.34 lesson).

## What does NOT change (regression guard)

| Path | beta.76 | beta.77 |
|---|---|---|
| Progress ticks / terminal | agent polls `harness_progress` → agent posts (wedge-prone) | ALSO direct-posted by harness when bound (wedge-immune); poll path still works |
| Clarification questions | agent-mediated (`awaiting_clarification` → poll → `harness_answer`) | UNCHANGED |
| Human answer/directive INBOUND | ONLY via tool calls (`harness_answer`/`harness_cancel`/…) | UNCHANGED |
| Reactions (🚀🛑⏸️💰) | direct-poll Slack via vault token | UNCHANGED |
| Inbound Slack message subscription | deliberately NOT wired (beta.34) | UNCHANGED |
| `harness_run`/`harness_progress`/`harness_answer` schemas | — | UNCHANGED |

## Tests (new `tests/beta77-harness-native-progress.test.mjs`)

- `hasRealSlackBinding`: real channel+thread → true; `""` channel → false;
  `agent:<uuid>` thread → false; `retired:…` thread → false; empty thread → false.
- `SlackProgressPoster.post`: hits `chat.postMessage` with Bearer token + thread_ts
  (stubbed fetch); best-effort on non-2xx / `ok:false` / thrown fetch / 429 →
  returns `{ok:false}`, never throws.
- `deliverProgress` fires from `setStatus` on BOTH a phase status (`executing`)
  and a terminal status (`done`/`aborted`) — behavioural via a real
  OrchestratorLoop with an injected `deliverProgress` spy.
- agent-bound session (`slack_thread=agent:<uuid>`) → deliverProgress no-ops
  (poll-model fallback).
- clarification path untouched: source-assert that `finaliseAwaitingClarification`
  / `harness_answer` are not modified to direct-post questions.
- wiring source-asserts: poster built in async bootstrap under credential_service;
  deliverProgress gated on progressPoster + native_progress_delivery + hasRealSlackBinding;
  loop.ts has NO Slack import; config + manifest declare `native_progress_delivery`.

## Ship gates

typecheck 0 + build 0 + full suite + smoke (via `node --import ./scripts/register-smoke-loader.mjs scripts/smoke.mjs`) green LOCALLY and in CI before merge. Squash-merge, tag `v0.1.0-beta.77`, GitHub release prerelease. Hand Carel the canonical git-cache-path install block.
