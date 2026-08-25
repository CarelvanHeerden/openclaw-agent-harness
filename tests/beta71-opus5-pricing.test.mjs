// beta.71 — Opus 5 pricing.
//
// Opus 5 launched 2026-07-24 (API id "claude-opus-5"), priced $5 in / $25 out
// per Mtok -- HALF of Fable 5's 10/50 and half of Opus 4.8's 15/75. It beats
// Fable on agentic coding (Frontier-Bench 43.3% vs 33.7%) at half the cost, so
// it's a strong orchestrator candidate. Before swapping models.lead to it, the
// PRICES table needs an exact entry or the beta.61 unknown-model fail-safe
// prices it at the most-expensive tier (Fable's 50 output) -> ~2x over-reserve
// + a spurious drift warning. This adds claude-opus-5 = 5/25 and asserts:
//   (1) it's priced, and cheaper than Fable/Opus-4.8 but pricier than sonnet;
//   (2) it's no longer an "unknown model" (fail-safe/drift path not taken);
//   (3) it does NOT change mostExpensivePrice() -- Fable's 50 stays the top.
import test from "node:test";
import assert from "node:assert/strict";

const sdk = await import("../dist/adapters/claude-code.js");

test("beta71: claude-opus-5 (+aliases) is priced at 5/25", () => {
  const { PRICES } = sdk;
  for (const id of ["claude-opus-5", "opus-5", "opus5"]) {
    assert.ok(PRICES[id], `${id} must be in PRICES`);
    assert.equal(PRICES[id].input, 5, `${id} input must be 5`);
    assert.equal(PRICES[id].output, 25, `${id} output must be 25`);
  }
});

test("beta71: opus-5 sits between sonnet and Fable/Opus-4.8 on price", () => {
  const { PRICES } = sdk;
  const o5 = PRICES["claude-opus-5"].output;
  assert.ok(o5 > PRICES["claude-sonnet-5"].output, "opus-5 must be pricier than sonnet (15)");
  assert.ok(o5 < PRICES["claude-fable-5"].output, "opus-5 must be cheaper than Fable (50)");
  assert.ok(o5 < PRICES["claude-opus-4-8"].output, "opus-5 must be cheaper than Opus 4.8 (75)");
});

test("beta71: estimateSubTaskCost prices opus-5 at half of Fable for the same tokens", () => {
  const { estimateSubTaskCost } = sdk;
  const tokens = 30000;
  const opus5 = estimateSubTaskCost("claude-opus-5", tokens);
  const fable = estimateSubTaskCost("claude-fable-5", tokens);
  // 5/25 vs 10/50 -> exactly half on both terms
  assert.ok(Math.abs(opus5 * 2 - fable) < 1e-9, "opus-5 must be exactly half of Fable per token");
});

test("beta71: opus-5 is NOT an unknown model (no fail-safe over-reserve, no drift warn)", () => {
  const { isUnknownModel, checkPriceDrift } = sdk;
  assert.equal(isUnknownModel("claude-opus-5"), false);
  // With a real 5/25 table entry, an actual cost matching the estimate must
  // NOT warn and must NOT be flagged unknownModel (contrast the b60 miss where
  // the unpriced opus fell through to warn:true, unknownModel:true).
  const tokensIn = 6000, tokensOut = 24000; // 20/80 split of 30k
  const estimated = (tokensIn * 5 + tokensOut * 25) / 1_000_000;
  const drift = checkPriceDrift("claude-opus-5", estimated, tokensIn, tokensOut);
  assert.notEqual(drift.unknownModel, true, "opus-5 must not be treated as unknown");
  assert.equal(drift.warn, false, "matching actual cost must not warn");
});

test("beta71: adding opus-5 does NOT change the fail-safe most-expensive tier (Opus 4.8's 75 stays top)", () => {
  const { mostExpensivePrice, PRICES } = sdk;
  // mostExpensivePrice ranks by OUTPUT price; Opus 4.8's 75 is the top tier
  // (higher than Fable's 50). opus-5's 25 is well below either, so the
  // fail-safe over-reserve tier is unchanged by adding it.
  const top = mostExpensivePrice(PRICES);
  assert.equal(top.output, 75, "most-expensive output must still be Opus 4.8's 75, not opus-5's 25");
  assert.equal(top.input, 15, "most-expensive input must still be Opus 4.8's 15");
});

test("beta71: an unknown future model still fails safe to Fable's tier, unaffected by opus-5", () => {
  const { estimateSubTaskCost, mostExpensivePrice, PRICES } = sdk;
  const tokens = 30000;
  const unknown = estimateSubTaskCost("claude-opus-6-preview", tokens);
  const top = mostExpensivePrice(PRICES);
  const topCost = (tokens * 0.2 * top.input + tokens * 0.8 * top.output) / 1_000_000;
  assert.equal(unknown, topCost, "unknown model still priced at Fable tier, not opus-5");
});
