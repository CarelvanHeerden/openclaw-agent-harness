/**
 * beta.46: the bare-repo refresh fetch must target remote-tracking refs
 * (refs/remotes/origin/*), never local branch heads (refs/heads/*).
 *
 * Regression for the first live beta.45 revise (Staging session dab303e8,
 * PR #858, worktree pending-1784500729321). beta.45 stopped the self-heal
 * from reaping the live worktree, so the run progressed to the branch-pin
 * and then died during planning at:
 *
 *   git fetch --prune origin +refs/heads/*:refs/heads/* failed (128):
 *   fatal: refusing to fetch into branch 'refs/heads/harness/...'
 *          checked out at '<worktree>'
 *
 * The full-mirror refspec force-updates every LOCAL head; git refuses to
 * update a head currently checked out in a worktree -- which the pinned
 * revise branch always is (or a leftover pending-<ts> from a prior aborted
 * run held it). Fetching into remote-tracking refs never touches local
 * heads, so it can never be refused on account of a checkout.
 *
 * This test reproduces the exact git behavior with a real bare repo + a
 * checked-out branch, proving (a) the OLD refspec is refused and (b) the
 * NEW refspec succeeds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let canGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  canGit = false;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.io",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.io",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

test(
  "beta.46: remote-tracking fetch succeeds where a local-head mirror fetch is refused on a checked-out branch",
  { skip: !canGit },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oah-b46-"));
    try {
      // 1. origin (non-bare) with main + a feature branch.
      const origin = join(root, "origin");
      mkdirSync(origin);
      git(origin, "init", "-q", "-b", "main");
      git(origin, "commit", "-q", "--allow-empty", "-m", "init");
      git(origin, "checkout", "-q", "-b", "harness/feat");
      git(origin, "commit", "-q", "--allow-empty", "-m", "feat work");
      git(origin, "checkout", "-q", "main");

      // 2. bare mirror clone (mirrors into LOCAL refs/heads/* like the harness).
      const bare = join(root, "bare.git");
      git(root, "clone", "-q", "--bare", origin, "bare.git");

      // 3. Add a worktree that CHECKS OUT harness/feat -- exactly the revise
      //    state (pinned branch is checked out in a pending worktree).
      const wt = join(root, "wt");
      git(bare, "worktree", "add", wt, "harness/feat");

      // advance origin so a fetch has something to bring down.
      git(origin, "checkout", "-q", "harness/feat");
      git(origin, "commit", "-q", "--allow-empty", "-m", "more feat");
      git(origin, "checkout", "-q", "main");

      // 4a. OLD refspec: local-head mirror -> git REFUSES (this is the bug).
      let refusedMsg = "";
      try {
        git(bare, "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*");
        assert.fail("local-head mirror fetch should have been refused on the checked-out branch");
      } catch (err) {
        refusedMsg = String(err.stderr ?? err.message ?? err);
        assert.match(refusedMsg, /refusing to fetch into branch/i, "expected the checked-out-branch refusal");
      }

      // 4b. NEW refspec: remote-tracking -> SUCCEEDS despite the checkout.
      git(bare, "fetch", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*");
      const remoteRef = git(bare, "rev-parse", "origin/harness/feat").trim();
      const originTip = git(origin, "rev-parse", "harness/feat").trim();
      assert.equal(remoteRef, originTip, "origin/harness/feat must track the real remote tip after the fetch");

      // 5. And the reuse checkout (`worktree add -B <b> <wt2> origin/<b>`) that
      //    beta.46 uses can now reset a fresh worktree to the pushed PR head.
      const wt2 = join(root, "wt2");
      // release the first worktree holding the branch first (reconcile does this live).
      git(bare, "worktree", "remove", "--force", wt);
      git(bare, "worktree", "add", "-B", "harness/feat", wt2, "origin/harness/feat");
      const checkoutTip = git(wt2, "rev-parse", "HEAD").trim();
      assert.equal(checkoutTip, originTip, "reuse checkout must land on the pushed PR head (origin/<branch>)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
