/**
 * Orchestrator loop.
 *
 * The core state machine. Given a session id (already row-inserted with a
 * crystallised prompt + brief), it walks:
 *
 *   crystallising -> planning -> executing -> reviewing -> {done|revise}
 *
 * Up to `config.loop.max_cycles` cycles of executing+reviewing. Early exits:
 *   - Adversary verdict "pass"
 *   - User ship-it reaction
 *   - User abort reaction
 *   - Session budget breached
 *   - Session hard timeout
 *
 * The loop is deliberately structured as pure decision helpers + an outer
 * driver, so `advance()` can be unit-tested standalone.
 */
import type { HarnessConfig } from "../config.js";
import type { BudgetEnforcer } from "../budgets/enforcer.js";
import type { PatRouter } from "../auth/pat-router.js";
import type { StateStore } from "../state/store.js";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
import type { LeadPlan, LeadPlanSubTask } from "./fable5-lead.js";
import type { ReviewReport } from "./fable5-adversary.js";
import type { WorkerResult } from "./sonnet-worker.js";
import type { RuntimeSnapshot } from "../vercel/logs.js";
import { type VerifyProbes } from "./verify.js";
export type LoopStatus = "crystallising" | "planning" | "executing" | "reviewing" | "done" | "failed" | "aborted";
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
};
/** beta.53: true when the worker awaited a non-existent env/monitor event. */
export declare function matchesEnvWaitHallucination(text: string): boolean;
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
export declare class WorkerTimeoutError extends Error {
    readonly seconds: number;
    constructor(seconds: number);
}
export declare function withTimeout<T>(p: Promise<T>, seconds: number): Promise<T>;
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
     * Injected work-doers. Real impls in src/adapters + src/vercel.
     *
     * `requester` is the session's Slack user id, threaded through so PAT
     * resolution can select THAT user's token (multi-user auth), rather than
     * defaulting to the first authorised user. Optional for back-compat with
     * test doubles that ignore it.
     */
    runLead: (brief: CrystallisedBrief, ctx?: {
        requester?: string;
    }) => Promise<LeadPlan>;
    runWorker: (params: {
        brief: CrystallisedBrief;
        subTask: LeadPlanSubTask;
        plan: LeadPlan;
        resumeSessionId?: string;
        requester?: string;
        /** beta.53 (P1b): corrective dispatch context appended on a retry. */
        dispatchHint?: string;
    }) => Promise<WorkerResult>;
    runAdversary: (params: {
        brief: CrystallisedBrief;
        plan: LeadPlan;
        runtime?: RuntimeSnapshot;
        requester?: string;
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
    /** Read the current HEAD sha of a worktree (for commit_made verification). */
    worktreeHeadSha?: (worktreePath: string) => Promise<string>;
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
}
export declare class OrchestratorLoop {
    private readonly deps;
    constructor(deps: OrchestratorDeps);
    /**
     * Pure state-transition rule (unit-tested).
     */
    static advance(input: {
        currentStatus: LoopStatus;
        verdict?: "pass" | "revise" | "block";
        cyclesRan: number;
        maxCycles: number;
        reactions: {
            shipIt: boolean;
            abort: boolean;
            pause: boolean;
        };
        budgetExhausted: boolean;
        hardTimeout: boolean;
    }): {
        nextStatus: LoopStatus;
        reason: string;
    };
    private setStatus;
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
    run(sessionId: string, brief: CrystallisedBrief): Promise<LoopOutcome>;
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
    private finaliseAbort;
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
}
/**
 * Kahn's-algorithm topological sort of sub-tasks by `dependsOn`.
 * Stable: preserves original seq order among independent tasks.
 * Throws on cycles.
 */
export declare function topoSortSubTasks(subTasks: LeadPlanSubTask[]): LeadPlanSubTask[];
//# sourceMappingURL=loop.d.ts.map