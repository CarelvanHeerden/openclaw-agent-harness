import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
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
  const imports = [...source.matchAll(/\b(?:import|export)(?:[^"'`;]*?\bfrom)?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const dynamicImports = [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const nonBuiltin = [...new Set([...imports, ...dynamicImports].filter((specifier) => !isBuiltin(specifier)))];
  assert.deepEqual(nonBuiltin, ["openclaw/plugin-sdk/plugin-entry"]);
});

test("activation entry is deterministically minified without discarding useful stack names", { skip: !existsSync(entryPath) }, () => {
  const root = mkdtempSync(resolve(tmpdir(), "oah-entry-rebuild-"));
  try {
    const first = resolve(root, "first.js");
    const second = resolve(root, "second.js");
    const script = resolve(repoRoot, "scripts/build-plugin-entry.mjs");
    for (const output of [first, second]) {
      execFileSync(process.execPath, [script, output], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
    }

    const committed = readFileSync(entryPath);
    assert.deepEqual(readFileSync(first), committed, "a rebuild must reproduce the committed entry byte-for-byte");
    assert.deepEqual(readFileSync(second), committed, "repeated builds must be byte-for-byte deterministic");
    assert.ok(committed.length < 1_700_000, `activation entry exceeds the 1.7 MB capture budget: ${committed.length}`);

    const source = committed.toString("utf8");
    assert.match(source, /bootstrapHarnessAsync/);
    assert.match(source, /loadSdk/);
    const maxLine = Math.max(...source.split("\n").map((line) => line.length));
    assert.ok(maxLine < 2_048, `minified entry has an impractical debug line of ${maxLine} characters`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw dependency capture accepts the minified entry within a bounded heap", { skip: !existsSync(entryPath) }, (t) => {
  const distDir = "/app/dist";
  if (!existsSync(distDir)) return t.skip("OpenClaw runtime source inspector is unavailable");

  const root = mkdtempSync(resolve(tmpdir(), "oah-live-capture-"));
  try {
    cpSync(resolve(repoRoot, "package.json"), resolve(root, "package.json"));
    cpSync(resolve(repoRoot, "plugin-entry"), resolve(root, "plugin-entry"), { recursive: true });
    mkdirSync(resolve(root, "node_modules"));
    symlinkSync("/app", resolve(root, "node_modules/openclaw"), "dir");
    const probe = resolve(repoRoot, "tests/fixtures/plugin-live-capture-probe.mjs");
    const output = execFileSync(process.execPath, ["--max-old-space-size=768", probe, root], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    });
    const result = JSON.parse(output.trim());
    assert.ok(result.files <= 3, `capture unexpectedly expanded to ${result.files} files`);
    assert.equal(result.packageRoots, 0);
    assert.equal(result.references, 0);
    assert.equal(result.unresolved, 0);
    assert.equal(result.activatedPluginId, "openclaw-agent-harness");
    assert.equal(result.registerName, "register");
    assert.ok(result.maxRSSKiB < 1_150_000, `capture plus metadata activation exceeded the 1.15 GB RSS ceiling: ${result.maxRSSKiB} KiB`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
