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
  logger: { info: (m: string, x?: unknown) => void; warn: (m: string, x?: unknown) => void; error?: (m: string, x?: unknown) => void };
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
  verifyDeploy: (args: { repoFullName: string; sha: string }) => Promise<DeployVerifyLite>;
  /**
   * Revert a set of merge commits (newest-first) on main. Returns whether it
   * went straight to main or via an auto-merged revert PR.
   */
  revertMerges: (args: {
    sessionId: string;
    repoFullName: string;
    shas: string[];
  }) => Promise<{ ok: boolean; pushedToMain: boolean; revertPrUrl?: string; detail: string }>;
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
export async function runDeployRepair(
  deps: DeployRepairDeps,
  input: DeployRepairInput,
): Promise<DeployRepairResult> {
  const { sessionId, repoFullName, originalMergeSha } = input;
  // Merge SHAs we may have to revert, newest-first as we go. Original PR is
  // the OLDEST, so it goes LAST in the revert list (we unshift newer ones).
  const mergedShas: string[] = [originalMergeSha];
  let totalCost = 0;
  let lastRepairPrUrl: string | undefined;
  let lastRepairPrNumber: number | undefined;

  deps.audit(
    "deploy.repair_started",
    { sessionId, originalMergeSha, maxAttempts: input.maxAttempts, repairBudgetUsd: input.repairBudgetUsd, error: input.originalDeploy.detail },
    sessionId,
  );

  let lastDeploy: DeployVerifyLite = input.originalDeploy;

  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const budgetRemaining = input.repairBudgetUsd - totalCost;
    if (budgetRemaining <= 0) {
      deps.logger.warn("[deploy-repair] repair budget exhausted before attempt", { sessionId, attempt, totalCost });
      return finaliseRevert(deps, input, mergedShas, totalCost, lastRepairPrUrl, "budget_paused", attempt - 1);
    }

    deps.audit("deploy.repair_attempt", { sessionId, attempt, budgetRemaining, deployError: lastDeploy.detail }, sessionId);
    deps.persist(sessionId, { deploy_repair_attempt: attempt });

    let repair: RepairRunResult;
    try {
      repair = await deps.runRepairAttempt({ sessionId, repoFullName, attempt, deploy: lastDeploy, budgetRemaining });
    } catch (err) {
      deps.logger.error?.("[deploy-repair] repair attempt threw", { sessionId, attempt, err: String(err) });
      repair = { shipped: false, costUsd: 0, reason: `repair attempt threw: ${String(err)}` };
    }
    totalCost += repair.costUsd;

    if (!repair.shipped || !repair.mergeSha) {
      // The repair pipeline itself failed to produce a merged fix. Record the
      // (possibly open) PR for the human handoff and stop attempting: if the
      // harness couldn't even ship a fix, more attempts won't help.
      if (repair.prUrl) { lastRepairPrUrl = repair.prUrl; lastRepairPrNumber = repair.prNumber; }
      deps.audit(
        "deploy.repair_attempt_failed",
        { sessionId, attempt, reason: repair.reason ?? "did not ship a merged fix", prUrl: repair.prUrl },
        sessionId,
      );
      return finaliseRevert(deps, input, mergedShas, totalCost, lastRepairPrUrl, "reverted", attempt);
    }

    // A repair PR was merged; it's now part of what we'd have to revert.
    mergedShas.unshift(repair.mergeSha);
    lastRepairPrUrl = repair.prUrl;
    lastRepairPrNumber = repair.prNumber;

    // Re-verify the deploy for the new merge SHA.
    let dv: DeployVerifyLite;
    try {
      dv = await deps.verifyDeploy({ repoFullName, sha: repair.mergeSha });
    } catch (err) {
      dv = { status: "error", detail: `deploy verify threw: ${String(err)}` };
    }
    lastDeploy = dv;
    deps.audit("deploy.repair_reverify", { sessionId, attempt, mergeSha: repair.mergeSha, status: dv.status }, sessionId);

    if (dv.status === "ready") {
      deps.audit("deploy.repaired", { sessionId, attempts: attempt, mergeSha: repair.mergeSha, deploymentUrl: dv.deploymentUrl, totalCostUsd: totalCost }, sessionId);
      deps.persist(sessionId, { deploy_status: "ready", deploy_detail: `repaired after ${attempt} attempt(s): ${dv.detail}`.slice(0, 5000), deploy_repair_attempt: attempt });
      return {
        outcome: "repaired",
        attempts: attempt,
        totalCostUsd: totalCost,
        finalDeploy: dv,
        message: `Deploy repaired after ${attempt} attempt(s). Now READY (${dv.deploymentUrl ?? "url n/a"}). Repair spend $${totalCost.toFixed(2)}.`,
      };
    }
    // beta.57 (P3): pending/unavailable is NOT evidence of a broken deploy --
    // it is ABSENCE of evidence (Vercel still building past the wait window,
    // or the token/API being unavailable). Reverting a possibly-good merge on
    // that basis destroys real work. Stop WITHOUT reverting and hand off to a
    // human to verify the deploy manually. Only a verified ERROR keeps the
    // repair loop (and the eventual revert) going.
    if (dv.status === "pending" || dv.status === "unavailable") {
      deps.audit("deploy.repair_unverified", { sessionId, attempt, mergeSha: repair.mergeSha, status: dv.status, totalCostUsd: totalCost }, sessionId);
      deps.persist(sessionId, {
        deploy_status: dv.status,
        deploy_detail: `deploy state UNVERIFIED after repair attempt ${attempt} (${dv.status}): ${dv.detail}. Merges left in place; verify the deployment manually.`.slice(0, 5000),
        deploy_repair_attempt: attempt,
      });
      return {
        outcome: "unverified",
        attempts: attempt,
        totalCostUsd: totalCost,
        finalDeploy: dv,
        reviewPrUrl: lastRepairPrUrl,
        message:
          `\u26a0\ufe0f Deploy state is UNVERIFIED (${dv.status}) after repair attempt ${attempt} -- the harness could not get a definitive READY/ERROR from Vercel. ` +
          `Nothing was reverted (the merges may be fine). Verify the deployment manually. Repair spend $${totalCost.toFixed(2)}.`,
      };
    }
    // status === "error" -> genuinely broken; continue to the next attempt,
    // unless we're out of attempts (loop guard handles that).
    void lastRepairPrNumber;
  }

  // Exhausted all attempts with a VERIFIED broken deploy.
  deps.audit("deploy.repair_exhausted", { sessionId, attempts: input.maxAttempts, totalCostUsd: totalCost }, sessionId);
  return finaliseRevert(deps, input, mergedShas, totalCost, lastRepairPrUrl, "reverted", input.maxAttempts);
}

/**
 * Revert all merges to restore a healthy main, leave the last repair attempt
 * as an open PR for human review, and build the loud handoff message.
 */
async function finaliseRevert(
  deps: DeployRepairDeps,
  input: DeployRepairInput,
  mergedShas: string[],
  totalCost: number,
  reviewPrUrl: string | undefined,
  outcome: "reverted" | "budget_paused",
  attempts: number,
): Promise<DeployRepairResult> {
  const { sessionId, repoFullName } = input;
  let revert: { ok: boolean; pushedToMain: boolean; revertPrUrl?: string; detail: string };
  try {
    revert = await deps.revertMerges({ sessionId, repoFullName, shas: mergedShas });
  } catch (err) {
    deps.logger.error?.("[deploy-repair] revert FAILED", { sessionId, err: String(err) });
    deps.audit("deploy.repair_revert_failed", { sessionId, shas: mergedShas, err: String(err) }, sessionId);
    deps.persist(sessionId, {
      deploy_status: "error",
      deploy_detail: `DEPLOY REPAIR FAILED AND REVERT FAILED. main may be BROKEN. Reverting SHAs ${mergedShas.join(", ")} errored: ${String(err)}`.slice(0, 5000),
      deploy_repair_attempt: attempts,
    });
    return {
      outcome: "revert_failed",
      attempts,
      totalCostUsd: totalCost,
      reviewPrUrl,
      message:
        `\u{1f6a8} DEPLOY REPAIR FAILED and the automatic REVERT ALSO FAILED. ` +
        `main may be in a BROKEN state \u2014 manual intervention required. ` +
        `Merges that need reverting (newest-first): ${mergedShas.map((s) => s.slice(0, 12)).join(", ")}. ` +
        `Error: ${String(err).slice(0, 300)}`,
    };
  }

  deps.audit(
    outcome === "budget_paused" ? "deploy.repair_budget_paused" : "deploy.repair_reverted",
    { sessionId, revertedShas: mergedShas, pushedToMain: revert.pushedToMain, revertPrUrl: revert.revertPrUrl, reviewPrUrl, attempts, totalCostUsd: totalCost },
    sessionId,
  );
  deps.persist(sessionId, {
    deploy_status: outcome === "budget_paused" ? "repair_budget_paused" : "reverted",
    deploy_detail:
      `Deploy could not be repaired in ${attempts} attempt(s)` +
      (outcome === "budget_paused" ? " (repair budget exhausted)" : "") +
      `. Reverted ${mergedShas.length} merge(s) to restore main` +
      (revert.pushedToMain ? " (direct push)" : ` (via revert PR ${revert.revertPrUrl ?? "n/a"})`) +
      `. Last attempt left open for review: ${reviewPrUrl ?? "n/a"}.`,
    deploy_repair_attempt: attempts,
  });

  const budgetNote =
    outcome === "budget_paused"
      ? `The repair budget ($${input.repairBudgetUsd.toFixed(2)}) was exhausted after ${attempts} attempt(s). ` +
        `main has been reverted to a WORKING state; the repair is PAUSED. Reply to authorise more budget to continue.`
      : `The deploy could not be fixed in ${attempts} attempt(s). main has been reverted to a WORKING state.`;

  return {
    outcome,
    attempts,
    totalCostUsd: totalCost,
    reviewPrUrl,
    revertPrUrl: revert.revertPrUrl,
    message:
      `\u26a0\ufe0f ${budgetNote} ` +
      `Reverted ${mergedShas.length} merge(s)` +
      (revert.pushedToMain ? " straight to main." : ` via an auto-merged revert PR (${revert.revertPrUrl ?? "n/a"}).`) +
      (reviewPrUrl ? ` The latest fix attempt is left OPEN for human review: ${reviewPrUrl}` : ` No open fix PR remains.`) +
      ` Repair spend $${totalCost.toFixed(2)}.`,
  };
}
