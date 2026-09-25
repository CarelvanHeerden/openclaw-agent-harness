import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? "");
const entryFile = resolve(root, "plugin-entry/index.js");
const distDir = "/app/dist";
assert.ok(existsSync(entryFile), `missing activation entry: ${entryFile}`);
assert.ok(existsSync(distDir), "OpenClaw runtime source inspector is unavailable");

const inspectorName = readdirSync(distDir).find((name) => {
  if (!name.startsWith("plugin-generation-source-inspection-") || !name.endsWith(".mjs")) return false;
  return readFileSync(resolve(distDir, name), "utf8").includes("function inspectPluginSourceDependencies");
});
assert.ok(inspectorName, "OpenClaw dependency source inspector is unavailable");

const inspector = await import(pathToFileURL(resolve(distDir, inspectorName)).href);
const inspect = Object.values(inspector).find(
  (value) => typeof value === "function" && value.name === "inspectPluginSourceDependencies",
);
assert.equal(typeof inspect, "function");

const result = inspect([{ pluginId: "openclaw-agent-harness", rootDir: root, entryFile }]);
result.assertSourceCurrent();

const activation = await import(pathToFileURL(entryFile).href);
const logs = [];
activation.default.register({
  registrationMode: "cli-metadata",
  logger: { info: (message) => logs.push(message), warn() {}, error() {} },
});
assert.equal(activation.default.id, "openclaw-agent-harness");
assert.equal(activation.default.register.name, "register");
assert.deepEqual(logs, ["[harness] cli-metadata registration"]);

console.log(JSON.stringify({
  files: result.files.length,
  packageRoots: result.packageRoots.length,
  references: result.references.length,
  unresolved: result.unresolved.length,
  activatedPluginId: activation.default.id,
  registerName: activation.default.register.name,
  maxRSSKiB: process.resourceUsage().maxRSS,
}));
