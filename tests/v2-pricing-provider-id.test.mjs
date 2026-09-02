/**
 * Pricing on the OpenCode path: the catalogue id, the overrides, and the
 * fail-safe that said nothing.
 *
 * Three defects, one symptom. A provider id is an operator's label for an
 * endpoint; the models.dev catalogue is keyed by models.dev's own id. They
 * diverge as soon as an operator avoids clashing with an OpenCode built-in --
 * `anthropic-compat`, `openai-compat` -- and every model underneath then
 * missed the catalogue, fell past the Anthropic-only `PRICES` table, and was
 * billed at the most-expensive-known fail-safe of $15/$75 per million. Sonnet
 * 4.5 at $3/$15 came out exactly 5x over on both terms.
 *
 * `models.price_overrides`, the documented way to correct exactly this, was
 * never passed to `resolvePrice` by this router, so following the advice in
 * the startup warning changed nothing.
 *
 * And none of it was visible: the fail-safe returns a plausible number, so the
 * ledger recorded plausible dollars and the only cost warning in the router
 * fires when the figure is `undefined`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pricingModelId } from "../dist/adapters/role-config.js";
import { BackendRouter } from "../dist/adapters/backend-router.js";

const SONNET = { input: 3, output: 15 };
const FAIL_SAFE = { input: 15, output: 75 };

/** A catalogue keyed the way models.dev keys it: by ITS provider id. */
function catalogue() {
  return {
    entries: {
      "anthropic/claude-sonnet-4-5": { id: "anthropic/claude-sonnet-4-5", provider: "anthropic", model: "claude-sonnet-4-5", ...SONNET },
      "openai/gpt-5.6": { id: "openai/gpt-5.6", provider: "openai", model: "gpt-5.6", input: 4, output: 20 },
    },
    fetchedAt: Date.now(),
    providerCount: 60,
  };
}

/**
 * A router with a catalogue already loaded.
 *
 * `refreshPricing` against a store holding a FRESH catalogue returns it
 * without fetching, so this touches no network.
 */
async function router({ providers, model, priceOverrides } = {}) {
  const warnings = [];
  const audits = [];
  const r = new BackendRouter({
    backends: { default: { backend: "opencode", model, tier: "strong" } },
    providers,
    priceOverrides,
    resolveKey: () => "sk-test-not-a-real-key",
    scratchDir: mkdtempSync(join(tmpdir(), "pricing-")),
    logger: { info: () => {}, warn: (m, meta) => warnings.push({ m, meta }) },
    audit: (event, payload) => audits.push({ event, payload }),
  });
  await r.refreshPricing({ read: () => catalogue(), write: () => {} });
  return { r, warnings, audits };
}

const compat = {
  "anthropic-compat": {
    npm: "@ai-sdk/openai-compatible",
    base_url: "https://api.anthropic.com/v1",
    api_key_service: "anthropic-compat-key",
    pricing_provider: "anthropic",
  },
};

/** One million input tokens, so the reported cost IS the per-million price. */
const ONE_M_IN = { usageSource: "tokens-only", costUsd: 0, tokensIn: 1_000_000, tokensOut: 0 };

// ---------------------------------------------------------------------------
// The id rewrite
// ---------------------------------------------------------------------------

test("pricingModelId moves only the provider segment", () => {
  const providers = { "anthropic-compat": { pricing_provider: "anthropic" } };
  assert.equal(
    pricingModelId("anthropic-compat/claude-sonnet-4-5", providers),
    "anthropic/claude-sonnet-4-5",
  );
});

test("pricingModelId leaves alone what it was not told about", () => {
  // A bare id, a provider that declared no mapping, and a provider that is not
  // declared at all. Each must survive untouched: guessing here fails the same
  // silent way the bug did.
  const providers = { "anthropic-compat": { pricing_provider: "anthropic" }, local: {} };
  assert.equal(pricingModelId("claude-sonnet-4-5", providers), "claude-sonnet-4-5");
  assert.equal(pricingModelId("local/qwen-coder", providers), "local/qwen-coder");
  assert.equal(pricingModelId("openai/gpt-5.6", providers), "openai/gpt-5.6");
  assert.equal(pricingModelId("anything/at/all", {}), "anything/at/all");
});

test("pricingModelId keeps a model id that itself contains slashes", () => {
  // `openrouter/anthropic/claude-3` is a real shape. Only the FIRST segment is
  // the provider; splitting on the last slash would address a different model.
  const providers = { "router-compat": { pricing_provider: "openrouter" } };
  assert.equal(
    pricingModelId("router-compat/anthropic/claude-3", providers),
    "openrouter/anthropic/claude-3",
  );
});

// ---------------------------------------------------------------------------
// What the ledger actually records
// ---------------------------------------------------------------------------

test("a -compat provider prices off the catalogue once it declares its pricing id", async () => {
  const { r } = await router({ providers: compat, model: "anthropic-compat/claude-sonnet-4-5" });
  const priced = r.priceTurn("worker", ONE_M_IN);
  assert.equal(priced.priceSource, "catalogue");
  assert.equal(priced.costUsd, SONNET.input);
});

test("REGRESSION: without the mapping the same turn bills 5x at the fail-safe", async () => {
  // Delete `pricing_provider` and the production bug returns exactly. This is
  // the assertion that fails if the rewrite is dropped -- and 15/3 is the
  // factor every v2 cost figure was out by.
  const unmapped = { "anthropic-compat": { ...compat["anthropic-compat"], pricing_provider: undefined } };
  const { r } = await router({ providers: unmapped, model: "anthropic-compat/claude-sonnet-4-5" });
  const priced = r.priceTurn("worker", ONE_M_IN);
  assert.equal(priced.priceSource, "fail-safe");
  assert.equal(priced.costUsd, FAIL_SAFE.input);
  assert.equal(priced.costUsd / SONNET.input, 5);
});

test("price_overrides outrank the catalogue, having previously done nothing", async () => {
  const { r } = await router({
    providers: compat,
    model: "anthropic-compat/claude-sonnet-4-5",
    priceOverrides: { "anthropic/claude-sonnet-4-5": { input: 1, output: 2 } },
  });
  const priced = r.priceTurn("worker", ONE_M_IN);
  assert.equal(priced.priceSource, "override");
  assert.equal(priced.costUsd, 1);
});

test("an override can also be written against the id the operator configured", async () => {
  // An operator reaches for the string in their own config file, not the one
  // the catalogue uses. `resolvePrice` accepts the bare model id, so the
  // rewrite must not make the obvious spelling stop working.
  const { r } = await router({
    providers: compat,
    model: "anthropic-compat/claude-sonnet-4-5",
    priceOverrides: { "claude-sonnet-4-5": { input: 7, output: 9 } },
  });
  const priced = r.priceTurn("worker", ONE_M_IN);
  assert.equal(priced.priceSource, "override");
  assert.equal(priced.costUsd, 7);
});

// ---------------------------------------------------------------------------
// Saying so
// ---------------------------------------------------------------------------

test("the fail-safe announces itself, once per model", async () => {
  const unmapped = { "anthropic-compat": { ...compat["anthropic-compat"], pricing_provider: undefined } };
  const { r, warnings, audits } = await router({ providers: unmapped, model: "anthropic-compat/claude-sonnet-4-5" });

  for (let i = 0; i < 5; i++) r.priceTurn("worker", ONE_M_IN);

  const priceWarnings = warnings.filter((w) => w.m.includes("most-expensive-known"));
  assert.equal(priceWarnings.length, 1, "a per-turn warning would bury the run's real output");
  assert.match(priceWarnings[0].m, /pricing_provider/, "the warning must name the fix");

  const events = audits.filter((a) => a.event === "backend.price_fail_safe");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.model, "anthropic-compat/claude-sonnet-4-5");
});

test("a correctly priced turn says nothing at all", async () => {
  const { r, warnings, audits } = await router({ providers: compat, model: "anthropic-compat/claude-sonnet-4-5" });
  r.priceTurn("worker", ONE_M_IN);
  assert.equal(warnings.filter((w) => w.m.includes("most-expensive-known")).length, 0);
  assert.equal(audits.filter((a) => a.event === "backend.price_fail_safe").length, 0);
});

// ---------------------------------------------------------------------------
// The distinctions the ladder exists to preserve
// ---------------------------------------------------------------------------

test("a local provider still reports zero, not a catalogue price", async () => {
  // `local` is a fact about the operator's deployment, keyed on the id they
  // configured, while the rewritten id names whoever publishes the model. This
  // caught the rewrite doing real damage: a local endpoint serving a
  // catalogued model stopped matching and began billing for free tokens.
  const providers = {
    "home-lab": {
      npm: "@ai-sdk/openai-compatible",
      base_url: "http://127.0.0.1:1234/v1",
      local: true,
      pricing_provider: "anthropic",
    },
  };
  const { r } = await router({ providers, model: "home-lab/claude-sonnet-4-5" });
  const priced = r.priceTurn("worker", ONE_M_IN);
  assert.equal(priced.priceSource, "local");
  assert.equal(priced.costUsd, 0);
});

test("usage nobody measured stays undefined rather than becoming a free turn", async () => {
  const { r } = await router({ providers: compat, model: "anthropic-compat/claude-sonnet-4-5" });
  const priced = r.priceTurn("worker", { usageSource: "unavailable", costUsd: 0, tokensIn: 0, tokensOut: 0 });
  assert.equal(priced.costUsd, undefined);
  assert.equal(priced.priceSource, "unmeasured");
});

test("a turn the agent priced itself is believed, rewrite or no rewrite", async () => {
  const { r } = await router({ providers: compat, model: "anthropic-compat/claude-sonnet-4-5" });
  const priced = r.priceTurn("worker", { usageSource: "acp-delta", costUsd: 0.42, tokensIn: 10, tokensOut: 10 });
  assert.equal(priced.costUsd, 0.42);
  assert.equal(priced.priceSource, "agent");
});
