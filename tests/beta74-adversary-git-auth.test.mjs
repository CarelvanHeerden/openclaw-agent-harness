// beta.74 — the adversary review's `git diff <baseSha> HEAD` needs a GitHub
// token to fetch the PROMISOR base-sha from origin on a --filter=blob:none
// partial clone. Session 666fc103 (beta.73 #876 re-fire): worker commit good
// (b6877b7, 16/16 tests), but adversary review crashed with
//   git diff 9cae70e9 HEAD failed (128): Authentication failed for ...ProjectThanos.git
//   fatal: could not fetch <sha> from promisor remote
// because git.diff() passed NO token. This was masked until beta.73's D2 fix
// put the worker on the real branch HEAD (before that, the worker sat on main,
// whose base needed no promisor fetch).
//
// Fix: git.diff(worktreePath, base, ghToken?) threads the token so run() sets
// OAH_GH_TOKEN + GIT_ASKPASS and the beta.34 cred-helper authenticates the
// promisor fetch; index.ts runAdversary resolves the requester's token
// (pat.resolve, same as allocateWorktree) and passes it.
// Secondary (D3 nit): finaliseFailedPreserveWorktree also emits the canonical
// loop.failed{reason} event so the review-crash terminal path is greppable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let GitAdapter;
try {
  ({ GitAdapter } = await import("../dist/adapters/git-worktree.js"));
} catch {
  GitAdapter = null;
}
const skipAll = { skip: GitAdapter === null };

// ---------------------------------------------------------------------------
// Behavioral — git.diff accepts + works with a token arg (local base = no fetch)
// ---------------------------------------------------------------------------

test("beta74: git.diff(wt, base, ghToken) returns the diff and accepts the token arg", skipAll, async () => {
  const wt = await mkdtemp(join(tmpdir(), "oah-beta74-"));
  try {
    const g = (args) => spawnSync("git", ["-C", wt, ...args], { encoding: "utf8" });
    g(["init", "-q"]);
    g(["config", "user.email", "t@t.t"]);
    g(["config", "user.name", "t"]);
    await writeFile(join(wt, "f.txt"), "one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "base"]);
    const base = spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    await writeFile(join(wt, "f.txt"), "one\ntwo\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "head"]);

    const git = new GitAdapter({ worktreesRoot: wt, logger: { info() {}, warn() {}, error() {} } });
    // token passed (base is local so no promisor fetch happens; the point is the
    // arg is accepted + threaded without breaking the local diff).
    const diff = await git.diff(wt, base, "ghp_dummytoken_not_used_locally");
    assert.match(diff, /\+two/, "diff shows the added line");
    // and still works WITHOUT a token (back-compat)
    const diff2 = await git.diff(wt, base);
    assert.match(diff2, /\+two/, "token-less diff still works");
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source-assertions — token threading + wiring
// ---------------------------------------------------------------------------

test("beta74: git.diff threads the token through run() (askpass + OAH_GH_TOKEN)", () => {
  const src = readFileSync(join(root, "src/adapters/git-worktree.ts"), "utf8");
  const idx = src.indexOf("async diff(");
  assert.ok(idx > 0, "diff() exists");
  const body = src.slice(idx, idx + 600);
  assert.match(body, /ghToken\?:\s*string/, "diff() takes an optional ghToken");
  assert.match(body, /makeAskpass\(ghToken\)/, "wires the askpass helper when a token is given");
  assert.match(body, /this\.run\(\[[^\]]*"diff"[^\]]*\],\s*undefined,\s*ask\?\.path,\s*ghToken\)/, "passes askpass path + token to run()");
});

test("beta74: index.ts runAdversary resolves the requester token and passes it to git.diff", () => {
  const src = readFileSync(join(root, "src/index.ts"), "utf8");
  const idx = src.indexOf("runAdversary: async ({");
  assert.ok(idx > 0, "runAdversary closure exists");
  const body = src.slice(idx, idx + 2400);
  assert.match(body, /requester/, "destructures requester");
  assert.match(body, /pat\.resolve\(/, "resolves the PAT for the repo");
  assert.match(body, /resolveGitToken\(/, "resolves the git token");
  assert.match(body, /git\.diff\(plan\.worktreePath,\s*diffBase,\s*adversaryGhToken\)/, "passes the token to git.diff");
});

test("beta74 (D3 nit): finaliseFailedPreserveWorktree also emits canonical loop.failed", () => {
  const src = readFileSync(join(root, "src/orchestrator/loop.ts"), "utf8");
  const idx = src.indexOf("private finaliseFailedPreserveWorktree(");
  assert.ok(idx > 0, "method exists");
  const body = src.slice(idx, idx + 900);
  assert.match(body, /audit\(\s*["']loop\.failed["']/, "emits loop.failed");
  assert.match(body, /loop\.failed_worktree_preserved/, "still emits the preserve-worktree event too");
});

test("beta74 version bumped to beta.74", () => {
  const v = readFileSync(join(root, "src/version.ts"), "utf8");
  assert.ok(v.includes("0.1.0-beta.74"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.1.0-beta.74");
});
