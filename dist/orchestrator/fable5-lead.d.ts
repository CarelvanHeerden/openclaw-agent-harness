/**
 * Fable-5 lead.
 *
 * Given a crystallised brief, produces:
 *   - a sub-task decomposition (ordered list of atomic units of work)
 *   - a risk assessment used to size the review effort
 *   - an initial repo/branch plan (repo name, branch name, worktree path)
 *
 * The lead never writes code itself. It only plans and delegates. It also
 * writes a "review checklist" that the adversary consumes on cycle N.
 */
import type { HarnessConfig } from "../config.js";
import type { CrystallisedBrief } from "../crystallise/prompt-refiner.js";
/**
 * Observable side-effect a sub-task is expected to produce. The harness
 * verifies these AFTER the SDK reports `end_turn`, so a worker that
 * confabulates "done" without actually pushing / opening a PR / editing a
 * file is caught and the sub-task is marked `failed` instead of `completed`.
 *
 * beta.7 fix #1: the SDK's stop reason is no longer accepted as ground truth
 * for tasks with observable outputs.
 */
export type SubTaskVerify = {
    kind: "branch_pushed";
    branch?: string;
} | {
    kind: "pr_opened";
} | {
    kind: "file_written";
    path: string;
} | {
    kind: "commit_made";
};
export interface LeadPlanSubTask {
    seq: number;
    title: string;
    intent: string;
    filesLikelyTouched: string[];
    successCriteria: string[];
    estimatedTokens: number;
    dependsOn?: number[];
    /**
     * Observable side-effects to verify after the worker's SDK turn ends.
     * When present and any check fails, the sub-task is FAILED regardless of
     * the SDK stop reason. Absent/empty = trust the SDK signal (pure-reasoning
     * or advisory sub-tasks with no observable output).
     */
    verify?: SubTaskVerify[];
}
export interface LeadPlan {
    repo: string;
    branch: string;
    worktreePath: string;
    subTasks: LeadPlanSubTask[];
    reviewChecklist: string[];
    riskLevel: "low" | "medium" | "high";
    approxCostUsd: number;
}
export interface LeadDeps {
    config: HarnessConfig;
    logger: {
        info: (m: string, meta?: unknown) => void;
    };
    callLeadModel: (brief: CrystallisedBrief, repos: string[]) => Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>;
    allocateWorktree: (repo: string, branch: string) => Promise<string>;
    estimateCost: (plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">) => number;
}
export declare function runLeadPlanner(brief: CrystallisedBrief, deps: LeadDeps): Promise<LeadPlan>;
//# sourceMappingURL=fable5-lead.d.ts.map