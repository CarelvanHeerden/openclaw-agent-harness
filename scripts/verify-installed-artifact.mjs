#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
      const relPath = relative(root, full);
      if (relPath === "node_modules/.bin" || relPath.startsWith("node_modules/.bin/")) continue;
      const metadata = lstatSync(full);
      if (metadata.isDirectory()) walk(full);
      else if (metadata.isFile()) out.push(relPath);
      else throw new Error(`artifact contains unsupported filesystem entry: ${relPath}`);
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

function manifestEntries(manifest, label, prefix = "") {
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`${label} is stale or invalid`);
  }
  const entries = new Map();
  for (const entry of manifest.entries) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(entry);
    if (!match || entries.has(`${prefix}${match[2]}`)) throw new Error(`${label} is stale or invalid`);
    entries.set(`${prefix}${match[2]}`, match[1]);
  }
  const digest = createHash("sha256").update(manifest.entries.join("\n")).digest("hex");
  if (
    (manifest.files !== undefined && manifest.files !== entries.size) ||
    (manifest.digest !== undefined && manifest.digest !== digest)
  ) {
    throw new Error(`${label} is stale or invalid`);
  }
  return entries;
}

function assertExactFiles(installedFiles, expectedEntries, label) {
  for (const [file, expectedSha] of expectedEntries) {
    if (!installedFiles.includes(file) || sha(resolve(installedRoot, file)) !== expectedSha) {
      throw new Error(`${label}: ${file}`);
    }
  }
}

function verifyInstallLock(installedFiles, committedLock) {
  const lockPath = resolve(installedRoot, "node_modules/.package-lock.json");
  if (!existsSync(lockPath)) return;
  const lockBytes = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(lockBytes);
  if (lockBytes !== `${JSON.stringify(lock, null, 2)}\n` || lock.lockfileVersion !== 3 || lock.requires !== true) {
    throw new Error("installed package-manager lock metadata is not canonical");
  }
  if (Object.keys(lock).some((key) => !["lockfileVersion", "requires", "packages"].includes(key))) {
    throw new Error("installed package-manager lock metadata contains unexpected fields");
  }
  const installedPackageKeys = Object.keys(committedLock.packages ?? {})
    .filter((key) => key.startsWith("node_modules/") && installedFiles.includes(`${key}/package.json`))
    .sort();
  const lockKeys = Object.keys(lock.packages ?? {}).sort();
  if (installedPackageKeys.length !== lockKeys.length || installedPackageKeys.some((key, index) => key !== lockKeys[index])) {
    throw new Error("installed package-manager lock metadata does not describe the exact dependency tree");
  }
  for (const key of lockKeys) {
    const committed = committedLock.packages?.[key];
    if (!committed) throw new Error(`installed package-manager lock metadata is not bound to the tested commit: ${key}`);
    const expected = structuredClone(committed);
    const actual = lock.packages[key];
    for (const field of ["resolved", "integrity"]) {
      if (expected.inBundle === true && !(field in actual)) delete expected[field];
    }
    if (key.startsWith("node_modules/@anthropic-ai/claude-agent-sdk-") && !("libc" in expected)) {
      const packageJson = JSON.parse(readFileSync(resolve(installedRoot, key, "package.json"), "utf8"));
      if (packageJson.libc !== undefined) expected.libc = packageJson.libc;
    }
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`installed package-manager lock metadata is not bound to the tested commit: ${key}`);
    }
  }
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
const expectedDependencyManifest = JSON.parse(committedBytes("scripts/package-dependency-manifest.json").toString("utf8"));
const expectedDependencyEntries = manifestEntries(
  expectedDependencyManifest,
  "bundled dependency manifest",
);
const installAdditionsManifest = JSON.parse(
  committedBytes("scripts/package-install-additions-manifest.json").toString("utf8"),
);
const installAdditionEntries = manifestEntries(
  installAdditionsManifest,
  "package-manager install additions manifest",
);
const expectedNativePackages = JSON.parse(
  committedBytes("scripts/claude-native-package-manifest.json").toString("utf8"),
);
const expectedOpenCodePackages = JSON.parse(
  committedBytes("scripts/opencode-native-package-manifest.json").toString("utf8"),
);
const nativeInstallEntries = new Map();
const nativeInstallPackages = new Map();
for (const [name, manifest] of Object.entries({
  ...(expectedNativePackages.packages ?? {}),
  ...(expectedOpenCodePackages.packages ?? {}),
})) {
  const packageEntries = manifestEntries(
    { version: 1, files: manifest.files, digest: manifest.digest, entries: manifest.entries },
    `native package manifest for ${name}`,
    `node_modules/${name}/`,
  );
  nativeInstallPackages.set(`node_modules/${name}/`, packageEntries);
  for (const [file, digest] of packageEntries) {
    if (nativeInstallEntries.has(file)) throw new Error(`duplicate native package manifest entry: ${file}`);
    nativeInstallEntries.set(file, digest);
  }
}
assertExactFiles(installedFiles, expectedDependencyEntries, "bundled dependency content is not bound to the tested commit");
const hasLocalInstallLayout = dependencyFiles.some((file) => (
  file === "node_modules/.package-lock.json" ||
  installAdditionEntries.has(file) ||
  nativeInstallEntries.has(file)
));
if (hasLocalInstallLayout) {
  assertExactFiles(installedFiles, installAdditionEntries, "package-manager-added dependency content is not bound to the tested commit");
}
for (const [prefix, packageEntries] of nativeInstallPackages) {
  const present = dependencyFiles.filter((file) => file.startsWith(prefix));
  if (!present.length) continue;
  const packageName = prefix.slice("node_modules/".length, -1);
  const label = packageName.startsWith("opencode-")
    ? "OpenCode native package content is not bound to the tested commit"
    : "Claude SDK native package content is not bound to the tested commit";
  if (present.length !== packageEntries.size || present.some((file) => !packageEntries.has(file))) {
    throw new Error(`${label}: ${packageName}`);
  }
  assertExactFiles(installedFiles, packageEntries, label);
}
for (const file of dependencyFiles) {
  if (
    file === "node_modules/.package-lock.json" ||
    expectedDependencyEntries.has(file) ||
    installAdditionEntries.has(file) ||
    nativeInstallEntries.has(file)
  ) continue;
  throw new Error(`installed dependency has no authenticated source: ${file}`);
}
verifyInstallLock(installedFiles, JSON.parse(committedBytes("package-lock.json").toString("utf8")));
const installAddedFiles = new Set([
  "node_modules/.package-lock.json",
  ...installAdditionEntries.keys(),
  ...nativeInstallEntries.keys(),
]);
const entries = installedFiles.filter((file) => file !== ".oah-artifact.json" && !installAddedFiles.has(file)).map((file) => {
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
const openCodePackageRoot = dirname(dirname(openCode.command));
const openCodePackage = JSON.parse(readFileSync(resolve(openCodePackageRoot, "package.json"), "utf8"));
const expectedOpenCodePackage = expectedOpenCodePackages.packages?.[openCodePackage.name];
const expectedOpenCodeLock = JSON.parse(committedBytes("package-lock.json").toString("utf8")).packages?.[`node_modules/${openCodePackage.name}`];
if (
  expectedOpenCodePackages.version !== 1 ||
  !expectedOpenCodePackage ||
  expectedOpenCodePackage.version !== openCodePackage.version ||
  expectedOpenCodeLock?.version !== expectedOpenCodePackage.version ||
  expectedOpenCodeLock?.integrity !== expectedOpenCodePackage.integrity
) {
  throw new Error(`OpenCode native package manifest is stale or incomplete for ${openCodePackage.name}`);
}
const openCodePackageFiles = strictFilesUnder(openCodePackageRoot);
const openCodePackageManifest = contentManifest(openCodePackageRoot, openCodePackageFiles);
const openCodeMismatch = expectedOpenCodePackage.entries?.findIndex(
  (entry, index) => entry !== openCodePackageManifest.entries[index],
) ?? -1;
if (
  expectedOpenCodePackage.entries?.length !== openCodePackageManifest.entries.length ||
  openCodeMismatch !== -1
) {
  throw new Error(`OpenCode native package content is not bound to the tested commit: ${openCodePackage.name}`);
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
