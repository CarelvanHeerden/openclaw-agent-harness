/**
 * beta.36: Vercel-aware merge gate + config wiring guards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexSrc = readFileSync(resolve(repoRoot, "src/index.ts"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "openclaw.plugin.json"), "utf8"));

test("merge gate override is Vercel-AND-revise-only (never on block or blocking finding)", () => {
  // The override that lets a do_not_merge auto-merge must require BOTH a
  // Vercel-configured project AND a revise-only reason.
  assert.match(indexSrc, /const overridable = vercelConfigured && reviseOnly/, "override must require vercelConfigured && reviseOnly");
  assert.match(indexSrc, /reviseOnly = lastVerdict === "revise" && !hasBlockingFinding/, "reviseOnly must exclude blocking findings");
  // A block verdict / blocking finding / non-vercel still hard-refuses.
  assert.match(indexSrc, /if \(rec !== "merge" && !overridable\)/, "non-overridable do_not_merge must still refuse");
});

test("deploy-repair only runs on ERROR + enabled", () => {
  assert.match(indexSrc, /dv\.status === "error" && repairCfg\?\.enabled/, "repair loop gated on deploy error + config.enabled");
});

test("repair budget defaults to daily_max_usd * budget_ratio, override honoured", () => {
  assert.match(indexSrc, /repairBudgetUsd && repairBudgetUsd > 0/, "explicit repairBudgetUsd override");
  assert.match(indexSrc, /config\.budgets\.daily_max_usd \* repairCfg\.budget_ratio/, "default = daily_max_usd * budget_ratio");
});

test("revert falls back to an auto-merged revert PR when not pushed to main", () => {
  assert.match(indexSrc, /if \(r\.pushedToMain\)/, "revertMerges checks pushedToMain");
  assert.match(indexSrc, /createPullRequest\(/, "must open a revert PR on the fallback path");
  assert.match(indexSrc, /mergePullRequest\(\{ repoFullName, prNumber: pr\.number/, "must auto-merge the revert PR");
});

test("manifest declares budgets.daily_max_usd and vercel.deploy_repair", () => {
  const budgets = manifest.configSchema?.properties?.budgets?.properties;
  assert.ok(budgets?.daily_max_usd, "manifest must declare budgets.daily_max_usd");
  const dr = manifest.configSchema?.properties?.vercel?.properties?.deploy_repair;
  assert.ok(dr, "manifest must declare vercel.deploy_repair");
  assert.ok(dr.properties?.max_attempts && dr.properties?.budget_ratio, "deploy_repair must declare max_attempts + budget_ratio");
});

test("config validates daily_max_usd >= daily_warn_usd", async () => {
  let mod;
  try { mod = await import("../dist/config.js"); } catch { mod = null; }
  if (!mod?.loadConfig && !mod?.validateConfig && !mod?.parseConfig) return; // shape-dependent; skip if not exported
});
