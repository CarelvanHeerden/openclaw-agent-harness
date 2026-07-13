#!/usr/bin/env node
/**
 * Smoke test script for openclaw-agent-harness.
 *
 * Loads the built plugin's default export, invokes register(api) with
 * a fake API surface, and asserts that:
 *   - the plugin returns a version identical to package.json
 *   - registerTool was called for the expected tool names
 *   - registerHook was called for message.received
 *   - the state store initialised without throwing
 *
 * Usage:
 *   node scripts/smoke.mjs
 * or after global install:
 *   openclaw-agent-harness-smoke
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8"));

const registeredTools = new Set();
const registeredHooks = new Set();
const registeredServices = new Set();
const logs = [];

const stateDir = resolve(tmpdir(), `harness-smoke-${Date.now()}`);
const fakeApi = {
  registrationMode: "runtime",
  logger: {
    info: (m, meta) => logs.push({ level: "info", m, meta }),
    warn: (m, meta) => logs.push({ level: "warn", m, meta }),
    error: (m, meta) => logs.push({ level: "error", m, meta }),
  },
  registerTool: (def) => { registeredTools.add(def.name); return () => {}; },
  registerHook: (name) => { registeredHooks.add(name); return () => {}; },
  registerService: (svc) => { registeredServices.add(svc.id); return () => {}; },
  getConfig: () => ({
    slack: { channel: "C_SMOKE", authorised_users: ["U_SMOKE"] },
    repos: { allowed: ["smoke/*"] },
    storage: { state_db_path: `${stateDir}/state.db`, worktree_root: `${stateDir}/wt` },
  }),
  workspaceDir: stateDir,
  sendMessage: async () => ({ ts: `${Date.now()}` }),
  addReaction: async () => {},
};

const mod = await import(resolve(here, "..", "dist", "index.js"));
const plugin = mod.default;

if (plugin.versionInfo?.pluginVersion !== pkg.version) {
  console.error(`FAIL: versionInfo.pluginVersion (${plugin.versionInfo?.pluginVersion}) !== package.version (${pkg.version})`);
  process.exit(1);
}

await plugin.register(fakeApi);

const expectTools = [
  "harness_status",
  "harness_health",
  "harness_start_session",
  "harness_session_get",
  "harness_telemetry",
  "harness_cancel",
  "harness_resume",
  "harness_retention_prune",
];

let failed = 0;
for (const t of expectTools) {
  if (!registeredTools.has(t)) {
    console.error(`FAIL: tool "${t}" was not registered`);
    failed++;
  }
}

if (!registeredHooks.has("message.received")) {
  console.error(`FAIL: hook "message.received" was not registered`);
  failed++;
}

for (const s of ["retention-nightly"]) {
  const full = `openclaw-agent-harness:${s}`;
  if (!registeredServices.has(full)) {
    console.error(`FAIL: service "${full}" was not registered`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\nSmoke failed: ${failed} check(s). Logs:`);
  for (const l of logs) console.error(`  [${l.level}] ${l.m}`);
  process.exit(1);
}

console.log(`Smoke OK: ${expectTools.length} tools, ${registeredHooks.size} hooks, ${registeredServices.size} services.`);
console.log(`  Tools:    ${[...registeredTools].sort().join(", ")}`);
console.log(`  Hooks:    ${[...registeredHooks].sort().join(", ")}`);
console.log(`  Services: ${[...registeredServices].sort().join(", ")}`);
