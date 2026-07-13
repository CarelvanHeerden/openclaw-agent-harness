# Changelog

## [Unreleased] -- maintainer review round 2

### Security

- *Read-side guard on `canUseTool`.* The SDK's built-in `Read` / `NotebookRead`
  bypasses Bash, so a worker could exfil `.env`, `credentials.db`, or
  private keys through the file reader without ever hitting the bash guard.
  `buildBashGuard()` now applies the same `path_denylist` to Read,
  NotebookRead, and to Glob/Grep patterns.

### Correctness

- *Structured-output validation.* `extractAndValidateJson()` replaces the
  bare `JSON.parse(extractJson(raw))` in every LLM call site. Missing
  required top-level keys now throw with the raw model output in the
  error message. When the model emits a second JSON object we would
  silently discard, we log a warning instead of dropping it in silence.
  Wired into classifier / crystalliser / lead / adversary calls.
- *Adversary diff chunking.* Prior behaviour was a hard
  `.slice(0, 200000)` on large diffs, so refactors bigger than 200 KB
  had their tails reviewed by no one. Now the diff is split on file
  boundaries into 180 KB chunks, reviewed sequentially with prior
  findings threaded through the system prompt, and the strictest
  verdict across chunks wins. If a single file exceeds one chunk it
  is truncated with an inline annotation so the adversary can note
  incomplete coverage.

### State model

- *PR lifecycle promoted out of `reactions_json`.* New columns on
  `sessions`: `pr_merged`, `pr_closed_at`, `pr_merged_at`. The github
  watcher writes them directly instead of stuffing JSON into the
  reactions blob. The state store also runs an idempotent backfill
  from the legacy `reactions_json.prClosedAt` / `.prMerged` shape.

### Observability

- *Price-drift detection.* `checkPriceDrift()` compares the SDK's real
  `total_cost_usd` against our estimate for the same model+tokens and
  warns when drift exceeds 20 %. Pricing is now configurable at the
  plugin level via `harness.models.price_overrides` so operators can
  patch stale rates without waiting for a release.

### Scalability

- *Slack reactions poller is rate-aware.* Adaptive backoff (15 s -> 120 s
  when no reactions arrive; resets on any new reaction), round-robin
  per-tick cap of 20 sessions, idle skip when no non-terminal sessions
  exist, and native 429 handling that honours `Retry-After`. Slack's
  Tier 3 budget is no longer a concern at 10+ concurrent sessions.
- *Reader surfaces 429s.* `SlackReactionsReader` no longer swallows
  rate-limit responses; throws `{ retryAfterSeconds }` so the poller
  can back off globally.

### CI / release hygiene

- *Live-SDK smoke workflow.* `scripts/live-sdk-smoke.mjs` calls the real
  Claude Agent SDK against a trivial classifier task. Costs cents.
  Gated CI workflow `live-sdk-smoke.yml` runs only on `workflow_dispatch`
  or on release tags. Catches SDK API drift before a live Slack test.

### Tests

115 tests passing (+22 new): `json-extraction.test.mjs` (6),
`diff-chunker.test.mjs` (6), `read-guard.test.mjs` (7),
`reactions-poller.test.mjs` (+3 adaptive/idle/429), `pr-watcher.test.mjs`
(row-level assertions on the new columns).

## [Unreleased]

### Fixed / Changed

- *Runtime data source is now provider-agnostic.* Vercel is still supported
  behind `harness.vercel.enabled` (feature flag), but any repo that deploys
  elsewhere can now hand-supply logs through the new `harness_upload_logs`
  tool. The adversary receives them as `runtime.provider = "manual"`
  with the same `NO RUNTIME DATA` safety net when nothing is available.
- *New table:* `runtime_uploads` (append-only, session-scoped, 16 KB cap).
- *Loop change:* `fetchRuntime` now reads the latest manual upload for the
  session first and falls back to Vercel only when the flag is on and no
  upload is present.
- *Docs / examples:* removed org-specific placeholders in favour of
  generic `example-org/example-repo` and `dev@example.com`. This is a
  public repo; concrete org names don't belong in it.
- *Git history rewritten* to strip a work email from every author line
  (was causing another user with the same domain email verified on their
  GitHub to be credited as a contributor). All commits are now under the
  personal GitHub noreply address.

## [0.1.0-beta.1] -- 2026-07-13

Beta cut. All Phase 1-3 subsystems land, wire together, and are tested.

### Added

- **Parallel sub-task execution.** `config.loop.subtask_concurrency`
  (default 1 = old behaviour). `topoSortSubTasks()` respects
  `plan.subTasks[].dependsOn` with cycle detection. Greedy dispatcher fills
  up to N concurrent, blocks on `Promise.race` until dependencies clear.
- **PR-merged watcher.** `src/adapters/github-watcher.ts` polls every
  5 min for shipped sessions; when the PR merges or closes, posts a Slack
  note, releases the worktree, and stamps `reactions_json.prClosedAt`.
- **New tools.** `harness_start_session` (direct API entry, bypasses
  classifier), `harness_health` (DB + schema + config + credentials
  snapshot), `harness_telemetry` (monthly + daily + per-session cost
  breakdown), `harness_cancel` (abort flag on non-terminal sessions),
  `harness_resume` (re-kick interrupted session from stored brief).
- **Nightly retention timer** as a registered service (24h interval)
  with proper stop() cleanup.
- **Reactions poller.** `src/slack/reactions-poller.ts` runs every 15s
  and writes into `sessions.reactions_json`. Loop reads that column
  cheaply on every checkpoint.
- **Session recovery.** `recoverSessions()` scans non-terminal sessions
  at bootstrap; stale ones -> `interrupted` with Slack thread notification.
- **GitHub PR opener.** `src/adapters/github-pr.ts`. `pushBranchAndOpenPr()`
  is the only place the harness pushes; non-pass adversary verdict opens
  the PR as *draft*.
- **Slack app manifest.** `deploy/slack-app-manifest.yaml` for one-shot
  bot user creation with minimum-scope OAuth.
- **Config JSON schema.** `src/config.schema.json` (draft 2020-12) for
  editor/doc integration.
- **Smoke test.** `scripts/smoke.mjs` boots the built plugin against a
  fake OpenClaw API and asserts advertised tools + hooks + services all
  register. Wired into CI.
- **Real-test runbook.** `docs/REAL-TEST-RUNBOOK.md`.

### Changed

- **CI switched from pnpm to npm.** `pnpm@10+` treats `better-sqlite3`'s
  native build script as a hard error even with `pnpm.onlyBuiltDependencies`
  set. `npm ci` builds cleanly. `zod` bumped to `^4` to satisfy the SDK
  peer.
- **Dockerfile now uses npm** with a native-compile toolchain layer.
- **Version scheme.** `0.0.1` -> `0.1.0-beta.1` (package.json,
  plugin.json, `src/version.ts`).
- **`plugin.json` reconciled** with the actual tool + hook + service
  surface. Old `harness_start_session` / `harness_resume` etc. names
  moved from vapourware to real registrations.

### Tests

87 tests passing (up from 45 at Phase 1 cut):
- `config.test.mjs` (6), `pat-router.test.mjs` (5),
  `crystallise.test.mjs` (5), `adversary.test.mjs` (4),
  `orchestrator-advance.test.mjs` (10), `dispatcher.test.mjs` (4),
  `bash-guard.test.mjs`, `budget-enforcer.test.mjs`,
  `slack-listener.test.mjs`
- New in beta: `topo-sort.test.mjs` (5),
  `parallel-execution.test.mjs` (3), `tools.test.mjs` (11),
  `pr-watcher.test.mjs` (5), `telemetry.test.mjs` (2),
  `reactions.test.mjs` (4), `reactions-poller.test.mjs` (3),
  `recovery.test.mjs` (3), `loop-integration.test.mjs` (5),
  `github-pr.test.mjs` (4)

## [Phase 1] -- 2026-07-13 (merged PR #2)

End-to-end wiring for a real Slack test.

- Real plugin entry (`src/index.ts`) mirroring `memory-hybrid`.
- Config parser with hard validation.
- Full orchestrator loop state machine.
- Sonnet worker + Fable-5 adversary + Fable-5 lead + PAT router.
- Claude SDK adapter + git worktree adapter + Vercel bridge.
- Slack listener + dispatcher.
- Bash guard (POSIX-ish tokeniser).
- Budget enforcer.
- State store + retention prune + session recovery.
- 3 tools: `harness_status`, `harness_retention_prune`,
  `harness_session_get`.
- Dockerfile, real-test runbook.

45 tests passing.

## [Phase 0] -- 2026-07-13 (merged PR #1)

Round-1 review of the initial scaffold. 7 findings addressed.
