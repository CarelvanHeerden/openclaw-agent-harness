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
