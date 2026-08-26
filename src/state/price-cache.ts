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

import type { Catalogue, CatalogueStore } from "../adapters/shared/model-catalogue.js";

/** Enough of the parsed document to trust it came from `parseModelsDevCatalogue`. */
function looksLikeCatalogue(x: unknown): x is Catalogue {
  if (x === null || typeof x !== "object") return false;
  const c = x as Partial<Catalogue>;
  if (typeof c.fetchedAt !== "number" || !Number.isFinite(c.fetchedAt)) return false;
  if (c.entries === null || typeof c.entries !== "object") return false;
  return Object.keys(c.entries).length > 0;
}

export function catalogueStore(db: DatabaseSync): CatalogueStore {
  return {
    read: () => {
      try {
        const row = db
          .prepare(`SELECT payload FROM model_prices WHERE id = 1`)
          .get() as { payload?: string } | undefined;
        if (!row?.payload) return undefined;
        const parsed: unknown = JSON.parse(row.payload);
        return looksLikeCatalogue(parsed) ? parsed : undefined;
      } catch {
        // A malformed cache is a miss, never a crash.
        return undefined;
      }
    },

    write: (cat: Catalogue) => {
      try {
        db.prepare(
          `INSERT INTO model_prices (id, fetched_at, payload) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at,
                                           payload    = excluded.payload`,
        ).run(cat.fetchedAt, JSON.stringify(cat));
      } catch {
        // A cache that cannot be written is a cache that stays cold. The next
        // run refreshes again; nothing downstream depends on this succeeding.
      }
    },
  };
}
