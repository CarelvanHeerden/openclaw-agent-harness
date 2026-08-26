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

import { PRICES, mostExpensivePrice } from "./pricing.js";

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
export const CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;

export const MODELS_DEV_URL = "https://models.dev/api.json";

/**
 * The fetch is bounded. A hung TLS handshake against a third-party host must
 * not be able to hold a refresh open indefinitely, even off the hot path,
 * because the refresh holds a lock that a later one would wait on.
 */
export const CATALOGUE_FETCH_TIMEOUT_MS = 20_000;

/**
 * A response declaring fewer providers than this is treated as corrupt.
 *
 * models.dev carries ~199 providers. A response with three is not a smaller
 * catalogue, it is a different document — an error page, a partial write, a
 * CDN serving something else — and accepting it would silently narrow pricing
 * to whatever survived. The floor is deliberately far below the real count so
 * it flags catastrophe, not drift.
 */
export const MIN_PLAUSIBLE_PROVIDERS = 20;

export class CatalogueRejected extends Error {
  constructor(readonly reason: string) {
    super(`models.dev response rejected: ${reason}`);
    this.name = "CatalogueRejected";
  }
}

function isFiniteNonNegative(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
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
export function parseModelsDevCatalogue(raw: unknown, now = Date.now()): Catalogue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CatalogueRejected("top level is not an object");
  }

  const providers = Object.entries(raw as Record<string, unknown>);
  if (providers.length < MIN_PLAUSIBLE_PROVIDERS) {
    throw new CatalogueRejected(
      `only ${providers.length} providers (expected at least ${MIN_PLAUSIBLE_PROVIDERS}); ` +
      `this is not a smaller catalogue, it is a different document`,
    );
  }

  const entries: Record<string, CatalogueEntry> = {};

  for (const [providerId, providerRaw] of providers) {
    if (providerRaw === null || typeof providerRaw !== "object") {
      throw new CatalogueRejected(`provider '${providerId}' is not an object`);
    }
    const models = (providerRaw as { models?: unknown }).models;
    if (models === undefined) continue;
    if (models === null || typeof models !== "object" || Array.isArray(models)) {
      throw new CatalogueRejected(`provider '${providerId}' has a non-object 'models'`);
    }

    for (const [modelId, modelRaw] of Object.entries(models as Record<string, unknown>)) {
      if (modelRaw === null || typeof modelRaw !== "object") continue;
      const cost = (modelRaw as { cost?: unknown }).cost;
      if (cost === null || typeof cost !== "object") continue;

      const c = cost as Record<string, unknown>;
      // Both terms must be present and sane. A model priced only on input
      // would project at a fraction of its real cost, which is the beta.61
      // failure with extra steps.
      if (!isFiniteNonNegative(c.input) || !isFiniteNonNegative(c.output)) continue;

      const limit = (modelRaw as { limit?: unknown }).limit;
      const l = (limit !== null && typeof limit === "object" ? limit : {}) as Record<string, unknown>;

      const id = `${providerId}/${modelId}`;
      entries[id] = {
        id,
        provider: providerId,
        model: modelId,
        input: c.input,
        output: c.output,
        ...(isFiniteNonNegative(c.cache_read) ? { cache_read: c.cache_read } : {}),
        ...(isFiniteNonNegative(c.cache_write) ? { cache_write: c.cache_write } : {}),
        ...(isFiniteNonNegative(l.context) ? { contextLimit: l.context } : {}),
        ...(isFiniteNonNegative(l.output) ? { outputLimit: l.output } : {}),
      };
    }
  }

  if (Object.keys(entries).length === 0) {
    throw new CatalogueRejected("no priced models in the response");
  }

  return { entries, fetchedAt: now, providerCount: providers.length };
}

export function isCatalogueStale(cat: Catalogue | undefined, now = Date.now()): boolean {
  if (!cat) return true;
  return now - cat.fetchedAt >= CATALOGUE_TTL_MS;
}

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
export function resolvePrice(input: PriceLookupInput): PriceResolution {
  const { model, overrides, catalogue, localProviders } = input;

  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
  const bare = provider ? model.slice(model.indexOf("/") + 1) : model;

  // An override may be written either way round, because an operator who
  // configured `local/qwen` will reach for that same string here.
  const ov = overrides?.[model] ?? overrides?.[bare];
  if (ov) return { price: ov, source: "override", billable: true };

  // Local is checked AFTER overrides: an operator who prices a local model has
  // said something specific and deliberate, and is entitled to be obeyed.
  if (provider && localProviders?.has(provider)) {
    return { price: { input: 0, output: 0 }, source: "local", billable: false };
  }

  const hit = catalogue?.entries[model];
  if (hit) return { price: hit, source: "catalogue", billable: true };

  const table = PRICES[model] ?? PRICES[bare];
  if (table) return { price: table, source: "table", billable: true };

  return { price: mostExpensivePrice(PRICES), source: "fail-safe", billable: true };
}

/** Cost of a completed call. Returns `undefined` when the model is not billable. */
export function costOf(
  tokensIn: number,
  tokensOut: number,
  resolution: PriceResolution,
): number | undefined {
  if (!resolution.billable) return undefined;
  return (tokensIn * resolution.price.input + tokensOut * resolution.price.output) / 1_000_000;
}

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

async function defaultFetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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
export async function refreshCatalogue(deps: RefreshDeps): Promise<Catalogue | undefined> {
  const now = deps.now?.() ?? Date.now();
  const cached = deps.store.read();
  if (!isCatalogueStale(cached, now)) return cached;

  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  try {
    const raw = await fetchJson(MODELS_DEV_URL, CATALOGUE_FETCH_TIMEOUT_MS);
    const fresh = parseModelsDevCatalogue(raw, now);
    deps.store.write(fresh);
    deps.audit?.("pricing.refresh.ok", {
      providers: fresh.providerCount,
      models: Object.keys(fresh.entries).length,
    });
    return fresh;
  } catch (err) {
    deps.audit?.("pricing.refresh.failed", {
      reason: err instanceof Error ? err.message : String(err),
      rejected: err instanceof CatalogueRejected,
      servingCachedFrom: cached?.fetchedAt ?? null,
    });
    return cached;
  }
}
