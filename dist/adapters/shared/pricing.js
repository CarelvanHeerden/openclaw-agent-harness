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
export const PRICES = {
    // opus-tier (most capable, most expensive)
    "claude-fable-5": { input: 10, output: 50 },
    "claude-mythos-5": { input: 10, output: 50 },
    // beta.61: aliases some deployments use for the opus-tier worker. Without
    // these, a config that set worker to a bare "opus"/"claude-opus-*" string
    // fell through to the sonnet fallback and was priced ~5x too low -- the
    // dominant half of the b60 smoke's ~15x cost under-estimate (worker was
    // swapped sonnet->opus, but the table had no opus key so the projection
    // stayed at sonnet rates and the >20% drift warning silently never fired).
    "claude-opus-4-8": { input: 15, output: 75 },
    "claude-opus-4-6": { input: 15, output: 75 },
    opus: { input: 15, output: 75 },
    // beta.71: Opus 5 (launched 2026-07-24, API id "claude-opus-5"). Priced at
    // $5 in / $25 out per Mtok -- HALF of Fable 5's 10/50 and half of Opus 4.8's
    // 15/75. Without this entry a config that swaps models.lead Fable->opus-5
    // would hit the beta.61 unknown-model fail-safe and be priced at the
    // most-expensive tier (Fable's 50 output), over-reserving budget ~2x and
    // firing a spurious drift warning on run 1. Opus 5's lower output price also
    // does NOT change mostExpensivePrice() -- Fable's 50 stays the fail-safe top.
    "claude-opus-5": { input: 5, output: 25 },
    "opus-5": { input: 5, output: 25 },
    "opus5": { input: 5, output: 25 },
    // sonnet-tier
    "claude-sonnet-5": { input: 3, output: 15 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    sonnet: { input: 3, output: 15 },
    // haiku-tier
    "claude-haiku-4-5": { input: 1, output: 5 },
    haiku: { input: 1, output: 5 },
};
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
export function mostExpensivePrice(table) {
    let max = { input: 0, output: 0 };
    for (const p of Object.values(table)) {
        // rank by output price (the dominant term in the 20/80 split)
        if (p.output > max.output || (p.output === max.output && p.input > max.input))
            max = p;
    }
    return max.output > 0 ? max : { input: 15, output: 75 };
}
/** beta.61: true when a model id has neither a table entry nor an override. */
export function isUnknownModel(model, overrides) {
    const table = { ...PRICES, ...(overrides ?? {}) };
    return !table[model];
}
/**
 * beta.61: assess pricing health of the CONFIGURED models. Returns per-model
 * flags: `unpriced` (not in the price table/overrides -> projections fall back
 * to the most-expensive tier), and `notLive` (a live model list was fetched and
 * this id was absent -> possibly renamed/deprecated). `liveIds` null means the
 * Models API was unreachable, so `notLive` is left undefined (unknown, not
 * false). Pure/deterministic given inputs -- no network here (fetch is done by
 * fetchLiveModelIds and passed in) so it is unit-testable.
 */
export function assessModelPricingHealth(configuredModels, liveIds, overrides) {
    const seen = new Set();
    const out = [];
    for (const m of configuredModels) {
        if (!m || seen.has(m))
            continue;
        seen.add(m);
        const entry = {
            model: m,
            unpriced: isUnknownModel(m, overrides),
        };
        if (liveIds)
            entry.notLive = !liveIds.includes(m);
        out.push(entry);
    }
    return out;
}
export function estimateSubTaskCost(model, tokens, overrides) {
    const table = { ...PRICES, ...(overrides ?? {}) };
    // beta.61: fail-safe fallback -- unknown model is priced at the MOST
    // EXPENSIVE known tier (over-reserve), not silently at sonnet (under-reserve).
    const p = table[model] ?? mostExpensivePrice(table);
    // Rough 20/80 in/out split for planning purposes
    return (tokens * 0.2 * p.input + tokens * 0.8 * p.output) / 1_000_000;
}
/**
 * Called after a real SDK call. Returns { drift, warn } where warn=true when
 * the actual cost deviates > 20% from our estimate for that model+tokens.
 * Callers should log the warning (with model + actual + estimate) so we
 * catch stale price tables in one run instead of over billing cycles.
 */
export function checkPriceDrift(model, actualCostUsd, tokensIn, tokensOut, overrides) {
    const table = { ...PRICES, ...(overrides ?? {}) };
    const p = table[model];
    if (!p) {
        // beta.61: an unknown model is itself a warn condition. Previously this
        // silently no-op'd (warn:false) -- which is exactly why the b60 opus
        // worker (no table entry) never surfaced its ~5x mispricing. Report the
        // estimate computed at the fail-safe most-expensive price so the operator
        // sees BOTH that the model is unpriced AND how far off the projection was.
        const fallback = mostExpensivePrice(table);
        const estimated = (tokensIn * fallback.input + tokensOut * fallback.output) / 1_000_000;
        const drift = estimated > 0 && actualCostUsd > 0 ? Math.abs(actualCostUsd - estimated) / estimated : 0;
        return { drift, warn: true, estimated, unknownModel: true };
    }
    const estimated = (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
    if (estimated <= 0 || actualCostUsd <= 0)
        return { drift: 0, warn: false, estimated };
    const drift = Math.abs(actualCostUsd - estimated) / estimated;
    return { drift, warn: drift > 0.2, estimated };
}
//# sourceMappingURL=pricing.js.map