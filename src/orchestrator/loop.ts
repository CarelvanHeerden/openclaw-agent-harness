/**
 * Orchestrator loop.
 *
 * The core state machine. Given a session id (already row-inserted with a
 * crystallised prompt), it walks:
 *
 *   crystallising -> planning -> executing -> reviewing -> {done|revise}
 *
 * Up to `config.loop.max_cycles` cycles of executing+reviewing. Early exits:
 *   - Adversary verdict "pass" AND config.loop.adversarial_pass_ends_early
 *   - User ship-it reaction
 *   - User abort reaction
 *   - Session budget breached
 *   - Session hard timeout
 *
 * At every state transition we `state.audit(...)` with the event name and
 * a JSON payload of the delta, plus checkpoint the session row so we can
 * resume after a container restart.
 */

import type { HarnessConfig } from "../config.js";
import type { BudgetEnforcer } from "../budgets/enforcer.js";
import type { PatRouter } from "../auth/pat-router.js";
import type { StateStore } from "../state/store.js";

export type LoopOutcome =
  | { status: "shipped"; sessionId: string; prUrl: string; cycles: number; totalCostUsd: number }
  | { status: "failed"; sessionId: string; reason: string; cycles: number; totalCostUsd: number }
  | { status: "aborted"; sessionId: string; reason: string; cycles: number; totalCostUsd: number };

export interface OrchestratorDeps {
  config: HarnessConfig;
  state: StateStore;
  budget: BudgetEnforcer;
  pat: PatRouter;
  logger: { info: (m: string, meta?: unknown) => void; warn: (m: string, meta?: unknown) => void; error: (m: string, meta?: unknown) => void };
}

export class OrchestratorLoop {
  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * PHASE 1 SKELETON: the real implementation lands next commit -- this
   * file currently just houses the type contract and the state-transition
   * helper `advance()`. That helper is unit-tested standalone.
   */
  async run(sessionId: string): Promise<LoopOutcome> {
    const row = this.deps.state.db
      .prepare(`SELECT id, requester, repo, cost_usd, cycles_ran FROM sessions WHERE id = ?`)
      .get(sessionId) as
      | { id: string; requester: string; repo: string; cost_usd: number; cycles_ran: number }
      | undefined;
    if (!row) throw new Error(`session ${sessionId} not found`);

    this.deps.state.audit("loop.start", { sessionId }, sessionId);

    // TODO(phase-2): wire real crystallise -> plan -> execute -> review sequence.
    return {
      status: "failed",
      sessionId,
      reason: "not-implemented",
      cycles: 0,
      totalCostUsd: row.cost_usd,
    };
  }

  /**
   * State transition rules. Pure so we can unit-test them.
   */
  static advance(input: {
    currentStatus: "crystallising" | "planning" | "executing" | "reviewing" | "done" | "failed" | "aborted";
    verdict?: "pass" | "revise" | "block";
    cyclesRan: number;
    maxCycles: number;
    reactions: { shipIt: boolean; abort: boolean; pause: boolean };
    budgetExhausted: boolean;
    hardTimeout: boolean;
  }): { nextStatus: typeof input.currentStatus; reason: string } {
    if (input.reactions.abort) {
      return { nextStatus: "aborted", reason: "user_abort_reaction" };
    }
    if (input.budgetExhausted) {
      return { nextStatus: "aborted", reason: "budget_exhausted" };
    }
    if (input.hardTimeout) {
      return { nextStatus: "aborted", reason: "hard_timeout" };
    }
    if (input.reactions.shipIt && input.currentStatus === "reviewing") {
      return { nextStatus: "done", reason: "user_ship_it_reaction" };
    }
    switch (input.currentStatus) {
      case "crystallising":
        return { nextStatus: "planning", reason: "crystallise_ok" };
      case "planning":
        return { nextStatus: "executing", reason: "plan_ready" };
      case "executing":
        return { nextStatus: "reviewing", reason: "subtasks_complete" };
      case "reviewing":
        if (input.verdict === "pass") return { nextStatus: "done", reason: "adversary_pass" };
        if (input.verdict === "block") return { nextStatus: "failed", reason: "adversary_block" };
        // verdict === "revise"
        if (input.cyclesRan >= input.maxCycles - 1) {
          return { nextStatus: "failed", reason: "max_cycles_reached" };
        }
        return { nextStatus: "executing", reason: "adversary_revise" };
      case "done":
      case "failed":
      case "aborted":
        return { nextStatus: input.currentStatus, reason: "terminal" };
    }
  }
}
