import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("automatic deploy repair and revert implementation is retired", () => {
  assert.equal(existsSync(join(root, "src/orchestrator/deploy-repair.ts")), false);
  assert.equal(existsSync(join(root, "dist/orchestrator/deploy-repair.js")), false);
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.doesNotMatch(index, /runDeployRepair|vercel_revise_override|env_block_cleared_by_green_ci|revertMerges/);
});
