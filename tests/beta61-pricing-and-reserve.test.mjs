// beta.61 — opus pricing + unknown-model fail-safe + drift warning + budget
// reservation + Anthropic /v1/models health check.
//
// The b60 smoke aborted at $10.93/$10 (109%): classifier est $0.05, planner
// est $0.72, actual $10.93 (~15x under). Two root causes:
//  (1) PRICING: worker was swapped sonnet->opus but the PRICES table had no
//      opus entry, so estimateSubTaskCost fell through to the sonnet fallback
//      (~5x too low) AND checkPriceDrift silently no-op'd on the unknown model
//      (warn:false), so the mispricing never surfaced.
//  (2) NO RESERVE: the last sub-task passed the budget gate, then the pending
//      adversary review had no budget -> all findings addressed but NO PR (one
//      review short of the deliverable).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const sdk = await import("../dist/adapters/claude-sdk.js");

// ---- Fix 1: opus pricing + fail-safe unknown-model fallback ----
test("beta61: opus-tier models are now priced (no longer fall through to sonnet)", () => {
  const { PRICES, estimateSubTaskCost } = sdk;
  // opus aliases present and priced ABOVE sonnet
  for (const opus of ["claude-opus-4-8", "opus"]) {
    assert.ok(PRICES[opus], `${opus} must be in PRICES`);
    assert.ok(PRICES[opus].output > PRICES["claude-sonnet-5"].output, `${opus} must be pricier than sonnet`);
  }
  // an opus sub-task now costs MORE than the same tokens at sonnet
  const tokens = 30000;
  const opusCost = estimateSubTaskCost("claude-opus-4-8", tokens);
  const sonnetCost = estimateSubTaskCost("claude-sonnet-5", tokens);
  assert.ok(opusCost > sonnetCost * 2, "opus est must be materially higher than sonnet (was priced as sonnet in b60)");
});

test("beta61: unknown model is priced at the MOST-EXPENSIVE tier (fail-safe over-reserve), not sonnet", () => {
  const { estimateSubTaskCost, mostExpensivePrice, PRICES } = sdk;
  const tokens = 30000;
  const unknownCost = estimateSubTaskCost("some-future-model-xyz", tokens);
  const sonnetCost = estimateSubTaskCost("claude-sonnet-5", tokens);
  assert.ok(unknownCost > sonnetCost, "unknown model must NOT be cheaper-than-or-equal sonnet (that under-reserves)");
  // equals the most-expensive-tier estimate
  const top = mostExpensivePrice(PRICES);
  const topCost = (tokens * 0.2 * top.input + tokens * 0.8 * top.output) / 1_000_000;
  assert.equal(unknownCost, topCost);
});

test("beta61: isUnknownModel true for unpriced, false for table/override entries", () => {
  const { isUnknownModel } = sdk;
  assert.equal(isUnknownModel("claude-sonnet-5"), false);
  assert.equal(isUnknownModel("claude-opus-4-8"), false);
  assert.equal(isUnknownModel("mystery-model"), true);
  assert.equal(isUnknownModel("mystery-model", { "mystery-model": { input: 1, output: 2 } }), false);
});

// ---- Fix 2: checkPriceDrift warns on unknown models ----
test("beta61: checkPriceDrift WARNS on an unknown model (b60: it silently returned warn:false)", () => {
  const { checkPriceDrift } = sdk;
  const r = checkPriceDrift("opus-not-in-table-xyz", 10.93, 200000, 150000);
  assert.equal(r.warn, true, "unknown model must warn");
  assert.equal(r.unknownModel, true);
  assert.ok(r.estimated > 0, "must compute an estimate at the fail-safe most-expensive price");
  // known model with matching cost does NOT warn
  const known = checkPriceDrift("claude-sonnet-5", (200000 * 3 + 150000 * 15) / 1_000_000, 200000, 150000);
  assert.equal(known.warn, false);
});

// ---- Fix 3: budget reservation ----
test("beta61: budget_reserve_ratio config default present and clamped in source", async () => {
  const { parseHarnessConfig } = await import("../dist/config.js");
  const c = parseHarnessConfig({ slack: { authorised_users: ["U0TEST"] }, repos: { allowed: ["acme/*"] } });
  assert.equal(c.loop.budget_reserve_ratio, 0.15);
  // manifest declares it
  const src = S("openclaw.plugin.json");
  assert.match(src, /"budget_reserve_ratio"/);
  assert.match(src, /"maximum":\s*0\.9/);
});

test("beta61: projection gate adds the review reserve (aborts before a sub-task that leaves no room for the review)", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /budget_reserve_ratio \?\? 0\.15/);
  assert.match(src, /const reserve = row\.budget_usd \* Math\.max\(0, Math\.min\(0\.9, reserveRatio\)\)/);
  assert.match(src, /if \(projected \+ reserve > row\.budget_usd\)/);
  // the abort audit now carries the reserve
  assert.match(src, /"loop\.budget_projection_abort"[\s\S]*?reserve/);
});

// ---- Fix 4: Anthropic /v1/models health check ----
test("beta61: fetchLiveModelIds parses /v1/models data ids and fails soft on error", async () => {
  const { fetchLiveModelIds } = sdk;
  // no key -> null
  assert.equal(await fetchLiveModelIds(""), null);
  // ok response
  const okFetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "claude-opus-4-8" }, { id: "claude-sonnet-5" }, { bad: 1 }] }) });
  const ids = await fetchLiveModelIds("sk-test", { fetchImpl: okFetch });
  assert.deepEqual(ids, ["claude-opus-4-8", "claude-sonnet-5"]);
  // non-ok -> null
  const badFetch = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await fetchLiveModelIds("sk-test", { fetchImpl: badFetch }), null);
  // throw -> null (never throws)
  const throwFetch = async () => { throw new Error("network"); };
  assert.equal(await fetchLiveModelIds("sk-test", { fetchImpl: throwFetch }), null);
});

test("beta61: assessModelPricingHealth flags unpriced + not-live configured models", () => {
  const { assessModelPricingHealth } = sdk;
  const configured = ["claude-fable-5", "brand-new-opus", "claude-sonnet-5"];
  const live = ["claude-fable-5", "claude-sonnet-5", "brand-new-opus"];
  const h = assessModelPricingHealth(configured, live);
  const byModel = Object.fromEntries(h.map((x) => [x.model, x]));
  assert.equal(byModel["claude-fable-5"].unpriced, false);
  assert.equal(byModel["brand-new-opus"].unpriced, true, "not in price table");
  assert.equal(byModel["brand-new-opus"].notLive, false, "but IS in the live list");
  // a configured model absent from the live list is notLive=true
  const h2 = assessModelPricingHealth(["renamed-old-model"], ["claude-sonnet-5"]);
  assert.equal(h2[0].notLive, true);
  // null liveIds -> notLive left undefined (unknown, not false)
  const h3 = assessModelPricingHealth(["claude-sonnet-5"], null);
  assert.equal(h3[0].notLive, undefined);
});

test("beta61: startup pricing-health check wired into bootstrapHarnessAsync", () => {
  const src = S("src/index.ts");
  assert.match(src, /fetchLiveModelIds, *\n? *assessModelPricingHealth|fetchLiveModelIds,\s*assessModelPricingHealth/s);
  assert.match(src, /assessModelPricingHealth\(configuredModels, liveIds, config\.models\.price_overrides\)/);
  assert.match(src, /harness\.model_pricing_unpriced/);
  assert.match(src, /no price-table entry/i);
});
