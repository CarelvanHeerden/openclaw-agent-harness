#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const expectedRoot = resolve(process.argv[2] ?? process.cwd());
const installedRoot = resolve(process.argv[3] ?? "");
if (!process.argv[3]) {
  throw new Error("Usage: node scripts/verify-installed-artifact.mjs <tested-checkout> <installed-package-root>");
}

function filesUnder(root, rel) {
  const start = resolve(root, rel);
  if (!existsSync(start)) throw new Error(`missing ${start}`);
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = resolve(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(start);
  return out.sort();
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const expectedPackage = JSON.parse(readFileSync(resolve(expectedRoot, "package.json"), "utf8"));
const installedPackage = JSON.parse(readFileSync(resolve(installedRoot, "package.json"), "utf8"));
const artifactBinding = JSON.parse(readFileSync(resolve(installedRoot, ".oah-artifact.json"), "utf8"));
const expectedHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: expectedRoot, encoding: "utf8" }).trim();
const expectedTreeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: expectedRoot, encoding: "utf8" }).trim();
if (artifactBinding.version !== 2 || artifactBinding.headSha !== expectedHeadSha || artifactBinding.treeSha !== expectedTreeSha) {
  throw new Error(`stale or invalid artifact binding: expected ${expectedHeadSha}/${expectedTreeSha}`);
}
if (expectedPackage.version !== installedPackage.version) {
  throw new Error(`version mismatch: tested ${expectedPackage.version}, installed ${installedPackage.version}`);
}

const installedFiles = filesUnder(installedRoot, ".").filter((file) => !file.startsWith("node_modules/.bin/"));
const requiredRoots = ["dist/", "docs/", "scripts/"];
for (const root of requiredRoots) {
  if (!installedFiles.some((file) => file.startsWith(root))) {
    throw new Error(`packaged file list is missing required root ${root}`);
  }
}
for (const file of ["package.json", "openclaw.plugin.json", "README.md", "LICENSE", ".oah-artifact.json"]) {
  if (!installedFiles.includes(file)) throw new Error(`packaged file list is missing ${file}`);
}

const entries = installedFiles.filter((file) => file !== ".oah-artifact.json").map((file) => {
  const installed = sha(resolve(installedRoot, file));
  let committed;
  if (file.startsWith("node_modules/")) {
    const source = resolve(expectedRoot, file);
    if (!existsSync(source)) throw new Error(`bundled dependency has no tested source: ${file}`);
    committed = sha(source);
  } else {
    try {
      committed = createHash("sha256").update(execFileSync("git", ["show", `HEAD:${file}`], { cwd: expectedRoot, maxBuffer: 64 * 1024 * 1024 })).digest("hex");
    } catch {
      throw new Error(`packaged first-party file is not bound to the tested commit: ${file}`);
    }
  }
  if (committed !== installed) throw new Error(`artifact mismatch: ${file}`);
  return `${installed}  ${file}`;
});
const manifestSha256 = createHash("sha256").update(entries.join("\n")).digest("hex");
const expectedBindingDigest = createHash("sha256")
  .update(`openclaw-agent-harness-artifact/v2\n${expectedHeadSha}\n${expectedTreeSha}\n${manifestSha256}\n${entries.length}\n`)
  .digest("hex");
if (
  artifactBinding.packageManifestSha256 !== manifestSha256 ||
  artifactBinding.packageFileCount !== entries.length ||
  artifactBinding.bindingDigest !== expectedBindingDigest
) {
  throw new Error(`packed content manifest is not bound to commit ${expectedHeadSha}`);
}
const { resolveOpenCodeBinary } = await import(
  pathToFileURL(resolve(installedRoot, "dist/adapters/backend-router.js")).href
);
const openCode = resolveOpenCodeBinary(undefined, undefined, installedRoot);
if (
  openCode.source !== "dependency" ||
  !realpathSync(openCode.command).startsWith(realpathSync(resolve(installedRoot, "..")))
) {
  throw new Error(`OpenCode did not resolve from the durable installation: ${JSON.stringify(openCode)}`);
}
const openCodeVersion = spawnSync(openCode.command, ["--version"], {
  encoding: "utf8",
  timeout: 10_000,
});
if (openCodeVersion.status !== 0) {
  throw new Error(`installed OpenCode executable failed --version: ${openCodeVersion.stderr || openCodeVersion.stdout}`);
}

const installedRequire = createRequire(resolve(installedRoot, "package.json"));
const sdkEntry = installedRequire.resolve("@anthropic-ai/claude-agent-sdk");
const sdkRoot = dirname(sdkEntry);
const sdkPackage = JSON.parse(readFileSync(resolve(sdkRoot, "package.json"), "utf8"));
const isMusl = process.platform === "linux" && process.report?.getReport?.().header?.glibcVersionRuntime === undefined;
const platformSuffix = process.platform === "linux"
  ? `linux-${process.arch}${isMusl ? "-musl" : ""}`
  : `${process.platform}-${process.arch}`;
const nativePackageName = `@anthropic-ai/claude-agent-sdk-${platformSuffix}`;
const nativePackageRoot = dirname(installedRequire.resolve(`${nativePackageName}/package.json`));
const claudeCommand = resolve(nativePackageRoot, process.platform === "win32" ? "claude.exe" : "claude");
if (!existsSync(claudeCommand)) throw new Error(`installed Claude SDK native executable is missing: ${claudeCommand}`);
if (!realpathSync(claudeCommand).startsWith(realpathSync(resolve(installedRoot, "..")))) {
  throw new Error(`Claude SDK native executable did not resolve from the durable installation: ${claudeCommand}`);
}
const claudeVersion = spawnSync(claudeCommand, ["--version"], {
  encoding: "utf8",
  timeout: 15_000,
});
if (claudeVersion.status !== 0) {
  throw new Error(`installed Claude SDK native executable failed --version: ${claudeVersion.stderr || claudeVersion.stdout}`);
}
const claudeVersionText = (claudeVersion.stdout || claudeVersion.stderr || "").trim();
if (sdkPackage.claudeCodeVersion && !claudeVersionText.startsWith(sdkPackage.claudeCodeVersion)) {
  throw new Error(`Claude SDK native version mismatch: SDK expects ${sdkPackage.claudeCodeVersion}, got ${claudeVersionText}`);
}

console.log(JSON.stringify({
  ok: true,
  version: expectedPackage.version,
  headSha: expectedHeadSha,
  treeSha: expectedTreeSha,
  artifactBindingDigest: expectedBindingDigest,
  files: entries.length,
  manifestSha256,
  openCodeCommand: openCode.command,
  openCodeVersion: (openCodeVersion.stdout || openCodeVersion.stderr || "").trim(),
  claudeSdkVersion: sdkPackage.version,
  claudeNativePackage: nativePackageName,
  claudeCommand,
  claudeVersion: claudeVersionText,
  testedRoot: expectedRoot,
  installedRoot,
}, null, 2));
