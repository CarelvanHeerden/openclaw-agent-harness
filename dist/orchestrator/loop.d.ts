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
};
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
     * beta.16 fix #3: release the per-session git worktree on terminal
     * transitions (`loop.shipped`, `loop.aborted`, hard failure). Prior to
     * beta.16 the worktree stayed live until the PR closed/merged (via the
     * pr-watcher), which meant every successful smoke left a `pending-<ts>`
     * worktree holding the smoke branch, and subsequent fetches on that
     * branch failed with `refusing to fetch into branch checked out at ...`.
     * Optional for back-compat with tests that stub the orchestrator; when
     * absent the loop falls back to the pr-watcher's release-on-close path.
     */
    releaseWorktree?: (params: {
        sessionId: string;
        repoFullName: string;
        reason: "shipped" | "aborted" | "failed";
    }) => Promise<void>;
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
    run(sessionId: string, brief: CrystallisedBrief): Promise<LoopOutcome>;
    /**
     * beta.16 fix #2: helper for emitting the `loop.subtask_observe_completed`
     * audit breadcrumb. Fires exactly once per observe-mode sub-task terminal
     * success. Payload is intentionally similar to `loop.subtask_verification`
     * so downstream consumers can treat the two events uniformly.
     */
    private emitObserveCompleted;
    /**
     * beta.16 fix #3: best-effort worktree release. Called on all terminal
     * transitions (shipped/aborted/failed). Never throws — worktree cleanup
     * failures are logged and swallowed so they cannot fail an already-
     * terminal session. The pr-watcher's release-on-close is still a safety
     * net for the rare case where release() here errors.
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
     * beta.16 fix #3: schedule a best-effort worktree release for a session
     * that has already reached a terminal status. Looks up the repo from the
     * sessions row (worktreePath is per-session, so we only need the repo
     * full name to route to the right bare clone). Never throws.
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