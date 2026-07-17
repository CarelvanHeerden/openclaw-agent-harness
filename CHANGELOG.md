# Changelog

## [0.1.0-beta.21] -- 2026-07-17

### Added

- **OKF concept pass-through: end-to-end plumbing.** The OKF plugin is
  installed on OpenClaw and enriches an agent turn's context with
  "Relevant Knowledge" blocks. That enrichment stops at the OpenClaw agent
  boundary — the harness-internal SDK calls (crystalliser, lead planner,
  worker) are separate Claude SDK invocations with their own system
  prompts, so OKF context did NOT propagate without explicit plumbing.

  Beta.21 threads an optional `relevantConcepts` array through:
  ```
  harness_run tool  ->  crystallise()  ->  CrystallisedBrief
                                       ->  lead system prompt
                                       ->  worker system prompt
  ```

  The harness does NOT crawl OKF bundles on its own; the plugin is
  pass-through only. Callers (typically the OpenClaw agent, when its
  context enrichment has surfaced concept blocks) supply the concept
  refs at the tool boundary.

  Concept ref shape:
  ```typescript
  interface OkfConceptRef {
    id: string;           // e.g. 'services/retry'
    path?: string;        // repo-relative path where the concept file lives
    summary?: string;     // one-line description
    tags?: string[];      // OKF tags
    content?: string;     // full concept file body (markdown)
  }
  ```

  Downstream effects:
  - **Crystalliser SDK prompt** gets a `RELEVANT KNOWLEDGE` block listing
    supplied concepts and instructing the model to add their `path` values
    to `filesLikelyTouched`. Unrelated `tags` become implicit `outOfScope`
    hints. Forbids invented concept ids.
  - **Lead planner SDK prompt** teaches the same rules: use concept
    `path` in the affected sub-task's `filesLikelyTouched`; treat
    unrelated concept `tags` as implicit out-of-scope hints.
  - **Worker system prompt** includes each concept's `id`, `summary`,
    `tags`, and (bounded) `content` when the sub-task's `filesLikelyTouched`
    intersects the concept's `path`. Path-less concepts are treated as
    broadly brief-scoped. Content is capped at 4KB per concept and 12KB
    total per sub-task to prevent prompt bloat.
  - **`harness_run` and `harness_start_session` tools** both accept a
    `relevantConcepts` parameter in their tool schemas.

### Fixed

- **Authoritative concept backfill.** `crystallisePrompt` now backfills
  `brief.relevantConcepts` from the caller-supplied concepts when the
  SDK-side crystalliser silently drops the new output field (pre-beta.21
  model versions may not honour it yet). SDK-enriched concepts (with
  summaries/tags/content) win over bare backfill.

### Testing

- 17 new tests. Test count: **306 -> 323**.
  - `beta21-okf-plumbing.test.mjs` (12 tests): propagation, backfill,
    prompt rendering, worker concept filtering (path/dir-prefix matching
    + path-less broad-scope), content truncation.
  - `beta21-lead-prompt-okf.test.mjs` (5 tests): source-string guards on
    the lead + crystalliser prompt guidance.

### Backward compatibility

- `relevantConcepts` is fully optional on all interfaces:
  - Old tool callers that omit the field: behaviour identical to beta.20.
  - Pre-beta.21 briefs restored from the DB: `relevantConcepts` is
    `undefined`; the lead + worker prompts render exactly as before.
  - Old test doubles that stub `callCrystalliser` with the 2-arg
    signature continue to work (3rd arg is optional).

### Migration notes

- To actually benefit from OKF, the OpenClaw agent must forward the
  concept blocks it received from context enrichment into the
  `harness_run` tool call as `relevantConcepts: [{id, path?, summary?,
  tags?, content?}, ...]`. Agents that don't do this see beta.20
  behaviour.
- The OpenClaw agent may pass `content` inline (for the concept file's
  markdown body) or omit it — in which case the worker gets only the
  id/summary/tags. Passing `content` is strictly better for large repos
  where the worker would otherwise waste tokens rediscovering context.

## [0.1.0-beta.20] -- 2026-07-17

### Added

- **README: task-phrasing guide.** New top-level section "How to ask for
  work" between the two-modes intro and the Why section. Covers:
  - **Tier 1** — plain-English asks for small changes on repos you know.
  - **Tier 2** — structured template for larger repos (`Task/Repo/Where/
    Do NOT/Done when/Risk`).
  - **Golden rules** — five phrasings that measurably affect plan
    quality (atomicity, out-of-scope, observable done-when, local-scope
    preference, honest risk).
  - **Four worked examples** — bugfix, small feature, refactor, docs-only.
    Each shows the recommended brief shape and the expected plan shape
    the lead planner should produce.
  - **Troubleshooting** — what to do if the plan is wrong (`:x:` +
    re-phrase with tighter atomicity, most common cause is a split
    write+commit).

  Complements the beta.19 atomicity rule on the lead planner side:
  beta.19 taught the model, beta.20 teaches the user.

### Testing

- No new tests. This is a docs-only release; the beta.19 test suite
  (306 tests) continues to pass.

## [0.1.0-beta.19] -- 2026-07-17

### Added

- **Lead system prompt: atomicity rule for write+commit and push+PR.**
  Staging's beta.17 smoke #2 exposed a lead-plan pathology: an acceptance
  criterion phrased as "append line X and commit locally" was decomposed
  into 3 sub-tasks (write / commit / verify) instead of one atomic
  write-and-commit. s2's verify contract (`commit_made`, `file_committed`,
  `file_written`) compared against s2's own worker-session-start SHA,
  but the write already happened in s1, so s2's HEAD was unchanged from
  its base and verification correctly failed. Correct behaviour given
  the plan, wrong plan.

  Beta.19 adds explicit guidance to the lead system prompt:
  - **ATOMICITY RULE:** a WRITE action and its accompanying COMMIT belong
    in ONE mutate sub-task. If a single sentence contains both a write
    clause and a commit clause, it is one atomic sub-task.
  - **Corollary:** teaches the model the concrete failure mode of the
    anti-pattern -- more durable than just saying "don't".
  - **Anti-pattern named:** 3 sub-tasks (write, commit, verify) for a
    single write-and-commit criterion. Correct shape: 1 mutate + optional
    1 observe.
  - **Extension to push+PR:** "push branch and open a PR" is ONE mutate
    sub-task with `contractScope='remote'`, not two.

### Fixed

- **`sub_tasks.started_at` is now actually populated.** The column existed
  in the schema since inception but nothing wrote to it, so every row had
  `started_at IS NULL`. Staging flagged this as a low-severity finding in
  the beta.18 smoke report. The INSERT that sets `status='running'` now
  also sets `started_at` to the same instant as `created_at`.

### Testing

- 6 new tests. Test count: **300 -> 306**.
  - `beta19-lead-prompt-atomicity.test.mjs`: source-string regression
    guards on the atomicity rule (any refactor that moves the guidance
    must update the test, which is deliberately the point).
  - `beta19-started-at.test.mjs`: end-to-end assertion that
    `started_at` is populated on real runs, monotonic across sub-tasks.

### Deferred

- Two low-severity findings from Staging's beta.18 report remain open:
  - Boot double-emit: needs specifics on which event fires twice before
    a targeted fix is possible.
  - Null `commit_sha` on `sub_tasks`: currently semantically correct (a
    sub-task that made no commit legitimately has `NULL`), but the schema
    could document the semantics or migrate to `''` for clarity. Deferred
    pending Staging preference.

## [0.1.0-beta.18] -- 2026-07-17

### Fixed

- **Observe-breadcrumb emitter now correctly gates on `taskMode !== "mutate"`.**
  Staging's beta.17 smoke #2 caught a semantic incoherence: a mutate
  sub-task produced `loop.subtask_observe_completed` with `taskMode:"mutate"`
  in the payload. The event name says "observe_completed", the payload
  admits it's a mutation.

  Root cause: the emit guard had two branches. The INNER branch
  (verify-eligible, when `buildVerifyProbes` is wired and `contract.length > 0`)
  correctly checked `st.taskMode === "observe" || (contract.length === 0
  && st.taskMode !== "mutate")`. The OUTER `else if` branch (verify path
  skipped) only checked `st.taskMode === "observe" || contract.length === 0`,
  missing the `!== "mutate"` guard. Beta.18 brings the two branches in
  line so the semantics match regardless of which path is taken.

  Beta.17 only exposed this because a test-double / production path with
  no probes wired hits the outer branch, and the lead planner
  over-decomposed an "append + commit" brief into separate mutate
  sub-tasks where s1 had no probes to verify against (probes existed but
  its inferred contract came up empty for a write-only sub-task).

- **Startup worktree self-heal now always emits its audit event, even
  when there's nothing to reap.** Beta.17 gated both the info-log AND
  the `harness.worktree_heal` audit event behind `scanned > 0`. Staging
  searched the audit vocab after installing beta.17, found no
  `harness.worktree_heal` event, and reported "no evidence found" for
  the self-heal. The absence was diagnostically ambiguous: fresh install
  with no leftovers vs. wiring silently broken.

  Beta.18 emits the audit event unconditionally. Fresh install with a
  clean root will now produce
  `{scanned:0, matched_terminal:0, matched_active:0, orphaned:0,
  removed:0, errors:[]}` — which is boring but present, and lets
  operators confirm the heal ran. Also emits a new
  `harness.worktree_heal_failed` audit event on the outer try/catch
  path, so a genuine wiring failure now surfaces in the audit stream.

### Testing

- 3 new tests. Test count: **297 -> 300**.
  - `beta18-observe-breadcrumb-guard.test.mjs`:
    - mutate sub-task with no probes does NOT emit observe breadcrumb
    - observe sub-task with no probes still emits (regression guard on
      the tightening)
    - unspecified `taskMode` with empty contract still emits (defensive
      default for pre-beta.15 plans)

### Known open item (deferred to beta.19)

- **Lead over-decomposition of "append + commit" briefs.** Staging's
  beta.17 smoke #2 exposed this: acceptance criteria phrased as
  "append line X and commit locally" produced 3 sub-tasks (write, commit,
  verify) where a single atomic mutate would work. s2's contract
  (`commit_made`/`file_committed`/`file_written`) compared against
  s2's own worker-session-start SHA, but the write happened in s1, so
  s2's HEAD was unchanged from its base and verification correctly
  failed. Correct behaviour given the plan, wrong plan.

  Prompt-tuning target: teach the lead that when a single acceptance
  criterion has both a write clause and a commit clause, they belong in
  one mutate sub-task. Deferred to beta.19 because prompt work needs
  more careful validation than a code-only fix.

## [0.1.0-beta.17] -- 2026-07-17

### Fixed

- **Blocker: worktree release was telemetry-only in beta.16.** Discovered by
  Staging's beta.16 smoke #2: the audit event `loop.worktree_released` fired
  with `reason:'shipped'`, but the physical worktree stayed on disk with the
  branch checked out. The next smoke crashed with the same
  `refusing to fetch into branch checked out at 'pending-<ts>'` error the
  beta.16 fix was supposed to eliminate.

  Root cause: `git.release(sessionId, repoFullName)` reconstructed the
  worktree path via `sessionWorktreePath(sessionId)` -> `<worktrees_root>/
  <sessionId>`. But the allocator (`index.ts allocateWorktree`) uses
  `sessionId: 'pending-' + Date.now()` as the ON-DISK id, NOT the DB session
  UUID. So the reconstructed path never existed, `if (!existsSync(wt)) return`
  silently no-op'd, and the audit event fired regardless. Both the beta.16
  loop-side wiring AND the pre-beta.16 pr-watcher release-on-close path
  had this bug -- the pr-watcher's failure was just never observed because
  it ran async on PR close and its outcome was never surfaced.

  Fix:
  - New `git.releaseByPath(worktreePath, repoFullName): {ok, path, error?}`
    is the authoritative release entry point. Takes the actual worktree
    path (looked up from `sessions.worktree_path`), does the git worktree
    remove, follows up with `rm -rf` if the dir survives, and prunes bare
    worktree admin state. Returns a structured outcome.
  - `git.release(sessionId, repoFullName, worktreePath?)` legacy shape is
    retained but delegates to `releaseByPath` when `worktreePath` is
    supplied. The 3-arg form is the correct call.
  - `OrchestratorDeps.releaseWorktree` signature now includes `worktreePath`
    and returns `{ok, path?, error?}`. Loop passes `plan.worktreePath` to
    the release call.
  - `pr-watcher` uses `releaseByPath(row.worktree_path, row.repo)`.

- **`{ok, error?}` on `loop.worktree_released` / `loop.worktree_release_failed`
  audit payloads.** Beta.16 fired the success event without any indication
  of whether the underlying operation succeeded. Beta.17 payloads carry
  `ok`, `path`, and (on failure) `error`. Would have caught the beta.16
  bug via audit stream inspection alone.

### Added

- **Startup worktree self-heal.** On plugin init, scan `worktrees_root` for
  leftover per-session dirs (allocator-shaped names: `pending-<digits>` or
  UUIDs), cross-check against the sessions table, and force-remove any
  worktree whose owning session is terminal (`done`/`failed`/`aborted`) or
  entirely unknown to the DB. Active sessions are preserved.

  Belt-and-suspenders on top of the loop-side release. Also fixes
  historical debt: every `pending-<ts>` worktree left behind by pre-beta.17
  gets cleaned up on the first restart after upgrading.

  Emits `harness.worktree_heal` audit event with counts:
  `{scanned, matched_terminal, matched_active, orphaned, removed, errors}`.

  Defence: `looksLikeAllocatorWorktree()` only matches `pending-<digits>`
  and UUIDs, so a misconfigured `worktrees_root` pointing at a shared
  directory cannot cascade into removing user scratch dirs.

### Testing

- 10 new tests. Test count: **287 -> 297**.
  - `beta17-release-by-path.test.mjs`: real git + real fs. Confirms
    `releaseByPath` actually removes physical worktree dirs and unregisters
    them from `git worktree list`.
  - `beta17-worktree-heal.test.mjs`: unit tests for the self-heal logic
    (terminal removal, orphan removal, active preservation, allocator-name
    guard, error reporting).

### Migration notes

- Callers of `git.release(sessionId, repoFullName)` (the 2-arg form) will
  still compile but continue to silently no-op when the reconstruction is
  wrong. Prefer `releaseByPath(worktreePath, repoFullName)`.
- The `releaseWorktree` orchestrator dep signature changed: `worktreePath`
  is now a required parameter and the return type is `{ok, path?, error?}`.
  Test doubles that stub this dep will need updating. See
  `tests/beta16-worktree-release.test.mjs` for the reference shape.

## [0.1.0-beta.16] -- 2026-07-17

### Added

- **`loop.subtask_observe_completed` audit breadcrumb.** Fires exactly once
  per observe-mode sub-task terminal success. Closes a telemetry gap
  discovered on Staging's beta.15 clean-pass smoke (session `b8b37f87`,
  PR #36): observe sub-tasks with `verify:[]` or an empty inferred contract
  correctly emit no `loop.subtask_verification` event (there's nothing to
  check), which leaves a ~minutes-long silent gap in the audit stream
  between the worker cost record and the next transition. Operators had
  to cross-reference the `sub_tasks` table to confirm the observe step
  ran to completion.

  Payload shape (parallel to `loop.subtask_verification`):
  ```json
  {
    "event": "loop.subtask_observe_completed",
    "payload": {
      "sessionId": "<uuid>",
      "seq": 2,
      "taskMode": "observe",
      "verify_count": 0,
      "worker_files_touched": [],
      "worker_commit_sha": null,
      "worker_end_reason": "end_turn",
      "cost_usd": 0.0912
    }
  }
  ```

  Fires when:
  - `st.taskMode === "observe"` **or**
  - contract is empty AND `taskMode` is not `"mutate"` (defensive default
    for pre-beta.15 plans without `taskMode`)

  Does not fire on `taskMode: "mutate"` even if that sub-task's contract
  happens to be empty (an explicit mutate contract with `verify:[]` is a
  planner bug, not a legitimate observe).

### Fixed

- **Worktree pruning on `loop.shipped` and terminal failures/aborts.**
  Prior to beta.16, worktree cleanup was only wired via the pr-watcher's
  release-on-close path. Every successful smoke left a `pending-<ts>`
  worktree holding the smoke branch and blocked the next fetch on that
  branch with `refusing to fetch into branch checked out at ...`.
  Discovered on Staging 2026-07-17 08:05 UTC when the beta.16 failure-
  injection smoke crashed on startup because the beta.15 clean-pass
  smoke's worktree had never been released.

  Fix: new `releaseWorktree` dep on the orchestrator, invoked on:
  - `loop.shipped` (PR opened) -- primary win, closes the exact Staging
    booby-trap.
  - `loop.aborted` (user_abort_reaction, hard_timeout, budget_exhausted).
  - Hard failure (plan_failed, adversary_error, pr_error, verification
    fail, no_review_produced, subtask worker exception, etc.).

  All six hard-failed return sites now route through a new `finaliseFailed`
  helper so we cannot forget to release on a new failure path added
  later. Best-effort semantics: release failures are logged and audited
  (`loop.worktree_release_failed`) but never propagate up to fail the
  session outcome. The pr-watcher's release-on-close remains as a safety
  net for the rare case where release() here errors.

### Testing

- **Regression test for beta.15's `baseRef` + `baseSemantics` payload on
  verify-failed audit events.** Beta.15's happy-path smoke never fired
  the `commit_verify_failed` / `file_committed_verify_failed` events, so
  the payload contract was unverified until Staging's failure-injection
  smoke on 2026-07-17 08:05 UTC (session `1610be9d`). That smoke is now
  a deterministic test: worker writes+stages a file but skips commit,
  contract has `file_written`/`file_committed`/`commit_made`, two of
  three verify checks fail, and the emitted audit events carry the
  correct `baseRef` (first 12 chars of the worker-session-start SHA) and
  `baseSemantics: "worker-session-start"`.

  Guards against a refactor that silently drops the fields or moves the
  pinning point away from worker-session-open (three plausible "start
  times" exist: session-create, plan-generation, worker-session-open --
  beta.15 specifically chose the third).

- **Test count: 277 -> 287 (+10 new).**

### Migration notes

- The `releaseWorktree` and `worktreeHeadSha` deps on `OrchestratorDeps`
  are both optional. Existing test doubles that omit them continue to
  work (verified by `beta.16: releaseWorktree not called when dep
  omitted (back-compat)` test). Real deployments should wire
  `releaseWorktree` -> `git.release(sessionId, repoFullName)` (see
  `src/index.ts` for the reference wiring).

- No planner/plan-schema changes. `LeadPlanSubTask.taskMode` continues to
  be interpreted exactly as in beta.15. The observe breadcrumb is a
  runtime-only enhancement.

## [0.1.0-beta.15] -- 2026-07-16

### Added

- **`taskMode` field on `LeadPlanSubTask` as the second scope axis.**
  Beta.14 closed the LOCAL/REMOTE scope class with `contractScope`. The
  beta.14 happy-path smoke on Staging exposed a second scope class:
  OBSERVATION vs MUTATION. A pure observation sub-task (final "verify
  everything is correct" step) had `commit_made` + `file_committed`
  inferred from language, then failed verification because the observation
  worker (correctly) produced no new commit vs sub-task-start SHA.

  Same architectural pattern as beta.14: promote scope to a first-class
  field. New enum:

  ```typescript
  export type TaskMode = "observe" | "mutate" | "mixed";
  ```

  New optional field on `LeadPlanSubTask`:

  ```typescript
  taskMode?: TaskMode;
  ```

  Semantics:
  - `observe` → sub-task is read-only. All mutation-scope kinds are
    filtered from the inferred contract:
    `file_written`, `commit_made`, `file_committed`, `branch_pushed`,
    `file_pushed`, `pr_opened`. State/existence kinds
    (`remote_branch_exists`, `commit_sha_matches`, `pr_state`,
    `file_in_pr`) remain — they check the state of the world at verify
    time, not whether this sub-task caused it.
  - `mutate` → sub-task produces new artifacts. Full inference. Matches
    beta.14 behaviour.
  - `mixed`  → both. Full inference. Rare; prefer decomposition.
  - absent   → fallback to beta.14 inference (100% backward compat).

### Two orthogonal scope axes

`contractScope` (beta.14) and `taskMode` (beta.15) compose:

|                          | `taskMode: mutate`         | `taskMode: observe`        |
|--------------------------|----------------------------|----------------------------|
| `contractScope: local`   | local writes/commits       | local read-only checks     |
| `contractScope: remote`  | push + PR + create commit  | check state of remote      |

A sub-task tagged `contractScope: 'local', taskMode: 'observe'` is the
purest read-only local check: nothing to verify beyond "the SDK finished"
— typically yields an empty contract, meaning "trust the SDK signal."

### Lead system prompt updated

- Describes `taskMode` with explicit rules.
- Encourages explicit `verify: []` on pure-observation sub-tasks (meaningful:
  "no observable side-effects, trust the SDK signal"). Cleaner than
  inference-then-filter.
- Documents the common plan shape: mutation steps with `taskMode='mutate'`,
  final observation step with `taskMode='observe'` + `verify: []`.

### Audit event enrichment

- `loop.commit_verify_failed` and `loop.file_committed_verify_failed`
  audit events now include `baseRef` (short SHA of worker-session-start
  HEAD) and `baseSemantics: "worker-session-start"`. This addresses
  Staging's beta.14 point 5: without this context, operators can't tell
  the difference between "worker didn't commit" and "no new commits
  since sub-task started, which is correct for observation-only
  sub-tasks."

### Tests

New file `tests/beta15-task-mode.test.mjs` — **10 tests** locking in:

1. `taskMode: 'observe'` filters out `file_written` / `commit_made` /
   `file_committed` / `branch_pushed` / `file_pushed` / `pr_opened` even
   when language would infer them.
2. `taskMode: 'observe'` preserves state-check kinds
   (`remote_branch_exists`, `commit_sha_matches`).
3. `taskMode: 'mutate'` applies full inference (baseline).
4. Absent `taskMode` falls back to beta.14 inference (backward compat).
5. `contractScope: 'local' + taskMode: 'observe'` → empty contract.
6. `contractScope: 'remote' + taskMode: 'observe'` → state-check kinds only.
7. Explicit `verify: []` wins over `taskMode` filter.
8. Explicit `verify: [{kind: ...}]` wins even with `taskMode: 'observe'`.
9. Exact beta.14 s4 case with `taskMode: 'observe'` yields empty contract.

Full suite: **267 -> 277 tests passing**, 0 fail, 0 skip. Typecheck clean.

### Precedence (updated)

1. Explicit `verify` array on sub-task → authoritative (unchanged from beta.9).
2. Regex inference produces candidates (beta.13 negation-aware + absence-gate).
3. `contractScope: "local"` → filter out remote-scope kinds.
4. `taskMode: "observe"` → filter out mutation-scope kinds.
5. Filters compose. `local + observe` = purest read-only check.

### Known limitations

- **`openPr` / `draftPr` tool-call flags still not threaded.** Would
  compose nicely with `contractScope` (e.g. `openPr: false` at tool level
  DEFAULTS all sub-tasks to `local`) but needs plan-level policy
  propagation. Deferred.
- **Depends on the lead model actually filling in `taskMode`.** Some
  smoke variance possible in the first beta.15 runs. Backward-compat
  fallback catches missed cases.

### Discovery

OpenClaw Staging bot's beta.14 audit report explicitly recommended this
fix, calling out both the s4 mutation-scope leak AND the audit-event
clarity gap (base_ref). Fifth smoke-test-driven improvement in as many
releases. Staging's diagnostic pattern is now the primary quality signal
for this repo.

---

## [0.1.0-beta.14] -- 2026-07-16

### Added

- **Authoritative `contractScope` field on `LeadPlanSubTask`.** Beta.11 /
  12 / 13 fixed three separate NLP-derived contract inference bugs
  (duplicate audit event, negation-blindness, absence-blindness), all
  with the same root cause: the harness was trying to REVERSE-ENGINEER
  scope from natural-language patterns when the lead planner already
  understands scope conceptually. Beta.14 promotes scope to a
  first-class field.

  New enum: `type ContractScope = "local" | "remote" | "mixed"`.

  New optional field on `LeadPlanSubTask`:
  ```typescript
  contractScope?: ContractScope
  ```

  Semantics:
  - `local`  → sub-task only touches worktree fs + git. ALL remote-scope
    contract kinds (`branch_pushed`, `remote_branch_exists`,
    `commit_sha_matches`, `pr_opened`, `pr_state`, `file_pushed`,
    `file_in_pr`) are filtered from the inferred contract regardless of
    ambient wording. The beta.11/12/13 NLP heuristics remain but become
    optional insurance rather than the primary line of defense.
  - `remote` → sub-task pushes / opens PRs / verifies remote state.
    Regex inference applies as before (including beta.13 gates).
  - `mixed`  → both local and remote. Full inference. Rare; lead should
    decompose when possible.
  - Absent  → fallback to beta.13 inference (100% backward compat with
    plans from beta.10–beta.13).

- **Lead system prompt updated** to describe `contractScope` and
  explicitly instruct the model when to use each value:
  - Sub-task says "Do not push" / "observation only" / "read-only" → MUST be `local`.
  - Sub-task says "push branch" / "open PR" → MUST be `remote`.
  - When in doubt: prefer `local` (missing field falls back to regex inference).

### Precedence (updated)

1. Explicit `verify` array on sub-task → authoritative (unchanged from beta.9). Bypasses everything including scope filter.
2. Regex inference produces candidates from title + intent + successCriteria (beta.13 negation-aware + absence-gate).
3. `contractScope: "local"` → FILTERS OUT remote-scope kinds from candidates.
4. `contractScope: "remote"` / `"mixed"` / absent → no filtering.

### Tests

New file `tests/beta14-authoritative-scope.test.mjs` — 10 tests locking in:

- `contractScope: "local"` filters out remote-scope kinds even when regex would infer them.
- `contractScope: "local"` preserves local-scope kinds (`file_written`, `commit_made`, `file_committed`).
- `contractScope: "remote"` applies full inference (baseline).
- `contractScope: "remote"` still honours beta.12 negation cues (defensive).
- Absent `contractScope` falls back to beta.13 inference (backward compat).
- Explicit `verify` array overrides both inference AND scope filter (precedence).
- Exact Staging beta.10–beta.13 happy-path s3 case with `contractScope: "local"` yields empty contract.
- `contractScope: "mixed"` applies full inference.

Full suite: **257 -> 267 tests passing**, 0 fail, 0 skip. Typecheck clean.

### Known limitations

- **Absence-assertion in the beta.13 layer is still global, not per-clause.** This becomes moot when the lead tags scope correctly; the scope filter is a cleaner primary path. Absence-assertion remains as backward-compat safety net.
- **`openPr` / `draftPr` tool-call flags still not threaded to the verifier.** Would compose nicely with `contractScope` in a future release: `openPr: false` at the tool level could DEFAULT all sub-tasks to `local`, but requires plan-level policy propagation. Deferred.
- **Depends on the lead model actually filling in `contractScope`.** If the model emits sub-tasks without the field, the beta.13 fallback kicks in. Some smoke variance is expected in the first few beta.14 runs while we see how consistently the model follows the new instruction.

### Discovery

OpenClaw Staging bot proposed this exact fix in its beta.12 audit report:

> "Best: Promote to a formal plan field: `subTasks[].contractScope: 'local' | 'remote'` or `subTasks[].verifyKinds: [...]`. The lead already understands scope conceptually."

Beta.14 implements Staging's suggestion. Third smoke-test-driven improvement in three consecutive releases (beta.11, 12, 13 were bug fixes; beta.14 is the architectural improvement Staging recommended to end the whack-a-mole cycle).

---

## [0.1.0-beta.13] -- 2026-07-16

### Fixed

- **Absence-assertion detection for remote-scope inference.** Beta.12's
  negation-cue helper caught `branch_pushed` and `pr_opened` inferences
  (their regexes match "push"/"PR" which fail the negation check), but the
  `VERIFY_REMOTE_RE` / `SHA_MATCH_RE` inference branch is triggered by
  "verify" / "confirm SHA" language, not by "push" — so the negation cue
  didn't apply. Result: a happy-path smoke sub-task whose intent said
  "observation only, no push, no PR" still inferred `remote_branch_exists`
  + `commit_sha_matches` from ambient "verify" wording.

  Fix: new `assertsAbsence(text)` gate. Any sub-task text asserting the
  ABSENCE of a remote artifact ("no push occurred", "no PR opened", "no
  remote tracking", "branch is only local", "did not push", "read-only",
  "git branch -r ... empty") is treated as an absence-assertion. When
  present, all positive remote-scope kinds are suppressed regardless of
  which regex triggered them. Doesn't affect explicit positive assertions
  ("Verify remote SHA matches local HEAD" — still infers as before).

### Tests

- New file `tests/beta13-absence-assertion.test.mjs` — 9 tests locking in:
  - Exact Staging beta.12 s3 case yields empty contract.
  - Common absence phrases ("no push occurred", "no PR opened", "no remote
    tracking branch", "read-only", "branch is only local") suppress
    remote-scope kinds.
  - Positive baselines ("Push branch and open draft PR", "Verify remote SHA
    matches local HEAD") still infer correctly.
  - Mixed clauses: absence-assertion is global, not per-clause —
    documented trade-off.

- Full suite: **248 -> 257 tests passing**, 0 fail, 0 skip. Typecheck clean.

### Known limitations

- **Absence-assertion is global, not per-clause.** A sub-task saying "Push
  branch. No PR needed." will suppress BOTH push and PR inferences because
  the absence assertion is detected anywhere in the sub-task text. Per-clause
  resolution is deferred (would need more complex scope tracking; not worth
  it for the current bug class).

- **`openPr` / `draftPr` tool-call flags still not threaded to the verifier.** Same as beta.12.

- **Adversary review's `runtime` dimension still not observed on a passing
  cycle.** Beta.13 should finally unblock this. Re-run the same happy-path
  smoke on beta.13 to confirm.

### Discovery

OpenClaw Staging bot on the beta.12 happy-path smoke correctly identified
s3's contract had two leaked remote-scope kinds and pinpointed the exact
regexes (`VERIFY_REMOTE_RE`, `SHA_MATCH_RE`) that hadn't been guarded by
the beta.12 fix. Third smoke-test-driven bug fix in three releases.

---

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
