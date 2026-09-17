#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

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
    for (const name of readdirSync(path)) {
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
if (expectedPackage.version !== installedPackage.version) {
  throw new Error(`version mismatch: tested ${expectedPackage.version}, installed ${installedPackage.version}`);
}

const expectedFiles = [
  ...filesUnder(expectedRoot, "dist"),
  "package.json",
  "openclaw.plugin.json",
].sort();
const installedFiles = [
  ...filesUnder(installedRoot, "dist"),
  "package.json",
  "openclaw.plugin.json",
].sort();
if (JSON.stringify(expectedFiles) !== JSON.stringify(installedFiles)) {
  throw new Error("packaged file list differs from the tested checkout");
}

const entries = expectedFiles.map((file) => {
  const expected = sha(resolve(expectedRoot, file));
  const installed = sha(resolve(installedRoot, file));
  if (expected !== installed) throw new Error(`artifact mismatch: ${file}`);
  return `${expected}  ${file}`;
});
const manifestSha256 = createHash("sha256").update(entries.join("\n")).digest("hex");
console.log(JSON.stringify({
  ok: true,
  version: expectedPackage.version,
  files: entries.length,
  manifestSha256,
  testedRoot: expectedRoot,
  installedRoot,
}, null, 2));
