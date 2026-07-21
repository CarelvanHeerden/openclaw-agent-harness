/**
 * beta.36: post-merge Vercel deploy-repair state machine.
 *
 * When a PR is merged to `main` on a Vercel-configured project, merging is
 * what triggers the production deployment. The deployment is then the runtime
 * arbiter the in-loop adversary never had (no in-loop preview deploy). So:
 *
 *   merge -> verify deploy for merge SHA
 *     READY  -> done (success)
 *     ERROR  -> repair loop:
 *                 for attempt in 1..max_attempts:
 *                   build a repair brief from the Vercel build logs
 *                   run the FULL harness pipeline (crystallise->plan->work->
 *                     review->ship) off the now-broken main, in the SAME
 *                     session (deploy_repair_attempt counter)
 *                   merge the repair PR
 *                   re-verify the deploy for the new merge SHA
 *                     READY -> done (repaired)
 *                     ERROR -> next attempt
 *                 all attempts failed OR repair budget exhausted:
 *                   REVERT every merge (original PR + all repair PRs) so main
 *                     is healthy again (direct push, or auto-merged revert PR
 *                     when main is branch-protected)
 *                   leave the last repair attempt as an OPEN PR for human
 *                     review, post a loud error explaining the whole chain
 *
 * The whole repair loop shares ONE budget pool =
 *   budgets.daily_max_usd * vercel.deploy_repair.budget_ratio
 * (user-overridable per invocation). If it's exhausted mid-loop we STOP,
 * revert to a working main, and pause for the user's go-ahead rather than
 * leaving main broken.
 *
 * This module is deps-injected so it stays unit-testable without a live
 * gateway. The runtime (index.ts) satisfies `DeployRepairDeps`.
 */
export type DeployStatus = "ready" | "error" | "pending" | "unavailable";
export interface DeployVerifyLite {
    status: DeployStatus;
    detail: string;
    deploymentUrl?: string;
    logsExcerpt?: string;
}
export interface RepairRunResult {
    /** Did the repair pipeline ship a PR we can merge? */
    shipped: boolean;
    prUrl?: string;
    prNumber?: number;
    /** Merge SHA if we merged it. */
    mergeSha?: string;
    costUsd: number;
    reason?: string;
}
export interface DeployRepairDeps {
    audit: (event: string, payload: Record<string, unknown>, sessionId: string) => void;
    logger: {
        info: (m: string, x?: unknown) => void;
        warn: (m: string, x?: unknown) => void;
        error?: (m: string, x?: unknown) => void;
    };
    /**
     * Run ONE repair attempt end-to-end: build a brief from the deploy error,
     * run the harness pipeline off latest main, ship + merge the repair PR, and
     * return the merge SHA. `budgetRemaining` caps this attempt's spend.
     */
    runRepairAttempt: (args: {
        sessionId: string;
        repoFullName: string;
        attempt: number;
        deploy: DeployVerifyLite;
        budgetRemaining: number;
    }) => Promise<RepairRunResult>;
    /** Verify the Vercel deployment for a merge SHA. */
    verifyDeploy: (args: {
        repoFullName: string;
        sha: string;
    }) => Promise<DeployVerifyLite>;
    /**
     * Revert a set of merge commits (newest-first) on main. Returns whether it
     * went straight to main or via an auto-merged revert PR.
     */
    revertMerges: (args: {
        sessionId: string;
        repoFullName: string;
        shas: string[];
    }) => Promise<{
        ok: boolean;
        pushedToMain: boolean;
        revertPrUrl?: string;
        detail: string;
    }>;
    /**
     * Persist the outcome onto the session row (deploy_status/detail,
     * repair attempt count, final state).
     */
    persist: (sessionId: string, patch: Record<string, unknown>) => void;
}
export interface DeployRepairInput {
    sessionId: string;
    repoFullName: string;
    /** The ORIGINAL merge SHA (the PR the user asked to merge). */
    originalMergeSha: string;
    /** Verify result for the original merge (must be ERROR to enter here). */
    originalDeploy: DeployVerifyLite;
    maxAttempts: number;
    /** Total repair budget (USD) shared across all attempts. */
    repairBudgetUsd: number;
}
export interface DeployRepairResult {
    outcome: "repaired" | "reverted" | "budget_paused" | "revert_failed" | "unverified";
    attempts: number;
    totalCostUsd: number;
    /** Final healthy deploy (when repaired). */
    finalDeploy?: DeployVerifyLite;
    /** The PR left open for human review (when reverted). */
    reviewPrUrl?: string;
    revertPrUrl?: string;
    message: string;
}
/**
 * Drive the post-merge deploy-repair state machine. Pure control flow; all
 * I/O is via `deps`.
 */
export declare function runDeployRepair(deps: DeployRepairDeps, input: DeployRepairInput): Promise<DeployRepairResult>;
//# sourceMappingURL=deploy-repair.d.ts.map