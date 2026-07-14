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
export interface LeadPlanSubTask {
    seq: number;
    title: string;
    intent: string;
    filesLikelyTouched: string[];
    successCriteria: string[];
    estimatedTokens: number;
    dependsOn?: number[];
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