# DEV_LOG.md — beta.9 implementation log

**Author:** Clark (subagent for Carel van Heerden)
**Branch:** feat/beta-9-richer-verify-contracts
**Goal:** Fix beta.8 `file_written` bug (excluded untracked files) by splitting the single `file_written` contract kind into 8 precise contract types. Extend contract inference, probes, audit events, and tests.

## Phase 1: Codebase Exploration

### Architecture Summary (as-found)

- `src/orchestrator/fable5-lead.ts`: `SubTaskVerify` type — 4 kinds: `branch_pushed`, `pr_opened`, `file_written`, `commit_made`
- `src/orchestrator/verify-contract.ts`: Infers verify contract from sub-task language via regex
- `src/orchestrator/verify.ts`: `VerifyProbes` interface + `verifySubTaskOutput` — runs probes and evaluates
- `src/orchestrator/loop.ts`: Integrates verification, emits audit events, marks sub-tasks `failed_verification`

### Beta.8 Bug Confirmed

`fileWrittenSince` in `verify.ts` checks `git diff vs base`, which requires the file to be COMMITTED or at least staged. Untracked files (written but not committed) are invisible to `git diff`. Sub-task s1 "write file X without committing" can never pass `file_written` verification on beta.8.

## Phase 2: Design Decisions

### Decision: Backward compat via optional probes

New probes are OPTIONAL in `VerifyProbes` to preserve existing test doubles. When a new-kind probe is absent, fall back to the closest old probe or emit a clear skip record.

### Decision: Keep existing kind names, add new ones

`branch_pushed`, `pr_opened`, `commit_made` are kept. New kinds added alongside.
Old audit event names (`loop.push_verify_failed`, `loop.file_verify_failed`, `loop.pr_verify_failed`, `loop.commit_verify_failed`) continue to fire for backward compat. New specific events fire alongside them.

### Decision: `file_written` probe change

`file_written` kind now calls `fileExistsOnDisk` (optional probe), falling back to `fileWrittenSince` (git diff). This fixes the beta.8 bug while preserving backward compat for test doubles that don't supply `fileExistsOnDisk`.

### Decision: no new npm deps

Used `node:fs`, `node:child_process` (already used), native `fetch`. No new deps.

## Phase 3: Implementation

### Files Changed

- `src/orchestrator/fable5-lead.ts` — 8 new SubTaskVerify kinds
- `src/orchestrator/verify.ts` — new optional probes + handlers
- `src/orchestrator/verify-contract.ts` — extended inference
- `src/orchestrator/loop.ts` — extended audit event mapping
- `openclaw.plugin.json` — added `harness_bootstrap_test_repo`
- `docs/AUTH.md` — added verification contracts section
- `docs/GITHUB_AUTH.md` — added verification contracts section
- `README.md` — bumped Fixes section for beta.9
- Tests: `verify-contract.test.mjs`, `verify.test.mjs`, `loop-integration.test.mjs`

## Phase 4: Known Limitations / Notes for Carel

1. `prForBranch`, `prFiles`, `remoteFileExists`, `remoteBranchSha`, `localHeadSha` probes are optional (not yet wired into the real `buildVerifyProbes` factory in `src/index.ts` or `src/adapters/github-pr.ts`). The contract kinds work end-to-end with mocks; real-world wiring needs a follow-up pass connecting these probes to the GitHub API.

2. The `buildVerifyProbes` factory in the real adapter code (not touched in this PR) will need updating to provide all new probes. This is architectural scaffolding work that should be done before running beta.9 in production against a live GitHub session.

3. `file_in_pr` and `pr_state` require `prNumber` when `prForBranch` is not available. If neither is available, the probe skips gracefully with a warning in the detail.

## Decisions that could be overridden

- The fallback from `fileExistsOnDisk` to `fileWrittenSince` could be removed (breaking change) once all real probe factories are updated.
- `branch_pushed` inference could be replaced with `remote_branch_exists` + `commit_sha_matches`; I kept `branch_pushed` for backward compat. If Carel wants cleaner semantics, update `inferVerifyContract` and update the "push branch infers branch_pushed" test.

---

# beta.63 — stall watchdog + interaction log + repo-convention awareness

**Author:** Clark (subagent for Carel) · 2026-07-23 · builds on beta.62 (86b7511)

Three-feature release (all config-gated, default-ON). New config keys are in BOTH
`src/config.ts` AND `openclaw.plugin.json` `configSchema` (`additionalProperties:false`).
Built in dependency order (log first — later parts write events into it).

## Part B — durable interaction log (built first)

- New `src/state/interaction-log.ts`: `InteractionLog` class + pure helpers
  (`redactValue`, `redactTokenShapes`, `summarisePrompt`, `resolveInteractionLogConfig`).
  Append-only JSONL written to `<dataDir>/logs` (dir = `dirname(state_db_path)`),
  **OUTSIDE the worktree**. Per-session file + rolling global tail.
- Redaction is applied unconditionally on write (reuses `redactSecrets` from
  git-worktree.ts + standalone token-shape regexes). `full_prompts` only gates the
  prompt BODY, never redaction.
- Threaded into the loop: `setStatus` mirrors `state_transition`; SDK call sites
  (lead/worker/adversary) log `sdk_request`/`sdk_response`; verify probes, env-wait
  retries, refusals, review crashes mirrored too.
- New `harness_logs` tool (registration.ts) tails a session's JSONL. Registered in
  manifest contracts.tools + sdk-compliance EXPECTED_TOOLS + tools.test deepEqual +
  smoke expectTools.
- Config: `log.interaction_log_enabled` (true), `log.dir` (""→`<dataDir>/logs`),
  `log.full_prompts` (false), `log.retention_days` (14).

## Part A — stall watchdog (built second)

- Additive `session.last_progress_at` (schema CREATE + store.ts migration list),
  written on every setStatus + checkpoint + sub-task start + finalize/push via a new
  `markProgress` helper.
- `OrchestratorLoop.checkStalls(now?)`: scans executing/reviewing sessions past the
  window; loud `loop.session_stalled`; re-tick recovery when no live runner + brief
  present; else — gated by `stall_auto_terminal` — terminal `failed`
  (`stalled_no_progress`) via `finaliseStalled`, which preserves the worktree and, when
  commits exist + `stall_graceful_pr`, opens a `needs_human_review` PR (synthesises a
  minimal brief if the crystallised one is gone).
- `progress.ts` snapshot gains `stalled` + `msSinceProgress`; `harness_progress` passes
  the configured window; `harness_resume` force description extended.
- Config: `loop.session_stall_seconds` (1800, clamped ≥300), `loop.stall_auto_terminal`
  (true), `loop.stall_graceful_pr` (true).

## Convention-awareness (built third)

- New `src/orchestrator/repo-conventions.ts`: `ingestRepoConventions` (Fix 1),
  `discoverCheckScripts` + `runCheckScripts` (Fix 2), `applyCharBudget` (longest-first
  truncation + note), `renderConventionsForPrompt` (per-role guidance).
- Fix 1: ingest at plan-ready (repo checked out at `plan.worktreePath`) → `brief.repoConventions`;
  threaded into lead (claude-sdk.ts), worker (sonnet-worker.ts), adversary (fable5-adversary.ts).
- Fix 2: `runFinalVerifyChecks` runs allowlisted check scripts inline+blocking before review;
  non-zero exit → REVISE-worthy `loop.convention_check_failed` finding that downgrades a `pass`
  to `revise` (never `block`/hard-fail); unrunnable/timeout → non-fatal skip note. Injectable
  `runCheckScript` dep for tests.
- Config: `brief.ingest_repo_conventions` (true), `brief.convention_char_budget` (10000),
  `verify.run_repo_check_scripts` (true), `verify.check_script_allowlist`
  (`["okf:check","lint","typecheck","test"]`), `verify.check_script_timeout_seconds` (600).

## Verification

- `npx tsc --noEmit`: clean. `npm run build`: exit 0. Full suite: **661 → 699 tests (+38), all pass**.
  Smoke: `Smoke OK: 15 tools` (harness_logs added).
- Conservative choices noted: convention-check failures are findings, never hard-fails; stall
  auto-terminal is separately gated; recovery re-tick is preferred over terminal when a brief exists;
  graceful stall-PR synthesises a minimal brief rather than evaporating commits.

# beta.64 — inner-turn hang resilience (first-token watchdog, retry, best-effort verify, scripted fallback)

**Author:** Clark (subagent for Carel)
**Goal:** Fix beta.63 smoke #2 — a VERIFY sub-task worker SDK call hung (stream opened, ZERO first token, zero cost, no sdkSessionId) and sat the full 1800s worker_timeout → terminal failed, NO PR, despite the prior sub-task having committed a clean shippable diff with a GREEN verify_probe. beta.63's watchdog only covers between-transition stalls; it was blind to a hang INSIDE a single worker turn.

## P0-1 — first-token watchdog + SDK stream events
- Extracted the SDK stream-consumption loop into an exported `consumeWorkerStream(stream, abort, {firstTokenTimeoutSeconds, now})` helper in `src/adapters/claude-sdk.ts` so the watchdog is directly testable with a fake async-iterable (no real SDK). `runWorkerSdk` now just builds the SDK stream + AbortController and delegates.
- SEPARATE watchdog timer armed on system/init (stream open), disarmed on the first assistant content block (text/tool_use). Fires → `abort.abort()` → distinct stopReason `first_token_timeout`.
- New interaction-log emitters `logSdkStreamOpened` (event `sdk_stream_opened`, carries sdkSessionId) + `logSdkFirstToken` (event `sdk_first_token`, carries msToFirstToken).
- **Wiring choice (documented in CHANGELOG): return-value-then-log.** `runWorkerSdk` RETURNS `streamOpened` + `msToFirstToken` + the distinct stopReason in `RunWorkerResult`; threaded through `WorkerResult`; the loop logs the two events from the returned values inside `runWorkerCallWithRetry`. Chosen over passing the InteractionLog handle down into the SDK adapter (keeps the adapter free of DB/state deps; matches how the loop already owns all interaction-log SDK boundary logging).

## P0-2 — retry on timeout
- New `loop.runWorkerCallWithRetry(...)` wraps the worker call: emits P0-1 stream events + the sdk_response boundary, and RETRIES once on a fresh session when the attempt times out (thrown WorkerTimeoutError OR returned `first_token_timeout` status). Max 1 retry (local loop counter, like beta.53). Audit `loop.worker_timeout_retry {seq, attempt, priorKind}`. Also emits `loop.worker_first_token_timeout` for the distinct class.

## P0-3 — best-effort verify
- `loop.tryBestEffortVerify(...)`: on a timed-out observe-mode VERIFY sub-task, if the prior mutate probe was GREEN (readLocalVerification all ok) AND the diff is clean+in-scope (`gitDiffStat` + `parseDiffStatPaths`/`collectExpectedFiles`), push + open PR flagged needs_human_review (reuses `getLastReview` + `pushBranchAndOpenPr`). Audit `loop.verify_skipped_best_effort` + `loop.shipped{viaBestEffortVerify:true}`. On push failure: `finaliseFailedPreserveWorktree`.

## P0-4 — scripted verifier fallback
- `loop.tryScriptedVerifyFallback(...)`: runs `npx tsc --noEmit` (via new injectable dep `runScriptedTsc`, gated on tsconfig.json existing) + `git diff --stat` + the allowlisted repo check scripts (reuses beta.63 `discoverCheckScripts`/`runCheckScripts`). Returns pass|fail|unavailable. Audit `loop.scripted_verify_fallback {result, tscOk, scriptsRan, scriptFailures}`. `unavailable` escalates to P0-3.

## P1 — mid-turn stall observability
- P1-5: `buildProgressSnapshot` now derives `msSinceLastSdkActivity` from the last SDK-activity audit event (subtask_start marker, worker_end_turn, subtask_verification, ...) and flips `stalled:true` during an executing turn when it crosses the first-token window (default 90s). registration.ts passes `sdk_first_token_timeout_seconds` as the inner-turn window.
- P1-6: `costZeroStallSuspected` — a running sub-task older than the window with cost still $0.
- P1-7: `recovery.auto_resuming` now carries `cause: "interrupted_non_terminal_agent_orchestrated"`.

## Config (BOTH src/config.ts + manifest configSchema)
- `loop.sdk_first_token_timeout_seconds` (default 90, clamp [10,1800])
- `loop.worker_timeout_retry_enabled` (default true)
- `loop.best_effort_verify` (default true)
- `loop.scripted_verify_fallback` (default true)

## New injectable loop deps
- `gitDiffStat(worktreePath, base)` → wired to `git.diffStat` (new `git diff --stat` method)
- `runScriptedTsc(worktreePath, timeoutMs)` → wired to spawnSync `npx tsc --noEmit`

## Verification
- `npx tsc --noEmit`: clean. `npm run build`: exit 0. Full suite: **699 → 724 tests (+25), all pass**. Smoke: `Smoke OK: 15 tools` (no new tool this beta).
- Conservative fail-safe choices: prefer retry → scripted fallback → best-effort reviewable PR over discarding work; a scripted-fallback failure with best_effort_verify off falls through to terminal (does not silently ship); best-effort verify requires BOTH prior-green AND clean in-scope diff (declines conservatively when the diff can't be computed).
