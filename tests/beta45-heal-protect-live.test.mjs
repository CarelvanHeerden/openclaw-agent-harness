/**
 * beta.45: worktree self-heal must never reap a live run's worktree.
 *
 * Regression for the first live beta.44 revise (session 994d1d11, PR #858):
 * the gateway re-registered the harness mid-run (plugin-registry eviction
 * family -- openclaw#87046 / #107596; triggered by an unrelated plugin
 * reload). Each bootstrap re-runs the beta.17 self-heal, which scanned the
 * worktrees dir and force-removed the LIVE revise worktree as an "orphan"
 * because the sessions row's `worktree_path` column is written only AFTER
 * the lead plan completes (loop.ts). The worker then had no worktree and the
 * run failed at $0.00.
 *
 * beta.45 adds two guards, both erring toward NOT reaping (a false-skip is
 * safe -- a genuinely-orphaned dir is reaped on a later bootstrap; a
 * false-reap is fatal -- it kills a live run):
 *   1. protectedWorktreePaths: dirs of loops running in THIS process
 *      (from runningSessionIds() -> worktree_path), matched by exact path
 *      AND basename (so a not-yet-persisted worktree_path is still covered
 *      when the caller can resolve the basename).
 *   2. dirMtimeMs + graceMs: skip any allocator-shaped dir modified within
 *      the grace window, covering a just-allocated pending-<ts> whose owning
 *      session row hasn't written worktree_path yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let healOrphanedWorktrees, Database;
try {
  ({ healOrphanedWorktrees } = await import("../dist/state/worktree-heal.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  healOrphanedWorktrees = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return { db, audit() {} };
}

function insertSession(db, id, status, worktreePath, repo = "o/r") {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, ?, 'C', 'U', 'u', ?, 'harness/x', ?, ?, ?, ?, 50, 0, 0)`
  ).run(id, `T-${id}`, repo, worktreePath, status, Date.now(), Date.now());
}

test(
  "beta.45: protected live-loop worktree (exact path) is never reaped",
  { skip: healOrphanedWorktrees === null },
  async () => {
    const state = makeStore();
    // Terminal session with a leftover worktree that SHOULD be reaped.
    insertSession(state.db, "term1", "done", "/wt/pending-100");
    const removed = [];
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-100", "/wt/pending-200"],
      releaseByPath: async (p) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
      // pending-200 is a live loop's worktree (protected by exact path).
      protectedWorktreePaths: ["/wt/pending-200"],
    });
    assert.equal(result.protected_running, 1);
    assert.equal(result.removed, 1, "only the terminal leftover is reaped");
    assert.deepEqual(removed, ["/wt/pending-100"]);
  },
);

test(
  "beta.45: THE revise race -- orphan pending dir in the planning window protected by mtime grace",
  { skip: healOrphanedWorktrees === null },
  async () => {
    // Reproduce 994d1d11 faithfully: at session INSERT `worktree_path` is ''
    // (empty), and only gets the real pending-<ts> path AFTER the lead plan
    // (loop.ts:481). During that planning window the on-disk pending dir does
    // NOT match any row (row.worktree_path='' -> basename('')='') so it is
    // classified as an orphan. Guard 1 (path) can't help because the caller's
    // runningSessionIds() -> worktree_path query also returns '' for it.
    // Guard 2 (mtime grace window) is what saves the live run: the dir was
    // just created, so it is within the window and skipped.
    const state = makeStore();
    insertSession(state.db, "revise1", "planning", ""); // worktree_path '' (real INSERT shape)
    const removed = [];
    const now = Date.now();
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-994"],
      releaseByPath: async (p) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
      // No resolvable path yet (row has ''), so nothing to protect by path.
      protectedWorktreePaths: [],
      graceMs: 120_000,
      dirMtimeMs: () => now - 2_000, // just allocated -> within grace
    });
    assert.equal(result.protected_recent, 1, "protected by mtime grace window");
    assert.equal(result.removed, 0, "the live revise worktree is NOT reaped");
    assert.equal(removed.length, 0);
  },
);

test(
  "beta.45: recently-modified allocator dir is skipped via mtime grace window",
  { skip: healOrphanedWorktrees === null },
  async () => {
    // No session row at all -> classified orphan. But it was just created
    // (mtime = now), so the grace window protects it. This covers the window
    // between `git worktree add` and the sessions row being written.
    const state = makeStore();
    const removed = [];
    const now = Date.now();
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-1001", "/wt/pending-1002"],
      releaseByPath: async (p) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
      graceMs: 120_000,
      dirMtimeMs: (p) => {
        if (p === "/wt/pending-1001") return now - 1_000;   // 1s old -> protected
        if (p === "/wt/pending-1002") return now - 600_000;  // 10min old -> reap
        return null;
      },
    });
    assert.equal(result.protected_recent, 1);
    assert.equal(result.removed, 1, "only the aged orphan is reaped");
    assert.deepEqual(removed, ["/wt/pending-1002"]);
  },
);

test(
  "beta.45: aged orphan past the grace window is still reaped (no false-skip forever)",
  { skip: healOrphanedWorktrees === null },
  async () => {
    const state = makeStore();
    const removed = [];
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-777"],
      releaseByPath: async (p) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
      graceMs: 60_000,
      dirMtimeMs: () => Date.now() - 3_600_000, // 1h old
    });
    assert.equal(result.protected_recent, 0);
    assert.equal(result.orphaned, 1);
    assert.equal(result.removed, 1);
    assert.deepEqual(removed, ["/wt/pending-777"]);
  },
);

test(
  "beta.45: protection guards run BEFORE session-row classification",
  { skip: healOrphanedWorktrees === null },
  async () => {
    // Even a dir whose session row is TERMINAL must be protected if it is in
    // the live set (belt-and-braces: a stale terminal row + a reused
    // worktree path should not cause a live reap). Ordering matters.
    const state = makeStore();
    insertSession(state.db, "stale-term", "failed", "/wt/pending-555");
    const removed = [];
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-555"],
      releaseByPath: async (p) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      protectedWorktreePaths: ["/wt/pending-555"],
    });
    assert.equal(result.protected_running, 1);
    assert.equal(result.matched_terminal, 0, "never reached terminal classification");
    assert.equal(result.removed, 0);
  },
);

test(
  "beta.45: no protection args -> behaves exactly like beta.17 (backward compat)",
  { skip: healOrphanedWorktrees === null },
  async () => {
    const state = makeStore();
    insertSession(state.db, "done1", "done", "/wt/pending-100");
    insertSession(state.db, "active1", "executing", "/wt/pending-200");
    const removed = [];
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-100", "/wt/pending-200", "/wt/pending-300"],
      releaseByPath: async (p) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
    });
    assert.equal(result.protected_running, 0);
    assert.equal(result.protected_recent, 0);
    assert.equal(result.matched_terminal, 1);
    assert.equal(result.matched_active, 1);
    assert.equal(result.orphaned, 1); // pending-300
    assert.equal(result.removed, 2);  // done + orphan
    assert.deepEqual(removed.sort(), ["/wt/pending-100", "/wt/pending-300"]);
  },
);
