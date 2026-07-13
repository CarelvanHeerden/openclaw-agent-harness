# Changelog

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
