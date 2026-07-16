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
export type SubTaskVerify =
  | { kind: "branch_pushed"; branch?: string }              // ref exists on origin
  | { kind: "pr_opened" }                                    // a PR URL was captured
  | { kind: "file_written"; path: string }                   // file mtime post-start + non-empty diff
  | { kind: "commit_made" };                                 // a new commit exists vs base

export interface LeadPlanSubTask {
  seq: number;
  title: string;
  intent: string;                    // what the worker should do
  filesLikelyTouched: string[];      // narrow scope
  successCriteria: string[];         // observable / testable outcomes
  estimatedTokens: number;           // rough cost forecast
  dependsOn?: number[];              // seq numbers this depends on
  /**
   * Observable side-effects to verify after the worker's SDK turn ends.
   * When present and any check fails, the sub-task is FAILED regardless of
   * the SDK stop reason. Absent/empty = trust the SDK signal (pure-reasoning
   * or advisory sub-tasks with no observable output).
   */
  verify?: SubTaskVerify[];
}

export interface LeadPlan {
  repo: string;                      // owner/repo
  branch: string;                    // harness/<slug>-<shortid>
  worktreePath: string;              // absolute local path
  subTasks: LeadPlanSubTask[];
  reviewChecklist: string[];         // items adversary must verify
  riskLevel: "low" | "medium" | "high";
  approxCostUsd: number;             // sum of estimatedTokens converted via price table
}

export interface LeadDeps {
  config: HarnessConfig;
  logger: { info: (m: string, meta?: unknown) => void };
  callLeadModel: (brief: CrystallisedBrief, repos: string[]) => Promise<Omit<LeadPlan, "worktreePath" | "approxCostUsd">>;
  allocateWorktree: (repo: string, branch: string) => Promise<string>;
  estimateCost: (plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">) => number;
}

export async function runLeadPlanner(
  brief: CrystallisedBrief,
  deps: LeadDeps,
): Promise<LeadPlan> {
  const raw = await deps.callLeadModel(brief, deps.config.repos.allowed);
  validatePlan(raw, deps.config);
  const worktreePath = await deps.allocateWorktree(raw.repo, raw.branch);
  const approxCostUsd = deps.estimateCost(raw);
  const plan: LeadPlan = { ...raw, worktreePath, approxCostUsd };
  deps.logger.info("[lead] plan", {
    subTaskCount: plan.subTasks.length,
    risk: plan.riskLevel,
    approxCostUsd,
  });
  return plan;
}

function validatePlan(
  plan: Omit<LeadPlan, "worktreePath" | "approxCostUsd">,
  config: HarnessConfig,
): void {
  if (!plan.repo || !plan.repo.includes("/")) {
    throw new Error(`lead plan repo "${plan.repo}" is not owner/repo`);
  }
  const owner = plan.repo.split("/")[0]!;
  const inAllowList = config.repos.allowed.some((glob) => {
    if (glob === plan.repo) return true;
    if (glob.endsWith("/*") && glob.slice(0, -2) === owner) return true;
    return false;
  });
  if (!inAllowList) {
    throw new Error(`lead plan repo "${plan.repo}" is not in the allow-list ${JSON.stringify(config.repos.allowed)}`);
  }
  if (!plan.branch.startsWith("harness/")) {
    throw new Error(`lead plan branch "${plan.branch}" must start with "harness/"`);
  }
  if (plan.subTasks.length === 0) {
    throw new Error("lead plan has zero sub-tasks");
  }
  if (plan.subTasks.length > 20) {
    throw new Error(`lead plan has ${plan.subTasks.length} sub-tasks; hard cap is 20`);
  }
  const seqs = new Set(plan.subTasks.map((s) => s.seq));
  if (seqs.size !== plan.subTasks.length) throw new Error("duplicate sub-task seq numbers");
}
