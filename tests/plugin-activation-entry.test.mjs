import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const entryRel = "plugin-entry/index.js";
const entryPath = resolve(repoRoot, entryRel);

test("activation entry is an isolated self-contained bundle", { skip: !existsSync(entryPath) }, () => {
  assert.deepEqual(pkg.openclaw.extensions, [`./${entryRel}`]);
  assert.deepEqual(pkg.openclaw.runtimeExtensions, [`./${entryRel}`]);
  assert.ok(pkg.files.includes("plugin-entry"));
  const integrity = JSON.parse(readFileSync(resolve(repoRoot, ".oah-build-integrity.json"), "utf8"));
  assert.equal(typeof integrity.entries[entryRel], "string");

  const source = readFileSync(entryPath, "utf8");
  const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)].map((m) => m[1]);
  const dynamicImports = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const nonBuiltin = [...new Set([...imports, ...dynamicImports].filter((specifier) => !isBuiltin(specifier)))];
  assert.deepEqual(nonBuiltin, ["openclaw/plugin-sdk/plugin-entry"]);
});

test("OpenClaw source capture accepts a freshly copied activation package", { skip: !existsSync(entryPath) }, async (t) => {
  const distDir = "/app/dist";
  if (!existsSync(distDir)) return t.skip("OpenClaw runtime source inspector is unavailable");
  const inspectorName = readdirSync(distDir).find((name) => {
    if (!name.startsWith("plugin-generation-source-inspection-") || !name.endsWith(".mjs")) return false;
    return readFileSync(resolve(distDir, name), "utf8").includes("inspectPluginGenerationSources");
  });
  if (!inspectorName) return t.skip("OpenClaw runtime source inspector is unavailable");

  const root = mkdtempSync(resolve(tmpdir(), "oah-activation-entry-"));
  try {
    cpSync(resolve(repoRoot, "package.json"), resolve(root, "package.json"));
    cpSync(resolve(repoRoot, "plugin-entry"), resolve(root, "plugin-entry"), { recursive: true });
    const inspector = await import(pathToFileURL(resolve(distDir, inspectorName)).href);
    const inspect = inspector.inspectPluginGenerationSources ?? Object.values(inspector).find((value) => typeof value === "function");
    assert.equal(typeof inspect, "function");
    const result = inspect([{ pluginId: "openclaw-agent-harness", rootDir: root, entryFile: resolve(root, entryRel) }]);
    assert.equal(typeof result.sourceDigests["openclaw-agent-harness"], "string");
    result.assertSourceCurrent();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
