/**
 * rc.6: what the session's money actually means, in one place.
 *
 * THE BUG THIS EXISTS FOR. #1184 spent $53.81 against a $50 session budget and
 * was then refused a CI repair cycle for being over $50. Both halves were
 * working as written. beta.78 made the session budget SOFT for ordinary work --
 * it warns and continues, and the hard admission boundary is the per-user daily
 * cap. beta.120 (fix 6) then made the EXTENSION gate measure hard against the
 * same number, on the sound reasoning that the harness electing to buy itself
 * another cycle with money the requester did not authorise is a different act
 * from a worker running long.
 *
 * Composed, they produce the worst available outcome: implementation may spend
 * past the number, and repair -- the only consumer measured hard against it --
 * is refused precisely because implementation did. The run overspends AND ships
 * red. Nothing in either rule is wrong on its own; the fault is that they read
 * the same field to mean two different things, and the one that loses is always
 * the one that would have finished the job.
 *
 * THE SHAPE OF THE FIX. Divide the approved figure up front instead of letting
 * whoever spends first take it all:
 *
 *   - `implementationTargetUsd` is what ordinary work is sized against. Soft, as
 *     beta.78 made it: crossing it warns. But the harness may not ELECT another
 *     implementation cycle past it, which is beta.120's rule aimed at the target
 *     rather than the whole figure -- strictly tighter than before.
 *   - `repairReserveUsd` is repair's own pot, and repair measures its own spend
 *     against it. It never reads total spend, so no amount of implementation
 *     overspend can deny it. That is the whole point: repair stops being the
 *     thing that gets refused for somebody else's spending.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not make the session budget hard,
 * and it does not raise any ceiling. The real walls are unchanged and still
 * hard: `budgets.session_hard_ceiling_usd`, `budgets.daily_max_usd`, the
 * per-user monthly cap in `BudgetEnforcer.check`, and `loop.ci_repair_cycles`.
 * The worst case here is implementation's actual spend plus one repair cycle,
 * which is the overshoot soft spend already permitted -- now deliberate and
 * accounted for rather than accidental.
 */

/** Fraction of the approved budget held back for repair when unset. */
export const DEFAULT_REPAIR_RESERVE_RATIO = 0.3;

/**
 * A reserve may not swallow the run. Above this the "target" would be so small
 * that ordinary work would be declining extensions from the first cycle, which
 * is a worse failure than the one this fixes.
 */
export const MAX_REPAIR_RESERVE_RATIO = 0.5;

export interface BudgetPolicy {
  /**
   * What the operator approved for this session (`sessions.budget_usd`).
   *
   * Named for what it is. RC-2 of the #1184 postmortem is largely a naming
   * complaint with teeth: user-facing text called this a "cap" while the loop
   * treated it as a target in one place and a wall in another, so an operator
   * reading "cap" had no way to predict either behaviour.
   */
  authorizedMaximumUsd: number;
  /** What ordinary implementation work is sized against. Soft. */
  implementationTargetUsd: number;
  /** Held back for CI repair and the verification tail. */
  repairReserveUsd: number;
}

export function resolveBudgetPolicy(input: {
  authorizedMaximumUsd: number | null | undefined;
  repairReserveRatio?: number | null;
}): BudgetPolicy {
  const approved =
    typeof input.authorizedMaximumUsd === "number" && Number.isFinite(input.authorizedMaximumUsd) && input.authorizedMaximumUsd > 0
      ? input.authorizedMaximumUsd
      : 0;
  const rawRatio = typeof input.repairReserveRatio === "number" && Number.isFinite(input.repairReserveRatio) ? input.repairReserveRatio : DEFAULT_REPAIR_RESERVE_RATIO;
  const ratio = Math.max(0, Math.min(MAX_REPAIR_RESERVE_RATIO, rawRatio));
  const reserve = round2(approved * ratio);
  return {
    authorizedMaximumUsd: approved,
    implementationTargetUsd: round2(approved - reserve),
    repairReserveUsd: reserve,
  };
}

/**
 * What the next cycle is likely to cost, from what this run's cycles have
 * actually cost. The 1.25 margin is beta.120's, kept because cycles trend
 * upwards as findings accumulate rather than down.
 *
 * Returns 0 when there is nothing to measure, which callers must read as "no
 * projection available" rather than "free".
 */
export function projectCycleCostUsd(spentUsd: number, cyclesRan: number): number {
  if (!(cyclesRan >= 1) || !(spentUsd > 0)) return 0;
  return (spentUsd / cyclesRan) * 1.25;
}

export interface RepairFundingInput {
  policy: BudgetPolicy;
  /** Spend attributable to repair cycles so far -- NOT the run's total. */
  repairSpentUsd: number;
  /** How many repair cycles this run has already been granted. */
  repairCyclesGranted: number;
  /** Measured cost of the repair cycles so far, if any have run. */
  projectedRepairCostUsd: number;
}

export type RepairFunding =
  | { funded: true; basis: "first_repair" | "reserve_covers_projection" }
  | { funded: false; basis: "no_reserve" | "reserve_exhausted"; shortfallUsd: number };

/**
 * Can the reserve pay for the repair cycle being asked for?
 *
 * The FIRST repair is funded whenever a reserve exists, without projecting.
 * This is deliberate and it is the point of the whole change. Before rc.6 the
 * projection was an average IMPLEMENTATION cycle, and a repair -- which fixes a
 * handful of named CI findings on a branch that is already built and reviewed --
 * was being priced as though it were another round of building the feature.
 * Any reserve an operator would plausibly configure loses that comparison, so
 * projecting the first repair would reproduce the refusal this exists to stop.
 *
 * Once a repair HAS run there is a measurement, and subsequent repairs are held
 * to it. The count is separately bounded by `loop.ci_repair_cycles`, which this
 * does not touch, so "always fund the first" cannot become an unbounded series.
 */
export function assessRepairFunding(input: RepairFundingInput): RepairFunding {
  const { policy, repairSpentUsd, repairCyclesGranted, projectedRepairCostUsd } = input;
  if (!(policy.repairReserveUsd > 0)) return { funded: false, basis: "no_reserve", shortfallUsd: 0 };
  if (repairCyclesGranted < 1) return { funded: true, basis: "first_repair" };
  const wouldSpend = Math.max(0, repairSpentUsd) + Math.max(0, projectedRepairCostUsd);
  if (wouldSpend <= policy.repairReserveUsd) return { funded: true, basis: "reserve_covers_projection" };
  return { funded: false, basis: "reserve_exhausted", shortfallUsd: round2(wouldSpend - policy.repairReserveUsd) };
}

/** One line an operator can act on, for the audit trail and the decline notice. */
export function describeBudgetPolicy(policy: BudgetPolicy): string {
  if (!(policy.authorizedMaximumUsd > 0)) return "no session budget is set, so nothing is reserved for repair";
  return (
    `$${policy.authorizedMaximumUsd.toFixed(2)} approved: ` +
    `$${policy.implementationTargetUsd.toFixed(2)} for implementation (soft -- crossing it warns) ` +
    `and $${policy.repairReserveUsd.toFixed(2)} held back for CI repair`
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
