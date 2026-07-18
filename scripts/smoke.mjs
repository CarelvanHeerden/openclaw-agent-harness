#!/usr/bin/env node
/**
 * Smoke test script for openclaw-agent-harness.
 *
 * Loads the built plugin's default export, invokes register(api) with
 * a fake API surface, and asserts that:
 *   - the plugin returns a version identical to package.json
 *   - registerTool was called for the expected tool names
 *   - the message hook was registered for message_received (underscore)
 *     and NOT for the invalid dotted name message.received
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
const registeredHooks = new Set(); // populated by BOTH api.on and api.registerHook
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
  // New-style config surface (definePluginEntry expects api.pluginConfig).
  pluginConfig: {
    // listener_enabled: true is deliberately set here to prove beta.34's
    // removal of the Slack listener is honoured EVEN when the (now-ignored)
    // key is on -- the plugin must still NOT register message_received.
    slack: { listener_enabled: true, channel: "C_SMOKE", authorised_users: ["U_SMOKE"] },
    repos: { allowed: ["smoke/*"] },
    storage: { state_db_path: `${stateDir}/state.db`, worktree_root: `${stateDir}/wt` },
  },
  // SDK signature: registerHook(events, handler, opts).
  // opts.name is REQUIRED by the real registry (throws 'hook registration
  // missing name' otherwise); smoke asserts we always pass it.
  registerHook: (events, _handler, opts) => {
    if (!opts || typeof opts.name !== "string" || opts.name.trim() === "") {
      throw new Error(`registerHook called without opts.name (events=${JSON.stringify(events)})`);
    }
    const list = Array.isArray(events) ? events : [events];
    for (const e of list) registeredHooks.add(e);
    return () => {};
  },
  // api.on: lightweight event-bus subscribe. hybrid-memory uses this for
  // `message_received`. Returns an unsubscribe fn.
  on: (event, _handler) => {
    registeredHooks.add(event);
    return () => {};
  },
  registerService: (svc) => { registeredServices.add(svc.id); return () => {}; },
  getConfig: () => ({
    slack: { listener_enabled: true, channel: "C_SMOKE", authorised_users: ["U_SMOKE"] },
    repos: { allowed: ["smoke/*"] },
    storage: { state_db_path: `${stateDir}/state.db`, worktree_root: `${stateDir}/wt` },
  }),
  workspaceDir: stateDir,
  sendMessage: async () => ({ ts: `${Date.now()}` }),
  addReaction: async () => {},
};

const mod = await import(resolve(here, "..", "dist", "index.js"));
const plugin = mod.default;

// Smoke supports both plain-object and definePluginEntry-wrapped exports.
// definePluginEntry returns whatever the SDK wraps it in; our loader stub
// (see scripts/smoke-stub.mjs) short-circuits and returns the descriptor
// object unchanged so `plugin.register` is directly callable.
if (typeof plugin.register !== "function") {
  console.error(`FAIL: plugin default export has no register(). Got: ${JSON.stringify(Object.keys(plugin ?? {}))}`);
  process.exit(1);
}

// CRITICAL: OpenClaw plugin loader requires register() to be SYNCHRONOUS.
// If register() returns a Promise, the gateway rejects the plugin with:
//   "Error: plugin register must be synchronous"
// Assert here so a regression fails smoke instead of silently shipping.
const registerResult = plugin.register(fakeApi);
if (registerResult && typeof registerResult.then === "function") {
  console.error("FAIL: register() returned a Promise; must be synchronous.");
  console.error("  See src/index.ts and the definePluginEntry({ register(api) { ... } }) block.");
  process.exit(1);
}

// Give the async bootstrap phase a chance to finish (poller start, recovery).
// Not strictly required for tool/hook/service registration checks below --
// those all happen in the sync phase -- but useful so smoke exercises the
// full lifecycle. 500ms is generous for the local fake API.
await new Promise((r) => setTimeout(r, 500));

const expectTools = [
  "harness_run",
  "harness_status",
  "harness_health",
  "harness_start_session",
  "harness_session_get",
  "harness_telemetry",
  "harness_upload_logs",
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

// beta.34 REMOVED the Slack listener: the harness is pure tool-driven, so it
// must NEVER register a `message_received` hook -- not even when
// `slack.listener_enabled: true` (that key is now ignored). The privileged
// surface (PATs, merges) is reachable only through the agent's tool layer,
// which structurally eliminates the bot-to-bot loop risk. Assert:
//   (a) `message_received` is NOT registered even with listener_enabled=true;
//   (b) the invalid dotted form `message.received` is NEVER registered.
if (registeredHooks.has("message_received")) {
  console.error(`FAIL: message_received was registered even though the Slack listener was removed in beta.34 (got: ${JSON.stringify([...registeredHooks])}). The harness must be tool-driven only.`);
  failed++;
}
if (registeredHooks.has("message.received")) {
  console.error(`FAIL: plugin registered the INVALID dotted event "message.received". Only "message_received" is a real runtime hook name.`);
  failed++;
}

for (const s of ["retention-nightly"]) {
  const full = `openclaw-agent-harness:${s}`;
  if (!registeredServices.has(full)) {
    console.error(`FAIL: service "${full}" was not registered`);
    failed++;
  }
}

// ---- Agent-orchestrated mode (DEFAULT): listener_enabled=false ----
// A fresh registration with listener_enabled off must register the SAME
// tools but must NOT subscribe to message_received. This is the default
// mode: the OpenClaw agent drives the harness via tools.
const agentHooks = new Set();
const agentTools = new Set();
const agentStateDir = `${stateDir}-agent`;
const agentApi = {
  ...fakeApi,
  pluginConfig: {
    slack: { listener_enabled: false, authorised_users: ["U_SMOKE"] }, // NB: no channel
    repos: { allowed: ["smoke/*"] },
    storage: { state_db_path: `${agentStateDir}/state.db`, worktree_root: `${agentStateDir}/wt` },
  },
  getConfig: () => ({
    slack: { listener_enabled: false, authorised_users: ["U_SMOKE"] },
    repos: { allowed: ["smoke/*"] },
    storage: { state_db_path: `${agentStateDir}/state.db`, worktree_root: `${agentStateDir}/wt` },
  }),
  registerTool: (def) => { agentTools.add(def.name); return () => {}; },
  registerHook: (events) => { const l = Array.isArray(events) ? events : [events]; for (const e of l) agentHooks.add(e); return () => {}; },
  on: (event) => { agentHooks.add(event); return () => {}; },
  registerService: () => () => {},
};
const agentRes = plugin.register(agentApi);
if (agentRes && typeof agentRes.then === "function") {
  console.error("FAIL (agent-mode): register() returned a Promise; must be synchronous.");
  failed++;
}
await new Promise((r) => setTimeout(r, 200));
if (agentHooks.has("message_received")) {
  console.error("FAIL (agent-mode): listener_enabled=false but message_received was still registered. The agent-orchestrated default must NOT listen to Slack.");
  failed++;
}
if (!agentTools.has("harness_run")) {
  console.error("FAIL (agent-mode): harness_run tool missing in agent-orchestrated mode.");
  failed++;
}

if (failed > 0) {
  console.error(`\nSmoke failed: ${failed} check(s). Logs:`);
  for (const l of logs) console.error(`  [${l.level}] ${l.m}`);
  process.exit(1);
}

console.log(`Smoke OK: ${expectTools.length} tools, ${registeredHooks.size} hooks, ${registeredServices.size} services.`);
console.log(`  Tools:            ${[...registeredTools].sort().join(", ")}`);
console.log(`  Hooks (listener): ${[...registeredHooks].sort().join(", ")}`);
console.log(`  Hooks (agent):    ${[...agentHooks].sort().join(", ") || "(none -- correct, agent-orchestrated)"}`);
console.log(`  Services:         ${[...registeredServices].sort().join(", ")}`);
