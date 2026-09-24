#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { contentManifest, publishedPackageBytes } from "./package-artifact-policy.mjs";

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

function strictFilesUnder(root) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = resolve(path, name);
      const metadata = lstatSync(full);
      if (metadata.isDirectory()) walk(full);
      else if (metadata.isFile()) out.push(relative(root, full));
      else throw new Error(`native package contains unsupported filesystem entry: ${relative(root, full)}`);
    }
  };
  walk(root);
  return out.sort();
}

function isWithin(root, candidate) {
  const rel = relative(realpathSync(root), realpathSync(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const expectedPackage = JSON.parse(readFileSync(resolve(expectedRoot, "package.json"), "utf8"));
const installedPackageBytes = readFileSync(resolve(installedRoot, "package.json"));
const installedPackage = JSON.parse(installedPackageBytes);
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

const committedBytes = (file) => {
  try { return execFileSync("git", ["show", `HEAD:${file}`], { cwd: expectedRoot, maxBuffer: 64 * 1024 * 1024 }); }
  catch { throw new Error(`packaged first-party file is not bound to the tested commit: ${file}`); }
};
const dependencyFiles = installedFiles.filter((file) => file.startsWith("node_modules/"));
const dependencyManifest = contentManifest(installedRoot, dependencyFiles);
const expectedDependencyManifest = JSON.parse(committedBytes("scripts/package-dependency-manifest.json").toString("utf8"));
const dependencyMismatch = expectedDependencyManifest.entries?.findIndex(
  (entry, index) => entry !== dependencyManifest.entries[index],
) ?? -1;
if (
  expectedDependencyManifest.version !== 1 ||
  expectedDependencyManifest.files !== dependencyManifest.files ||
  expectedDependencyManifest.digest !== dependencyManifest.digest ||
  expectedDependencyManifest.entries?.length !== dependencyManifest.entries.length ||
  dependencyMismatch !== -1
) {
  throw new Error("bundled dependency content is not bound to the tested commit");
}
const entries = installedFiles.filter((file) => file !== ".oah-artifact.json").map((file) => {
  const installed = sha(resolve(installedRoot, file));
  if (!file.startsWith("node_modules/")) {
    const expected = file === "package.json" ? publishedPackageBytes(committedBytes(file)) : committedBytes(file);
    const committed = createHash("sha256").update(expected).digest("hex");
    if (committed !== installed) throw new Error(`artifact mismatch: ${file}`);
  }
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
const consumerNodeModules = resolve(installedRoot, "..");
if (!isWithin(consumerNodeModules, nativePackageRoot)) {
  throw new Error(`Claude SDK native package did not resolve from the exact consumer installation: ${nativePackageRoot}`);
}
const expectedNativePackages = JSON.parse(
  committedBytes("scripts/claude-native-package-manifest.json").toString("utf8"),
);
const expectedNativePackage = expectedNativePackages.packages?.[nativePackageName];
const expectedLock = JSON.parse(committedBytes("package-lock.json").toString("utf8"));
const expectedLockPackage = expectedLock.packages?.[`node_modules/${nativePackageName}`];
if (
  expectedNativePackages.version !== 1 ||
  !expectedNativePackage ||
  expectedPackage.optionalDependencies?.[nativePackageName] !== expectedNativePackage.version ||
  expectedLockPackage?.version !== expectedNativePackage.version ||
  expectedLockPackage?.integrity !== expectedNativePackage.integrity
) {
  throw new Error(`Claude SDK native package manifest is stale or incomplete for ${nativePackageName}`);
}
const nativePackageFiles = strictFilesUnder(nativePackageRoot);
const nativePackageManifest = contentManifest(nativePackageRoot, nativePackageFiles);
const nativeMismatch = expectedNativePackage.entries?.findIndex(
  (entry, index) => entry !== nativePackageManifest.entries[index],
) ?? -1;
if (
  expectedNativePackage.files !== nativePackageManifest.files ||
  expectedNativePackage.digest !== nativePackageManifest.digest ||
  expectedNativePackage.entries?.length !== nativePackageManifest.entries.length ||
  nativeMismatch !== -1
) {
  throw new Error(`Claude SDK native package content is not bound to the tested commit: ${nativePackageName}`);
}
const claudeCommand = resolve(nativePackageRoot, process.platform === "win32" ? "claude.exe" : "claude");
if (!existsSync(claudeCommand)) throw new Error(`installed Claude SDK native executable is missing: ${claudeCommand}`);
if (!isWithin(consumerNodeModules, claudeCommand)) {
  throw new Error(`Claude SDK native executable did not resolve from the exact consumer installation: ${claudeCommand}`);
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
  claudeNativePackageManifestSha256: nativePackageManifest.digest,
  claudeCommand,
  claudeVersion: claudeVersionText,
  testedRoot: expectedRoot,
  installedRoot,
}, null, 2));
