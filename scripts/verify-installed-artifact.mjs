#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
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

const installedFiles = filesUnder(installedRoot, ".");
const requiredRoots = ["dist/", "docs/", "scripts/"];
for (const root of requiredRoots) {
  if (!installedFiles.some((file) => file.startsWith(root))) {
    throw new Error(`packaged file list is missing required root ${root}`);
  }
}
for (const file of ["package.json", "openclaw.plugin.json", "README.md", "LICENSE"]) {
  if (!installedFiles.includes(file)) throw new Error(`packaged file list is missing ${file}`);
}

const entries = installedFiles.map((file) => {
  if (!existsSync(resolve(expectedRoot, file))) throw new Error(`packaged file has no tested-checkout source: ${file}`);
  const expected = sha(resolve(expectedRoot, file));
  const installed = sha(resolve(installedRoot, file));
  if (expected !== installed) throw new Error(`artifact mismatch: ${file}`);
  return `${expected}  ${file}`;
});
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
const manifestSha256 = createHash("sha256").update(entries.join("\n")).digest("hex");
console.log(JSON.stringify({
  ok: true,
  version: expectedPackage.version,
  files: entries.length,
  manifestSha256,
  openCodeCommand: openCode.command,
  openCodeVersion: (openCodeVersion.stdout || openCodeVersion.stderr || "").trim(),
  testedRoot: expectedRoot,
  installedRoot,
}, null, 2));
