/**
 * beta.36: GitAdapter.revertCommits — real git.
 *
 * Sets up a real "origin" bare + the harness's local bare clone with an
 * `origin` remote, seeds two commits on main, then reverts them newest-first
 * and asserts main is back to the base tree and the reverts were pushed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let GitAdapter;
try {
  ({ GitAdapter } = await import("../dist/adapters/git-worktree.js"));
} catch {
  GitAdapter = null;
}
const skipAll = { skip: GitAdapter === null };
const g = (args, cwd) => spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

async function world() {
  const root = await mkdtemp(join(tmpdir(), "beta36-revert-"));
  const origin = join(root, "origin.git");
  const bare = join(root, ".repos", "o", "r.git");
  await mkdir(bare, { recursive: true });
  g(["init", "--bare", "--initial-branch=main", origin]);

  // Seed origin with 3 commits on main: base, C1, C2.
  const seed = join(root, ".seed");
  await mkdir(seed, { recursive: true });
  g(["init", "--initial-branch=main", seed]);
  g(["config", "user.email", "t@t"], seed);
  g(["config", "user.name", "t"], seed);
  await writeFile(join(seed, "f.txt"), "base\n");
  g(["add", "-A"], seed); g(["commit", "-m", "base"], seed);
  await writeFile(join(seed, "f.txt"), "base\nc1\n");
  g(["add", "-A"], seed); g(["commit", "-m", "c1"], seed);
  const c1 = g(["rev-parse", "HEAD"], seed).stdout.trim();
  await writeFile(join(seed, "f.txt"), "base\nc1\nc2\n");
  g(["add", "-A"], seed); g(["commit", "-m", "c2"], seed);
  const c2 = g(["rev-parse", "HEAD"], seed).stdout.trim();
  g(["push", origin, "main"], seed);

  // Local bare clone of origin (mimics the harness bare repo with an origin remote).
  g(["clone", "--bare", origin, bare]);
  g(["-C", bare, "remote", "set-url", "origin", origin]); // ensure origin points at our bare origin
  await rm(seed, { recursive: true, force: true });
  return { root, origin, bare, c1, c2 };
}

test("revertCommits reverts newest-first and pushes to main", skipAll, async () => {
  const { root, origin, bare, c1, c2 } = await world();
  void bare;
  // worktreesRoot must be the dir that CONTAINS `.repos/o/r.git`; that's `root`.
  const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

  // Revert c2 then c1 (newest-first). No token needed for a local file remote.
  const res = await git.revertCommits("o/r", [c2, c1], "unused-token", { baseBranch: "main" });
  assert.equal(res.pushedToMain, true, "local file remote allows direct push to main");
  assert.equal(res.revertedShas.length, 2);

  // origin/main tree should now equal the base (f.txt == "base\n").
  const check = await mkdtemp(join(tmpdir(), "beta36-check-"));
  g(["clone", origin, check]);
  const content = spawnSync("cat", [join(check, "f.txt")], { encoding: "utf8" }).stdout;
  assert.equal(content, "base\n", `main should be reverted to base, got: ${JSON.stringify(content)}`);

  await rm(root, { recursive: true, force: true });
  await rm(check, { recursive: true, force: true });
});
