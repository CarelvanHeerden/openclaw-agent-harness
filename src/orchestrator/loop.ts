/**
 * OrchestratorLoop
 *
 * The 3-cycle controller: plan -> execute (workers) -> assemble -> review.
 * Early exit on adversarial pass, budget hit, or user override.
 *
 * PHASE 0 SCAFFOLD. Real implementation lands in later phases.
 */

import type { HarnessConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { BudgetEnforcer } from "../budgets/enforcer.js";
import type { PatRouter } from "../auth/pat-router.js";

export interface LoopDeps {
  config: HarnessConfig;
  state: StateStore;
  budgets: BudgetEnforcer;
  pat: PatRouter;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
}

export interface LoopInput {
  sessionId: string;
  crystallisedPrompt: string;
  requester: string;
  repo: string;
}

export interface LoopOutcome {
  status: "shipped" | "aborted" | "failed" | "budget_hit";
  prUrl?: string;
  totalCostUsd: number;
  cycles: number;
}

export class OrchestratorLoop {
  constructor(private readonly deps: LoopDeps) {}

  async run(_input: LoopInput): Promise<LoopOutcome> {
    // TODO(phase-2): implement plan/execute/assemble/review loop.
    // TODO(phase-3): wire adversarial reviewer.
    // TODO(phase-4): budget enforcement + Vercel logs.
    this.deps.logger.warn("[loop] run() called but not implemented (phase-0 scaffold)");
    return {
      status: "failed",
      totalCostUsd: 0,
      cycles: 0,
    };
  }
}
