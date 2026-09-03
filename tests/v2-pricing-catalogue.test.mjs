/**
 * M8: models.dev pricing, and the cost leaks it exists to make visible.
 *
 * Two halves that belong together. The catalogue is untrusted input feeding
 * every budget decision, so the tests are mostly about what it REFUSES. The
 * leak fixes are about a subtler failure: a zero that meant "nobody looked"
 * being indistinguishable from a zero that meant "free".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CATALOGUE_TTL_MS,
  CatalogueRejected,
  MIN_PLAUSIBLE_PROVIDERS,
  MODELS_DEV_URL,
  costOf,
  isCatalogueStale,
  parseModelsDevCatalogue,
  refreshCatalogue,
  resolvePrice,
} from "../dist/adapters/shared/model-catalogue.js";
import { PRICES } from "../dist/adapters/shared/pricing.js";

const root = resolve(import.meta.dirname, "..");

/** A response with enough providers to clear the plausibility floor. */
function plausible(extra = {}) {
  const out = {};
  for (let i = 0; i < MIN_PLAUSIBLE_PROVIDERS + 5; i++) {
    out[`p${i}`] = { models: { m: { cost: { input: 1, output: 2 } } } };
  }
  return { ...out, ...extra };
}

// ---------------------------------------------------------------------------
// What the parser refuses
// ---------------------------------------------------------------------------

test("a response that is not an object is rejected", () => {
  for (const bad of [null, [], "nope", 42]) {
    assert.throws(() => parseModelsDevCatalogue(bad), CatalogueRejected);
  }
});

test("an implausibly small response is rejected as a DIFFERENT document", () => {
  // Three providers is not a smaller catalogue; it is an error page, a partial
  // write, or a CDN serving something else. Accepting it would silently narrow
  // pricing to whatever survived.
  assert.throws(
    () => parseModelsDevCatalogue({
      a: { models: { m: { cost: { input: 1, output: 2 } } } },
      b: { models: {} },
      c: { models: {} },
    }),
    (err) => err instanceof CatalogueRejected && /different document/.test(err.message),
  );
});

test("a malformed provider rejects the WHOLE response, not just that provider", () => {
  // All-or-nothing on shape: a half-applied catalogue is the one failure with
  // no legible symptom, because the prices that survived look exactly like the
  // prices that were checked.
  assert.throws(
    () => parseModelsDevCatalogue(plausible({ broken: "not an object" })),
    CatalogueRejected,
  );
  assert.throws(
    () => parseModelsDevCatalogue(plausible({ broken: { models: "not an object" } })),
    CatalogueRejected,
  );
});

test("a response with no priced models at all is rejected", () => {
  const empty = {};
  for (let i = 0; i < MIN_PLAUSIBLE_PROVIDERS + 5; i++) empty[`p${i}`] = { models: {} };
  assert.throws(() => parseModelsDevCatalogue(empty), CatalogueRejected);
});

// ---------------------------------------------------------------------------
// What the parser accepts, and how
// ---------------------------------------------------------------------------

test("per-model gaps are SKIPPED, not fatal", () => {
  // models.dev legitimately lists models with no published pricing. Rejecting
  // the document over one would mean never having a catalogue at all.
  const cat = parseModelsDevCatalogue(plausible({
    anthropic: {
      models: {
        good: { cost: { input: 3, output: 15 } },
        unpriced: {},
        "cost-not-object": { cost: "nope" },
      },
    },
  }));
  assert.ok(cat.entries["anthropic/good"], "the priced model was dropped");
  assert.equal(cat.entries["anthropic/unpriced"], undefined);
  assert.equal(cat.entries["anthropic/cost-not-object"], undefined);
});

test("a model priced on input alone is skipped", () => {
  // Half a price projects at a fraction of the real cost, which is the beta.61
  // failure with extra steps.
  const cat = parseModelsDevCatalogue(plausible({
    x: { models: { half: { cost: { input: 3 } } } },
  }));
  assert.equal(cat.entries["x/half"], undefined);
});

test("negative and non-finite prices are skipped", () => {
  const cat = parseModelsDevCatalogue(plausible({
    x: {
      models: {
        neg: { cost: { input: -1, output: 2 } },
        nan: { cost: { input: Number.NaN, output: 2 } },
        inf: { cost: { input: 1, output: Number.POSITIVE_INFINITY } },
      },
    },
  }));
  for (const id of ["x/neg", "x/nan", "x/inf"]) assert.equal(cat.entries[id], undefined, id);
});

test("entries are keyed provider/model, matching how roles address them", () => {
  const cat = parseModelsDevCatalogue(plausible({
    anthropic: { models: { "claude-x": { cost: { input: 3, output: 15 }, limit: { context: 200000, output: 64000 } } } },
  }));
  const e = cat.entries["anthropic/claude-x"];
  assert.equal(e.provider, "anthropic");
  assert.equal(e.model, "claude-x");
  assert.equal(e.input, 3);
  assert.equal(e.output, 15);
  assert.equal(e.contextLimit, 200000);
  assert.equal(e.outputLimit, 64000);
});

test("cache read/write prices come through when present", () => {
  const cat = parseModelsDevCatalogue(plausible({
    x: { models: { m: { cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
  }));
  assert.equal(cat.entries["x/m"].cache_read, 0.1);
  assert.equal(cat.entries["x/m"].cache_write, 1.25);
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

test("the ladder runs override, then catalogue, then table, then fail-safe", () => {
  const catalogue = parseModelsDevCatalogue(plausible({
    anthropic: { models: { "claude-x": { cost: { input: 3, output: 15 } } } },
  }));

  // 1. An override outranks everything.
  assert.equal(
    resolvePrice({ model: "anthropic/claude-x", catalogue, overrides: { "anthropic/claude-x": { input: 99, output: 99 } } }).source,
    "override",
  );

  // 2. The catalogue, when it has the id.
  assert.equal(resolvePrice({ model: "anthropic/claude-x", catalogue }).source, "catalogue");

  // 3. The offline table, for ids the catalogue does not carry.
  const table = resolvePrice({ model: "claude-fable-5", catalogue });
  assert.equal(table.source, "table");
  assert.deepEqual({ input: table.price.input, output: table.price.output }, PRICES["claude-fable-5"]);

  // 4. The beta.61 fail-safe: unknown models OVER-reserve, because
  //    under-reserving lets a run overshoot and that is only visible later.
  const unknown = resolvePrice({ model: "who/knows", catalogue });
  assert.equal(unknown.source, "fail-safe");
  const dearest = Math.max(...Object.values(PRICES).map((p) => p.output));
  assert.equal(unknown.price.output, dearest, "the fail-safe is not the most expensive known price");
});

test("an override may be written bare or qualified", () => {
  // An operator who configured `local/qwen` will reach for that same string.
  assert.equal(resolvePrice({ model: "local/qwen", overrides: { "local/qwen": { input: 1, output: 1 } } }).source, "override");
  assert.equal(resolvePrice({ model: "local/qwen", overrides: { qwen: { input: 1, output: 1 } } }).source, "override");
});

test("a local provider reports tokens, never dollars", () => {
  const r = resolvePrice({ model: "lmstudio/qwen", localProviders: new Set(["lmstudio"]) });
  assert.equal(r.source, "local");
  assert.equal(r.billable, false);
  // The distinction the old `costUsd: 0` erased: undefined is "does not
  // apply", zero is "measured as free".
  assert.equal(costOf(1000, 2000, r), undefined);
});

test("an explicit override beats the local flag", () => {
  // An operator who prices a local model has said something deliberate.
  const r = resolvePrice({
    model: "lmstudio/qwen",
    localProviders: new Set(["lmstudio"]),
    overrides: { "lmstudio/qwen": { input: 0.5, output: 1 } },
  });
  assert.equal(r.source, "override");
  assert.equal(r.billable, true);
  assert.equal(costOf(1_000_000, 1_000_000, r), 1.5);
});

test("costOf is tokens times price per million", () => {
  const r = resolvePrice({ model: "anthropic/x", overrides: { "anthropic/x": { input: 10, output: 50 } } });
  assert.equal(costOf(1_000_000, 0, r), 10);
  assert.equal(costOf(0, 1_000_000, r), 50);
  assert.equal(costOf(500_000, 200_000, r), 10 * 0.5 + 50 * 0.2);
});

// ---------------------------------------------------------------------------
// Refresh: bounded, cached, never fatal
// ---------------------------------------------------------------------------

function memStore(initial) {
  let held = initial;
  return { read: () => held, write: (c) => { held = c; }, current: () => held };
}

test("a fresh cache is served without any fetch at all", async () => {
  const cached = parseModelsDevCatalogue(plausible(), 1000);
  const store = memStore(cached);
  let fetched = false;
  const out = await refreshCatalogue({
    store,
    now: () => 1000 + CATALOGUE_TTL_MS - 1,
    fetchJson: async () => { fetched = true; return plausible(); },
  });
  assert.equal(fetched, false, "a fresh cache still hit the network");
  assert.equal(out, cached);
});

test("a stale cache triggers a refresh and is replaced", async () => {
  const store = memStore(parseModelsDevCatalogue(plausible(), 1000));
  const out = await refreshCatalogue({
    store,
    now: () => 1000 + CATALOGUE_TTL_MS,
    fetchJson: async () => plausible({ anthropic: { models: { neu: { cost: { input: 1, output: 1 } } } } }),
  });
  assert.ok(out.entries["anthropic/neu"], "the refreshed catalogue was not returned");
  assert.ok(store.current().entries["anthropic/neu"], "the refreshed catalogue was not persisted");
});

test("a failed fetch degrades to the last good cache and is AUDITED", async () => {
  // A pricing refresh is never worth failing a run over, but a refresh that
  // has been failing for a month must be discoverable without reading source.
  const cached = parseModelsDevCatalogue(plausible(), 1000);
  const store = memStore(cached);
  const events = [];
  const out = await refreshCatalogue({
    store,
    now: () => 1000 + CATALOGUE_TTL_MS,
    fetchJson: async () => { throw new Error("ETIMEDOUT"); },
    audit: (e, p) => events.push([e, p]),
  });
  assert.equal(out, cached, "a failed refresh did not fall back to cache");
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "pricing.refresh.failed");
  assert.match(events[0][1].reason, /ETIMEDOUT/);
  assert.equal(events[0][1].servingCachedFrom, 1000);
});

test("a REJECTED response is audited as rejected, and the cache is untouched", async () => {
  const cached = parseModelsDevCatalogue(plausible(), 1000);
  const store = memStore(cached);
  const events = [];
  const out = await refreshCatalogue({
    store,
    now: () => 1000 + CATALOGUE_TTL_MS,
    fetchJson: async () => ({ only: "one provider" }),
    audit: (e, p) => events.push([e, p]),
  });
  assert.equal(out, cached);
  assert.equal(events[0][1].rejected, true, "a schema rejection was not distinguished from a network failure");
  assert.equal(store.current(), cached, "a rejected response overwrote the good cache");
});

test("a refresh never throws, even with no cache to fall back to", async () => {
  const out = await refreshCatalogue({
    store: memStore(undefined),
    fetchJson: async () => { throw new Error("boom"); },
  });
  assert.equal(out, undefined);
});

test("a successful refresh is audited with what it got", async () => {
  const events = [];
  await refreshCatalogue({
    store: memStore(undefined),
    fetchJson: async () => plausible(),
    audit: (e, p) => events.push([e, p]),
  });
  assert.equal(events[0][0], "pricing.refresh.ok");
  assert.ok(events[0][1].models > 0);
  assert.ok(events[0][1].providers >= MIN_PLAUSIBLE_PROVIDERS);
});

test("the fetch is bounded by a timeout", async () => {
  let sawTimeout;
  await refreshCatalogue({
    store: memStore(undefined),
    fetchJson: async (url, timeoutMs) => { sawTimeout = timeoutMs; assert.equal(url, MODELS_DEV_URL); return plausible(); },
  });
  assert.ok(sawTimeout > 0 && sawTimeout <= 60_000, `implausible fetch timeout: ${sawTimeout}`);
});

test("staleness is a day", () => {
  assert.equal(CATALOGUE_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(isCatalogueStale(undefined), true);
  const cat = parseModelsDevCatalogue(plausible(), 0);
  assert.equal(isCatalogueStale(cat, CATALOGUE_TTL_MS - 1), false);
  assert.equal(isCatalogueStale(cat, CATALOGUE_TTL_MS), true);
});

// ---------------------------------------------------------------------------
// The cost leaks
// ---------------------------------------------------------------------------

test("the crystallise pass reports what it spent, on every exit", async () => {
  const { crystallisePrompt } = await import("../dist/crystallise/prompt-refiner.js");
  const base = {
    config: { brief: {} },
    logger: { info: () => {}, warn: () => {} },
  };

  // The reject path still paid for a classifier call.
  const rejected = await crystallisePrompt("x", {
    ...base,
    callClassifier: async () => ({ intent: "not_dev", reason: "chat", costUsd: 0.004, tokensIn: 900, tokensOut: 40 }),
    callCrystalliser: async () => { throw new Error("must not be called"); },
  });
  assert.equal(rejected.kind, "reject");
  assert.equal(rejected.spend.costUsd, 0.004, "a rejected request reported as free");

  // So did the clarify path.
  const clarified = await crystallisePrompt("x", {
    ...base,
    callClassifier: async () => ({ intent: "clarify", reason: "", suggestedClarification: "which repo?", costUsd: 0.003 }),
    callCrystalliser: async () => { throw new Error("must not be called"); },
  });
  assert.equal(clarified.kind, "clarify");
  assert.equal(clarified.spend.costUsd, 0.003);
});

test("a successful crystallise sums the classifier AND the brief", async () => {
  const { crystallisePrompt } = await import("../dist/crystallise/prompt-refiner.js");
  const out = await crystallisePrompt("build a thing", {
    config: { brief: {} },
    logger: { info: () => {}, warn: () => {} },
    callClassifier: async () => ({ intent: "dev", reason: "", costUsd: 0.004, tokensIn: 900, tokensOut: 40 }),
    callCrystalliser: async () => ({
      title: "Add a thing", motivation: "Because the thing is missing.", acceptanceCriteria: ["it exists"],
      filesLikelyTouched: [], outOfScope: [], riskLevel: "low",
      costUsd: 0.02, tokensIn: 3000, tokensOut: 800,
    }),
  });
  assert.equal(out.kind, "brief");
  assert.equal(Number(out.spend.costUsd.toFixed(6)), 0.024);
  assert.equal(out.spend.tokensIn, 3900);
  assert.equal(out.spend.tokensOut, 840);
  assert.equal(out.spend.partial, false);
});

test("tokens without a price mark the total as a FLOOR, not a total", async () => {
  // A local model run and a free run must not be the same number.
  const { crystallisePrompt } = await import("../dist/crystallise/prompt-refiner.js");
  const out = await crystallisePrompt("x", {
    config: { brief: {} },
    logger: { info: () => {}, warn: () => {} },
    callClassifier: async () => ({ intent: "dev", reason: "", tokensIn: 900, tokensOut: 40 }),
    callCrystalliser: async () => ({
      title: "Add a thing", motivation: "Because the thing is missing.", acceptanceCriteria: ["it exists"],
      filesLikelyTouched: [], outOfScope: [], riskLevel: "low",
      costUsd: 0.02, tokensIn: 100, tokensOut: 10,
    }),
  });
  assert.equal(out.spend.partial, true, "a tokens-only call did not flag the total as partial");
  assert.equal(out.spend.costUsd, 0.02);
  assert.equal(out.spend.tokensIn, 1000);
});

test("the wiring no longer hardcodes a zero crystallise cost", () => {
  const src = readFileSync(resolve(root, "src/index.ts"), "utf8");
  const before = src.indexOf("crystallisePrompt returns a discriminated union");
  assert.equal(before, -1, "the old zero-cost comment is still there");
  assert.match(src, /const costUsd = result\.spend\.costUsd/,
    "index.ts does not read the spend total through");
});

test("the scout's cost survives an empty report, which is where a TIMEOUT lands", () => {
  // `scoutRepo` returns `timedOut: true` with an empty report rather than
  // throwing, so the most expensive scout outcome was the one being zeroed.
  const src = readFileSync(resolve(root, "src/orchestrator/lead.ts"), "utf8");
  const branch = src.slice(src.indexOf('skippedReason: "empty_report"'));
  const window = branch.slice(0, 400);
  assert.match(window, /costUsd: result\?\.costUsd/, "the empty-report branch still drops the scout cost");
  assert.match(window, /timedOut: result\?\.timedOut/, "the empty-report branch still drops the timeout flag");
});

test("the bounded workerContext top-up is billed into the lead total", () => {
  const src = readFileSync(resolve(root, "src/orchestrator/lead.ts"), "utf8");
  assert.match(src, /leadCallCostUsd \+= topUp\.costUsd \?\? 0/,
    "the workerContext top-up is still free in the ledger");
});

test("the revise-spec turn returns its cost at the wiring", () => {
  const src = readFileSync(resolve(root, "src/index.ts"), "utf8");
  assert.match(src, /return \{ subTasks: r\.subTasks, costUsd: r\.costUsd/,
    "runLeadReviseSpec still drops the cost it was handed");
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the pricing cache has a table and it is a single row", () => {
  const sql = readFileSync(resolve(root, "src/state/schema.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS model_prices/);
  assert.match(sql, /CHECK \(id = 1\)/, "the cache table permits more than one row");
});

test("a corrupt cache row reads as a MISS, never a crash", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { catalogueStore } = await import("../dist/state/price-cache.js");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE model_prices (id INTEGER PRIMARY KEY CHECK (id = 1), fetched_at INTEGER NOT NULL, payload TEXT NOT NULL)`);
  const store = catalogueStore(db);

  assert.equal(store.read(), undefined, "an empty table did not read as a miss");

  db.prepare(`INSERT INTO model_prices (id, fetched_at, payload) VALUES (1, 1, ?)`).run("{not json");
  assert.equal(store.read(), undefined, "unparseable JSON did not read as a miss");

  db.prepare(`UPDATE model_prices SET payload = ? WHERE id = 1`).run(JSON.stringify({ entries: {}, fetchedAt: 1 }));
  assert.equal(store.read(), undefined, "an empty catalogue did not read as a miss");

  const good = parseModelsDevCatalogue(plausible(), 4242);
  store.write(good);
  const back = store.read();
  assert.equal(back.fetchedAt, 4242);
  assert.ok(Object.keys(back.entries).length > 0);
  db.close();
});

test("the catalogue module depends on no backend", () => {
  const src = readFileSync(resolve(root, "src/adapters/shared/model-catalogue.ts"), "utf8");
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(!/claude-code|acp|@anthropic/.test(spec), `model-catalogue imports a backend: ${spec}`);
  }
});
