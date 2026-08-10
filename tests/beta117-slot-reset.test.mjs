/**
 * beta.117: resetting a pooled slot between sub-tasks.
 *
 * Exercises the REAL GitAdapter rather than a stub. The b117 e2e test supplies
 * its own reset implementation, so nothing there covers the adapter's actual
 * clean flags -- a mutation swapping `clean -fd` for `clean -fdx` survived the
 * whole suite until this file existed.
 *
 * The distinction matters more than it looks. `-x` also removes IGNORED files,
 * and `node_modules` is ignored. Adding it would delete the dependency tree the
 * slot paid ~25 seconds to install, on every single reuse -- which inverts the
 * entire cost argument for pooling slots instead of allocating per sub-task.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let GitAdapter;
try {
  ({ GitAdapter } = await import("../dist/adapters/git-worktree.js"));
} catch {
  GitAdapter = null;
}

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const g = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: ENV }).trim();

const dirs = [];
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("beta117: a slot reset keeps node_modules and discards the last sub-task's work",
  { skip: GitAdapter === null }, async () => {
    const root = mkdtempSync(join(tmpdir(), "oah-b117-reset-"));
    dirs.push(root);
    const wt = join(root, "slot");
    execFileSync("git", ["init", "-q", "-b", "main", wt], { env: ENV });
    g(wt, "config", "user.name", "T");
    g(wt, "config", "user.email", "t@e.com");
    g(wt, "config", "commit.gpgsign", "false");
    writeFileSync(join(wt, ".gitignore"), "node_modules\n");
    writeFileSync(join(wt, "a.txt"), "base\n");
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", "base");
    const clean = g(wt, "rev-parse", "HEAD");

    // A slot mid-use: installed dependencies, a committed change from the
    // previous sub-task, and untracked scratch left behind by the worker.
    mkdirSync(join(wt, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(wt, "a.txt"), "work from the previous sub-task\n");
    g(wt, "commit", "-qam", "previous sub-task");
    writeFileSync(join(wt, "scratch.tmp"), "untracked debris\n");

    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });
    await git.resetPooled(wt, clean);

    assert.ok(
      existsSync(join(wt, "node_modules", "left-pad", "index.js")),
      "the installed dependencies must survive, or every slot reuse costs another npm ci",
    );
    assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "base\n", "the previous sub-task's commit must be gone");
    assert.ok(!existsSync(join(wt, "scratch.tmp")), "and so must its untracked debris");
  });
