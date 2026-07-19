/**
 * beta.38: worktree-collision fixes in the git adapter (real git + real fs).
 *
 * Two behaviours, both from the Staging ProjectThanos smoke:
 *
 *  1. `robustRemoveDir` (exercised via releaseByPath): a worktree whose tree
 *     contains a nested/native-module dir must still be fully removed. The old
 *     `rm(recursive, force)` (no retries) lost the race against ENOTEMPTY/EBUSY
 *     on Next.js `node_modules/@next/swc-*` trees, orphaning the dir so it then
 *     collided with the next run on the same branch.
 *
 *  2. Branch-collision reconciliation semantics: `git worktree add -B <branch>`
 *     REFUSES when <branch> is already checked out in another worktree. This
 *     test reproduces that hard failure and proves that releasing the stale
 *     worktree first (exactly what `reconcileBranchWorktrees` does) unblocks the
 *     add. This is the precise failure that killed session 36f53c40
 *     (`fatal: '<branch>' is already checked out at '<pending-...>'`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

async function makeGitWorld() {
  const root = await mkdtemp(join(tmpdir(), "beta38-git-"));
  const bare = join(root, ".repos", "o", "r.git");
  await mkdir(bare, { recursive: true });
  const seed = join(root, ".seed");
  await mkdir(seed, { recursive: true });
  spawnSync("git", ["init", "--initial-branch=main", seed], { stdio: "ignore" });
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

test("beta.38: releaseByPath removes a worktree with a nested/populated subtree",
  skipAll, async () => {
    const { root, bare, repoFullName } = await makeGitWorld();
    const git = new GitAdapter({ worktreesRoot: root, logger: { info() {}, warn() {}, error() {} } });

    const wtPath = join(root, `pending-${Date.now()}`);
    spawnSync("git", ["-C", bare, "worktree", "add", "-B", "harness/beta38", wtPath, "main"], { stdio: "ignore" });
    // Simulate a heavy node_modules tree with deeply nested dirs (the class of
    // thing that produced ENOTEMPTY in the smoke).
    const deep = join(wtPath, "node_modules", "@next", "swc-linux-x64-musl", "nested", "more");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "binary.node"), "x".repeat(1024));
    assert.ok(existsSync(deep), "setup: nested tree must exist");

    const outcome = await git.releaseByPath(wtPath, repoFullName);
    assert.equal(outcome.ok, true, `release should succeed: ${outcome.error ?? ""}`);
    assert.equal(existsSync(wtPath), false, "worktree dir with nested subtree must be fully gone");

    await rm(root, { recursive: true, force: true });
  });

test("beta.38: branch-collision semantics — releasing the stale worktree unblocks add",
  skipAll, async () => {
    const { root, bare } = await makeGitWorld();
    const branch = "harness/collision";

    // First run's live worktree holds the branch.
    const p1 = join(root, `pending-${Date.now()}-1`);
    const add1 = spawnSync("git", ["-C", bare, "worktree", "add", "-B", branch, p1, "main"], { encoding: "utf8" });
    assert.equal(add1.status, 0, "first worktree add must succeed");

    // Second run tries to add the SAME branch at a new path -> must FAIL
    // (this is the exact fatal that killed session 36f53c40).
    const p2 = join(root, `pending-${Date.now()}-2`);
    const add2 = spawnSync("git", ["-C", bare, "worktree", "add", "-B", branch, p2, "main"], { encoding: "utf8" });
    assert.notEqual(add2.status, 0, "second add on the same branch must fail while p1 holds it");
    // git phrases this differently across versions: older git says
    // "already checked out at", newer git says "already used by worktree at".
    assert.match(add2.stderr, /already (checked out|used by worktree)/i);

    // reconcile: release p1 (what reconcileBranchWorktrees does), then retry.
    spawnSync("git", ["-C", bare, "worktree", "remove", "--force", p1], { stdio: "ignore" });
    spawnSync("git", ["-C", bare, "worktree", "prune"], { stdio: "ignore" });
    const add3 = spawnSync("git", ["-C", bare, "worktree", "add", "-B", branch, p2, "main"], { encoding: "utf8" });
    assert.equal(add3.status, 0, `add must succeed after releasing the stale worktree: ${add3.stderr}`);
    assert.ok(existsSync(p2));

    await rm(root, { recursive: true, force: true });
  });
