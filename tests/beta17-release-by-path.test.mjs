/**
 * beta.17 fix #1 (blocker): `git.releaseByPath` actually removes the
 * physical worktree.
 *
 * Root cause of the beta.16 smoke #2 failure: `git.release(sessionId, repo)`
 * reconstructed the worktree path via `sessionWorktreePath(sessionId)`,
 * which uses `<worktrees_root>/<sessionId>`. The allocator (see
 * index.ts allocateWorktree) uses `sessionId: 'pending-' + Date.now()`,
 * NOT the DB session UUID. So the reconstructed path never existed, and
 * `if (!existsSync(wt)) return` silently no-op'd every release call.
 * The audit event fired anyway, producing telemetry-only "released"
 * events that lied to operators.
 *
 * These tests exercise the physical file-system side effect: create a
 * fake worktree dir under a real git repo, call releaseByPath, and
 * assert the dir is actually gone. Uses real git + real fs (no mocks).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let GitAdapter;
try {
  ({ GitAdapter } = await import("../dist/adapters/git-worktree.js"));
} catch {
  GitAdapter = null;
}

const skipAll = { skip: GitAdapter === null };

/** Minimal git bare + worktree setup so releaseByPath can actually run.
 *  A fresh bare repo has no commits, so we seed one via a non-bare clone
 *  and then push the initial commit to the bare. That gives us a `main`
 *  branch the harness can worktree-add against. */
async function makeGitWorld() {
  const root = await mkdtemp(join(tmpdir(), "beta17-git-"));
  const bare = join(root, ".repos", "o", "r.git");
  await mkdir(bare, { recursive: true });

  // Initialise a normal repo, commit, then push to a bare init'd sibling.
  const seed = join(root, ".seed");
  await mkdir(seed, { recursive: true });
  const seedEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  spawnSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore", env: seedEnv });
  spawnSync("git", ["-C", seed, "config", "user.email", "test@test"], { stdio: "ignore" });
  spawnSync("git", ["-C", seed, "config", "user.name", "test"], { stdio: "ignore" });
  await writeFile(join(seed, "README.md"), "seed\n");
  spawnSync("git", ["-C", seed, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", seed, "commit", "-m", "seed"], { stdio: "ignore" });
  spawnSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "ignore" });
  spawnSync("git", ["-C", seed, "push", bare, "main"], { stdio: "ignore" });
  await rm(seed, { recursive: true, force: true });
  return { root, bare, repoFullName: "o/r" };
}

test(
  "beta.17: releaseByPath actually removes a pending-<ts> worktree",
  skipAll,
  async () => {
    const { root, bare, repoFullName } = await makeGitWorld();
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

    // Allocate a real per-session worktree with the pending-<ts> id shape
    // the allocator uses in production.
    const pendingId = `pending-${Date.now()}`;
    const wtPath = join(root, pendingId);
    spawnSync("git", ["-C", bare, "worktree", "add", "-B", "harness/beta17-test", wtPath, "main"], { stdio: "ignore" });
    assert.ok(existsSync(wtPath), "setup: worktree dir must exist before release");

    const outcome = await git.releaseByPath(wtPath, repoFullName);
    assert.equal(outcome.ok, true, `release should succeed: ${outcome.error ?? ""}`);
    assert.equal(outcome.path, wtPath);

    assert.equal(existsSync(wtPath), false, "physical worktree dir must be gone after release");

    // `git worktree list` must no longer register the removed worktree.
    const list = spawnSync("git", ["-C", bare, "worktree", "list", "--porcelain"], { encoding: "utf8" }).stdout;
    assert.ok(!list.includes(pendingId), `git worktree list must not include ${pendingId}: ${list}`);

    await rm(root, { recursive: true, force: true });
  },
);

test(
  "beta.17: releaseByPath returns ok:true when the path is already gone (idempotent)",
  skipAll,
  async () => {
    const { root, repoFullName } = await makeGitWorld();
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

    const missing = join(root, "pending-never-existed-9999");
    const outcome = await git.releaseByPath(missing, repoFullName);
    assert.equal(outcome.ok, true, "missing path is not an error");
    await rm(root, { recursive: true, force: true });
  },
);

test(
  "beta.17: releaseByPath returns ok:false with error for empty path",
  skipAll,
  async () => {
    const { root, repoFullName } = await makeGitWorld();
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

    const outcome = await git.releaseByPath("", repoFullName);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /empty/i);
    await rm(root, { recursive: true, force: true });
  },
);

test(
  "beta.17: release(sessionId, repo, worktreePath) uses worktreePath override, not reconstruction",
  skipAll,
  async () => {
    // Regression: beta.16's git.release(id, repo) reconstructed the path
    // from id via sessionWorktreePath. If a caller passes the correct
    // worktreePath as the 3rd arg, that MUST win.
    const { root, bare, repoFullName } = await makeGitWorld();
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

    const pendingId = `pending-${Date.now()}`;
    const wtPath = join(root, pendingId);
    spawnSync("git", ["-C", bare, "worktree", "add", "-B", "harness/beta17-override", wtPath, "main"], { stdio: "ignore" });
    assert.ok(existsSync(wtPath));

    // Note the DB-session-UUID that would NOT match the actual dir on disk.
    const wrongSessionId = "65cb022d-6ff9-4372-a9e0-063e5200115f";
    const outcome = await git.release(wrongSessionId, repoFullName, wtPath);
    assert.equal(outcome.ok, true, `release with override should succeed: ${outcome.error ?? ""}`);
    assert.equal(existsSync(wtPath), false);

    await rm(root, { recursive: true, force: true });
  },
);

test(
  "beta.17: listWorktreeDirs enumerates per-session dirs but excludes .repos",
  skipAll,
  async () => {
    const { root, bare, repoFullName } = await makeGitWorld();
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

    // Create two allocator-shaped dirs
    for (const name of [`pending-${Date.now()}-a`, `pending-${Date.now()}-b`]) {
      await mkdir(join(root, name), { recursive: true });
    }
    const dirs = await git.listWorktreeDirs();
    const names = dirs.map((d) => d.split("/").pop());
    assert.ok(names.some((n) => n.startsWith("pending-")), `expected pending-* entries: ${names.join(",")}`);
    assert.ok(!names.includes(".repos"), `.repos must be excluded`);

    await rm(root, { recursive: true, force: true });
  },
);
