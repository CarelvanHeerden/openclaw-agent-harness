/**
 * The state-DB binding for the models.dev pricing catalogue.
 *
 * Kept out of `store.ts` and off the `StateStore` interface deliberately: this
 * is a cache, and nothing in the harness should be able to reach for it as
 * though it were state. Losing every row costs exactly one refresh.
 *
 * Reads are defensive because the row is a JSON blob written by a previous
 * version of this code. An unreadable or shape-shifted payload is treated as a
 * cache miss — the caller then refreshes, or falls back to `PRICES` — rather
 * than as an error, because there is no failure here worth propagating to a
 * run. See `model-catalogue.ts` for the ladder that consumes it.
 */
import type { DatabaseSync } from "node:sqlite";
import type { CatalogueStore } from "../adapters/shared/model-catalogue.js";
export declare function catalogueStore(db: DatabaseSync): CatalogueStore;
//# sourceMappingURL=price-cache.d.ts.map