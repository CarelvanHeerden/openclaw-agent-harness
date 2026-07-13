# Changelog

## Unreleased

### Phase 1: end-to-end wiring (feat/phase-1)

- Real plugin entry (`src/index.ts`) that mirrors the memory-hybrid contract:
  `{ id, name, description, kind, configSchema.parse, versionInfo, register(api) }`.
- Config parser (`src/config.ts`) with deep-merge defaults and hard
  validation on safety-critical fields (channel, authorised users, budgets,
  allow-list, vercel).
- Orchestrator loop (`src/orchestrator/loop.ts`) implementing the full
  state machine: `crystallising -> planning -> executing (per-sub-task) ->
  reviewing -> {done | revise | failed | aborted}`, with:
    - checkpoints (`current_cycle`, `last_completed_sub_task`, `last_worker_sdk_session`)
    - budget + hard-timeout gates per sub-task
    - reactions gate (ship_it during reviewing, abort anywhere)
    - per-cycle review persistence + audit trail
- Sonnet worker (`src/orchestrator/sonnet-worker.ts`): builds a scoped
  system prompt, runs the injected SDK call with `canUseTool` guard, commits
  changed files, never pushes.
- Adversary (`src/orchestrator/fable5-adversary.ts`): dimension-based review
  with a runtime safety-net that upgrades a silent "pass" to "revise" when
  no runtime data is available.
- Claude SDK adapters (`src/adapters/claude-sdk.ts`): typed wrappers around
  `@anthropic-ai/claude-agent-sdk`'s `query()` for classifier, crystalliser,
  lead, adversary, and worker. Robust JSON extraction with `extractJson()`.
- Git worktree adapter (`src/adapters/git-worktree.ts`): PAT-scoped askpass
  helper so tokens never land in config or URL.
- GitHub REST adapter (`src/adapters/github.ts`): pull-request creation + repo access verification.
- Vercel bridge (`src/vercel/logs.ts`): bounded preview wait, deployment
  state resolution, event log excerpt for adversary.
- Slack adapter (`src/adapters/slack.ts`) + dispatcher (`src/slack/dispatcher.ts`):
  fire-and-forget session runner with UNIQUE constraint dedup on Slack thread.
- Bash guard (`src/safety/bash-guard.ts`) now exports `buildBashGuard()` — a
  ready-to-plug `canUseTool` callback with path denylist support.
- Tools: `harness_status`, `harness_retention_prune`, `harness_session_get`.
- Session recovery on plugin start: stale non-terminal sessions are marked
  `aborted` based on `last_checkpoint_at`.
- Dockerfile for isolated real-test runs.
- Runbook: `docs/REAL-TEST-RUNBOOK.md`.

### Tests (45 total, all green)

- `config.test.mjs` (6)
- `pat-router.test.mjs` (5)
- `crystallise.test.mjs` (5)
- `adversary.test.mjs` (4)
- `orchestrator-advance.test.mjs` (10)
- `dispatcher.test.mjs` (4)
- `bash-guard.test.mjs`, `budget-enforcer.test.mjs`, `slack-listener.test.mjs` (11)

## Unreleased

### Added

- **Session checkpointing schema.** `sessions` gains `current_cycle`,
  `last_completed_sub_task`, `last_checkpoint_at`, `claude_sdk_session_id`,
  and `last_worker_sdk_session`. `sub_tasks` gains `sdk_session_id`,
  `started_at`, `completed_at`. Enables incremental resume after container
  restart mid-session.
- **1 thread = 1 session invariant.** UNIQUE index on
  `sessions(slack_channel, slack_thread)` plus explicit `routeMessage()`
  logic in `SlackChannelListener`.
- **Bash guard rewrite.** New `src/safety/bash-guard.ts` with a POSIX-ish
  tokeniser, per-segment allow-list, command-substitution rejection,
  `/dev/tcp` and `/dev/udp` block, explicit `git push` refusal, and
  network-command refusal. Replaces the naive substring regexes.
- **Adversary runtime-data awareness.** `AdversaryInput.runtime` typed
  status (`ok | no_deploy_yet | build_failed | unavailable`) plus a
  `runtimeBanner()` helper the orchestrator injects verbatim into the
  adversary system prompt. Prevents silent blind runtime review.
- **Retention pruning.** New `src/state/retention.ts` with a documented
  cron entry in `docs/OPERATIONS.md`. Audit log 90-day default, terminal
  sessions kept unless explicitly opted out.
- **Unit tests.** `tests/bash-guard.test.mjs`,
  `tests/budget-enforcer.test.mjs`, `tests/slack-listener.test.mjs`.
  `pnpm test` now builds first, then runs against `dist/`.

### Changed

- **SDK pin.** `@anthropic-ai/claude-agent-sdk` is now pinned to `0.3.207`
  (was `^0.1.0`). Also pinned `better-sqlite3` (`11.10.0`) and added `zod`
  (`3.24.1`) since the SDK's `tool()` uses Zod schemas.
- **Schema loading.** `openStateStore()` locates `schema.sql` relative to
  the running module and copies it into `dist/` at build time so the
  compiled package doesn't need `src/`.
