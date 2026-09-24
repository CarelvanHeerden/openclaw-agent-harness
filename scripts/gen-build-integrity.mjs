#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, ".oah-build-integrity.json");
const check = process.argv.includes("--check");
const roots = ["src", "dist", "docs", "scripts", ".github", "package.json", "openclaw.plugin.json", "README.md", "LICENSE"];

function collect(rel) {
  const absolute = resolve(root, rel);
  if (!existsSync(absolute)) throw new Error(`missing release input ${rel}`);
  if (!statSync(absolute).isDirectory()) return [rel];
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(root, path));
    }
  };
  walk(absolute);
  return files;
}

const files = roots.flatMap(collect).sort();
const entries = Object.fromEntries(files.map((file) => [
  file,
  createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex"),
]));
const manifest = `${JSON.stringify({ version: 1, algorithm: "sha256", entries }, null, 2)}\n`;

if (check) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== manifest) {
    throw new Error("release build integrity manifest is stale; run npm run build and commit the generated manifest");
  }
  console.log(`release build integrity verified for ${files.length} files`);
} else {
  writeFileSync(output, manifest);
}
