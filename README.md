# openclaw-agent-harness

*Multi-agent code-writing harness for OpenClaw.* Post a dev request in a Slack channel, and a Fable-5 lead plans, Sonnet workers write code in isolated git worktrees, and a Fable-5 adversary reviews the diff (with optional runtime logs, see below) before a PR opens under the requester's GitHub identity.

> *Status: beta.* Version `0.1.0-beta.1`. All Phase 1-3 subsystems land and pass tests (87/87 green, smoke script clean). See `docs/REAL-TEST-RUNBOOK.md` before wiring up a live channel.

## Why

Slack is where dev asks happen, and Claude Code is where the actual writing gets done. This plugin closes the loop: crystallise the ask into a brief, plan atomic sub-tasks, execute them in parallel Sonnet subprocesses inside a git worktree, and have a Fable-5 adversary sign off before a PR is opened.

Nothing pushes to a repo until the adversary is satisfied (or a human drops `:rocket:` to override). Nothing pushes at all without a per-repo per-user PAT the requester owns.

## Architecture

```
Slack channel
     |
     v
[ SlackChannelListener ]  -- routes: new session / follow-up / ignore
     |
     v
[ Dispatcher ]  -- inserts session row (UNIQUE thread), reacts :eyes:
     |
     v
[ Crystalliser ]  -- classifier (haiku) + brief refiner (fable-5)
     |
     v
[ Fable-5 lead ]  -- plan: repo, branch, sub-tasks, review checklist
     |
     v
[ Orchestrator loop ]  -- up to N cycles:
     |
     v
   [ Sonnet worker ] x concurrency  -- canUseTool bash guard, worktree isolation
     |
     v
   [ Fable-5 adversary ]  -- diff + Vercel logs + runtime banner
     |
     +--- verdict=pass    --> [ GitHub PR opener ]  --> Slack :tada:
     +--- verdict=revise  --> next cycle
     +--- verdict=block   --> Slack :x:
```

## Subsystems (all wired)

| Piece                        | File                                             | Purpose                                                |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Plugin entry                 | `src/index.ts`                                   | OpenClaw plugin descriptor + `register(api)`           |
| Config parser                | `src/config.ts`                                  | Hard validation, deep-merge defaults                   |
| Config JSON schema           | `src/config.schema.json`                         | Editor / doc integration                               |
| PAT router                   | `src/auth/pat-router.ts`                         | Per-user, per-repo PAT resolution                      |
| Prompt crystalliser          | `src/crystallise/prompt-refiner.ts`              | Classifier -> brief pipeline                           |
| Fable-5 lead                 | `src/orchestrator/fable5-lead.ts`                | Plan validator (allow-list, branch prefix, sub-cap 20) |
| Sonnet worker                | `src/orchestrator/sonnet-worker.ts`              | Runs one sub-task with `canUseTool` guard              |
| Fable-5 adversary            | `src/orchestrator/fable5-adversary.ts`           | Reviews diff, runtime banner, safety-net              |
| Orchestrator loop            | `src/orchestrator/loop.ts`                       | 3-cycle state machine + parallel exec + topo sort      |
| Claude SDK adapter           | `src/adapters/claude-sdk.ts`                     | `@anthropic-ai/claude-agent-sdk` wrappers              |
| Git worktree adapter         | `src/adapters/git-worktree.ts`                   | Allocate/commit/diff/push, per-session isolation       |
| GitHub PR opener             | `src/adapters/github-pr.ts`                      | Push branch, POST /pulls (draft if verdict != pass)   |
| GitHub PR-merged watcher     | `src/adapters/github-watcher.ts`                 | Detects merge/close, releases worktree                 |
| Runtime logs bridge          | `src/vercel/logs.ts`                             | Optional. Vercel bridge (feature-flagged) OR manual upload via `harness_upload_logs`. Adversary refuses to sign off on runtime dimension when no data is present. |
| Slack listener               | `src/slack/channel-listener.ts`                  | Pure `routeMessage()` + UNIQUE thread guard           |
| Slack dispatcher             | `src/slack/dispatcher.ts`                        | Bridges listener -> orchestrator                       |
| Slack reactions reader       | `src/slack/reactions.ts`                         | Authorised-user filter                                 |
| Reactions poller             | `src/slack/reactions-poller.ts`                  | 15s interval, writes into `reactions_json` column      |
| Bash guard                   | `src/safety/bash-guard.ts`                       | Tokeniser-based POSIX-ish denylist                     |
| Budget enforcer              | `src/budgets/enforcer.ts`                        | Daily + monthly USD ledger                            |
| State store                  | `src/state/store.ts` + `schema.sql`              | SQLite (better-sqlite3), audit log                     |
| Retention                    | `src/state/retention.ts`                         | 90-day audit prune, terminal-session prune             |
| Session recovery             | `src/state/recovery.ts`                          | Stale in-flight -> `interrupted`, Slack notify         |
| Tools                        | `src/tools/registration.ts`                      | 8 tools (see below)                                    |

## Tools exposed

- `harness_status` -- active sessions + monthly spend
- `harness_health` -- DB reachable, schema OK, config valid, cred set
- `harness_start_session` -- direct API entry (bypasses classifier)
- `harness_session_get` -- one session with sub-tasks/reviews/audit
- `harness_telemetry` -- monthly ledger + session cost breakdown
- `harness_upload_logs` -- attach runtime logs from any deploy target (nginx, CloudWatch, on-prem) when Vercel is off
- `harness_cancel` -- set abort flag; loop terminates at next checkpoint
- `harness_resume` -- re-kick an interrupted session with its brief
- `harness_retention_prune` -- manual audit-log prune

## Runtime data (optional, not tied to Vercel)

The adversary reviews *runtime* dimension only when runtime data is available. Two sources are supported:

1. *Vercel bridge* -- `harness.vercel.enabled: true`. The harness polls Vercel deployments for the branch, waits up to `preview_wait_seconds` for a preview to land, and pulls a bounded event-log excerpt.
2. *Manual upload* -- for repos that don't deploy to Vercel. Any authorised user calls `harness_upload_logs` with a session id and a log excerpt (nginx, CloudWatch, on-prem, whatever). The adversary consumes the most-recent upload with `provider: "manual"`.

If neither is available, the adversary is given a `NO RUNTIME DATA` banner and MUST NOT sign off on runtime concerns. It won't silently pass a diff just because it can't see the running system.

## Reactions

Only from `slack.authorised_users`:

- `:rocket:` on a bot message in `reviewing` state -> ship it
- `:x:` -> abort at next checkpoint
- `:pause_button:` -> (planned) pause the session
- `:moneybag:` -> allow session to blow past its per-session budget cap

## Quick start

```bash
git clone https://github.com/CarelvanHeerden/openclaw-agent-harness
cd openclaw-agent-harness
npm ci
npm test        # runs 87 tests
npm run smoke   # boots the plugin against a fake OpenClaw API
```

Then follow `docs/REAL-TEST-RUNBOOK.md` for wiring up the real Slack channel and Vault credentials.

## Development

- `npm run typecheck` -- strict TS, no `any` leaks in `src/`
- `npm run build` -- emits `dist/` + copies `schema.sql`
- `npm test` -- Node test runner, 87 tests as of `0.1.0-beta.1`
- `npm run smoke` -- post-build bootstrap sanity

CI on every push and PR: `.github/workflows/ci.yml`.

## License

MIT. See `LICENSE`.
