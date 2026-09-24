#!/usr/bin/env node
// Release-critical mutation checks for the v2 four-operation control plane.
// Mutations tied to removed onboarding, extension, and hard-clarification
// product surfaces are intentionally absent: those modules no longer ship.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mutations = [
  {
    name: "confirmation binds proposal security class",
    file: "dist/control/service.js",
    find: "securityClass: p.security_class,",
    replace: "securityClass: undefined,",
    tests: ["tests/control-service.test.mjs"],
  },
  {
    name: "merge provider selects proposal by authorization run id",
    file: "dist/control/github-merge-provider.js",
    find: "WHERE p.run_id=?`).get(runId)",
    replace: "WHERE p.run_id<>?`).get(runId)",
    tests: ["tests/control-production-merge-recovery.test.mjs", "tests/control-foundation.test.mjs"],
  },
  {
    name: "live service recurrently reconciles merge intents",
    file: "dist/control/service.js",
    find: "void this.deps.mergeService.recoverPending(); }, Math.max",
    replace: "void 0; }, Math.max",
    tests: ["tests/control-service.test.mjs"],
  },
  {
    name: "retired ambiguity fields cannot escape into a confirmable brief",
    file: "dist/crystallise/prompt-refiner.js",
    find: "delete legacy.clarificationNeeded;",
    replace: "void legacy.clarificationNeeded;",
    tests: ["tests/beta80-repo-only-and-bimodal-clarify.test.mjs"],
  },
];

const built = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf8" });
if (built.status !== 0) {
  console.error(built.stderr || built.stdout);
  process.exit(1);
}

let failures = 0;
for (const mutation of mutations) {
  const target = join(root, mutation.file);
  const pristine = readFileSync(target, "utf8");
  if (!pristine.includes(mutation.find)) {
    console.error(`FAIL  ${mutation.name}: mutation anchor is stale`);
    failures++;
    continue;
  }
  try {
    writeFileSync(target, pristine.replace(mutation.find, mutation.replace));
    const result = spawnSync(process.execPath, ["--test", ...mutation.tests], { cwd: root, encoding: "utf8", timeout: 300_000 });
    if (result.status === 0) {
      console.error(`FAIL  ${mutation.name}: focused tests survived`);
      failures++;
    } else {
      console.log(`ok    ${mutation.name}`);
    }
  } finally {
    writeFileSync(target, pristine);
  }
}
if (failures) process.exit(1);
