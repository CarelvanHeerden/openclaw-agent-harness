/**
 * Orchestrator loop.
 *
 * The core state machine. Given a session id (already row-inserted with a
 * crystallised prompt + brief), it walks:
 *
 *   crystallising -> planning -> executing -> reviewing -> {done|revise}
 *
 * Up to `config.loop.max_cycles` cycles of executing+reviewing, plus any
 * extension `advance()` grants for a converging finding trend (b119). Early
 * exits:
 *   - Adversary verdict "pass"
 *   - User ship-it reaction
 *   - User abort reaction
 *   - Session budget breached
 *   - Session hard timeout
 *
 * The loop is deliberately structured as pure decision helpers + an outer
 * driver, so `advance()` can be unit-tested standalone.
 *
 * That split has a failure mode worth naming, because it cost b119 through
 * b123: a decision helper can be provably correct and still have no effect,
 * because the driver never acts on what it returned. Unit tests on the helper
 * pass, a grep for the handler passes, and the feature is dead. Anything that
 * changes what `advance()` returns needs a SCENARIO test that asserts the run
 * behaved differently, not a unit test that asserts the decision differed.
 */
import type { HarnessConfig } from "../config.js";
import type { BudgetEnforcer } from "../budgets/enforcer.js";
import type { PatRouter } from "../auth/pat-router.js";
import type { StateStore } from "../state/store.js";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
import type { LeadPlan, LeadPlanSubTask } from "./fable5-lead.js";
import type { ReviewReport, ReviewFinding } from "./fable5-adversary.js";
import type { WorkerResult } from "./sonnet-worker.js";
import type { RuntimeSnapshot } from "../vercel/logs.js";
/**
 * beta.64 (P0-3): parse the file paths out of a `git diff --stat base..HEAD`
 * output. Each stat line looks like ` path/to/file.ts | 12 ++--`. The trailing
 * ` N files changed, ...` summary line is skipped. Pure/deterministic.
 */
export declare function parseDiffStatPaths(diffStat: string): string[];
/**
 * beta.64 (P0-3): collect the union of `filesLikelyTouched` across all of a
 * plan's sub-tasks -- the "expected files" set for the best-effort clean-diff
 * check. Pure/deterministic.
 */
export declare function collectExpectedFiles(plan: LeadPlan): string[];
/**
 * beta.94 (Feature 1b): the UNION of every sub-task's DECLARED file scope --
 * the concrete file paths carried on each sub-task's verify probes
 * (file_written / file_committed / file_pushed / file_in_pr) PLUS its
 * `filesLikelyTouched`. This is the authoritative "in-scope" set the
 * deterministic final-scope check compares committed files against. A committed
 * file OUTSIDE this union is out-of-scope. Pure/deterministic.
 */
export declare function collectDeclaredScopeFiles(plan: LeadPlan): string[];
/**
 * beta.113: the phase-2 (stream-open -> first-token) window for one attempt.
 *
 * Escalating, because the DR/BCP run proved a fixed one does not survive a slow
 * start: sub-task 3 timed out at 30s, the b64 retry fired, and attempt 2 timed
 * out at 30s again. Exported so the escalation is testable without an SDK.
 */
export declare function firstTokenWindowForAttempt(attempt: number, baseSeconds: number, multiplier: number, capSeconds: number): number;
/**
 * beta.113: does a declared scope entry cover this committed file?
 *
 * The DR/BCP run declared `prisma/migrations` and then committed
 * `prisma/migrations/20260807102822_continuity_resilience/migration.sql`. That
 * was reported out-of-scope in both cycles, because the matcher compares two
 * file paths and a directory is not one. The file was the entire point of the
 * sub-task, and the spec demanded it -- `prisma migrate dev --name
 * continuity_resilience` -- so nothing could have declared its real name in
 * advance: migrate stamps a timestamp at generation time.
 *
 * A false out-of-scope entry is not cosmetic. b110 made a large enough count
 * abort the cycle outright, and every entry here is noise in the diff the
 * adversary reads.
 *
 * A declared entry is treated as a directory when it ends in a slash or glob,
 * or when its last segment carries no extension. `prisma/migrations` covers
 * files beneath it; `src/app/api/foo/route.ts` still only covers itself.
 */
export declare function declaredCovers(committedFile: string, declared: string): boolean;
import type { BranchAllocationDecision } from "../adapters/git-worktree.js";
import { type VerifyProbes } from "./verify.js";
import type { InteractionLog, InteractionPhase } from "../state/interaction-log.js";
export type LoopStatus = "crystallising" | "planning" | "executing" | "reviewing" | "done" | "failed" | "aborted" | "awaiting_clarification";
export type LoopOutcome = {
    status: "shipped";
    sessionId: string;
    prUrl: string;
    cycles: number;
    totalCostUsd: number;
} | {
    status: "failed";
    sessionId: string;
    reason: string;
    cycles: number;
    totalCostUsd: number;
} | {
    status: "aborted";
    sessionId: string;
    reason: string;
    cycles: number;
    totalCostUsd: number;
} | {
    status: "skipped_already_running";
    sessionId: string;
    reason: string;
    cycles: number;
    totalCostUsd: number;
} | {
    status: "awaiting_clarification";
    sessionId: string;
    question: string;
    seq: number;
    cycles: number;
    totalCostUsd: number;
};
/** beta.53: true when the worker awaited a non-existent env/monitor event. */
export declare function matchesEnvWaitHallucination(text: string): boolean;
/** beta.54: true when the worker confabulated an async coordination primitive. */
export declare function matchesAsyncCoordConfabulation(text: string): boolean;
export declare function matchesInvalidPremiseSkip(text: string): boolean;
export declare function matchesWorkerDeviation(text: string): boolean;
/**
 * beta.56 (P0-1): render the previous cycle's adversary review as a corrective
 * dispatch hint for revise-cycle workers.
 *
 * ROOT CAUSE this fixes: on an `adversary_revise` verdict the loop re-ran the
 * SAME sub-task prompts verbatim -- `runWorker({brief, subTask, plan})` carried
 * no findings, so cycle 2 was cycle 1 replayed and the loop structurally could
 * not converge (the immortal-finding treadmill beta.44-49 patched around, the
 * beta.35 "revise no-op" carve-out, and the refusal spiral all trace here).
 * The worker on a revise cycle now sees verdict, summary, and the concrete
 * findings, scoped with an explicit "if none apply to your sub-task, change
 * nothing" instruction so the beta.35 legal-no-op path still works.
 */
export declare function buildReviseDispatchHint(review: ReviewReport): string;
/** Test/diagnostic helper: clear any armed watchdog for a session. */
export declare function clearStallWatchdog(sessionId: string): void;
/** True if a loop for this session is currently running in this process. */
export declare function isSessionLoopRunning(sessionId: string): boolean;
/** Test/diagnostic helper: snapshot of currently-running session ids. */
export declare function runningSessionIds(): string[];
/**
 * beta.42: bound a promise by a timeout. The worker SDK call was previously
 * awaited with NO timeout (loop.ts runOne), so a hung worker (SDK socket
 * stall, or the runtime torn down under the await by a plugin re-register)
 * left the `await` unresolved forever -> the loop froze, `updated_at` stopped,
 * and the hard-deadline check (only evaluated BETWEEN sub-tasks) never ran.
 * That was the true root cause of the ~5h30m silent wedge on the beta.39 +
 * beta.40 ProjectThanos smokes. Racing the worker against a rejecting timeout
 * converts an infinite hang into a bounded, catchable failure that the loop's
 * existing try/catch already handles (marks the sub_task failed, sets
 * failed.err, returns). Returns a tuple so the caller can clear the timer.
 */
/**
 * beta.110: the committed tree bears no resemblance to what the plan declared,
 * so there is nothing worth reviewing. Thrown by runFinalScopeCheck.
 *
 * Distinct from ordinary scope creep, which stays a `medium` review finding.
 * This is the 12,423-out-of-scope-files case from PR #932 session `9217236c`.
 */
export declare class ScopeBlowoutError extends Error {
    readonly outOfScopeCount: number;
    readonly threshold: number;
    readonly sample: string[];
    constructor(outOfScopeCount: number, threshold: number, sample: string[]);
}
export declare class WorkerTimeoutError extends Error {
    readonly seconds: number;
    readonly limit: string;
    /**
     * beta.106: `limit` names the knob that actually fired.
     *
     * This helper bounds the worker, the lead and the adversary, but the message
     * hardcoded "worker_timeout_seconds" for all three. On the b105 smoke a LEAD
     * timeout at 900s was reported as "worker exceeded worker_timeout_seconds
     * (900s)" while `worker_timeout_seconds` was set to 1800 -- a number that
     * appeared nowhere in the config, sending the diagnosis to the wrong phase.
     * Defaults to the old text so existing callers and their assertions are
     * unchanged.
     */
    constructor(seconds: number, limit?: string);
}
export declare function withTimeout<T>(p: Promise<T>, seconds: number, limit?: string): Promise<T>;
export interface OrchestratorDeps {
    config: HarnessConfig;
    state: StateStore;
    budget: BudgetEnforcer;
    pat: PatRouter;
    logger: {
        info: (m: string, meta?: unknown) => void;
        warn: (m: string, meta?: unknown) => void;
        error: (m: string, meta?: unknown) => void;
    };
    /**
     * beta.63 (Part B): durable interaction log. Optional for back-compat with
     * test doubles that don't exercise it; when present, EVERY state transition,
     * verify probe, refusal/env-wait/deviation, and stall/recovery event is
     * mirrored into a JSONL file OUTSIDE the worktree (the SDK adapters log their
     * own sdk_request/sdk_response events via the same instance). Never throws.
     */
    interactionLog?: InteractionLog;
    /**
     * Injected work-doers. Real impls in src/adapters + src/vercel.
     *
     * `requester` is the session's Slack user id, threaded through so PAT
     * resolution can select THAT user's token (multi-user auth), rather than
     * defaulting to the first authorised user. Optional for back-compat with
     * test doubles that ignore it.
     */
    runLead: (brief: CrystallisedBrief, ctx?: {
        requester?: string;
        /**
         * beta.105: the session the plan belongs to, so worktree allocation can
         * audit which checkout path it took against that session. Optional for
         * back-compat with test doubles.
         */
        sessionId?: string;
        /**
         * beta.122: the branch this session is ALREADY on. When set it is used
         * verbatim, so a re-plan cannot rename the branch out from under commits
         * that are already on it (the b121 dash-vs-slash commit loss).
         */
        pinnedSessionBranch?: string;
        /**
         * beta.122: the session's last recorded commit. Lets allocation re-attach
         * a missing branch to real work instead of resetting to base.
         */
        recoverBranchFromSha?: string;
        /**
         * beta.105: called when allocation chooses its checkout path. The loop
         * turns it into `loop.branch_allocation`, because the b103 smoke could
         * not tell from the trail whether a resume preserved the branch or reset
         * it off eight of its own commits.
         */
        onBranchDecision?: (d: BranchAllocationDecision) => void;
    }) => Promise<LeadPlan>;
    /**
     * beta.67 (P0b): the Fable revise-spec turn. On an adversary `revise`
     * verdict, runs ONCE at the top of the revise cycle: Fable reads findings +
     * plan, investigates, and returns REFRESHED sub-tasks whose workerContext
     * carries a resolved changeSpec. Fed to cycle-2 workers via beta.66's warm
     * render path -- workers never see raw findings (the beta.63/64 no-op
     * regression). Optional: unwired OR throws -> fall back to
     * buildReviseDispatchHint (never worse than beta.66).
     */
    runLeadReviseSpec?: (params: {
        brief: CrystallisedBrief;
        plan: LeadPlan;
        review: ReviewReport;
        requester?: string;
    }) => Promise<{
        subTasks: LeadPlanSubTask[];
    }>;
    runWorker: (params: {
        brief: CrystallisedBrief;
        subTask: LeadPlanSubTask;
        plan: LeadPlan;
        /**
         * beta.117: the checkout this worker must actually work in.
         *
         * Before b117 the worker derived it from `plan.worktreePath`, because there
         * was only ever one. Under parallelism that is the integration checkout,
         * and a worker editing it would defeat the isolation entirely -- so the
         * loop now states the worktree explicitly and the implementation must
         * honour THIS value, not the plan's. Optional only so pre-b117 stubs keep
         * compiling; callers fall back to `plan.worktreePath` when it is absent.
         */
        worktreePath?: string;
        resumeSessionId?: string;
        requester?: string;
        /** beta.53 (P1b): corrective dispatch context appended on a retry. */
        dispatchHint?: string;
        /**
         * beta.91 (Fix 3): per-sub-task worker model override. When set, the SDK
         * call uses this model instead of config.models.worker (mechanical
         * scaffolding sub-tasks -> cheaper/faster model). Absent = config.models.worker.
         */
        modelOverride?: string;
        /**
         * beta.90 (Feature 2): stream-slow liveness callback. Invoked when the
         * worker SDK stream opens then goes idle (no token/activity delta) past
         * the configured threshold. OBSERVABILITY ONLY -- never aborts.
         */
        onStreamSlow?: (info: {
            idleMs: number;
            elapsedMs: number;
            tokensOut: number;
            label: string;
        }) => void;
        /** beta.113: per-attempt phase-2 watchdog widening; see runWorkerCallWithRetry. */
        firstTokenTimeoutSecondsOverride?: number;
    }) => Promise<WorkerResult>;
    runAdversary: (params: {
        brief: CrystallisedBrief;
        plan: LeadPlan;
        runtime?: RuntimeSnapshot;
        requester?: string;
        /**
         * beta.67 (Bug B): the persisted branch fork-point sha to diff the review
         * against (`git diff <baseSha>..HEAD`). When set, the adversary sees ONLY
         * the branch's own commits; when omitted, the implementation falls back to
         * the default base branch name (prior behaviour).
         */
        baseSha?: string;
        /**
         * beta.69 (F3): the prior cycle's review, so the adversary is told which
         * findings the worker already attempted (prompt) and the verdict gate can
         * treat recycled findings as non-new (they cannot sustain a `revise`).
         */
        priorFindings?: ReviewFinding[];
    }) => Promise<ReviewReport>;
    fetchRuntime?: (params: {
        plan: LeadPlan;
        sessionId: string;
    }) => Promise<RuntimeSnapshot | undefined>;
    pushBranchAndOpenPr: (params: {
        plan: LeadPlan;
        brief: CrystallisedBrief;
        reviewReport: ReviewReport;
        requester?: string;
    }) => Promise<string>;
    /** Signal source: user Slack reactions on our messages. */
    readReactions: (sessionId: string) => Promise<{
        shipIt: boolean;
        abort: boolean;
        pause: boolean;
        budgetBump: boolean;
    }>;
    reportProgress?: (sessionId: string, status: LoopStatus, meta?: unknown) => Promise<void>;
    /**
     * beta.77: harness-native OUTBOUND progress/terminal delivery. Fired from
     * `setStatus` on EVERY phase + terminal transition (the single choke point).
     * The implementation (index.ts) best-effort direct-posts the current
     * `harness_progress` headline to Slack via a vault-resolved bot token WHEN the
     * session has a real Slack binding -- an INDEPENDENT path from the wedge-prone
     * agent `api.sendMessage` turn. Fire-and-forget; the loop stays Slack-agnostic
     * (no Slack import here) and a throw here can NEVER escape `setStatus`.
     * Clarifications/inbound stay agent-mediated (`harness_answer`) -- unchanged.
     */
    deliverProgress?: (sessionId: string, status: LoopStatus) => void;
    /**
     * beta.78 (Feature 1+2): harness-native OUTBOUND ad-hoc warning delivery.
     * Same independent direct-post channel as `deliverProgress` (vault bot token,
     * gated on a real Slack binding), but for an arbitrary one-line warning
     * (soft session-budget breach; daily-cap hit). Fire-and-forget, best-effort,
     * never throws. Loop stays Slack-agnostic (no Slack import); a no-op when
     * there is no poster or no real binding (agent-orchestrated runs).
     */
    postWarning?: (sessionId: string, text: string) => void;
    /**
     * beta.8 fix #1 (done right): HARNESS-SIDE observable-side-effect probes.
     * The loop builds a VerifyProbes for a given plan/branch/worktree and runs
     * the inferred contract AFTER each sub-task, independent of the worker's
     * SDK stop reason. This is what actually catches a confabulated "I pushed"
     * / "I opened a PR" -- the harness hits git / the provider API itself.
     *
     * Optional so existing test doubles that don't exercise verification keep
     * working; when absent, verification is skipped (SDK signal trusted).
     */
    buildVerifyProbes?: (params: {
        plan: LeadPlan;
        requester: string;
        worktreePath: string;
        baseSha: string;
    }) => VerifyProbes;
    /**
     * beta.63 (convention-awareness Fix 2): injectable check-script runner used by
     * the final-verify convention-check pass. Defaults to `npm run <name>`
     * (spawnSync) inside the worktree. Injected in tests so no real npm process
     * spawns. When absent, {@link runCheckScripts}'s built-in runner is used.
     */
    runCheckScript?: (name: string, cwd: string, timeoutMs: number) => {
        status: number | null;
        stdout: string;
        stderr: string;
        error?: unknown;
        timedOut?: boolean;
    };
    /**
     * beta.115: run the TypeScript compiler WITHOUT the repo's npm script, for
     * when `npm run typecheck` is unrunnable (exit 127) but the compiler itself
     * is reachable -- the b114 state, where CI typechecked the same tree fine
     * via `npx tsc --noEmit`. Returns null when no route exists, which the gate
     * must report as unavailable rather than clean.
     */
    runTypecheckDirect?: (worktree: string, timeoutMs: number) => {
        via: string;
        status: number | null;
        stdout: string;
        stderr: string;
        timedOut?: boolean;
    } | null;
    /** beta.115: evidence about why a check script could not execute, for the audit. */
    diagnoseCheckEnv?: (worktree: string) => Record<string, unknown>;
    /** Read the current HEAD sha of a worktree (for commit_made verification). */
    worktreeHeadSha?: (worktreePath: string) => Promise<string>;
    /**
     * beta.67 (Bug B): compute the branch FORK-POINT sha -- the merge-base of the
     * default base branch and HEAD in the worktree. Captured once at plan_ready
     * and persisted on the session (sessions.plan_base_sha) so the adversary
     * review diffs `git diff <plan_base_sha>..HEAD` (branch-only commits) instead
     * of against main-at-review-time (which accumulates unrelated history and
     * caused beta.66 smoke #4's false-positive revise). Optional; when absent the
     * fork-point is not captured and the adversary falls back to the base-branch
     * name (prior behaviour).
     */
    worktreeMergeBase?: (worktreePath: string, baseBranch: string) => Promise<string>;
    /**
     * beta.67 (Bug B): count commits in `<base>..HEAD` in the worktree, used only
     * for the cheap loop.adversary_diff_base sanity log (warn when the branch
     * has suspiciously many commits vs the plan's sub-task count). Optional.
     */
    worktreeCommitCount?: (worktreePath: string, base: string) => Promise<number>;
    /**
     * beta.101: of `shas`, which are NOT reachable from `from`? Powers the
     * ledger-reachability guard that refuses to review or ship a branch which has
     * lost commits this run already recorded (see ./ledger-integrity.ts).
     * Optional; when absent the guard is skipped (fails open).
     */
    unreachableCommits?: (worktreePath: string, from: string, shas: string[]) => Promise<string[]>;
    /**
     * beta.101: list the repo's tracked files in the worktree, for plan-time
     * detection of paths the lead invented (see ./plan-path-validate.ts).
     * Optional; when absent the check is skipped.
     */
    listRepoFiles?: (worktreePath: string) => Promise<string[]>;
    /**
     * beta.64 (P0-3/P0-4): `git diff --stat <base>..HEAD` in the worktree, for the
     * best-effort-verify clean-diff check and the scripted-verifier fallback's
     * informational diff. Optional; when absent the clean-diff check treats the
     * diff as unavailable (best-effort verify then declines, conservatively).
     */
    gitDiffStat?: (worktreePath: string, base: string) => Promise<string>;
    /**
     * beta.94 (Feature 1b): files COMMITTED in `<base>..HEAD` in the worktree
     * (`git log <base>..HEAD --name-only`). Wraps GitAdapter.listCommittedFiles.
     * Used by the deterministic final-scope check to compare committed files
     * against the union of declared per-sub-task scopes. Optional; when absent the
     * scope check is skipped (no finding). Injected in tests.
     */
    worktreeCommittedFiles?: (worktreePath: string, base: string) => Promise<string[]>;
    /**
     * beta.64 (P0-4): run `npx tsc --noEmit` in the worktree for the scripted
     * verifier fallback. Returns `{ ok, output }` (ok=true means exit 0). Optional;
     * when absent (or the repo has no tsconfig), the tsc step is skipped and the
     * fallback verdict rests on the allowlisted repo check scripts alone. Injected
     * in tests so no real tsc process spawns.
     */
    runScriptedTsc?: (worktreePath: string, timeoutMs: number) => Promise<{
        ok: boolean;
        output: string;
    }>;
    /**
     * beta.81 (Track B / B2): read the COMBINED GitHub CI status for a pushed
     * commit SHA -- "success" | "failure" | "pending" | "none" (no checks). Wraps
     * getCombinedStatus (github.ts). The post-push CI wait-state polls this until
     * it is not `pending` (or ci.wait_timeout_seconds elapses). Optional; when
     * absent the CI wait is SKIPPED (pre-beta.81 behaviour) and the run ships on
     * the review verdict alone. Injected in tests with a fake status sequence.
     */
    ciCombinedStatus?: (input: {
        repoFullName: string;
        sha: string;
        requester: string;
    }) => Promise<"success" | "failure" | "pending" | "none" | "unknown">;
    /**
     * beta.119: the structured evidence behind the CI verdict (counts of check
     * runs seen / running / failed, and whether each API was readable at all).
     * `pollCiStatus` prefers this over `ciCombinedStatus` because a single bare
     * verdict cannot express "the check list SHRANK since the last poll", which
     * is what the b118 false-green needed to be caught. Optional; when absent the
     * loop falls back to the bare status and skips the high-water-mark rule.
     */
    ciSnapshot?: (input: {
        repoFullName: string;
        sha: string;
        requester: string;
    }) => Promise<{
        state: "success" | "failure" | "pending" | "none" | "unknown";
        checkTotal: number;
        checksReadable: boolean;
        statusReadable: boolean;
        reason: string;
        /**
         * beta.124: non-empty when the read failed for a reason waiting will not
         * fix (401/403/404), carrying the remedy rather than the status code.
         * Optional so an older or hand-rolled snapshot source still type-checks;
         * absent simply means "keep polling", the pre-b124 behaviour.
         */
        permanentDenial?: string;
        /**
         * beta.125: which endpoint the check counts came from. `workflow_runs`
         * means the Checks API was denied and the Actions fallback answered
         * instead -- a real verdict over everything Actions ran, blind to any
         * third-party GitHub App check run. Absent is treated as `check_runs`.
         */
        checksSource?: "check_runs" | "workflow_runs" | "";
    }>;
    /**
     * beta.81 (Track B / B2): on CI `failure`, fetch a short excerpt of the
     * failing check-run logs so they can be surfaced as the revise finding
     * source. Optional; when absent the failure is surfaced without log detail.
     */
    ciFailingLogs?: (input: {
        repoFullName: string;
        sha: string;
        requester: string;
    }) => Promise<string>;
    /**
     * beta.119: can the token routed to this repo push GitHub Actions workflow
     * files? `true`/`false` when GitHub reported the token's scopes, `null` when
     * it did not (fine-grained PATs and App tokens report none, and are capable).
     * Only a definite `false` stops a run. Optional; absent disables the check.
     */
    tokenScopes?: (input: {
        repoFullName: string;
        requester: string;
    }) => Promise<boolean | null>;
    /**
     * beta.81 (Track B / B3): when a repo has NO CI (`ciCombinedStatus === "none"`),
     * AUTHOR a `.github/workflows/*.yml` running the repo's declared check
     * scripts (detected from package.json: typecheck/lint/test/build) in the
     * worktree so CI runs on GitHub. Returns the workflow path written (relative)
     * or null if nothing to author (no package.json / no runnable scripts).
     * Carel: no local fallback ever -- build the CI instead. Optional; when
     * absent B3 is skipped. Injected in tests (no real fs write).
     */
    ciAuthorWorkflow?: (input: {
        worktreePath: string;
    }) => Promise<{
        path: string;
        scripts: string[];
    } | null>;
    /**
     * beta.16 fix #3 + beta.17 correctness: release the per-session git
     * worktree on terminal transitions (`loop.shipped`, `loop.aborted`, hard
     * failure). Prior to beta.16 the worktree stayed live until the PR
     * closed/merged (via the pr-watcher).
     *
     * beta.17 change: now returns `{ok, path, error?}` and takes an explicit
     * `worktreePath` (looked up from the sessions row) rather than relying
     * on `sessionId` reconstruction. Beta.16's `git.release(sessionId, repo)`
     * silently no-op'd because the allocator uses `pending-<Date.now()>` on-
     * disk ids, not DB session UUIDs. Callers must pass `worktreePath`.
     *
     * Optional for back-compat with tests that stub the orchestrator; when
     * absent the pr-watcher's release-on-close remains as a safety net.
     */
    releaseWorktree?: (params: {
        sessionId: string;
        repoFullName: string;
        worktreePath: string;
        reason: "shipped" | "aborted" | "failed";
    }) => Promise<{
        ok: boolean;
        path?: string;
        error?: string;
    }>;
    /**
     * beta.117: lifecycle for one parallel-worker slot checkout.
     *
     * Only consulted when effective concurrency exceeds 1, so a serial run --
     * still the default -- never allocates a slot and behaves exactly as it did
     * before b117. Optional so the many tests that stub the orchestrator do not
     * all have to grow a git implementation.
     */
    allocatePooledWorktree?: (params: {
        sessionId: string;
        repoFullName: string;
        sessionBranch: string;
        slotBranch: string;
        slot: number;
    }) => Promise<string>;
    resetPooledWorktree?: (worktreePath: string, sha: string) => Promise<void>;
    releasePooledWorktree?: (params: {
        repoFullName: string;
        worktreePath: string;
        slotBranch: string;
    }) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** `git -C <cwd> <args>`, rejecting on non-zero exit. Used for merge-back. */
    gitRun?: (cwd: string, args: string[]) => Promise<string>;
}
/**
 * beta.97 (Fix #7): is the adversary finding count CONVERGING across cycles?
 *
 * Convergence = the run was making real progress toward a clean pass but ran
 * out of cycle budget, so an operator should be TOLD it's worth extending
 * (re-run harness_revise) rather than shown a bare do_not_merge. We require
 * BOTH: (a) at least two cycles of signal, and (b) a NET downward trend from
 * the first cycle to the last (last < first). A late bump (e.g. 13 -> 8 -> 12,
 * where cycle-3 fixes added new review surface) still counts as converging so
 * long as the run ended below where it started -- that late bump is exactly the
 * "new code introduced new findings" case where one more cycle plausibly clears
 * it. A flat or net-rising arc (e.g. 8 -> 9 -> 11) is NOT converging: extending
 * would likely just churn, so the plain do_not_merge stands.
 *
 * Pure + unit-tested. Empty/single-cycle input returns false (no signal).
 */
export declare function isConvergingFindingTrend(counts: number[] | undefined): boolean;
/**
 * beta.119: is the run converging hard enough to be worth BUYING another cycle?
 *
 * Deliberately stricter than `isConvergingFindingTrend`, and measured on a
 * different quantity. That predicate drives an advisory note, so it is
 * generous on purpose -- its own doc cites 13 -> 8 -> 12 as converging, on the
 * grounds that a late bump is "new code introduced new findings". Fine for a
 * sentence on a PR; not a basis for spending several dollars and ten minutes.
 *
 * It also counts the wrong things. TOTAL findings include the `info` notes the
 * adversary emits to record that a PRIOR finding was fixed, so the number can
 * rise precisely BECAUSE the run is succeeding. b118's totals went 16 -> 8 -> 9
 * and that final rise is mostly bookkeeping; its BLOCKING counts went 9 -> 5 ->
 * 4, monotonically down. Blocking findings are also the only ones that keep the
 * PR from merging, so they are what another cycle would be buying.
 *
 * Requires: something still blocking (otherwise the run ships anyway), a net
 * improvement over the run, and no regression in the latest cycle -- a run that
 * just went backwards has not earned another turn.
 */
export declare function isConvergingBlockingTrend(blocking: number[] | undefined): boolean;
export declare class OrchestratorLoop {
    private readonly deps;
    /**
     * beta.117: serialises merge-back into the session worktree. One per loop
     * instance, which is one per process -- the only worktree it guards.
     */
    private readonly mergeBackMutex;
    constructor(deps: OrchestratorDeps);
    /**
     * Pure state-transition rule (unit-tested).
     */
    static advance(input: {
        currentStatus: LoopStatus;
        verdict?: "pass" | "revise" | "block";
        cyclesRan: number;
        maxCycles: number;
        /** beta.97 (Fix #7): per-cycle adversary finding counts, in cycle order. */
        findingCountsByCycle?: number[];
        reactions: {
            shipIt: boolean;
            abort: boolean;
            pause: boolean;
        };
        budgetExhausted: boolean;
        hardTimeout: boolean;
        /**
         * beta.109: findings in this review that are diff-addressable AND at medium
         * severity or above, per isBlockingFinding. Undefined disables the gate.
         */
        blockingFindings?: number;
        /** beta.109: `loop.ship_when_no_blocking_findings`, default on. */
        shipWhenNoBlockingFindings?: boolean;
        /**
         * beta.119: per-cycle BLOCKING finding counts, in cycle order. Drives the
         * cycle extension. Deliberately not `findingCountsByCycle`, which includes
         * the `info` notes the adversary emits to record prior fixes and so can
         * rise because a run is succeeding.
         */
        blockingCountsByCycle?: number[];
        /** beta.119: extra cycles already granted beyond `maxCycles` this run. */
        cycleExtensionsGranted?: number;
        /** beta.119: `loop.max_cycle_extensions`. 0 disables extension entirely. */
        maxCycleExtensions?: number;
        /**
         * beta.119: whether the remaining budget comfortably covers another cycle.
         * The caller computes it from real per-cycle spend; an extension must never
         * be the thing that runs a session out of money.
         */
        budgetHeadroomOk?: boolean;
        /**
         * beta.120 (fix 4): true when too little wall clock remains to run another
         * cycle AND still push. Stops revising and lands what exists.
         */
        shipTimeReserved?: boolean;
    }): {
        nextStatus: LoopStatus;
        reason: string;
    };
    private setStatus;
    /**
     * beta.63 (Part A): mark forward progress WITHOUT a status change (e.g. a
     * sub-task started/completed, review started, push done). Bumps
     * last_progress_at so the watchdog sees liveness inside a long phase, and
     * logs a progress breadcrumb to the interaction log.
     */
    private markProgress;
    /**
     * beta.90 (Feature 2): build the stream-slow liveness callback for a worker
     * dispatch. When the SDK stream opens then goes idle past the threshold, this
     * (1) emits `loop.worker_stream_slow` for the audit trail and (2) bumps the
     * session liveness heartbeat (last_progress_at, the beta.63 column the stall
     * watchdog reads) so harness_progress surfaces "worker stream idle Ns" rather
     * than the phase looking wedged. Best-effort + throw-guarded: this is pure
     * observability and must NEVER disturb the worker call.
     */
    private makeStreamSlowCallback;
    /**
     * beta.94 (Feature 2): the idle-no-work conjunction handler. Confirms the
     * sub-task produced NO worktree writes (committed OR working-tree changes)
     * since the sub-task base, then emits `loop.worker_idle_no_work`
     * (LOG-ONLY by default). When loop.worker_idle_abort_enabled is true it ALSO
     * calls onIdleAbort() to abort the sub-task via the existing
     * WorkerTimeoutError / {outcome:'timeout'} terminal path (worktree preserved).
     * Never throws.
     */
    private handleWorkerIdleNoWork;
    private checkpoint;
    private addCost;
    private saveReview;
    /**
     * beta.38: re-entrancy guard. If a loop for this session is already running
     * in this process (plugin re-register mid-run), do NOT start a second one --
     * that races the live loop's worktree and kills the run. Return a distinct
     * `skipped_already_running` outcome so callers (recovery) can log-and-move-on.
     * The guard is registered/cleared here so EVERY entry path (fresh run and
     * recovery auto-resume both call `run()`) is covered and can't be forgotten.
     */
    /**
     * beta.117: bring one parallel worker's commits onto the session branch.
     *
     * Serialised across the whole loop instance by {@link mergeBackMutex}: git
     * will not take two concurrent index operations in one worktree, and a lock
     * turns that race into a queue.
     *
     * A conflict here is the mechanism working, not a bug. Two workers writing
     * the same file that neither declared used to corrupt each other invisibly in
     * the shared worktree; now it surfaces as a named conflict against a specific
     * sub-task. The sub-task is marked failed so the cycle's own machinery
     * re-runs it -- by which point the other worker's change is already on the
     * branch, so the retry sees it and adapts.
     */
    private mergeBackSlot;
    run(sessionId: string, brief: CrystallisedBrief): Promise<LoopOutcome>;
    /**
     * beta.57 (P1): sessions whose loop THIS OrchestratorLoop instance is
     * currently driving. The module-scoped `runningSessions` registry is shared
     * across runtimes (it deliberately survives a plugin re-register), so a
     * teardown that drains on it waits for OTHER runtimes' loops too -- on a
     * re-register churn the doomed runtime could block up to
     * teardown_drain_seconds for a session it does not own and whose DB handle
     * it is not holding. Teardown should drain only on sessions it owns.
     */
    private readonly ownedSessions;
    ownedRunningSessionIds(): string[];
    /**
     * beta.60: instance accessor for the module-level re-entrancy guard set (all
     * in-process running loops, across runtime generations). Used by
     * harness_resume force-unstick to REFUSE unsticking a session that still has
     * a live loop-runner tracked -- so we never yank a genuinely-busy loop out
     * from under itself. A session that wedged with a dead executor will NOT be
     * in this set once the stall-watchdog/reclaim cleared its handle (or if the
     * runtime that ran it was torn down), which is exactly when force is safe.
     */
    runningSessionIds(): string[];
    /**
     * beta.42: arm an active stall-watchdog for a session whose re-entry the
     * guard just skipped. After `loop.stall_watchdog_seconds`, re-read the
     * session's progress; if it has NOT advanced past `lastProgressMs` AND the
     * guard entry is still present, the tracked loop is wedged with no external
     * re-entry to reclaim it -- force-deregister the stale handle (so the next
     * recovery/run reclaims it) and emit `loop.wedge_detected`. Idempotent: an
     * existing timer for the session is replaced.
     */
    private armStallWatchdog;
    private runInner;
    /**
     * beta.70 (F5): did THIS observe sub-task already complete cleanly in a
     * PRIOR cycle? Used to skip a redundant observe re-probe on a revise cycle.
     * Returns the prior cycle + status when a `sub_tasks` row exists at the same
     * seq, in an earlier cycle, with a completed/no-change status. Conservative:
     * a prior FAILED observe returns null (we re-run it). Best-effort; on any DB
     * error returns null (never blocks the run).
     */
    private priorObserveCompleted;
    /**
     * beta.16 fix #2: helper for emitting the `loop.subtask_observe_completed`
     * audit breadcrumb. Fires exactly once per observe-mode sub-task terminal
     * success. Payload is intentionally similar to `loop.subtask_verification`
     * so downstream consumers can treat the two events uniformly.
     */
    private emitObserveCompleted;
    /**
     * beta.16 fix #3 + beta.17 telemetry: best-effort worktree release.
     * Called on all terminal transitions (shipped/aborted/failed). Never
     * throws — worktree cleanup failures are logged, audited, and swallowed
     * so they cannot fail an already-terminal session.
     *
     * beta.17: audit payload now carries `{ok, path, error?}` on both the
     * success and failure events so operators can distinguish
     * event-fired-but-nothing-happened from event-fired-and-succeeded.
     * Beta.16's `loop.worktree_released` was a lie on production because
     * the underlying release() silently no-op'd (see releaseByPath docs).
     */
    private tryReleaseWorktree;
    /**
     * Pull the latest verification outcome per sub-task from the audit log,
     * to feed the adversary as local runtime data (beta.7 fix #1).
     */
    /**
     * beta.8: cheap, unconditional final observable check. Independently asks
     * the provider whether the branch exists on origin (the single most
     * important fact: did anything actually reach the remote?). Runs even when
     * the review budget is exhausted, because it costs ~$0 in tokens and is
     * the harness's last line of defence against a confabulated "it shipped".
     * Records loop.cheap_observable_check with the result.
     */
    private runCheapObservableCheck;
    private readLocalVerification;
    /**
     * beta.7 fix #2: project the cost of an upcoming sub-task. Prefer the
     * running median of ACTUAL costs (empirical, per-session), because token
     * estimates from the lead are notoriously optimistic. Fall back to the
     * plan's token estimate via the price table, then to a conservative
     * per-task reserve so we never project zero.
     */
    private estimateSubTaskCost;
    /**
     * beta.7 fix #2: estimate adversary review cost. Reviews scan the whole
     * diff, so cost scales with the work done: use the max observed sub-task
     * cost as a proxy, with a conservative floor.
     */
    private estimateReviewCost;
    /**
     * beta.64 (P0-1 + P0-2): run ONE worker sub-task call bounded by
     * worker_timeout_seconds, emit the sdk_stream_opened / sdk_first_token /
     * sdk_response interaction-log events (P0-1), and RETRY ONCE on a FRESH SDK
     * session when the attempt times out (P0-2). A timeout is either:
     *   - the outer withTimeout throwing WorkerTimeoutError (full-turn worker
     *     timeout), OR
     *   - the inner first-token watchdog returning result.status ===
     *     'first_token_timeout' (stream opened, ZERO tokens -- beta.63 smoke #2).
     * Returns `{outcome:'ok', result}` on a usable turn (even a non-completed
     * end_turn -- the caller's verification handles that), or `{outcome:'timeout',
     * summary, failErr}` when the (possibly retried) call still timed out.
     * `worker_timeout_retry_enabled: false` disables the retry (still audits the
     * timeout). Max 1 retry per sub-task, mirroring the beta.53 env-wait pattern.
     */
    private runWorkerCallWithRetry;
    /**
     * beta.64 (P0-4): SCRIPTED VERIFIER FALLBACK for an observe-mode VERIFY
     * sub-task whose LLM turn timed out. A "run tsc, diff, check scripts" verify
     * step needs no model: run `npx tsc --noEmit`, `git diff --stat <base>..HEAD`,
     * and the allowlisted repo check scripts (reusing the beta.63 discover/run
     * plumbing) deterministically, and report pass/fail as if the sub-task ran.
     * Returns 'pass' (all deterministic checks green), 'fail' (a check failed), or
     * 'unavailable' (feature disabled, or nothing runnable -> caller escalates to
     * best-effort verify). Never throws. Gated by loop.scripted_verify_fallback.
     */
    private tryScriptedVerifyFallback;
    /**
     * beta.64 (P0-3): BEST-EFFORT VERIFY. Honors the beta.60 "Carel must get a
     * reviewable PR" rule. When an observe-mode VERIFY sub-task times out (after
     * the P0-2 retry AND the P0-4 scripted fallback declined/was unavailable),
     * AND the prior mutate sub-task's verify_probe is GREEN, AND git diff-stat
     * shows only expected files touched, do NOT discard the work: push the branch
     * and open the PR flagged merge_recommendation=needs_human_review (reusing the
     * beta.62 graceful-PR machinery), marking the run verify_skipped. Returns true
     * when a graceful PR was opened (run is terminal `done`), false otherwise (the
     * caller falls through to terminal fail). Gated by loop.best_effort_verify.
     * Never throws.
     */
    private tryBestEffortVerify;
    /**
     * beta.81 (Track B / B2 + B3): POST-PUSH CI VERIFICATION WAIT-STATE. After a
     * branch is pushed + the PR opened, CI is the verification spine (Carel:
     * "the harness should just monitor the CI and check for errors"). This polls
     * getCombinedStatus(headSha) every `ci.poll_interval_seconds` until it is not
     * `pending`, up to `ci.wait_timeout_seconds`, and returns one of:
     *   - {outcome:'success'}  -> proceed to ship (caller keeps the PR).
     *   - {outcome:'failure', logs} -> CI red; caller drives a revise / flags the
     *       PR needs_human_review with the failing logs as the finding source.
     *   - {outcome:'timeout'} -> SOFT checkpoint (Carel: not a hard fail): surface
     *       "CI still running after N min on <sha>" + offer a resumable
     *       continue-watching. Caller keeps the PR open (needs_human_review).
     *   - {outcome:'none'} -> repo has NO CI. Caller authors a workflow (B3) --
     *       NEVER a local fallback (Carel: "I do not want it to run locally, ever").
     *   - {outcome:'skipped'} -> ciCombinedStatus dep absent (pre-beta.81 test
     *       doubles / unwired deployments); caller ships on the review verdict.
     * Injected `sleep` (default real setTimeout) keeps tests instant. Never throws
     * -- a status-fetch error is treated as a transient `pending` and re-polled.
     */
    pollCiStatus(input: {
        sessionId: string;
        repoFullName: string;
        sha: string;
        requester: string;
        /**
         * beta.91 (F4): true when the harness AUTHORED + pushed a CI workflow this
         * cycle. A `none` status then means "GitHub has not registered the run
         * YET" (registration lag), NOT "repo has no CI" -- so we grace-poll instead
         * of terminating on poll 1 (the b90 shipped-known-red bug).
         */
        workflowAuthoredThisSession?: boolean;
        sleep?: (ms: number) => Promise<void>;
        now?: () => number;
    }): Promise<{
        outcome: "success";
        degradedSource?: string;
    } | {
        outcome: "failure";
        logs: string;
    } | {
        outcome: "timeout";
        sha: string;
        waitedSeconds: number;
    } | {
        outcome: "none";
    } | {
        outcome: "authored_workflow_never_registered";
        sha: string;
        waitedSeconds: number;
    } | {
        outcome: "indeterminate";
        sha: string;
        waitedSeconds: number;
        reason: string;
    } | {
        outcome: "skipped";
    }>;
    /**
     * beta.63 (convention-awareness Fix 2): run the repo's DECLARED check scripts
     * (from package.json#scripts, gated by verify.check_script_allowlist) inline +
     * blocking in the worktree at the end of a cycle's execution. Returns
     * REVISE-worthy `ReviewFinding[]` for scripts that exited non-zero; unrunnable/
     * timed-out scripts produce a NON-FATAL note (no finding). Never throws.
     * Emits `loop.convention_check_ran` per run and `loop.convention_check_failed`
     * per non-zero exit.
     */
    private runFinalVerifyChecks;
    /**
     * beta.94 (Feature 1b): DETERMINISTIC FINAL SCOPE CHECK. Replaces the
     * idle-prone LLM "final verification of scope boundaries" sub-task (elided in
     * Feature 1a) with a harness-side git check: diff the files COMMITTED in
     * `<plan_base_sha>..HEAD` against the UNION of every sub-task's declared
     * per-file scope (collectDeclaredScopeFiles). A committed file OUTSIDE that
     * union is out-of-scope. This does NOT hard-fail -- it returns a ReviewFinding
     * (dimension `fit`, severity `medium`) so it folds into the adversary review,
     * mirroring runFinalVerifyChecks. Gated by loop.deterministic_final_scope_check
     * (default true). Best-effort, EXCEPT for the beta.110 blowout tripwire,
     * which throws ScopeBlowoutError to stop the cycle before review.
     *
     * Emits `loop.final_scope_check_ran` per run and
     * `loop.final_scope_check_out_of_scope` when out-of-scope files are found.
     */
    /**
     * beta.111: run the repo's OWN typecheck script and block on errors in files
     * this branch changed.
     *
     * Separate from runFinalVerifyChecks, which is gated behind
     * verify.run_repo_check_scripts and stays off by default because running a
     * repo's whole check suite per cycle is expensive. This runs exactly one
     * script and only reports errors it can attribute to this branch, so it is
     * safe to leave on. See typecheck-gate.ts for why the alternative -- diffing
     * against a typecheck at the base commit -- is not worth a second full run.
     *
     * Never throws. A gate that cannot run is a note, not a failure; the one
     * thing it must never do is invent a green.
     */
    private runTypecheckGate;
    private runFinalScopeCheck;
    /**
     * beta.78 (Feature 2): the configured per-user daily hard cap, or 0 when
     * unset/misconfigured. 0 => no daily gate (back-compat: pre-beta.78 configs
     * and test doubles without a `budgets` block behave as before). Defensive.
     */
    private dailyMaxUsd;
    /**
     * beta.78 (Feature 2): a user's spend TODAY from the persistent ledger, or 0
     * if the budget enforcer double doesn't expose getDailySpend (test doubles).
     * Never throws.
     */
    private safeDailySpend;
    /**
     * beta.119: can this run genuinely afford one more execute+review cycle?
     *
     * Gate for the converging-trend cycle extension. "Converging" says another
     * cycle would HELP; this says we can PAY for it, and the two together are
     * what make an automatic extension safe. The estimate comes from this run's
     * own average cycle cost rather than a guess, and is padded, because the
     * failure mode to avoid is an extension that runs a session out of money
     * mid-cycle -- strictly worse than shipping on the ceiling, which at least
     * leaves a reviewable PR.
     *
     * Checked against BOTH the session ceiling and the per-user daily cap, since
     * either can be the binding constraint. Never throws; on any doubt it
     * returns false and the run ships as it did pre-b119.
     */
    private hasBudgetHeadroomForAnotherCycle;
    /**
     * beta.78 (Feature 1+2): daily-AWARE soft session-budget warning. When a
     * run crosses its SOFT session budget, warn the user via Slack (best-effort,
     * direct-post) and FACTOR IN remaining daily headroom -- Carel's ask: "If
     * the user has used 80% of their daily, the soft limit should be aware that
     * there is only 20% left for the day, and notify the user if this might be a
     * bit low and ask for a budget increase." Never throws.
     */
    private warnSessionBudgetSoft;
    /**
     * beta.78 (Feature 2): hard daily-cap notification. Posted when the run is
     * aborted because the user's daily_max_usd would be exceeded. Never throws.
     */
    private warnDailyMaxHit;
    private finaliseAbort;
    /**
     * beta.120 (fix 1, CRITICAL): an abort must never destroy work.
     *
     * WHAT HAPPENED. The b119 take-2 smoke ran 121.6 minutes against a 120-minute
     * `session_hard_timeout_seconds`. At the cycle-3 review boundary the deadline
     * had passed, `advance` returned `aborted/hard_timeout`, and `finaliseAbort`
     * scheduled a worktree release. Gone: 27 commits, 15 files, ~1,900 lines, a
     * clean typecheck and a converging review (14 -> 10 -> 8 findings). The work
     * was recoverable only because git had not yet GC'd the objects in a cached
     * clone. Nothing about that was by design.
     *
     * THE RULE. A resource ceiling is not a verdict on the code. Hitting one means
     * "stop spending", not "throw it away". So:
     *
     *   - resource aborts (timeout / budget / daily cap) SHIP what they have, as
     *     a needs_human_review PR -- exactly what `finaliseStalled` has always
     *     done for a stalled-but-committed branch;
     *   - a USER abort does not open a PR (they said stop), but still preserves
     *     the worktree when commits exist;
     *   - only an abort with genuinely nothing committed releases the worktree,
     *     and it says so in the audit.
     *
     * Never throws: on any failure the worktree is preserved, which is the safe
     * direction.
     */
    private finaliseAbortSalvaging;
    /**
     * beta.120: does this aborting session have commits worth protecting? Mirrors
     * the stall path's probe. Fails CLOSED -- any doubt reports "yes", because a
     * false positive costs a preserved directory and a false negative costs the
     * work.
     */
    private abortHasSalvageableCommits;
    /**
     * beta.129: pause at the review boundary, ask the operator to buy more wall
     * clock, and wait IN PLACE for the answer. Returns the seconds granted, or 0
     * for a decline, an unreadable reply, or silence.
     *
     * Waiting in place rather than returning through `finaliseAwaitingClarification`
     * is the whole trick. That path resumes via a fresh `loop.run`, which re-plans
     * from scratch -- another lead call, and a plan that need not match the one
     * the existing commits were written against. Polling the answer column keeps
     * the cycle counter, the findings history, the worktree and the deadline
     * arithmetic exactly where they are.
     *
     * beta.132: the price of waiting in place is that the question dies with the
     * process holding it, and b129 had no way to notice -- `harness_answer` read
     * the wait window as proof of life and told session 2b4c1d33's operator the
     * run would pick their answer up. It had already exited. Hence the
     * heartbeat: every tick below stamps the row, and an answer arriving to a
     * stale one finishes the ship rather than being promised to nobody.
     */
    private askForTimeExtension;
    /**
     * beta.130: persist an extended wall clock so a crash-recovery or a later
     * resume honours what the operator granted instead of reverting to the
     * default and guillotining the run a second time.
     */
    /**
     * beta.132: say "I am still here" on the row the operator's answer lands on.
     *
     * Best-effort by design. A failed stamp reads as a dead listener, which
     * costs the run its time extension and ships an honest do-not-merge PR --
     * where the alternative, assuming life, strands the work. This is the safe
     * direction to fail in.
     */
    private stampClarificationHeartbeat;
    private persistExtendedDeadline;
    /**
     * beta.131: give an unroutable CI failure somebody to belong to.
     *
     * b127 folds CI findings into the review and lets the deterministic router
     * hand each one to whoever owns its file. That is the right design and it
     * works -- when the finding HAS a file. When it does not, the finding becomes
     * a mapping miss and is broadcast to every sub-task as context, which sounds
     * like the safe default and is not: session 03a8a7b6 bought a repair cycle
     * for `file: null, adoptedBySeq: null`, re-ran all seven sub-tasks against
     * the adversary's opinions for about $3, and left CI red on the same
     * assertion. The audit said "1 CI finding(s), unrouted" twice and spent the
     * cycle anyway.
     *
     * So an unroutable failure gets its own sub-task instead of everyone's
     * peripheral vision. It carries the raw failing output and declares no file
     * scope, which is what "may touch any file" means here -- there is no
     * pre-commit contract gate, and an empty `filesLikelyTouched` is the one
     * value revise-scoping will never skip.
     *
     * Only for findings with no file. One that names a path already has an owner
     * with the context to fix it, and a fresh worker starting cold is worse.
     */
    private addCiRepairSubTask;
    /** beta.129: the branch fork-point captured at plan_ready, or "" when absent. */
    private planBaseSha;
    /**
     * beta.16 fix #3 + beta.17 correctness: schedule a best-effort worktree
     * release for a session that has already reached a terminal status.
     * Looks up both `repo` and `worktree_path` from the sessions row so the
     * release call gets the actual on-disk path (not a reconstruction).
     * Never throws.
     */
    private scheduleWorktreeReleaseForSession;
    /**
     * beta.16 fix #3: build a `LoopOutcome` for a hard-failed session and
     * release the worktree. Centralises the six failure-return sites so we
     * cannot forget to release the worktree on new failure paths.
     */
    private finaliseFailed;
    /**
     * beta.62 (fix #3): terminal-fail a session WITHOUT releasing the worktree,
     * so the on-disk commit chain stays inspectable. Used for a review CRASH
     * that could NOT be salvaged into a graceful PR (e.g. a cycle-1 crash with
     * no prior review, a non-green self-verify, or the graceful push itself
     * failed). The b60-attempt-2 failure discarded 8 good commits precisely
     * because the crash path released the worktree; preserving it means a human
     * can `git log`/push the branch manually even when the harness couldn't.
     */
    private finaliseFailedPreserveWorktree;
    /**
     * beta.63 (Part A): the LATE-STAGE STALL WATCHDOG.
     *
     * Origin: the b60 record-depth run got ~7 sub-tasks deep, hit a live
     * env-wait-retry, then the loop STOPPED EMITTING with the session still
     * `executing` and no terminal event -- for ~2 days -- until a container
     * restart cleared it. beta.42 bound the re-entrancy guard, beta.60 bound the
     * whole `runOne`; this binds the SESSION as a whole (and the finalize phase
     * specifically), which those two do not cover.
     *
     * For every non-terminal executing/reviewing session whose last_progress_at
     * froze past `loop.session_stall_seconds`, it:
     *   1. emits a LOUD `loop.session_stalled {phase, msSinceProgress}` (logger +
     *      audit + interaction log);
     *   2. attempts bounded self-recovery -- if NO live loop-runner owns the
     *      session (dead executor), re-tick the loop-runner (reuse resume
     *      machinery: re-drive `run()` from the crystallised brief); if a live
     *      runner IS present the session is genuinely busy -> leave it alone;
     *   3. if unrecoverable AND `stall_auto_terminal` is on, transition to a
     *      terminal `failed`(reason=stalled_no_progress) PRESERVING the worktree,
     *      and -- when the branch already has commits and `stall_graceful_pr` is
     *      on -- attempt a graceful push+PR flagged needs_human_review (beta.62
     *      pattern) so a 95%-done deliverable is not evaporated the way b60 was.
     *
     * Idempotent + never throws. Safe to call from a gateway tick / maintenance
     * cycle / interval. Returns the list of stalls handled (for tests + telemetry).
     */
    checkStalls(now?: number): Promise<Array<{
        sessionId: string;
        phase: string;
        msSinceProgress: number;
        action: string;
    }>>;
    /**
     * beta.67 (Bug A): EXTERNAL stall-sweep entry point.
     *
     * Origin: beta.66 smoke #4 -- the loop-runner PROCESS died between a
     * worker's sdk_response and the next handler step. The session record stayed
     * `status=executing` forever; `ps` showed no live process. beta.63's
     * in-process `checkStalls` watchdog CANNOT fire in this case: a dead process
     * cannot watchdog its own death. Also `harness_cancel` set a `reactions_json.
     * abort` flag that the dead loop never consumed, so the session never
     * reached a terminal status.
     *
     * This method is meant to be called by the EXTERNAL periodic `stall-sweep`
     * service (registered in src/index.ts like pr-watcher / retention-nightly),
     * which runs INDEPENDENT of any loop-runner process. On each tick it:
     *
     *   1. runs the EXISTING {@link checkStalls} fast path (detection + bounded
     *      re-tick recovery + auto-terminal transition) -- the external process
     *      is the safety net, checkStalls is still the in-process fast path;
     *   2. ADDITIONALLY reaps sessions that have a pending cancel flag
     *      (`reactions_json.abort`) set but are STILL non-terminal because their
     *      loop is dead (no live loop-runner) -- transitions those to a terminal
     *      `failed` (reason `cancelled_dead_loop`) PRESERVING the worktree
     *      (beta.62 pattern), consuming the cancel the dead loop never did.
     *
     * Covers `executing`, `planning`, and `reviewing` (checkStalls covers only
     * executing/reviewing; a planning session whose loop dies must also be
     * reaped by the cancel path). Idempotent + never throws. Returns a summary
     * for tests + telemetry.
     */
    sweepStalls(now?: number): Promise<{
        ran: boolean;
        recovered: Array<{
            sessionId: string;
            phase: string;
            msSinceProgress: number;
            action: string;
        }>;
        terminated: Array<{
            sessionId: string;
            phase: string;
            reason: string;
        }>;
    }>;
    /**
     * beta.63 (Part A): terminal handling of an UNRECOVERABLE stall. Never
     * evaporate a near-done deliverable: if the branch has commits and
     * `stall_graceful_pr` is on, attempt a graceful push+PR flagged
     * needs_human_review (beta.62 pattern); otherwise fail terminally PRESERVING
     * the worktree so the commit chain stays inspectable on disk. Never throws.
     * Returns a short action string for telemetry.
     */
    private finaliseStalled;
    /** beta.63: read the persisted lead plan JSON for a session (or null). */
    /**
     * beta.101 / beta.105: is every commit this session recorded still reachable
     * from the worktree's HEAD?
     *
     * b101 built this and ran it in ONE place: immediately before the adversary
     * SDK call. The b103 smoke (session b8ece861) showed why that is not enough.
     * A clarification resume moved the branch ref off the run's own work -- eight
     * of ten ledger commits stopped being ancestors of the tip -- and the run then
     * stalled at a second clarification and was aborted. The guard never ran once,
     * because the session never reached review. The loss was found four hours
     * later, by hand, in a post-mortem.
     *
     * So this is now a shared probe with two call sites: at RESUME (right after a
     * re-plan re-allocates the worktree, which is the operation that loses
     * commits) and before REVIEW (unchanged). Extracted rather than duplicated so
     * the two can never drift apart.
     *
     * Fails OPEN on a probe error: an unreachable-commit check that cannot run
     * must not block an otherwise sound run.
     */
    /**
     * beta.108: emit `loop.phase_timing` so every phase of a run is attributable.
     *
     * Deliberately one event shape rather than a bespoke field per phase, so a
     * report can sum `durationMs` grouped by `phase` and have the total match the
     * wall clock. Never throws -- timing must not be able to fail a run.
     */
    private emitPhaseTiming;
    /**
     * beta.109: how many of a review's findings would justify another cycle.
     *
     * Uses isBlockingFinding -- diff-addressable AND medium or above -- so this
     * agrees with the convention-finding gate rather than inventing a second,
     * looser notion of "serious" alongside merge-recommendation's high-and-above
     * BLOCKING_SEVERITIES.
     */
    private countBlockingFindings;
    /**
     * rc.5: the findings that should stop a MERGE -- a real unfixed defect, or the
     * harness reporting it could not verify something. Distinct from
     * `countBlockingFindings`, which asks whether another cycle is worth running.
     * See `blocksMerge`.
     */
    private mergeBlockingFindings;
    /**
     * beta.122: the most recent commit this session is known to have made, or
     * undefined when it has made none.
     *
     * Feeds the allocator's re-attach path. The b121 smoke lost two commits
     * because a resume could not find the branch by name and reset to base; the
     * ledger knew the tip the whole time, so a rename can no longer cost the
     * work even when it happens.
     */
    lastLedgerCommitSha(sessionId: string): string | undefined;
    /**
     * The commits this session has recorded, oldest first. Shared by the
     * reachability guard and the allocator's re-attach so the two can never
     * disagree about what "this session's work" means.
     */
    private readLedgerCommits;
    private checkLedgerReachability;
    private getPlanJson;
    /**
     * rc.3: the one rule the three salvage paths share -- has an adversary ever
     * reviewed this session's code at all?
     *
     * The harness advertises that nothing is pushed until the adversary passes.
     * That was not strictly true. Three paths reached `pushBranchAndOpenPr` after
     * synthesising a placeholder `revise` report for a session where no review had
     * EVER run: `tryBestEffortVerify` (the verify sub-task timed out),
     * `finaliseAbortSalvaging` (a budget or time ceiling), and
     * `finaliseReviewCrash` (an infra error, which beta.90 deliberately let
     * through on cycle 1). Each stamped the PR `needs_human_review`, which is a
     * real mitigation but is body text on a PR -- it relies on a human reading it.
     *
     * Where a PRIOR review exists, shipping with that stamp is still a defensible
     * trade: something adversarial did look at this code, and losing the work has
     * a cost too. Where NOTHING has reviewed it, the trade is not available, so
     * these paths now preserve the worktree instead. The commits survive on disk
     * and stay resumable; only the push is refused.
     */
    private hasBeenReviewed;
    /**
     * rc.3: audit a refused salvage push. Returns true when the caller must NOT
     * push, so every call site reads as `if (this.refuseUnreviewedSalvage(...))`.
     */
    private refuseUnreviewedSalvage;
    /** beta.63: read the most recent completed review for a session (or undefined). */
    private getLastReview;
    /**
     * beta.62 (fix #2/#3): handle an adversary-review CRASH. The completed,
     * self-verified sub-task work must not be silently discarded (the
     * b60-attempt-2 failure). GRACEFUL PATH -- when all of:
     *   - `graceful_pr_on_review_crash` is not disabled, AND
     *   - a PRIOR cycle already produced a completed adversary review
     *     (`priorReview`), AND
     *   - this cycle's own sub-task self-verification is fully GREEN (the latest
     *     verification for every sub-task passed),
     * open the PR anyway with `merge_recommendation = 'needs_human_review'` so a
     * human can inspect the adversary-motivated commits. The harness_merge_pr
     * hard gate refuses `needs_human_review` (never auto-overridable), so this
     * cannot silently ship unverified code -- it just preserves the deliverable.
     * OTHERWISE fail terminally but PRESERVE the worktree (fix #3) so the branch
     * remains inspectable on disk. Never throws.
     *
     * beta.90 (Feature 1): an INFRASTRUCTURE crash (out of disk / memory / IO /
     * transport -- see infra-crash.ts) with GREEN self-verify is ALSO eligible,
     * WITHOUT requiring cycle>=2 or a prior review, because it is an environment
     * failure that says nothing about the code. When there is no prior review to
     * ship, a minimal `revise` review is synthesized so the graceful PR still
     * opens flagged needs_human_review.
     */
    private finaliseReviewCrash;
    /**
     * beta.55 (B2): pause the session for a human decision. Persists the
     * question + the paused sub-task seq and sets status `awaiting_clarification`.
     * CRITICAL: does NOT release the worktree (unlike finaliseFailed/Abort) so
     * harness_answer can re-drive the loop from the paused seq in place. The
     * worktree-heal protect set (beta.45) + recovery both treat
     * `awaiting_clarification` as resumable, so a stray re-register or restart
     * won't reap the worktree or auto-fail the pause.
     */
    private finaliseAwaitingClarification;
}
/**
 * beta.63 (Part A/B): map a loop status to the interaction-log phase
 * classification. Kept a free function so it is importable by tests.
 */
export declare function mapPhase(status: LoopStatus): InteractionPhase;
/**
 * Kahn's-algorithm topological sort of sub-tasks by `dependsOn`.
 * Stable: preserves original seq order among independent tasks.
 * Throws on cycles.
 */
export declare function topoSortSubTasks(subTasks: LeadPlanSubTask[]): LeadPlanSubTask[];
//# sourceMappingURL=loop.d.ts.map