#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const action = process.argv[2];
const artifactPath = resolve(root, ".oah-artifact.json");
const scope = resolve(root, "node_modules/@anthropic-ai");
const stash = resolve(root, ".oah-pack-stash");
const lock = resolve(root, ".oah-pack-lock");
const nativePrefix = "claude-agent-sdk-";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function acquireLock() {
  const deadline = Date.now() + 300_000;
  while (true) {
    try {
      mkdirSync(lock);
      writeFileSync(resolve(lock, "pid"), `${process.pid}\n`);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = 0;
      try { owner = Number(readFileSync(resolve(lock, "pid"), "utf8").trim()); } catch {}
      let stale = false;
      try { stale = Date.now() - statSync(lock).mtimeMs > 600_000; } catch {}
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

if (action === "prepare") {
  acquireLock();
  try {
    restore();
    const dirty = git("status", "--porcelain", "--untracked-files=no");
    if (dirty) throw new Error(`refusing to pack a tracked dirty worktree:\n${dirty}`);
    const headSha = git("rev-parse", "HEAD");
    const treeSha = git("rev-parse", "HEAD^{tree}");
    const bindingDigest = createHash("sha256")
      .update(`openclaw-agent-harness-artifact/v1\n${headSha}\n${treeSha}\n`)
      .digest("hex");
    writeFileSync(artifactPath, `${JSON.stringify({ version: 1, headSha, treeSha, bindingDigest }, null, 2)}\n`);
    if (existsSync(scope)) {
      const native = readdirSync(scope).filter((name) => name.startsWith(nativePrefix));
      if (native.length) {
        mkdirSync(stash);
        for (const name of native) renameSync(resolve(scope, name), resolve(stash, name));
      }
    }
  } catch (error) {
    restore();
    releaseLock();
    throw error;
  }
} else if (action === "restore") {
  restore();
  releaseLock();
} else {
  throw new Error("Usage: node scripts/prepare-package-artifact.mjs <prepare|restore>");
}
