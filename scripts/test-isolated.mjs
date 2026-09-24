#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(dirname(root), ".oah-test-"));
const cleanup = () => rmSync(temp, { recursive: true, force: true });
const interrupted = (signal) => { cleanup(); process.exit(128 + (signal === "SIGINT" ? 2 : 15)); };
process.once("SIGINT", () => interrupted("SIGINT"));
process.once("SIGTERM", () => interrupted("SIGTERM"));

try {
  const source = join(temp, "source");
  execFileSync("git", ["clone", "--quiet", "--shared", root, source], { cwd: temp });
  const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  if (patch.length) execFileSync("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd: source, input: patch, maxBuffer: 128 * 1024 * 1024 });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean);
  for (const relative of untracked) {
    const from = join(root, relative);
    const to = join(source, relative);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: source, encoding: "utf8" });
  if (dirty.trim()) {
    execFileSync("git", ["add", "-A"], { cwd: source });
    execFileSync("git", ["-c", "user.name=Isolated Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "isolated test snapshot"], { cwd: source });
  }
  if (existsSync(join(root, "node_modules"))) execFileSync("cp", ["-al", join(root, "node_modules"), join(source, "node_modules")], { cwd: temp });
  const result = spawnSync("npm", ["run", "test:in-place"], {
    cwd: source,
    stdio: "inherit",
    env: { ...process.env, OAH_TEST_ISOLATED: "1", GIT_CONFIG_GLOBAL: join(source, "tests/fixtures/gitconfig"), GIT_CONFIG_SYSTEM: "/dev/null" },
    timeout: 1_800_000,
  });
  process.exitCode = result.status ?? 1;
} finally {
  cleanup();
}
