/**
 * Live model pricing from models.dev, and the ladder that decides which price
 * a budget projection actually uses.
 *
 * WHY THIS EXISTS. `PRICES` is a hand-maintained table, and beta.61 is the
 * record of what happens when it falls behind: a worker swapped from sonnet to
 * opus was priced at sonnet rates because the table had no opus key, the
 * projection ran ~5x light, and the >20% drift warning that should have caught
 * it never fired *because* the model was unknown. v2 makes that worse by
 * design — the whole point is to run models nobody here has priced, on
 * endpoints nobody here operates.
 *
 * WHY IT IS UNTRUSTED INPUT. `api.json` is a 4.3MB third-party response that
 * feeds every budget decision downstream. Malformed or poisoned, it would not
 * fail loudly; it would quietly change what the harness believes a run costs.
 * So it is validated as a WHOLE before any of it is trusted, and a response
 * that fails is rejected entirely rather than merged in part — a half-applied
 * catalogue is the one outcome with no legible failure mode, because the prices
 * that survived look exactly like the prices that were checked.
 *
 * WHY CACHE-THEN-REFRESH. The fetch must never sit in front of a run. The
 * cached catalogue answers immediately, the refresh happens off the hot path,
 * and a refresh that fails leaves the last good cache in place. Degradation is
 * ordered and each step is narrower than the last: overrides, then live cache,
 * then `PRICES`, then the most-expensive-known fail-safe.
 */
export interface ModelPrice {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
}
export interface CatalogueEntry extends ModelPrice {
    /** `provider/model`, matching how roles address models in config. */
    id: string;
    provider: string;
    model: string;
    contextLimit?: number;
    outputLimit?: number;
}
export interface Catalogue {
    /** Keyed by `provider/model`. */
    entries: Record<string, CatalogueEntry>;
    /** When this catalogue was fetched, epoch ms. */
    fetchedAt: number;
    /** How many providers the source declared, for the sanity floor. */
    providerCount: number;
}
/** models.dev is refreshed daily; anything younger is served from cache. */
export declare const CATALOGUE_TTL_MS: number;
export declare const MODELS_DEV_URL = "https://models.dev/api.json";
/**
 * The fetch is bounded. A hung TLS handshake against a third-party host must
 * not be able to hold a refresh open indefinitely, even off the hot path,
 * because the refresh holds a lock that a later one would wait on.
 */
export declare const CATALOGUE_FETCH_TIMEOUT_MS = 20000;
/**
 * A response declaring fewer providers than this is treated as corrupt.
 *
 * models.dev carries ~199 providers. A response with three is not a smaller
 * catalogue, it is a different document — an error page, a partial write, a
 * CDN serving something else — and accepting it would silently narrow pricing
 * to whatever survived. The floor is deliberately far below the real count so
 * it flags catastrophe, not drift.
 */
export declare const MIN_PLAUSIBLE_PROVIDERS = 20;
export declare class CatalogueRejected extends Error {
    readonly reason: string;
    constructor(reason: string);
}
/**
 * Validate and convert in one pass, all or nothing.
 *
 * Throws `CatalogueRejected` rather than returning a partial catalogue. A
 * model entry that is malformed is SKIPPED — models.dev legitimately lists
 * models with no published pricing, and rejecting the whole document because
 * one entry lacks a cost figure would mean never having a catalogue at all.
 * The all-or-nothing rule applies to the document's SHAPE; per-model gaps are
 * expected and handled by the ladder falling through to `PRICES`.
 */
export declare function parseModelsDevCatalogue(raw: unknown, now?: number): Catalogue;
export declare function isCatalogueStale(cat: Catalogue | undefined, now?: number): boolean;
export interface PriceLookupInput {
    /** As configured: `provider/model` or a bare id. */
    model: string;
    overrides?: Record<string, ModelPrice>;
    catalogue?: Catalogue;
    /** Providers the operator declared local. See `source: "local"`. */
    localProviders?: ReadonlySet<string>;
}
export type PriceSource = "override" | "catalogue" | "table" | "fail-safe" | "local";
export interface PriceResolution {
    price: ModelPrice;
    source: PriceSource;
    /**
     * True when no dollar figure should be reported for this model at all.
     *
     * A local endpoint bills nothing, so the honest output is a token count with
     * no cost attached. `costUsd: 0` would be indistinguishable from a cost
     * nobody measured, and the whole cost-leak class this milestone fixes is
     * made of zeroes that meant "unknown".
     */
    billable: boolean;
}
/**
 * The ladder, in order, with the reason each step is below the last.
 *
 * 1. `price_overrides` — the operator said so explicitly. Nothing outranks it.
 * 2. the live catalogue — fetched, validated, and addressed by `provider/model`.
 * 3. `PRICES` — the offline table, correct for Anthropic ids and stale by
 *    construction for everything else.
 * 4. most-expensive-known — the beta.61 fail-safe. An unknown model
 *    OVER-reserves budget, because under-reserving lets a run overshoot and
 *    that failure is only visible on the invoice.
 */
export declare function resolvePrice(input: PriceLookupInput): PriceResolution;
/** Cost of a completed call. Returns `undefined` when the model is not billable. */
export declare function costOf(tokensIn: number, tokensOut: number, resolution: PriceResolution): number | undefined;
export interface CatalogueStore {
    read: () => Catalogue | undefined;
    write: (cat: Catalogue) => void;
}
export interface RefreshDeps {
    store: CatalogueStore;
    fetchJson?: (url: string, timeoutMs: number) => Promise<unknown>;
    audit?: (event: string, payload: unknown) => void;
    now?: () => number;
}
/**
 * Refresh if stale, and never throw.
 *
 * A pricing refresh is not worth failing a run over — that is the entire
 * argument for cache-then-refresh — so every failure degrades to the cached
 * catalogue and is AUDITED rather than swallowed. A refresh that has been
 * failing for a month is a thing an operator should be able to discover
 * without reading the source.
 */
export declare function refreshCatalogue(deps: RefreshDeps): Promise<Catalogue | undefined>;
//# sourceMappingURL=model-catalogue.d.ts.map