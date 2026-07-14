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
    /** Injected work-doers. Real impls in src/adapters + src/vercel. */
    runLead: (brief: CrystallisedBrief) => Promise<LeadPlan>;
    runWorker: (params: {
        brief: CrystallisedBrief;
        subTask: LeadPlanSubTask;
        plan: LeadPlan;
        resumeSessionId?: string;
    }) => Promise<WorkerResult>;
    runAdversary: (params: {
        brief: CrystallisedBrief;
        plan: LeadPlan;
        runtime?: RuntimeSnapshot;
    }) => Promise<ReviewReport>;
    fetchRuntime?: (params: {
        plan: LeadPlan;
        sessionId: string;
    }) => Promise<RuntimeSnapshot | undefined>;
    pushBranchAndOpenPr: (params: {
        plan: LeadPlan;
        brief: CrystallisedBrief;
        reviewReport: ReviewReport;
    }) => Promise<string>;
    /** Signal source: user Slack reactions on our messages. */
    readReactions: (sessionId: string) => Promise<{
        shipIt: boolean;
        abort: boolean;
        pause: boolean;
        budgetBump: boolean;
    }>;
    reportProgress?: (sessionId: string, status: LoopStatus, meta?: unknown) => Promise<void>;
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
    private finaliseAbort;
}
/**
 * Kahn's-algorithm topological sort of sub-tasks by `dependsOn`.
 * Stable: preserves original seq order among independent tasks.
 * Throws on cycles.
 */
export declare function topoSortSubTasks(subTasks: LeadPlanSubTask[]): LeadPlanSubTask[];
//# sourceMappingURL=loop.d.ts.map