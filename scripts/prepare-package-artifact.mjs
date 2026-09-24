#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const root = process.cwd();
const action = process.argv[2];
const artifactPath = resolve(root, ".oah-artifact.json");
const scope = resolve(root, "node_modules/@anthropic-ai");
const nativePrefix = "claude-agent-sdk-";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const gitPath = (name) => resolve(root, git("rev-parse", "--git-path", name));
const stash = gitPath("oah-pack-stash");
const lock = gitPath("oah-pack-lock");

function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
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
function manifestFor(packageRoot) {
  const entries = filesUnder(packageRoot)
    .filter((file) => file !== ".oah-artifact.json")
    .map((file) => `${sha(resolve(packageRoot, file))}  ${file}`);
  return { files: entries.length, digest: createHash("sha256").update(entries.join("\n")).digest("hex") };
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
  if (!existsSync(stash)) return;
  mkdirSync(scope, { recursive: true });
  for (const name of readdirSync(stash)) {
    const target = resolve(scope, name);
    rmSync(target, { recursive: true, force: true });
    renameSync(resolve(stash, name), target);
  }
  rmSync(stash, { recursive: true, force: true });
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
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", temp, "."], {
      cwd: root, encoding: "utf8", env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_json: "false" },
    });
    const filename = readdirSync(temp).find((name) => name.endsWith(".tgz"));
    if (!filename) throw new Error("npm pack did not create the preliminary tarball");
    const extracted = resolve(temp, "extract");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", resolve(temp, basename(filename)), "-C", extracted]);
    return manifestFor(resolve(extracted, "package"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (action === "prepare") {
  acquireLock();
  try {
    restore();
    const dirty = git("status", "--porcelain", "--untracked-files=all");
    if (dirty) throw new Error(`refusing to pack a dirty or untracked worktree:\n${dirty}`);
    const headSha = git("rev-parse", "HEAD");
    const treeSha = git("rev-parse", "HEAD^{tree}");
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
