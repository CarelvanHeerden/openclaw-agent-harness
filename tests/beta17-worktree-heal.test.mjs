/**
 * beta.17: startup worktree self-heal.
 *
 * On plugin init, scan the worktrees root for leftover `pending-<ts>`
 * (and UUID) dirs, cross-check against the sessions table, and
 * force-remove any worktree whose owning session is terminal
 * (done/failed/aborted) or entirely unknown to the DB. Belt-and-suspenders
 * on top of the loop-side release. Also fixes historical debt: any
 * `pending-<ts>` worktree left behind by pre-beta.17 gets cleaned up on
 * the first restart after upgrading.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let healOrphanedWorktrees, looksLikeAllocatorWorktree, Database;
try {
  ({ healOrphanedWorktrees, looksLikeAllocatorWorktree } = await import("../dist/state/worktree-heal.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  healOrphanedWorktrees = null;
}

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  return {
    db,
    audit() {}, // not exercised by these tests
  };
}

function insertSession(db, id, status, worktreePath, repo = "o/r") {
  // Vary slack_thread by id so multiple test sessions in the same DB don't
  // collide on the (slack_channel, slack_thread) unique index.
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, ?, 'C', 'U', 'u', ?, 'harness/x', ?, ?, ?, ?, 50, 0, 0)`
  ).run(id, `T-${id}`, repo, worktreePath, status, Date.now(), Date.now());
}

test(
  "beta.17: looksLikeAllocatorWorktree matches pending-<digits> and UUIDs, rejects arbitrary names",
  { skip: healOrphanedWorktrees === null },
  () => {
    assert.equal(looksLikeAllocatorWorktree("pending-1784280163806"), true);
    assert.equal(looksLikeAllocatorWorktree("65cb022d-6ff9-4372-a9e0-063e5200115f"), true);
    // Rejections
    assert.equal(looksLikeAllocatorWorktree("pending-"), false);
    assert.equal(looksLikeAllocatorWorktree("my-scratch-dir"), false);
    assert.equal(looksLikeAllocatorWorktree(".repos"), false);
    assert.equal(looksLikeAllocatorWorktree("pending-abc"), false);
  },
);

test(
  "beta.17: healOrphanedWorktrees removes leftovers tied to terminal sessions",
  { skip: healOrphanedWorktrees === null },
  async () => {
    const state = makeStore();
    // Session 1: terminal (done), worktree leftover
    insertSession(state.db, "sess1", "done", "/wt/pending-100");
    // Session 2: aborted, worktree leftover
    insertSession(state.db, "sess2", "aborted", "/wt/pending-200");
    // Session 3: active, worktree must NOT be touched
    insertSession(state.db, "sess3", "executing", "/wt/pending-300");

    const removed = [];
    const dirs = ["/wt/pending-100", "/wt/pending-200", "/wt/pending-300"];

    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => dirs,
      releaseByPath: async (p, repo) => {
        removed.push({ p, repo });
        return { ok: true, path: p };
      },
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.scanned, 3);
    assert.equal(result.matched_terminal, 2);
    assert.equal(result.matched_active, 1);
    assert.equal(result.orphaned, 0);
    assert.equal(result.removed, 2);
    assert.equal(result.errors.length, 0);
    // Only the two terminal dirs got released
    assert.deepEqual(
      removed.map((r) => r.p).sort(),
      ["/wt/pending-100", "/wt/pending-200"],
    );
  },
);

test(
  "beta.17: healOrphanedWorktrees removes orphan dirs (no matching session)",
  { skip: healOrphanedWorktrees === null },
  async () => {
    const state = makeStore();
    // No sessions inserted -> every dir is an orphan.
    const removed = [];
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-999", "/wt/pending-1000"],
      releaseByPath: async (p, repo) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
    });
    assert.equal(result.scanned, 2);
    assert.equal(result.orphaned, 2);
    assert.equal(result.removed, 2);
    assert.deepEqual(removed.sort(), ["/wt/pending-1000", "/wt/pending-999"]);
  },
);

test(
  "beta.17: healOrphanedWorktrees skips dirs that do NOT look like allocator output",
  { skip: healOrphanedWorktrees === null },
  async () => {
    // Defence against a misconfigured worktrees_root pointing at a shared
    // directory. Non-allocator names must be left alone even when there's
    // no matching session.
    const state = makeStore();
    const removed = [];
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/my-important-scratch", "/wt/pending-500"],
      releaseByPath: async (p) => { removed.push(p); return { ok: true, path: p }; },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
    });
    assert.equal(result.scanned, 2);
    assert.equal(removed.length, 1, "only the allocator-shaped dir gets touched");
    assert.equal(removed[0], "/wt/pending-500");
  },
);

test(
  "beta.17: healOrphanedWorktrees preserves active sessions and reports errors",
  { skip: healOrphanedWorktrees === null },
  async () => {
    const state = makeStore();
    // Use digit suffixes so looksLikeAllocatorWorktree matches. The names
    // are the semantic labels for the reader, not the on-disk form.
    insertSession(state.db, "active1", "executing", "/wt/pending-1000001");
    insertSession(state.db, "term1", "done", "/wt/pending-1000002");
    const removed = [];
    const result = await healOrphanedWorktrees(state, {
      listWorktreeDirs: async () => ["/wt/pending-1000001", "/wt/pending-1000002", "/wt/pending-1000003"],
      releaseByPath: async (p) => {
        if (p === "/wt/pending-1000003") return { ok: false, path: p, error: "simulated permission denied" };
        removed.push(p);
        return { ok: true, path: p };
      },
      logger: { info() {}, warn() {}, error() {} },
      fallbackRepoFullName: "o/r",
    });
    assert.equal(result.matched_active, 1);
    assert.equal(result.matched_terminal, 1);
    assert.equal(result.orphaned, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /permission denied/i);
    assert.equal(removed.length, 1);
    assert.equal(removed[0], "/wt/pending-1000002");
  },
);
