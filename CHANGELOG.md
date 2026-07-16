# Changelog

## [0.1.0-beta.12] -- 2026-07-16

### Fixed

- **Contract inference is now negation-aware.** Surfaced by the beta.10
  happy-path smoke test on Staging (session
  `6366e03d-3e14-497c-ba1c-f820db20171e`): a sub-task whose intent
  explicitly said *"Do not push, do not open a PR"* still had
  `branch_pushed`, `remote_branch_exists`, `commit_sha_matches`, `pr_opened`,
  and `pr_state` inferred into its contract. The regex-based inference
  matched on the *presence* of push/PR words regardless of surrounding
  negation context. The verifier then failed the sub-task because it
  couldn't find a remote branch / PR the sub-task was explicitly told
  not to create. Worker did the right thing; verifier disagreed with
  itself.

  Fix: new `hasPositiveMatch(text, re)` helper iterates matches and
  rejects any whose immediately preceding ~40-char window (bounded by
  sentence break) contains a negation cue: `do not`, `don't`, `no`,
  `without`, `never`, `avoid`, `skip`, `not to`, `stop after`,
  `instead of`, `rather than`, `shouldn't`, `must not`, `shall not`,
  `no need to`. Sentence boundaries (`.`, `;`, `\n`) contain the
  negation scope, so mixed clauses like *"Push the branch. Do not
  open a PR."* resolve correctly (push positive, PR negated).

### Tests

- New file `tests/beta12-negation-aware.test.mjs` — 9 tests locking in:
  - The exact Staging happy-path s2 case yields a commit-only contract.
  - Negated push/PR/commit language does not produce positive kinds.
  - Positive push/PR language still produces them (no regression).
  - Mixed clauses are resolved per-sentence-boundary.

- Full suite: **239 -> 248 tests passing**, 0 fail, 0 skip. Typecheck clean.

### Known limitations (not fixed in beta.12)

- **`openPr` / `draftPr` tool-call flags are not yet threaded to the
  verifier.** Staging flagged this in the same audit report. Currently
  the contract inference reads only sub-task language, ignoring the
  session's `openPr: false` flag. If a sub-task's language positively
  mentions "open a PR" but the caller passed `openPr: false`, the
  verifier will still infer `pr_opened`. This is a bigger surgery
  (plan schema needs the flags threaded to sub-tasks) and is deferred.
  Workaround for now: rely on sub-task-language scoping only, and don't
  rely on `openPr: false` at the tool-call layer to suppress PR contract
  inference.

- **Adversary review not yet observed on a passing cycle.** Every smoke
  test since beta.6 has halted before the reviewer runs. Beta.12 should
  finally allow the happy-path smoke to complete a full cycle so the
  runtime dimension can be observed. Re-run the same happy-path smoke
  on beta.12 to confirm.

### Discovery

The OpenClaw Staging bot on the beta.10 happy-path smoke flagged this
precisely: *"contract-scope leak: verifier applies session-level
acceptance to every sub-task."* Actual root cause: negation-blindness
in the regex inference, not a contract-scope leak. Same symptom, more
specific fix.

---

## [0.1.0-beta.11] -- 2026-07-16

### Fixed

- **Duplicate `loop.remote_branch_verify_failed` audit event on push failures.** Discovered by the beta.10 Staging smoke test: a single `push branch` sub-task fired `loop.remote_branch_verify_failed` twice (once from the `branch_pushed` contract kind's case in `loop.ts`, once from the `remote_branch_exists` case), because contract inference stacks both kinds for push language and both cases in the audit-emission switch emitted the same new event name. Fix: `branch_pushed` case now fires **only** its backward-compat `loop.push_verify_failed`; `remote_branch_exists` owns `loop.remote_branch_verify_failed` alone. Each event now fires exactly once per contract kind. Old audit consumers still see `loop.push_verify_failed`; new consumers still see `loop.remote_branch_verify_failed`. No API changes.

### Tests

- New assertion in `tests/loop-integration.test.mjs`: a push sub-task with both `branch_pushed` and `remote_branch_exists` in its inferred contract fires each of `loop.push_verify_failed`, `loop.remote_branch_verify_failed`, `loop.commit_sha_verify_failed` **exactly once**. Would fail against the pre-beta.11 duplicate-emission code.

- Full suite: **238 -> 239 tests passing**, 0 fail, 0 skip. Typecheck clean.

---

## [0.1.0-beta.10] -- 2026-07-16

### Fixed

- **Beta.9 wiring gap: the 5 new optional verification probes are now
  provided by the production `buildVerifyProbes` factories.** Beta.9 shipped
  the richer contract kinds + `verifySubTaskOutput` handling + graceful
  fallback (`passed: true` when a probe is absent, trusting SDK), but the
  factories in `src/index.ts` (both the loop-path and the worker-path) only
  provided the four beta.8 probes. In production this meant that
  `file_committed`, `remote_branch_exists`, `file_pushed`, `pr_state`,
  `file_in_pr`, and `commit_sha_matches` all returned `passed: true` on
  empty air — the graceful-skip path was the *only* path taken. Beta.10
  wires all 5 optional probes to real primitives: `fs.stat`,
  `git log <base>..HEAD --name-only`, `git ls-remote`, and the provider
  contents / pulls / files REST endpoints.

### Added

- **`GitAdapter.listCommittedFiles(worktreePath, base)`** — files touched by
  commits in `base..HEAD` (used by `file_committed`).
- **`GitAdapter.remoteBranchSha(worktreePath, remote, branch, ghToken?)`** —
  tip SHA on the remote via `git ls-remote` (used by `remote_branch_exists`
  and `commit_sha_matches`).
- **`tests/beta10-wiring.test.mjs`** — 14 new tests that hit a real temp
  git repo and stub `fetch` per URL. Includes a confabulation scenario
  where a worker "does" 5 remote operations that never actually happened;
  all 5 checks must FAIL against the wired probes. If any test asserts a
  skipped-as-true pass, the wiring has regressed.

### Provider parity

All new probes are provider-aware (GitHub + GitLab). Endpoints used:

- GitHub: `GET /repos/{owner}/{repo}/git/refs/heads/{branch}`,
  `GET /repos/.../contents/{path}?ref={branch}`,
  `GET /repos/.../pulls?head={owner}:{branch}&state=all`,
  `GET /repos/.../pulls/{n}/files?per_page=100`.
- GitLab: `GET /projects/{id}/repository/branches/{branch}`,
  `GET /projects/{id}/repository/files/{path}?ref={branch}`,
  `GET /projects/{id}/merge_requests?source_branch={branch}&state=all`,
  `GET /projects/{id}/merge_requests/{iid}/changes`.

### Impact

On Staging the beta.9 smoke test halted at s1 with a genuine
`file not in diff vs base` (because s1 writes without committing). With the
beta.9 code path, the plan would proceed but s3–s4 could still be worker-
confabulated: the loop path's factory was not providing `remoteFileExists`
or `prForBranch`, so the corresponding contract kinds returned pass-as-
skipped. Beta.10 makes all inferred checks *actually check*. Predicted
next smoke test outcome: sub-tasks with observable side effects now
succeed only when they *really* succeeded (branch pushed, PR opened,
file in PR files), and fail with specific `loop.*_verify_failed` events
when they did not.

---

## [0.1.0-beta.9] -- 2026-07-16

### Fixed

- **Untracked-file verification bug (beta.8 regression).** Sub-task s1
  ("write file X") could never pass `file_written` verification on beta.8
  because the verifier used `git diff vs base`, which excludes untracked
  files. A file written but not yet committed is exactly what s1 produces.
  beta.9 changes `file_written` to use `fs.stat` (filesystem check), so
  untracked files are visible and the happy path proceeds. The old
  `fileWrittenSince` probe (git diff) is kept as a backward-compat fallback
  for test doubles that predate beta.9.

### Added

- **7 new precise verification contract kinds** alongside the existing 4:
  - `file_committed` — path in `git log <base>..HEAD` (committed to local branch)
  - `remote_branch_exists` — remote branch ref exists with SHA detail
  - `file_pushed` — file exists in remote branch contents (GitHub API)
  - `pr_state` — PR exists AND is in `open` / `draft` / `merged` state
  - `file_in_pr` — file appears in PR files list
  - `commit_sha_matches` — local HEAD SHA equals remote branch tip SHA
  (The existing `branch_pushed`, `pr_opened`, `commit_made` are kept for
  backward compat and continue to fire their original audit events.)

- **Extended contract inference** in `verify-contract.ts`:
  - `"write/create X"` → `file_written` (now fs.stat, includes untracked)
  - `"commit"` (no push) → `commit_made` + `file_committed`
  - `"push branch"` → `branch_pushed` + `remote_branch_exists` + `commit_sha_matches`
  - `"verify remote SHA"` → `remote_branch_exists` + `commit_sha_matches`
  - `"open PR"` / `"open draft PR"` → `pr_opened` + `pr_state`
  - `"end-to-end verification"` → `branch_pushed` + `pr_opened` + `file_pushed` + `file_in_pr`

- **8 new specific audit events** (old names still fire alongside for compat):
  `loop.file_written_verify_failed`, `loop.file_committed_verify_failed`,
  `loop.remote_branch_verify_failed`, `loop.file_pushed_verify_failed`,
  `loop.pr_state_verify_failed`, `loop.file_in_pr_verify_failed`,
  `loop.commit_sha_verify_failed`

- **`harness_bootstrap_test_repo` added to `contracts.tools`** in
  `openclaw.plugin.json`. This tool was registered since beta.6 but
  missing from the manifest, causing a gateway warning on every startup.

- **Verification contract docs** added to `docs/AUTH.md` and
  `docs/GITHUB_AUTH.md`: table of all 10 contract kinds, inference rules,
  and audit event reference.

### Tests

- 224 tests (was 176), all passing. New coverage:
  - Regression test for beta.8 untracked-file bug (must pass on beta.9)
  - Per-kind unit tests (success + failure) for all 8 new contract kinds
  - Graceful-skip tests for all new optional probes
  - Backward-compat probe fallback tests
  - 5-sub-task integration test (write → commit → push → PR → e2e verify)
  - Malicious-worker tests (empty file, absent file)
  - Audit event backward-compat tests (old names still fire alongside new)
  - Existing beta.8 confabulation regression test preserved

### Breaking changes

- None. All beta.8 contract kinds, probe names, and audit event names continue
  to work unchanged. New probes are optional in `VerifyProbes`. The `file_written`
  kind now prefers `fileExistsOnDisk` when provided; it falls back to
  `fileWrittenSince` (beta.8 behaviour) when absent.

## [Unreleased] -- maintainer review round 2

### Changed -- agent-orchestrated by default (BREAKING for autonomous setups)

- *The harness is now agent-orchestrated by default.* The OpenClaw agent
  drives the harness via tools instead of the plugin listening to Slack on
  its own. New config flag `slack.listener_enabled` (default `false`):
    - `false` (default): the plugin does NOT subscribe to `message_received`.
      The OpenClaw agent calls `harness_run` / `harness_start_session` and
      polls `harness_status`. `slack.channel` is no longer required in this
      mode.
    - `true`: previous behaviour -- the plugin listens on `slack.channel`
      and treats allow-listed messages as dev requests.
  Existing autonomous deployments must set `slack.listener_enabled: true`
  to keep the listener.
- *New tool `harness_run`* -- the primary agent entry point. Takes a raw
  natural-language request, runs the same classify -> crystallise pipeline
  the listener uses, and either starts a session (returns `sessionId`),
  returns a clarifying question, or rejects (not-dev / unsafe).
- *`harness_start_session` Slack args are now optional.* `slackChannel` /
  `slackThread` are no longer required; when omitted a synthetic
  `agent:<sessionId>` thread key satisfies the UNIQUE(slack_thread)
  constraint and progress is not pushed to Slack (poll the tools instead).
- The crystalliser closure is now shared between the Slack dispatcher and
  the agent tools via `HarnessRuntime.crystallise`, so both paths use an
  identical pipeline.

### Docs

- *UML diagrams added.* `docs/ARCHITECTURE.md` gains a new `§0. UML diagrams`
  section with GitHub-native Mermaid: a component diagram (who owns what),
  a full end-to-end sequence diagram (one dev request through crystallise,
  plan, parallel workers, adversary, PR), and a state-machine diagram that
  mirrors `OrchestratorLoop.advance()`. The README embeds a condensed
  sequence diagram. All four blocks validated with the Mermaid parser.
- *README refreshed* to `0.1.0-beta.2`: test count 130 (was 87), 9 tools
  in the subsystem table (was 8), and state store described as built-in
  `node:sqlite` (was better-sqlite3).

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
