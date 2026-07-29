# SPEC — Harness-native progress delivery (decouple from the OpenClaw agent turn)

**Status:** DRAFT (planning) — Carel greenlit 2026-07-27 ("start planning on #2 now").
**Author:** Clark. **Target:** beta.77 candidate.

## Problem

Harness run progress ("Executing sub-task N/M", "Adversarial review in progress",
terminal PR) is announced to Slack by an OpenClaw **agent turn** — an
`embedded_run` on the channel/thread session that drives the progress poller.
That embedded run periodically WEDGES:

```
stalled session ... state=processing activeWorkKind=embedded_run
  lastProgress=embedded_run:started lastProgressAge=3403s
  classification=stalled_agent_run recovery=none
```

When it wedges, progress updates STOP even though the harness loop itself is
almost certainly still running. Operator-visible symptom: the run goes silent,
looks dead, and a human has to kickstart the gateway to unstick it. Observed
repeatedly (`5b914cf8`, `d47c8686`, ...). `recovery=none` = the runtime detects
the stall but has no recovery path for embedded runs (this is a KNOWN upstream
core bug — see the upstream findings section; NOT a harness bug).

The fragility is architectural: **harness observability depends on a
wedge-prone agent embedded-run.** The harness loop has its own robust recovery
(beta.60 stall-unstick etc.), but its *reporting* rides a component we don't
control and that has no recovery.

## Goal

Make harness progress + terminal delivery NOT depend on an OpenClaw agent turn.
The harness already runs its loop in its own process context and already has a
`delivery` concept for cron/webhook. Route progress announcements through a
**harness-owned delivery path** (direct Slack Web API post OR gateway webhook)
so a wedged channel-agent embedded-run can never blind a run again.

## Non-goals

- Fixing the core `embedded_run` wedge itself (that's the upstream contribution
  path — issue #85251; we ADD our repro, we do NOT fork).
- Changing how a human *drives* the harness (tool calls still come via the agent).
  Only the OUTBOUND progress/terminal announce path is decoupled.

## Source-trace findings (2026-07-28, confirmed in code)

1. **The harness had a direct-to-Slack path and DELIBERATELY removed it (beta.34/37).**
   `progress.ts` header documents it: the pre-beta.37 `reportProgress` tried
   `chat.postMessage` into `sessions.slack_channel`/`slack_thread`, but for
   agent-orchestrated runs those are `""` / `agent:<uuid>` (NO real Slack
   binding), so every post was rejected + swallowed. They switched to the POLL
   model: an external OpenClaw agent polls `harness_progress` and relays. THAT
   poller agent turn is the wedge surface (Staging: `harness-progress-<id>`
   cron = an agent turn calling `message action=send`, `consecutiveErrors:5`).
2. **So the fix is NOT "re-add the old broken direct path."** The old path
   failed for ONE reason: no real channel/thread binding on the session row.
   The cure = capture the REAL delivery target (channel + thread_ts) at
   `harness_run` time and push directly to the Slack **Web API**, bypassing
   BOTH `api.sendMessage` (which may itself route through the runtime) AND the
   poller cron.
3. **Session row already has `slack_channel` + `slack_thread` columns**
   (`schema.sql`), and `startSessionFromBrief` already accepts optional
   `slackChannel`/`slackThread` — they're just usually OMITTED by the
   agent-orchestrated caller (synthesised to `agent:<sessionId>`). If the caller
   passes the real ones, they persist today with no schema change.
4. **Bot-token source:** the harness resolves creds vault-first (see `gitToken`
   / `CredentialAdapter` / `api.callTool("credential_get")`). A Slack bot token
   can be resolved the SAME way at bootstrap (vault service e.g. `slack` /
   `slack:default`, env fallback) and held for direct `chat.postMessage` — no
   per-post agent turn.

## THE ONE BLOCKING UNKNOWN (confirm before coding)

Does the OpenClaw **tool-invocation context** passed to `harness_run` expose the
real originating Slack **channel id + thread_ts**? I saw a `deliveryContext`
(`to: channel:C0BHN081CA0`, `threadId`) on the SESSION in `sessions_list`, but I
need to confirm the harness_run TOOL receives that at call time (so it can
persist the real binding instead of `agent:<uuid>`). If YES — the build is:
capture it → persist → direct push. If NO — the agent caller must pass
`slackChannel`/`slackThread` explicitly on the `harness_run` call (a tool-schema
+ caller change), still workable but a bigger surface. Staging can confirm what
the tool ctx carries.

## Design (candidate)

1. **Progress emitter interface.** The loop already emits `markProgress` /
   `reportProgress` internally. Add an optional `announceProgress(sessionId,
   phase, meta)` sink on `OrchestratorDeps`, wired to a harness-owned deliverer,
   NOT the agent session.

2. **Harness-owned Slack deliverer.** A thin module that posts to the Slack Web
   API (`chat.postMessage`) directly, using the bot token already available to
   the harness (the SlackAdapter already has `sendMessage`; confirm it does NOT
   route through an agent turn — if it does, add a direct-post path). Keyed by
   the run's channel + thread_ts (already known at run start).
   - Rate-limit aware (respect 429/Retry-After — no tight loop).
   - Best-effort: a delivery failure must NEVER fail the run (same discipline as
     beta.75 postPrComment).
   - De-dupe: at most one post per phase transition (not per 45s tick) to avoid
     the poller's chattiness.

3. **Terminal delivery is the important one.** The PR-opened / failed / aborted
   terminal MUST land even if every progress tick was dropped. Post the terminal
   summary through the harness deliverer at `finalise*`.

4. **Config gate.** `harness.delivery.mode = "agent" | "harness_native"`
   (default keep `agent` until validated, then flip). Manifest-declared
   (additionalProperties:false — beta.34 lesson).

5. **Watchdog independence.** The harness stall-sweep / progress watchdog must
   read loop state from the DB (it already does), NOT from whether the announce
   landed — so a dropped announce is never mistaken for a dead loop.

## Open questions (resolve before build)

- Does `SlackAdapter.sendMessage` in THIS wiring go through an agent embedded
  run, or straight to the Slack Web API? If the latter, decoupling is mostly
  wiring; if the former, we need a direct-post path (bot token + channel + thread).
- Where does the bot token live for a harness-native post (vault? env? the
  channel plugin's account)? Confirm the harness can read it without an agent turn.
- Poller vs push: today an external poller agent reads harness_progress and
  posts. The clean design is the harness PUSHES on phase transition (no poller
  agent at all), which also removes the poller's own embedded-run as a wedge
  surface. Prefer push.

## Upstream findings (Carel: "check what's open/closed but not shipped")

Searched `openclaw/openclaw` issues/PRs 2026-07-27. The embedded-run wedge is a
KNOWN, ACTIVE upstream problem — do NOT fork; add our repro to the existing
tracking and prefer the decoupling above as our own mitigation.

- **#85251** (OPEN, P1, labels `clawsweeper-recovery-stuck`, `impact:message-loss`,
  `impact:session-state`): "Codex app-server emits `notification:turn/started`
  then goes silent; embedded run wedges for the full stuck-session recovery
  window." EXACTLY our symptom (`embedded_run:started`, silent, message lost,
  recovery aborts after ~360s but does not retry). Proposed fix = a per-turn
  `turn-started-without-progress` watchdog that surfaces a retryable error
  instead of a silent wedge. → **This is the issue to add our Slack-channel
  repro + logs to** (our case is the Slack/Claude agent turn, theirs is Codex;
  same class: turn/started then no progress, recovery=none/abort-only).
- **PR #89040** (OPEN, P1, `size:XL`, `status: waiting on author`): "perf: avoid
  event-loop stall during embedded_run bootstrap-context" — fixes 14–22s
  event-loop stalls during embedded_run bootstrap-context that drop messages
  (issue #87509). NOT merged/shipped. Related but a different failure mode
  (bootstrap-context event-loop block vs a turn that never progresses).
- **#84569** (CLOSED, P1, `impact:message-loss`, `clawsweeper:linked-pr-open`):
  "WhatsApp session stalls on long model_call ... reply never delivered." Sibling
  stall class, closed with a linked PR — verify whether that fix is in our
  2026.5.x build or still unshipped for us.

**Recommendation to Carel:** (a) do NOT fork; (b) build the harness-native
delivery decoupling (this spec) as OUR mitigation — entirely in our control;
(c) add our Slack-agent embedded-run repro + the `d47c8686`/`5b914cf8` logs as a
comment on upstream **#85251** rather than filing a new duplicate; (d) confirm
whether #84569's shipped fix (or lack thereof) covers our build.
