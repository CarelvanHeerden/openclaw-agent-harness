import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const manifestPath = resolve(repoRoot, "openclaw.plugin.json");
const pkgPath = resolve(repoRoot, "package.json");

// Expected tool contract - must be kept in sync with src/tools/registration.ts
const EXPECTED_TOOLS = [
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

test("sdk: openclaw.plugin.json exists", () => {
  assert.equal(existsSync(manifestPath), true, "openclaw.plugin.json must exist at plugin root");
});

test("sdk: manifest has required top-level fields", () => {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(typeof m.id, "string", "manifest.id must be a string");
  assert.equal(m.id, "openclaw-agent-harness");
  assert.equal(typeof m.name, "string");
  assert.equal(typeof m.description, "string");
  assert.equal(typeof m.activation, "object");
  assert.equal(m.activation.onStartup, true);
  assert.equal(typeof m.contracts, "object");
  assert.ok(Array.isArray(m.contracts.tools), "contracts.tools must be an array");
  assert.equal(typeof m.configSchema, "object");
});

test("sdk: manifest contracts.tools lists every registered tool", () => {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = new Set(m.contracts.tools);
  for (const t of EXPECTED_TOOLS) {
    assert.ok(declared.has(t), `contracts.tools missing "${t}"`);
  }
  for (const t of m.contracts.tools) {
    assert.ok(EXPECTED_TOOLS.includes(t), `contracts.tools declares unknown tool "${t}"`);
  }
});

test("sdk: manifest configSchema is a JSON Schema object", () => {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  const cs = m.configSchema;
  assert.equal(cs.type, "object", "configSchema.type must be 'object'");
  assert.equal(typeof cs.properties, "object", "configSchema.properties must be an object");
});

test("sdk: package.json has openclaw block with extensions + compat", () => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(typeof pkg.openclaw, "object", "package.json#openclaw block is required");
  assert.ok(Array.isArray(pkg.openclaw.extensions), "openclaw.extensions must be an array");
  assert.ok(pkg.openclaw.extensions.length > 0, "openclaw.extensions must not be empty");
  assert.ok(Array.isArray(pkg.openclaw.runtimeExtensions), "openclaw.runtimeExtensions must be an array");
  assert.equal(typeof pkg.openclaw.compat, "object", "openclaw.compat is required");
  assert.equal(typeof pkg.openclaw.compat.pluginApi, "string", "openclaw.compat.pluginApi is required");
  assert.equal(typeof pkg.openclaw.compat.minGatewayVersion, "string", "openclaw.compat.minGatewayVersion is required");
});

test("sdk: package.json files array includes openclaw.plugin.json (not plugin.json)", () => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.ok(Array.isArray(pkg.files), "package.json#files must be an array");
  assert.ok(pkg.files.includes("openclaw.plugin.json"), "files must include openclaw.plugin.json");
  assert.equal(pkg.files.includes("plugin.json"), false, "files must not include legacy plugin.json");
});

test("sdk: package.json engines.node is >=22", () => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(typeof pkg.engines?.node, "string");
  assert.match(pkg.engines.node, />=\s*22/, "engines.node must require Node >=22");
});

test("sdk: dist entry point wraps definePluginEntry (when built)", { skip: !existsSync(resolve(repoRoot, "dist/index.js")) }, async () => {
  const src = readFileSync(resolve(repoRoot, "dist/index.js"), "utf8");
  assert.ok(
    src.includes("definePluginEntry"),
    "dist/index.js must reference definePluginEntry from openclaw/plugin-sdk/plugin-entry",
  );
  assert.ok(
    src.includes("pluginConfig") || src.includes('"pluginConfig"'),
    "dist/index.js must read config from api.pluginConfig",
  );
});

test("sdk: dist does not call registerHook without opts.name", { skip: !existsSync(resolve(repoRoot, "dist/index.js")) }, async () => {
  // OpenClaw plugin registry throws 'hook registration missing name' when
  // registerHook is called without an `opts.name` string. Signature is
  // `registerHook(events, handler, opts)` -- opts.name required.
  //
  // This test greps the built dist for any registerHook call that only
  // passes two args, which would be the exact regression that broke us
  // on 2026-07-14. Not a perfect AST check, but it catches the shape
  // change in `src/index.ts` reliably enough (tsc emits calls with the
  // same arity as the source).
  const src = readFileSync(resolve(repoRoot, "dist/index.js"), "utf8");
  // Find all registerHook( ... ) call sites and count top-level commas.
  // A safe call is `registerHook(events, handler, opts)` -- 2 commas.
  const re = /\bregisterHook\s*\(/g;
  let match;
  const badSites = [];
  while ((match = re.exec(src)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let commas = 0;
    let i = start;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 1) commas++;
      i++;
    }
    if (commas < 2) {
      // Slice a small window for the error message.
      const window = src.slice(Math.max(0, match.index - 30), Math.min(src.length, i + 30));
      badSites.push({ index: match.index, commas, window });
    }
  }
  assert.equal(
    badSites.length,
    0,
    `dist/index.js has ${badSites.length} registerHook() call(s) with fewer than 3 args. SDK requires (events, handler, opts) with opts.name.\nFirst offender: ${badSites[0] ? badSites[0].window : "n/a"}`,
  );
});

test("sdk: dist register() is synchronous (does not return Promise)", { skip: !existsSync(resolve(repoRoot, "dist/index.js")) }, async () => {
  // OpenClaw plugin loader rejects with 'plugin register must be synchronous'
  // if register() returns a Promise. Guard against a future regression that
  // makes register() `async` or awaits inside it.
  const src = readFileSync(resolve(repoRoot, "dist/index.js"), "utf8");
  // A compiled `register(api) { ... }` method that is NOT async has no
  // `async register` or `register: async` in its shape. tsc emits either
  // `async register(` or `register(api) {` depending on source style.
  assert.equal(
    /\basync\s+register\s*\(/.test(src),
    false,
    "dist/index.js contains `async register(` -- register() must be synchronous per OpenClaw plugin SDK contract.",
  );
  assert.equal(
    /register\s*:\s*async\s*\(/.test(src),
    false,
    "dist/index.js contains `register: async (` -- register() must be synchronous per OpenClaw plugin SDK contract.",
  );
});
