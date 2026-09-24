import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const index = readFileSync(resolve(root, "src/index.ts"), "utf8");
const merge = readFileSync(resolve(root, "src/control/merge.ts"), "utf8");

test("legacy merge path cannot override readiness or run deploy repair", () => {
  assert.match(index, /Legacy session merge is disabled/);
  assert.doesNotMatch(index, /vercel_revise_override|env_block_cleared_by_green_ci|runDeployRepair|repairBudgetUsd &&/);
});

test("canonical merge revalidates readiness and exact head before provider mutation", () => {
  const inspect = merge.indexOf("provider.inspect");
  const readiness = merge.indexOf("evaluatePrReadiness", inspect);
  const mutation = merge.indexOf("provider.merge", inspect);
  assert.ok(inspect >= 0 && readiness > inspect && mutation > readiness);
  assert.match(merge, /inspection\.headSha!==auth\.expectedHeadSha/);
  assert.match(merge, /inspection\.merged/);
});
