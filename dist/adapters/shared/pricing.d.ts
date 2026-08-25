/**
 * Backend-agnostic cost arithmetic.
 *
 * v2.0.0: moved out of the Claude SDK adapter unchanged. A budget projection is
 * tokens times a price, and neither term belongs to a vendor -- the loop asks
 * "can I afford another sub-task" identically whichever backend is running it.
 *
 * `fetchLiveModelIds` deliberately did NOT come with it: that one calls the
 * Anthropic Models API and is therefore Claude-specific. M8 adds the
 * models.dev refresh alongside this table, at which point `PRICES` becomes the
 * offline fallback rather than the source of truth.
 */
/**
 * Cost estimation table (USD per M tokens).
 *
 * Update policy: these prices WILL drift. `estimateSubTaskCost()` is used
 * only for BUDGET PROJECTIONS in the loop; the authoritative source of
 * truth is the `total_cost_usd` returned by the SDK on each call, which we
 * accumulate in the state store.
 *
 * `checkPriceDrift()` runs whenever we get a real SDK cost back and compares
 * it against our estimate. Drift > 20% logs a warning so we can update the
 * table. Pricing is also configurable at plugin config time via
 * `harness.models.price_overrides` (see config.ts), so operators can patch
 * without waiting for a release.
 */
export declare const PRICES: Record<string, {
    input: number;
    output: number;
}>;
/**
 * beta.61: the price used when a model id is NOT in the table (and not
 * overridden). Previously this silently fell back to sonnet -- which
 * UNDER-estimates for a more expensive model and lets a run overshoot its
 * budget (exactly the b60 opus-priced-as-sonnet miss). A budget projection
 * must FAIL SAFE: an unknown model is assumed to be the MOST EXPENSIVE known
 * tier, so we over-reserve rather than under-reserve. Combined with the
 * checkPriceDrift unknown-model warning, an operator sees the mispricing on
 * run 1 and can add an exact price_override.
 */
export declare function mostExpensivePrice(table: Record<string, {
    input: number;
    output: number;
}>): {
    input: number;
    output: number;
};
/** beta.61: true when a model id has neither a table entry nor an override. */
export declare function isUnknownModel(model: string, overrides?: Record<string, {
    input: number;
    output: number;
}>): boolean;
/**
 * beta.61: assess pricing health of the CONFIGURED models. Returns per-model
 * flags: `unpriced` (not in the price table/overrides -> projections fall back
 * to the most-expensive tier), and `notLive` (a live model list was fetched and
 * this id was absent -> possibly renamed/deprecated). `liveIds` null means the
 * Models API was unreachable, so `notLive` is left undefined (unknown, not
 * false). Pure/deterministic given inputs -- no network here (fetch is done by
 * fetchLiveModelIds and passed in) so it is unit-testable.
 */
export declare function assessModelPricingHealth(configuredModels: string[], liveIds: string[] | null, overrides?: Record<string, {
    input: number;
    output: number;
}>): Array<{
    model: string;
    unpriced: boolean;
    notLive?: boolean;
}>;
export declare function estimateSubTaskCost(model: string, tokens: number, overrides?: Record<string, {
    input: number;
    output: number;
}>): number;
/**
 * Called after a real SDK call. Returns { drift, warn } where warn=true when
 * the actual cost deviates > 20% from our estimate for that model+tokens.
 * Callers should log the warning (with model + actual + estimate) so we
 * catch stale price tables in one run instead of over billing cycles.
 */
export declare function checkPriceDrift(model: string, actualCostUsd: number, tokensIn: number, tokensOut: number, overrides?: Record<string, {
    input: number;
    output: number;
}>): {
    drift: number;
    warn: boolean;
    estimated: number;
    unknownModel?: boolean;
};
//# sourceMappingURL=pricing.d.ts.map