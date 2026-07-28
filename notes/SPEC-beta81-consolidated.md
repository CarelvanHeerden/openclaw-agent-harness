# SPEC beta.81 (CONSOLIDATED) — everything open, folded into one release

Carel 2026-07-28 11:09: "Fold everything that we have open, from budget to these items into the next beta release." So ONE beta (beta.81) carries all three tracks. Base: beta.80 (`70fd574`).

## Track A — budget transparency (soft limit UNCHANGED)
(from SPEC-beta81-budget-transparency.md; that file's detail stands)
- A1: surface a SESSION estimate up front, harness-owned + persisted on the session row (recommendBudget already computes it; today it's only a daily-cap-gated agent-relayed note). "Estimated ~$X; cap $Y."
- A2: formalise SESSION usage-vs-cap. NOTE (Staging corrected me): the harness ALREADY bakes `($5.68/$10.00)` into the progress headline — so A2 is NOT from zero. Add: terminal totals (final spend vs cap + whether the beta.61 reserve/abort fired, with a "re-run at higher cap" line), "% of cap", and push (native poster) not pull-only.
- A3: emit an UNCONDITIONAL `tool.run.budget_estimate {estimated, cap, dailySoFar, dailyMax}` audit on EVERY run (today `tool.run.budget_recommendation` is `if(rec.note)`-gated on daily-cap pressure only, so it never fires with a generous daily cap — Staging proved zero hits ever). So "was budget surfaced?" is always answerable from the log.
- Soft session limit stays; NO hard pause for budget (Carel affirmed soft).

## Track B — CI-verification shift (the big architectural one; Carel's clear directive)
Carel: "run the full suite until green ... should not happen. This is what github is for. The harness should just monitor the CI and check for errors" + "the harness should code, not try and run it locally."

CURRENT STATE (verified in code):
- Worker prompt (sonnet-worker.ts ~296-327) EXPLICITLY instructs local blocking runs: `npm test`, `npx vitest run`, `npm run build`, `npx eslint .` in-turn. THIS is what let sub-task 11 sit in an until-green loop.
- `combinedCiStatus(sha)` EXISTS (github.ts:200) reading GitHub commit status + check-runs, but is consulted ONLY at merge time; the loop passes `ciStatus: undefined` (loop.ts:2118). CI is NOT part of the verification/revise loop.
- The loop's only external-verify wait is `fetchRuntime` (Vercel bridge). No CI-wait.

THE SHIFT:
- B1: worker prompt — REMOVE the "run tests / build / lint locally, inline, to green" instructions. Worker WRITES code + commits. Keep the beta.70 "no repo-wide generators/tsc/build" guard; extend it to "do not run the test suite / build to green — CI does that." Warm context (beta.66/67) already gives the worker what it needs to write correctly.
- B2: verification spine = CI. After the worker pushes the branch, the harness POLLS `combinedCiStatus(headSha)` until not-pending (with a timeout), then feeds the result into the cycle: CI `success` → proceed to adversary/ship; CI `failure` → fetch the failing check logs and drive a REVISE cycle with them as the finding source.
- B3: the beta.63 LOCAL check-script runner becomes the NO-CI FALLBACK, behind an off-by-default-when-CI-present flag. If the repo/PR has CI checks, use CI. If it has NONE (combinedCiStatus === "none"), fall back to the local runner (so no-CI repos still work). Do NOT rip the local runner out.

### DESIGN DECISIONS for Carel (the 2 that carry rework risk):
1. **CI-wait model + timeout.** CI is async + slow (his Cursor run: 9 min of CI). The harness must push then WAIT for CI to complete before reviewing — a new loop wait-state. Proposed: poll `combinedCiStatus` every ~20s up to a `ci.wait_timeout_seconds` (default ~900s = 15 min, config). On timeout → treat as `pending`/inconclusive, surface to human, do not hang. OK?
2. **No-CI repos.** When `combinedCiStatus === "none"` (repo has no Actions/checks), fall back to the local check-script runner (B3). Alternative: refuse/clarify. Proposed: silent fallback to local runner (keeps no-CI repos working). OK?
(Thanos HAS GitHub CI — his 9-min run — so the primary path is exercised there.)

## Track C — retry/deadline backstop (the d01a7484 stall bug)
Two execution-loop bugs, surfaced by the oversized test sub-task (fixed by Track B, but the backstops must still work):
- C1: `worker_timeout_retry` (beta.64) LOGGED `attempt: 2` but fired NO SDK request (zero `sdk_stream_opened` for ~57 min). Fix: the retry must actually re-invoke `runWorker` on a fresh SDK session; if the retry cannot fire, it must FAIL the sub-task, not no-op into silence.
- C2: beta.60 `subtask_deadline_seconds` (2100s from runOne START = should have fired ~10:10:43) did NOT backstop the wedged retry. Fix: ensure the outer `withTimeout(runOne)` actually covers the worker-timeout-retry path (the retry likely re-enters below the wrapper, or the timeout handler wedged marking the row failed). A wedged sub-task MUST fail cleanly within the deadline, never hang forever.
- NEEDS the forensic audit chain from Staging (session d01a7484: sdk_request 09:35:43 → timeout 10:05:43 → worker_timeout_retry attempt 2 → silence; confirm whether `loop.subtask_deadline_exceeded` ever fired) to pin the exact re-entry point.

## Sequencing / risk
- A (budget) + C (retry/deadline) are LOW-risk, self-contained → build first.
- B (CI shift) is the architectural one → build after the 2 design decisions are confirmed; it's the biggest rework-risk (don't repeat the beta.79 wrong-shape mistake). Gate B on Carel's answers to the 2 decisions above.
- All land in ONE beta.81 PR per Carel's "fold everything."

## Version discipline
Bump src/version.ts + package.json to 0.1.0-beta.81 + rebuild dist. version.ts==package.json test enforces.

## Track C EXPANDED (Staging forensic on d01a7484, 2026-07-28 11:13) — now THREE defects + deadline-arming, not two

The stall changed shape: a recovery path engaged ~11:10 and started a FULL re-plan (bounce-looping, actively re-burning). Full audit chain proved:

**C1 — worker_timeout_retry logs a decision but never re-fires the SDK call.**
```
10:05:43.197 worker_timeout_retry seq=11 attempt:2 priorKind:"worker_timeout"
  ↳ ~65 min: NO sdk_request, NO sdk_stream_opened. subtask row untouched
    (status=running cost=0 sdk_session_id=NULL). Retry executor died between
    the log line and the SDK re-entry.
```
FIX: the retry must actually re-invoke runWorker with a fresh sdkSessionId, OR fail the sub-task hard. Never log-then-noop.

**C2 (was "deadline gap") — subtask_deadline never armed/fired for this path.** Staging: "this session had zero deadline pressure" — the beta.60 watchdog that should have force-failed seq 11 was not tracking it at all. FIX: ensure the outer runOne deadline is armed for the worker-timeout-retry path and force-fails within the deadline.

**C3 (NEW) — recovery-after-worker-timeout does a FULL SESSION RESTART, not a resume-at-failed-subtask.**
```
11:10:14 recovery.auto_resuming wasStatus="executing" cause="interrupted_non_terminal_agent_orchestrated"
11:10:14 loop.start  ← fresh session start from scratch, re-plan. NOT a resume of seq 11.
```
This re-plans the same brief + re-executes the 10 already-completed sub-tasks (whose commits are still in the worktree) → duplicates ~$5 spend. The seq=11 row is orphaned (never marked failed). FIX: recovery after a worker timeout must resume AT the failed sub-task, marking that sub-task `failed`, NOT restart the whole session. (Preserve completed sub-task commits; don't re-do them.)

**C4 (NEW, separate follow-up) — recovery BOUNCE LOOP.** 4x `recovery.auto_resuming wasStatus="planning"` in ~40s (11:11:44, 11:11:53, 11:12:15, 11:12:25) — planning keeps getting interrupted + re-resumed before it can finish. `interrupted_non_terminal_agent_orchestrated` fires on `planning` on a very short cycle. FIX: circuit-breaker on recovery.auto_resuming — >N resumes in <M seconds ⇒ hard stop (fail the session, surface to human) instead of infinite bounce. (Can fold into beta.81 Track C or be a fast follow.)

OPERATIONAL: d01a7484 recommended for immediate `harness_cancel` (it's actively re-burning; the worktree still holds the 10 completed commits for independent review). Staging has the tool.

## Track C — terminal datapoint (d01a7484 ended, 2026-07-28 11:15)
Session terminated `Failed` at $5.68/$10 (the re-burn did NOT fully materialise — good). 10/11 sub-tasks completed + committed on `harness/feat-grc-continuity-resilience` (salvageable for independent review). FINAL crash cause: the recovery FULL-RESTART re-plan (the C3 defect) itself crashed with `extractJson failed: no JSON in output` — the LEAD returned prose instead of the JSON plan contract (the beta.40 anti-persona-drift class, resurfacing on the re-plan path). 
IMPLICATION: fixing C3 (resume-at-failed-subtask, NO full re-plan) removes the trigger entirely — this crash is only reached because recovery wrongly re-planned from scratch. SECONDARY: the lead re-plan path may lack the beta.40 JSON-parse retry-with-truncation fallback the CLASSIFIER has (runClassifierSdk) — consider giving the lead SDK call the same "retry once on extractJson failure" guard so a transient prose-drift doesn't hard-crash a re-plan. Low priority once C3 lands (re-plan shouldn't happen), but cheap defense-in-depth.

## Track B — DESIGN DECISIONS RESOLVED (Carel 2026-07-28 11:16)
1. **CI-wait timeout = 15 min** (`ci.wait_timeout_seconds` default 900). ON TIMEOUT: do NOT silently mark inconclusive — PROVIDE FEEDBACK to the user ("CI still running after 15 min on <sha>") AND OFFER TO CONTINUE WATCHING (a resumable watch, not a hard give-up). So the timeout is a soft checkpoint that surfaces + offers to keep polling, not a failure.
2. **No-CI repos: NO LOCAL FALLBACK, EVER.** Carel (verbatim): "If a repo does not have CI, the harness should build it, so the CI runs on Github. I do not want it to run locally, ever." → This OVERRIDES the earlier B3 "local runner behind a flag" proposal. REVISED B3: when a repo has no CI (`combinedCiStatus === "none"` / no `.github/workflows`), the harness AUTHORS a GitHub Actions workflow (install + the repo's declared check scripts: typecheck/lint/test) as part of the change, pushes it, and verification runs on GitHub. The beta.63 LOCAL check-script runner is REMOVED from the verification spine (not kept as fallback). Local test/build/lint execution is banned everywhere — worker prompt (B1) must forbid it, and there is no local-verify step at all.

REVISED Track B build list:
- B1: worker prompt — REMOVE all "run tests/build/lint locally inline" instructions; worker WRITES + COMMITS code only. Forbid any local `npm test`/`npm run build`/`tsc`/`eslint` run. (Warm context beta.66/67 gives the worker what it needs.)
- B2: after push, poll `combinedCiStatus(headSha)` every ~20s up to 900s. success → proceed to adversary/ship. failure → fetch failing check-run logs → drive revise. timeout(900s) → surface "CI still running" + offer `harness_resume`-style continue-watching (resumable), NOT a hard fail.
- B3: if `combinedCiStatus === "none"` (no CI present), AUTHOR a `.github/workflows/*.yml` running the repo's declared check scripts (detect from package.json), include it in the PR, so CI runs on GitHub. NEVER fall back to local.
- B4: REMOVE / retire the beta.63 local check-script runner from the verification path (verify.run_repo_check_scripts). Verification is CI-only now.

## C4 CORRECTION (Clark code-read, 2026-07-28) — NOT a missing tools:[]; it's model prose-drift DESPITE tools:[]
Staging's error string quoted the harness's generic hint "check that structured calls run with tools: [] to disable built-in tools". But `structuredCall` (claude-sdk.ts:395) ALREADY passes `tools: []` (line 456, beta.28) for EVERY structured call incl. the lead (line 1015). So `tools:[]` is NOT missing — the lead model drifted to prose ANYWAY (the beta.40 anti-persona class). So C4's real fix is NOT "add tools:[]" (already there) — it's the RETRY-ONCE-on-extractJson-failure guard + fast-fail (don't tight-loop the same failing call). That guard is ALREADY present in the tree's beta.81 WIP (runLeadSdk try/catch retry on /extractJson failed|no JSON|validation failed/, gated by jsonRetryEnabled). C3 (resume-at-subtask, no full re-plan) remains the primary fix so a re-plan rarely happens; C4 retry is defense-in-depth for when it does.

## STATE NOTE (2026-07-28): beta.81 WIP already substantially built in the dev working tree (UNCOMMITTED)
On resuming, found ~738 src insertions uncommitted across all 3 tracks + a NEW src/adapters/ci-workflow.ts (Track B) + version already bumped to beta.81. Files touched: claude-sdk, github, config(+schema), index, loop, progress, sonnet-worker, recovery, schema.sql, store, registration, openclaw.plugin.json, 2 test files. Do NOT rebuild from scratch — ASSESS completeness (typecheck/build/test) then fill gaps + ship. HEAD is still beta.80 (70fd574); nothing beta.81 committed yet.
