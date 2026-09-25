#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { contentManifest, publishedPackageBytes } from "./package-artifact-policy.mjs";

const root = process.cwd();
const action = process.argv[2];
const artifactPath = resolve(root, ".oah-artifact.json");
const packagePath = resolve(root, "package.json");
const dependencyManifestPath = "scripts/package-dependency-manifest.json";
const scope = resolve(root, "node_modules/@anthropic-ai");
const nativePrefix = "claude-agent-sdk-";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const gitPath = (name) => resolve(root, git("rev-parse", "--git-path", name));
const stash = gitPath("oah-pack-stash");
const lock = gitPath("oah-pack-lock");
const packageStash = gitPath("oah-pack-package.json");

function filesUnder(dir) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = resolve(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}
function committedBytes(file) {
  try { return execFileSync("git", ["show", `HEAD:${file}`], { cwd: root, maxBuffer: 128 * 1024 * 1024 }); }
  catch { throw new Error(`refusing to pack non-commit content: ${file}`); }
}
function assertPackedContentMatchesCommit(packageRoot) {
  const files = filesUnder(packageRoot);
  for (const file of files) {
    if (file === ".oah-artifact.json" || file.startsWith("node_modules/")) continue;
    const expected = file === "package.json" ? publishedPackageBytes(committedBytes(file)) : committedBytes(file);
    const packed = readFileSync(resolve(packageRoot, file));
    if (!packed.equals(expected)) throw new Error(`refusing to pack content that differs from HEAD: ${file}`);
  }
  const dependencies = contentManifest(packageRoot, files.filter((file) => file.startsWith("node_modules/")));
  const expected = JSON.parse(committedBytes(dependencyManifestPath).toString("utf8"));
  const mismatch = expected.entries?.findIndex((entry, index) => entry !== dependencies.entries[index]) ?? -1;
  if (
    expected.version !== 1 || expected.files !== dependencies.files || expected.digest !== dependencies.digest ||
    expected.entries?.length !== dependencies.entries.length || mismatch !== -1
  ) {
    const detail = mismatch === -1 ? "file set differs" : `first mismatch: expected ${expected.entries[mismatch]}, got ${dependencies.entries[mismatch]}`;
    throw new Error(`refusing to pack dependency content that differs from ${dependencyManifestPath}: ${detail}`);
  }
}
function manifestFor(packageRoot) {
  const files = filesUnder(packageRoot).filter((file) => file !== ".oah-artifact.json");
  return contentManifest(packageRoot, files);
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function acquireLock() {
  const deadline = Date.now() + 300_000;
  while (true) {
    try { mkdirSync(lock); writeFileSync(resolve(lock, "pid"), `${process.pid}\n`); return; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = 0; try { owner = Number(readFileSync(resolve(lock, "pid"), "utf8").trim()); } catch {}
      let stale = false; try { stale = Date.now() - statSync(lock).mtimeMs > 600_000; } catch {}
      if (stale) { rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for concurrent npm pack process ${owner}`);
      sleep(100);
    }
  }
}
function releaseLock() { rmSync(lock, { recursive: true, force: true }); }
function restore() {
  rmSync(artifactPath, { force: true });
  if (existsSync(packageStash)) renameSync(packageStash, packagePath);
  if (!existsSync(stash)) return;
  mkdirSync(scope, { recursive: true });
  for (const name of readdirSync(stash)) {
    const target = resolve(scope, name);
    rmSync(target, { recursive: true, force: true });
    renameSync(resolve(stash, name), target);
  }
  rmSync(stash, { recursive: true, force: true });
}
function stagePublishedPackage() {
  writeFileSync(packageStash, readFileSync(packagePath));
  writeFileSync(packagePath, publishedPackageBytes(committedBytes("package.json")));
}
function movePublisherNativePackages() {
  if (!existsSync(scope)) return;
  const native = readdirSync(scope).filter((name) => name.startsWith(nativePrefix));
  if (!native.length) return;
  mkdirSync(stash);
  for (const name of native) renameSync(resolve(scope, name), resolve(stash, name));
}
function packedManifest() {
  const temp = mkdtempSync(gitPath("oah-pack-manifest-"));
  try {
    const env = { ...process.env, npm_config_ignore_scripts: "true", npm_config_json: "false" };
    for (const name of Object.keys(env)) {
      if (name === "npm_command" || name.startsWith("npm_lifecycle_") || name.startsWith("npm_package_")) delete env[name];
    }
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", temp, "."], {
      cwd: root, encoding: "utf8", env,
    });
    const filename = readdirSync(temp).find((name) => name.endsWith(".tgz"));
    if (!filename) throw new Error("npm pack did not create the preliminary tarball");
    const extracted = resolve(temp, "extract");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", resolve(temp, basename(filename)), "-C", extracted]);
    const packageRoot = resolve(extracted, "package");
    assertPackedContentMatchesCommit(packageRoot);
    return manifestFor(packageRoot);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

const onSignal = (signal) => {
  try { restore(); releaseLock(); }
  finally { process.exit(128 + (signal === "SIGINT" ? 2 : 15)); }
};
process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

if (action === "prepare") {
  acquireLock();
  try {
    restore();
    const dirty = git("status", "--porcelain", "--untracked-files=all");
    if (dirty) throw new Error(`refusing to pack a dirty or untracked worktree:\n${dirty}`);
    const headSha = git("rev-parse", "HEAD");
    const treeSha = git("rev-parse", "HEAD^{tree}");
    stagePublishedPackage();
    movePublisherNativePackages();
    const manifest = packedManifest();
    const bindingDigest = createHash("sha256")
      .update(`openclaw-agent-harness-artifact/v2\n${headSha}\n${treeSha}\n${manifest.digest}\n${manifest.files}\n`)
      .digest("hex");
    writeFileSync(artifactPath, `${JSON.stringify({ version: 2, headSha, treeSha, packageManifestSha256: manifest.digest, packageFileCount: manifest.files, bindingDigest }, null, 2)}\n`);
  } catch (error) { restore(); releaseLock(); throw error; }
} else if (action === "restore") {
  restore(); releaseLock();
} else {
  throw new Error("Usage: node scripts/prepare-package-artifact.mjs <prepare|restore>");
}
