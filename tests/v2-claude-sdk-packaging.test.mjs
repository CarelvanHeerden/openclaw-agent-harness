import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
    assert.ok(
      !artifact.bundled?.some((name) => name === "@anthropic-ai/claude-agent-sdk" || name.startsWith("@anthropic-ai/claude-agent-sdk-")),
      "the platform-selecting SDK and its native optional packages must be installed for the consumer, not frozen into the publisher platform tarball",
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
    assert.equal(
      JSON.parse(readFileSync(join(installDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")).version,
      result.claudeSdkVersion,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
