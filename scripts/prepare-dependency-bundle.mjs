#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";

const action = process.argv[2];
const root = process.cwd();
const scope = resolve(root, "node_modules/@anthropic-ai");
const stash = resolve(root, ".oah-pack-stash");
const prefix = "claude-agent-sdk-";

function restore() {
  if (!existsSync(stash)) return;
  mkdirSync(scope, { recursive: true });
  for (const name of readdirSync(stash)) {
    const target = resolve(scope, name);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(resolve(stash, name), target);
  }
  rmdirSync(stash);
}

if (action === "hide") {
  restore();
  if (existsSync(scope)) {
    const names = readdirSync(scope).filter((name) => name.startsWith(prefix));
    if (names.length > 0) {
      mkdirSync(stash);
      for (const name of names) renameSync(resolve(scope, name), resolve(stash, name));
    }
  }
} else if (action === "restore") {
  restore();
} else {
  throw new Error("Usage: node scripts/prepare-dependency-bundle.mjs <hide|restore>");
}
