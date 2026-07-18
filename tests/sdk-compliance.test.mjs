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
// beta.9: added harness_bootstrap_test_repo (was registered since beta.6 but missing from manifest)
const EXPECTED_TOOLS = [
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
  "harness_bootstrap_test_repo",
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

test("sdk: no native-binary dependencies (npm install --ignore-scripts must be enough)", () => {
  // OpenClaw's plugin loader invokes `npm install --ignore-scripts` for
  // security (see openclaw runtime `install-CLxRzDc9.js`). That means any
  // dep with a native binary fetched by a postinstall/install script
  // (better-sqlite3, sqlite3, node-sass, etc.) will land on Carel's machine
  // WITHOUT a compiled `.node` binary and the plugin will fail with:
  //     'Could not locate the bindings file'
  //
  // Rule: never add a dep whose install requires running scripts. Use
  // pure-JS packages, prebuild-loaded @napi-rs/* natives that ship the
  // binary inside the npm tarball itself, or Node built-ins (node:sqlite).
  //
  // Also assert we don't reintroduce pnpm.onlyBuiltDependencies -- if we
  // ever add that back, it's a signal a native dep sneaked in.
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const NATIVE_DEP_DENYLIST = new Set([
    "better-sqlite3",
    "sqlite3",
    "node-sass",
    "canvas",
    "sharp", // sharp bundles its own but historically caused issues on --ignore-scripts
    "node-gyp",
  ]);
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const offenders = Object.keys(allDeps).filter((d) => NATIVE_DEP_DENYLIST.has(d));
  assert.equal(
    offenders.length,
    0,
    `package.json declares native-binary dep(s): ${offenders.join(", ")}. OpenClaw installs plugins with --ignore-scripts, so post-install compile/fetch scripts DO NOT run. Use node:sqlite or a pure-JS alternative.`,
  );
  assert.equal(
    pkg.pnpm?.onlyBuiltDependencies,
    undefined,
    "package.json declares pnpm.onlyBuiltDependencies -- indicates a native dep was reintroduced. Drop it and switch to a pure-JS / node:* alternative.",
  );
});

test("sdk: dist and src do not import better-sqlite3", { skip: !existsSync(resolve(repoRoot, "dist/index.js")) }, () => {
  // Belt-and-braces guard alongside the package.json check above.
  // Catches the case where the dep is removed but a leftover import lingers.
  const filesToCheck = [
    resolve(repoRoot, "dist/state/store.js"),
    resolve(repoRoot, "src/state/store.ts"),
  ];
  for (const f of filesToCheck) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    // Match `from "better-sqlite3"` or `require("better-sqlite3")` but not
    // documentation comments that happen to include the string.
    const importRe = /(?:from|require\s*\()\s*["']better-sqlite3["']/;
    assert.equal(
      importRe.test(src),
      false,
      `${f} imports better-sqlite3. Use "node:sqlite" (DatabaseSync) instead — npm install --ignore-scripts (which OpenClaw uses) does not fetch native binaries.`,
    );
  }
});

test("sdk: dist does not register the invalid dotted event 'message.received'", { skip: !existsSync(resolve(repoRoot, "dist/index.js")) }, () => {
  // The OpenClaw runtime's PLUGIN_HOOK_NAMES uses `message_received`
  // (underscore). The dotted form `message.received` is NOT a valid hook
  // name -- registering it yields a runtime warning:
  //     unknown typed hook "message.received" ignored
  // ...and the Slack listener silently never fires. This regressed on
  // 2026-07-15 via a bogus `?? api.on("message.received", ...)` fallback
  // and a `registerHook(["message_received", "message.received"], ...)`
  // call. Guard against it coming back.
  const raw = readFileSync(resolve(repoRoot, "dist/index.js"), "utf8");
  // Strip comments so explanatory prose that mentions the dotted name (e.g.
  // "the dotted form message.received is invalid") does not trip the check.
  // We only care about the dotted string appearing in actual CODE.
  const codeOnly = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (avoid matching "://" in URLs)
  assert.equal(
    /["']message\.received["']/.test(codeOnly),
    false,
    'dist/index.js has CODE referencing the invalid dotted event "message.received". Use only "message_received" (underscore) -- the dotted name is not in the runtime PLUGIN_HOOK_NAMES and is silently ignored.',
  );
  // Sanity: the valid name must still be present in code.
  assert.equal(
    /["']message_received["']/.test(codeOnly),
    true,
    'dist/index.js must register the inbound-message listener under "message_received".',
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

// beta.28: structured SDK calls (classifier/crystalliser/lead/adversary) must
// run with NO tools. Otherwise the SDK's Claude Code agent explores the local
// filesystem and narrates prose instead of emitting the JSON contract, which
// broke the ProjectThanos smoke with
// `[classifier] extractJson failed: no JSON in output: "I'm in plan mode ..."`.
//
// The authoritative switch is `tools: []` (disables all built-in tools).
// beta.27 wrongly used `allowedTools: []` (auto-approve list, a no-op) and the
// agent kept wandering. This test guards against regressing to that mistake.
test("sdk: structuredCall disables tools via tools: [] (beta.28)", () => {
  const src = readFileSync(resolve(repoRoot, "src/adapters/claude-sdk.ts"), "utf8");
  assert.match(
    src,
    /\btools:\s*\[\s*\]/,
    "src/adapters/claude-sdk.ts must set `tools: []` on the structured sdk.query call to disable all built-in tools.",
  );
});

test("sdk: structuredCall does NOT rely on allowedTools:[] alone (beta.28 regression guard)", () => {
  // allowedTools is the auto-approve list, not a restriction. If someone
  // removes `tools: []` and leaves only `allowedTools: []`, the agent will
  // wander again. Require `tools: []` to be present regardless.
  const src = readFileSync(resolve(repoRoot, "src/adapters/claude-sdk.ts"), "utf8");
  assert.match(src, /\btools:\s*\[\s*\]/, "tools: [] must be present (allowedTools: [] alone is insufficient).");
});

test("sdk: compiled structuredCall keeps tools: [] (beta.28)", { skip: !existsSync(resolve(repoRoot, "dist/adapters/claude-sdk.js")) }, () => {
  const src = readFileSync(resolve(repoRoot, "dist/adapters/claude-sdk.js"), "utf8");
  assert.match(src, /\btools:\s*\[\s*\]/, "dist must carry tools: [] on the structured call.");
});
