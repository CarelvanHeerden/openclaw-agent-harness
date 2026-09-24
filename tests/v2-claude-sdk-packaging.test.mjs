import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    timeout: 180_000,
  });
}

function installedVersion(requireFromPackage, name) {
  let current = dirname(requireFromPackage.resolve(name));
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

test("the exact tarball clean-installs and runs the consumer-platform Claude SDK native CLI", () => {
  const temp = mkdtempSync(join(tmpdir(), "oah-claude-sdk-artifact-"));
  try {
    const packDir = join(temp, "pack");
    const installDir = join(temp, "install");
    mkdirSync(packDir);
    mkdirSync(installDir);
    writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true }));

    const packed = JSON.parse(run("npm", ["pack", root, "--json", "--pack-destination", packDir], temp));
    const artifact = packed[0] ?? Object.values(packed)[0];
    const tarball = join(packDir, basename(artifact.filename));
    assert.ok(artifact.bundled?.includes("@anthropic-ai/claude-agent-sdk"), "the SDK must share the bundled fixed peer graph");
    assert.ok(
      !artifact.bundled?.some((name) => name.startsWith("@anthropic-ai/claude-agent-sdk-")),
      "platform-specific Claude binaries must be selected for the consumer platform, not frozen into the publisher-platform tarball",
    );

    run("npm", ["install", "--ignore-scripts", "--omit=dev", tarball], installDir);
    const packageRoot = join(installDir, "node_modules", "openclaw-agent-harness");
    const result = JSON.parse(run(
      process.execPath,
      [join(packageRoot, "scripts", "verify-installed-artifact.mjs"), root, packageRoot],
      installDir,
    ));

    assert.equal(result.ok, true);
    assert.match(result.claudeNativePackage, /^@anthropic-ai\/claude-agent-sdk-(?:linux|darwin|win32)-/);
    assert.match(result.claudeVersion, /^\d+\.\d+\.\d+ \(Claude Code\)$/);
    const installedRequire = createRequire(join(packageRoot, "package.json"));
    assert.equal(installedVersion(installedRequire, "@anthropic-ai/claude-agent-sdk"), result.claudeSdkVersion);
    for (const [name, version] of [["fast-uri", "3.1.8"], ["hono", "4.13.8"], ["qs", "6.16.0"]]) {
      assert.equal(installedVersion(installedRequire, name), version, name);
    }

    const audit = spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: installDir, encoding: "utf8", timeout: 180_000 });
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
    rmSync(temp, { recursive: true, force: true });
  }
});
