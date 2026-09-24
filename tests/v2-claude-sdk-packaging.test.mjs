import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packIsolatedHead } from "./helpers/package-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false", ...env },
    timeout: 300_000,
  });
}

function installedVersion(requireFromPackage, name) {
  let resolved;
  try { resolved = requireFromPackage.resolve(`${name}/package.json`); }
  catch { resolved = requireFromPackage.resolve(name); }
  let current = dirname(resolved);
  while (current !== dirname(current)) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === name) return parsed.version;
    }
    current = dirname(current);
  }
  throw new Error(`could not find the installed manifest for ${name}`);
}

test("npm pack rejects package-eligible untracked content before binding a commit", () => {
  const temp = mkdtempSync(join(dirname(root), ".oah-dirty-pack-"));
  try {
    const source = join(temp, "source");
    run("git", ["clone", "--quiet", "--shared", root, source], temp);
    run("cp", ["-al", join(root, "node_modules"), join(source, "node_modules")], temp);
    writeFileSync(join(source, "docs", "untracked-pack-probe.md"), "must never ship\n");
    const packed = spawnSync("npm", ["pack", "--pack-destination", temp], { cwd: source, encoding: "utf8", timeout: 300_000 });
    assert.notEqual(packed.status, 0);
    assert.match(`${packed.stdout}\n${packed.stderr}`, /refusing to pack a dirty or untracked worktree/);
    assert.equal(existsSync(join(source, ".oah-artifact.json")), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});


test("npm pack rejects package-eligible content hidden by git excludes", () => {
  const temp = mkdtempSync(join(dirname(root), ".oah-ignored-pack-"));
  try {
    const source = join(temp, "source");
    run("git", ["clone", "--quiet", "--shared", root, source], temp);
    run("cp", ["-al", join(root, "node_modules"), join(source, "node_modules")], temp);
    writeFileSync(join(source, ".git", "info", "exclude"), "dist/ignored-pack-probe.js\n", { flag: "a" });
    writeFileSync(join(source, "dist", "ignored-pack-probe.js"), "must never ship\n");
    assert.equal(run("git", ["status", "--porcelain", "--untracked-files=all"], source), "");
    const packed = spawnSync("npm", ["pack", "--pack-destination", temp], { cwd: source, encoding: "utf8", timeout: 300_000 });
    assert.notEqual(packed.status, 0);
    assert.match(`${packed.stdout}\n${packed.stderr}`, /refusing to pack non-commit content: dist\/ignored-pack-probe\.js/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("npm pack rejects modified bundled dependency bytes hidden in node_modules", () => {
  const temp = mkdtempSync(join(dirname(root), ".oah-mutated-dependency-pack-"));
  try {
    const source = join(temp, "source");
    run("git", ["clone", "--quiet", "--shared", root, source], temp);
    run("cp", ["-al", join(root, "node_modules"), join(source, "node_modules")], temp);
    const manifest = join(source, "node_modules", "zod", "package.json");
    const original = readFileSync(manifest, "utf8");
    rmSync(manifest);
    writeFileSync(manifest, original.replace('"version": "4.4.3"', '"version": "4.4.3-mutated"'));
    const packed = spawnSync("npm", ["pack", "--pack-destination", temp], { cwd: source, encoding: "utf8", timeout: 300_000 });
    assert.notEqual(packed.status, 0);
    assert.match(`${packed.stdout}\n${packed.stderr}`, /refusing to pack dependency content/);
    assert.equal(existsSync(join(source, ".oah-artifact.json")), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("npm pack rejects extra packable bundled dependency bytes hidden in node_modules", () => {
  const temp = mkdtempSync(join(dirname(root), ".oah-extra-dependency-pack-"));
  try {
    const source = join(temp, "source");
    run("git", ["clone", "--quiet", "--shared", root, source], temp);
    run("cp", ["-al", join(root, "node_modules"), join(source, "node_modules")], temp);
    writeFileSync(join(source, "node_modules", "zod", "commit-binding-probe.js"), "export default 'must never ship';\n");
    const packed = spawnSync("npm", ["pack", "--pack-destination", temp], { cwd: source, encoding: "utf8", timeout: 300_000 });
    assert.notEqual(packed.status, 0);
    assert.match(`${packed.stdout}\n${packed.stderr}`, /refusing to pack dependency content/);
    assert.equal(existsSync(join(source, ".oah-artifact.json")), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("the exact tarball clean-installs, audits, and runs consumer-platform Claude and OpenCode binaries", async () => {
  const packed = packIsolatedHead(root, "oah-native-consumer-");
  try {
    const { temp, artifact, tarball } = packed;
    const installDir = join(temp, "install");
    mkdirSync(installDir);
    writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true }));

    assert.ok(artifact.bundled?.includes("@anthropic-ai/claude-agent-sdk"), "the SDK must share the bundled fixed peer graph");
    assert.ok(
      !artifact.bundled?.some((name) => name.startsWith("@anthropic-ai/claude-agent-sdk-")),
      "platform-specific Claude binaries must be selected for the consumer platform, not frozen into the publisher-platform tarball",
    );

    run("npm", ["install", "--ignore-scripts", "--omit=dev", tarball], installDir, { npm_config_cache: join(temp, "npm-cache") });
    const packageRoot = join(installDir, "node_modules", "openclaw-agent-harness");
    const publishedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(publishedManifest.scripts, undefined, "development-only lifecycle, test, schema, and lint commands must not be published");
    for (const absent of ["test-isolated.mjs", "gen-config-schema.mjs", "gen-config-reference.mjs"]) {
      assert.equal(existsSync(join(packageRoot, "scripts", absent)), false, absent);
    }
    const result = JSON.parse(run(
      process.execPath,
      [join(packageRoot, "scripts", "verify-installed-artifact.mjs"), root, packageRoot],
      installDir,
    ));

    assert.equal(result.ok, true);
    assert.match(result.claudeNativePackage, /^@anthropic-ai\/claude-agent-sdk-(?:linux|darwin|win32)-/);
    assert.match(result.claudeNativePackageManifestSha256, /^[a-f0-9]{64}$/);
    assert.match(result.claudeVersion, /^\d+\.\d+\.\d+ \(Claude Code\)$/);

    const originalClaudeSize = statSync(result.claudeCommand).size;
    try {
      appendFileSync(result.claudeCommand, "\nOAH malicious same-version substitution probe\n");
      const substitutedVersion = spawnSync(result.claudeCommand, ["--version"], {
        cwd: installDir,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(substitutedVersion.status, 0, substitutedVersion.stderr || substitutedVersion.stdout);
      assert.equal((substitutedVersion.stdout || substitutedVersion.stderr || "").trim(), result.claudeVersion);

      const substituted = spawnSync(
        process.execPath,
        [join(packageRoot, "scripts", "verify-installed-artifact.mjs"), root, packageRoot],
        { cwd: installDir, encoding: "utf8", timeout: 30_000 },
      );
      assert.notEqual(substituted.status, 0);
      assert.match(substituted.stderr, /Claude SDK native package content is not bound to the tested commit/);
    } finally {
      truncateSync(result.claudeCommand, originalClaudeSize);
    }

    const installedRequire = createRequire(join(packageRoot, "package.json"));
    assert.equal(installedVersion(installedRequire, "@anthropic-ai/claude-agent-sdk"), result.claudeSdkVersion);
    assert.equal(installedVersion(installedRequire, "opencode-ai"), "1.18.23");
    for (const [name, version] of [["fast-uri", "3.1.8"], ["hono", "4.13.8"], ["qs", "6.16.0"]]) {
      assert.equal(installedVersion(installedRequire, name), version, name);
    }
    const installedRouter = await import(pathToFileURL(join(packageRoot, "dist", "adapters", "backend-router.js")).href);
    const openCode = installedRouter.resolveOpenCodeBinary(undefined, undefined, packageRoot);
    assert.equal(openCode.source, "dependency");
    assert.match(run(openCode.command, ["--version"], installDir), /^1\.18\.23\s*$/);

    const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: installDir, encoding: "utf8", timeout: 300_000, env: { ...process.env, npm_config_cache: join(temp, "npm-cache") } });
    const auditReport = JSON.parse(audit.stdout);
    assert.equal(audit.status, 0, audit.stdout || audit.stderr);
    assert.deepEqual(auditReport.metadata.vulnerabilities, { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 });

    const staleCheckout = join(temp, "stale-checkout");
    run("git", ["clone", "--quiet", "--shared", root, staleCheckout], temp);
    run("git", ["-c", "user.name=Artifact Test", "-c", "user.email=artifact@example.invalid", "commit", "--allow-empty", "-m", "different reviewed head"], staleCheckout);
    const stale = spawnSync(process.execPath, [join(packageRoot, "scripts", "verify-installed-artifact.mjs"), staleCheckout, packageRoot], { cwd: installDir, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /stale or invalid artifact binding/);
  } finally {
    packed.cleanup();
  }
});
