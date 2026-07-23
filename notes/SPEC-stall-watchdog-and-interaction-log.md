# SPEC — Late-stage Stall Watchdog + Durable Interaction Log

Author: Clark · 2026-07-23 · Origin: b60 record-depth run silently stalled ~2 days near completion,
no terminal verdict, cleared only by a Staging restart. Carel greenlit the watchdog + asked for a
dedicated harness log of every SDK/LLM interaction to pin down near-completion failures.

These are TWO fixes that reinforce each other: the watchdog RECOVERS the stall; the interaction log
lets us DIAGNOSE why it stalled (and any future near-completion failure).

---

## Part A — Late-stage stall watchdog (loop liveness)

**Problem:** existing recovery covers planning-phase interrupts (beta.38/44) and the beta.60
whole-`runOne` dispatcher bound (subtask_deadline). But the b60 run got ~7 sub-tasks deep, hit a
live env-wait-retry, then the loop STOPPED EMITTING with the session still `executing` and no
terminal event — for ~2 days — until a container restart cleared it. So there is a liveness gap:
a session can go quiet AFTER the last sub-task deadline window but BEFORE/at the finalize
(adversary → push → PR) phase, with no watchdog covering it.

**Root shape (from the b60 seq-7 stall forensics, beta.60 memory):** a row/phase can sit with
`updated_at` frozen and no worker process, and nothing re-ticks the loop to notice. beta.60 bound
`runOne`; this binds the SESSION as a whole and the finalize phase specifically.

**Fix — session-level heartbeat + stall detector:**
1. Loop writes a `session.last_progress_at` timestamp on EVERY state transition (sub-task
   start/complete, review start/complete, finalize start, push, PR-open). Cheap, single column.
2. A watchdog (gateway tick / `maintenance cycle` style, OR an internal interval) checks any
   session in a non-terminal executing/reviewing/finalising state where
   `now - last_progress_at > config.loop.session_stall_seconds` (default e.g. 1800s, MUST be
   > the longest legit phase incl. adversary review + push).
3. On stall detection: emit `loop.session_stalled {phase, msSinceProgress}` (LOUD — logger + audit +
   the interaction log from Part B), then attempt bounded self-recovery:
   - if no worker/finalize process is live → re-tick the loop-runner for that session (resume the
     phase it was in), same machinery as beta.44 resume.
   - if recovery can't re-arm (dead executor) → transition to a terminal `failed` with
     `reason=stalled_no_progress`, PRESERVE the worktree (beta.62 preserve pattern) so the near-done
     commits are recoverable, and — critically — if the branch already has commits, attempt the
     graceful push+PR (beta.62 review-crash-recovery pattern) flagged `needs_human_review` so a
     95%-done deliverable is NOT evaporated by a restart the way b60 was.
4. `harness_progress` surfaces `stalled: true` + `msSinceProgress` so a poller can SEE the stall
   instead of it looking identical to legit long work.

**Config:** `loop.session_stall_seconds` (default 1800, clamp sane), `loop.stall_graceful_pr` (default
true — push+needs_human_review PR on unrecoverable stall if commits exist). config.ts + manifest.

**Escape hatch:** extend `harness_resume force:true` (beta.60) to also cover a stalled
executing/finalising session; and let `cron wake` target a specific `sessionId` loop-runner (the
b60 lesson — `cron wake mode:now` hit the top-level scheduler, not the stalled loop, so it did
nothing).

**Why separate blast radius from the convention spec:** this is loop-liveness plumbing (can wedge or
mis-recover a live run); the convention work is a brief/verify feature. Keep them separate betas.

---

## Part B — Durable, structured interaction log (THE diagnosability fix)

**Carel's idea, and it's the right one.** The b60 stall was undiagnosable because:
- harness `state.db` (plan JSON, sub-task shapes, audit_log) lives INSIDE the ephemeral git worktree
  that gets released at teardown — so a released/restarted worktree takes the history with it
  (recorded pain: beta.47 "persist state.db OUTSIDE the ephemeral worktree").
- the piped stdout (`okf-test.log`) does NOT capture DB audit events, and freezes/detaches on
  restart (recorded pain: the log pipe kept dying on SIGHUP; b60 seq-5/seq-7 failures were NOT in
  stdout, only in the DB Staging read via harness_progress).
- SDK/LLM interactions (lead planner, worker, adversary) are separate Claude Agent SDK calls with
  their own prompts — their inputs/outputs/costs/timing are NOT durably captured anywhere the
  operator can read after the fact.

**Fix — a dedicated, append-only, structured interaction log OUTSIDE the worktree:**

**Location:** harness data dir (NOT the worktree), e.g. `<harnessDataDir>/logs/session-<id>.jsonl`,
one JSONL file per session (survives worktree release AND container restart if the data dir is on a
persisted volume). Also a rolling `harness-interactions.jsonl` global tail for cross-session view.

**What to log (one JSON line per event):**
- `ts`, `sessionId`, `phase` (classify/plan/worker/review/finalize), `seq`, `cycle`
- every SDK/LLM call: `event: "sdk_request"` {model, role (lead|worker|adversary), promptChars,
  toolsAllowed, sdkSessionId} and `event: "sdk_response"` {finishReason, outputChars, costUsd,
  durationMs, toolCalls[], finalMessageTail}
- every state transition (mirror of audit_log but durable + external)
- every verify probe {kind, contract, result, detail}
- worker refusals / env-wait-retries / deviations / review crashes (the events we keep needing)
- the stall detection + recovery events from Part A
- REDACTION: never log token/secret values; redact known credential patterns before write
  (reuse the exec-redaction discipline). Log prompt *sizes* + *tails*, not necessarily full prompts
  by default — add `log.full_prompts` (default false) for deep-debug, since full transcripts can be
  huge + sensitive.

**Why JSONL + external:** greppable, tail-able, survives teardown/restart, machine-parseable for a
future `harness_diagnose` view. Directly answers "pin down near-completion failures" — a stalled run
leaves a complete trail: last sdk_request with no matching sdk_response = the exact hang point;
frozen phase + last event ts = the stall boundary.

**Config:** `log.interaction_log_enabled` (default true), `log.dir` (default `<dataDir>/logs`),
`log.full_prompts` (default false), `log.retention_days` (default e.g. 14 — prune old session logs).
config.ts + manifest.

**Bonus:** a thin `harness_logs sessionId:<id>` tool (or `harness_progress` extension) that returns
the tail of the session's JSONL so the operator/poller can read it without shell/container access —
closes the "DB-only, not in stdout" gap that made b60 undiagnosable from my seat.

**Tests:** log file written outside worktree + survives a simulated release; JSONL parses; secret
redaction on a planted token; full_prompts gate; retention prune; sdk_request without sdk_response
is detectable (the stall signature); config+manifest wiring.

---

## Sequencing (three separate betas, ordered by leverage)

1. **Part B first (interaction log)** — highest leverage: without it we keep flying blind on
   near-completion failures. Also the diagnostic substrate the watchdog's events feed into.
2. **Part A (stall watchdog)** — the recovery, now observable because B captures the trail.
3. **Convention-awareness** (separate spec) — the feature, lowest urgency now #858 landed.

Each config-gated, default-on, manifest-updated, on current tip (beta.62/63).
