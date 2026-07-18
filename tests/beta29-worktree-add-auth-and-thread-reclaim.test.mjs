/**
 * beta.29 — two Staging ProjectThanos findings.
 *
 * (1) `git worktree add` promisor-fetch auth failure.
 *     The bare clone uses `--filter=blob:none` (partial clone). Checking out
 *     files during `worktree add` triggers a lazy promisor fetch back to
 *     origin. After the clone we `remote set-url` to the token-less URL, and
 *     the old code ran `worktree add` with NO askpass, so git tried to prompt
 *     and failed:
 *       fatal: could not read Username for 'https://github.com'
 *       fatal: could not fetch <sha> from promisor remote
 *     (Staging session 781a9532). Fix: thread the askpass helper through the
 *     worktree-add call. This test asserts the source wires askpass on that
 *     specific call.
 *
 * (2) Thread-lock ignores session status. The UNIQUE(slack_channel,
 *     slack_thread) index made a failed session permanently lock its thread.
 *     Fix: startSessionRow frees the thread when the only prior session on it
 *     is terminal (done/failed/aborted); a NON-terminal session still blocks.
 *     Asserted at the source level (the reclaim query + terminal set).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

test("beta.29: worktree add is invoked with the askpass helper (src)", () => {
  const src = readFileSync(resolve(repoRoot, "src/adapters/git-worktree.ts"), "utf8");
  // Find the `worktree`, `add` run call and confirm it passes ask.path
  // (the 3rd arg to run() that wires GIT_ASKPASS).
  const m = src.match(/run\(\s*\[\s*"-C",\s*bare,\s*"worktree",\s*"add"[\s\S]*?\]\s*,\s*undefined\s*,\s*ask\.path\s*\)/);
  assert.ok(
    m,
    "worktree add run() must pass `ask.path` so the promisor blob fetch during checkout is authenticated.",
  );
});

test("beta.29: compiled worktree add carries askpass (dist)", { skip: !existsSync(resolve(repoRoot, "dist/adapters/git-worktree.js")) }, () => {
  const src = readFileSync(resolve(repoRoot, "dist/adapters/git-worktree.js"), "utf8");
  const m = src.match(/"worktree",\s*"add"[\s\S]{0,120}?ask\.path/);
  assert.ok(m, "dist must carry ask.path on the worktree add call.");
});

test("beta.29: startSessionRow reclaims a thread from a terminal prior session (src)", () => {
  const src = readFileSync(resolve(repoRoot, "src/tools/registration.ts"), "utf8");
  // Reclaim query deletes only terminal statuses.
  assert.match(
    src,
    /DELETE FROM sessions WHERE slack_channel = \? AND slack_thread = \? AND status IN \('done','failed','aborted'\)/,
    "must delete only terminal (done/failed/aborted) prior sessions when reclaiming a thread.",
  );
  // Non-terminal active session still blocks.
  assert.match(
    src,
    /is already active \(status=/,
    "a non-terminal session on the thread must still block with an 'already active' reason.",
  );
  // Audit event for observability.
  assert.match(src, /tool\.run\.thread_reclaimed/, "thread reclaim must emit an audit event.");
});

test("beta.29: terminal status set matches the loop's terminal set (done/failed/aborted)", () => {
  const reg = readFileSync(resolve(repoRoot, "src/tools/registration.ts"), "utf8");
  const loop = readFileSync(resolve(repoRoot, "src/orchestrator/loop.ts"), "utf8");
  // Loop uses ["done", "failed", "aborted"] as terminal. Registration's
  // reclaim must use the same set, or a thread could be reclaimed while the
  // loop still considers the session live (or vice-versa).
  assert.match(loop, /\["done",\s*"failed",\s*"aborted"\]/, "loop terminal set should be done/failed/aborted (guard).");
  assert.match(reg, /new Set\(\["done",\s*"failed",\s*"aborted"\]\)/, "registration terminal set must match the loop's.");
});
