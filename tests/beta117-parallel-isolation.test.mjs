/**
 * beta.117: parallel sub-tasks get isolated checkouts, and their work is
 * replayed onto the session branch one at a time.
 *
 * Parallelism has existed since b91 and has always shipped off, because the
 * design is unsafe rather than merely unproven: concurrent workers shared one
 * worktree and one git index, and `commit` stages `git add -A` under no lock,
 * so the first worker to finish committed whatever the others had half-written.
 * b91's guard compares DECLARED `filesLikelyTouched`, and b113 proved
 * declaration unreliable when a worker regenerated 141 undeclared `okf/**`
 * files.
 *
 * The merge-back tests run against REAL git. Cherry-pick conflict semantics --
 * what git leaves in the index, what `--abort` restores, whether a range
 * replays in order -- are exactly the kind of thing a mock would assert into
 * existence incorrectly, and the whole safety argument for b117 rests on a
 * collision surfacing as a conflict rather than as silent corruption.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreePool, slotBranch } from "../dist/orchestrator/worktree-pool.js";
import { mergeBackSubTask, commitsToReplay, Mutex } from "../dist/orchestrator/merge-back.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: ENV }).trim();

/** Resolve to "resolved" or "timeout", so a stranded promise fails instead of hanging. */
const settleWithin = (p, ms) =>
  Promise.race([p.then(() => "resolved", () => "resolved"), new Promise((r) => setTimeout(() => r("timeout"), ms))]);

const dirs = [];
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repo with a session branch and two linked worktrees, as b117 creates. */
function makeRepoWithWorktrees() {
  const root = mkdtempSync(join(tmpdir(), "oah-b117-"));
  dirs.push(root);
  const main = join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", main], { env: ENV });
  git(main, "config", "user.name", "T");
  git(main, "config", "user.email", "t@e.com");
  git(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "a.txt"), "base\n");
  writeFileSync(join(main, "b.txt"), "base\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  git(main, "checkout", "-q", "-b", "harness/feat");

  const mk = (name) => {
    const p = join(root, name);
    git(main, "worktree", "add", "-q", "-b", `harness/fixture-${name}`, p, "harness/feat");
    git(p, "config", "user.name", "T");
    git(p, "config", "user.email", "t@e.com");
    git(p, "config", "commit.gpgsign", "false");
    return p;
  };
  return { session: main, w1: mk("w1"), w2: mk("w2") };
}

/** The injected git surface, backed by the real binary. */
const GIT = {
  run: async (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: ENV }),
  headSha: async (cwd) => git(cwd, "rev-parse", "HEAD"),
};

const commitIn = (wt, file, body, msg) => {
  writeFileSync(join(wt, file), body);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", msg);
  return git(wt, "rev-parse", "HEAD");
};

// ---------------------------------------------------------------------------
// Merge-back, against real git
// ---------------------------------------------------------------------------

test("beta117: two workers on disjoint files both land on the session branch", async () => {
  const { session, w1, w2 } = makeRepoWithWorktrees();
  const base = git(session, "rev-parse", "HEAD");
  commitIn(w1, "a.txt", "from worker one\n", "harness(1): a");
  commitIn(w2, "b.txt", "from worker two\n", "harness(2): b");

  const r1 = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  const r2 = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w2, workerBranch: "harness/fixture-w2", baseSha: base, seq: 2 });

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(readFileSync(join(session, "a.txt"), "utf8"), "from worker one\n");
  assert.equal(readFileSync(join(session, "b.txt"), "utf8"), "from worker two\n", "the second landing must not lose the first");
  assert.equal(r1.fastForward, true, "the first worker lands on an unmoved tip");
  assert.equal(r2.fastForward, false, "the second finds the tip moved and merges");
});

test("beta117: worker commits stay REACHABLE, which is what the ledger guard checks", async () => {
  // The reason b117 merges instead of cherry-picking. b101's guard unions
  // sub_tasks.commit_sha with the append-only loop.worker_end_turn audit events
  // and fails the run when HEAD cannot reach a recorded sha. Cherry-pick writes
  // NEW shas, so every parallel sub-task would have been reported as lost work
  // by the guard that exists to detect lost work -- and because the audit log is
  // append-only by design, rewriting the sub_tasks row would not have fixed it.
  const { session, w1, w2 } = makeRepoWithWorktrees();
  const base = git(session, "rev-parse", "HEAD");
  const sha1 = commitIn(w1, "a.txt", "one\n", "harness(1): a");
  const sha2 = commitIn(w2, "b.txt", "two\n", "harness(2): b");

  await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w2, workerBranch: "harness/fixture-w2", baseSha: base, seq: 2 });

  const reachable = (sha) => {
    try { git(session, "merge-base", "--is-ancestor", sha, "HEAD"); return true; } catch { return false; }
  };
  assert.ok(reachable(sha1), "the ledger sha recorded for sub-task 1 must survive merge-back verbatim");
  assert.ok(reachable(sha2), "and so must sub-task 2's");
});

test("beta117: the undeclared-overlap case surfaces as a conflict, not corruption", async () => {
  // This is the b113 shape: two workers both write a file neither declared.
  // Under the old shared worktree this produced a commit whose contents did not
  // match its message and nothing noticed.
  const { session, w1, w2 } = makeRepoWithWorktrees();
  const base = git(session, "rev-parse", "HEAD");
  commitIn(w1, "a.txt", "worker one's version\n", "harness(1): a");
  commitIn(w2, "a.txt", "worker two's version\n", "harness(2): a");

  const r1 = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  assert.equal(r1.ok, true, "the first one in wins cleanly");

  const r2 = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w2, workerBranch: "harness/fixture-w2", baseSha: base, seq: 2 });
  assert.equal(r2.ok, false, "the second must fail loudly rather than silently overwrite");
  assert.equal(r2.reason, "conflict");
  assert.deepEqual(r2.conflictedPaths, ["a.txt"], "the report must name the file so the failure is actionable");
  assert.match(r2.detail, /sub-task 2/, "and name the sub-task");
});

test("beta117: a conflict leaves the session worktree clean for the next sub-task", async () => {
  // If a failed pick left the repo mid-cherry-pick, every subsequent merge-back
  // in the run would fail too, turning one conflict into a dead cycle.
  const { session, w1, w2 } = makeRepoWithWorktrees();
  const base = git(session, "rev-parse", "HEAD");
  commitIn(w1, "a.txt", "one\n", "harness(1): a");
  commitIn(w2, "a.txt", "two\n", "harness(2): a");
  await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w2, workerBranch: "harness/fixture-w2", baseSha: base, seq: 2 });

  assert.equal(git(session, "status", "--porcelain"), "", "no half-applied pick may be left behind");
  const after = git(session, "rev-parse", "HEAD");

  // A third, unrelated worker must still be able to land.
  const w3 = join(session, "..", "w3");
  git(session, "worktree", "add", "-q", "-b", "harness/fixture-w3", w3, "harness/feat");
  git(w3, "config", "user.name", "T");
  git(w3, "config", "user.email", "t@e.com");
  git(w3, "config", "commit.gpgsign", "false");
  commitIn(w3, "b.txt", "three\n", "harness(3): b");
  const r3 = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w3, workerBranch: "harness/fixture-w3", baseSha: after, seq: 3 });
  assert.equal(r3.ok, true, "the cycle must survive one conflicting sub-task");
});

test("beta117: a worker that changed nothing is not a failure", async () => {
  const { session, w1 } = makeRepoWithWorktrees();
  const base = git(session, "rev-parse", "HEAD");
  const r = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  assert.equal(r.ok, true, "no-change sub-tasks are routine on revise cycles");
  assert.deepEqual(r.landed, []);
});

test("beta117: several commits from one worker replay in order", async () => {
  const { session, w1 } = makeRepoWithWorktrees();
  const base = git(session, "rev-parse", "HEAD");
  commitIn(w1, "a.txt", "first\n", "harness(1): first");
  commitIn(w1, "a.txt", "second\n", "harness(1): second");
  const picks = await commitsToReplay(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  assert.equal(picks.length, 2, "oldest first, so the replay reproduces the worker's own history");

  const r = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(session, "a.txt"), "utf8"), "second\n", "the later commit must win");
  assert.equal(git(session, "log", "-1", "--pretty=%s"), "harness(1): second");
});

test("beta117: the session branch only ever moves forward as whole commits", async () => {
  const { session, w1 } = makeRepoWithWorktrees();
  const base = git(session, "rev-parse", "HEAD");
  commitIn(w1, "a.txt", "x\n", "harness(1): a");
  const r = await mergeBackSubTask(GIT, { sessionWorktree: session, workerWorktree: w1, workerBranch: "harness/fixture-w1", baseSha: base, seq: 1 });
  assert.equal(r.headSha, git(session, "rev-parse", "HEAD"), "the reported head must be the real one");
  assert.equal(r.fastForward, true, "an unmoved tip must fast-forward and add no merge commit");
  assert.equal(git(session, "rev-parse", "HEAD~1"), base, "so history stays linear in the common case");
});

// ---------------------------------------------------------------------------
// The mutex that serialises those replays
// ---------------------------------------------------------------------------

test("beta117: the mutex serialises overlapping replays", async () => {
  const m = new Mutex();
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const job = (id) =>
    m.run(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      order.push(id);
      concurrent -= 1;
    });
  await Promise.all([job(1), job(2), job(3)]);
  assert.equal(maxConcurrent, 1, "git cannot take two index operations at once");
  assert.deepEqual(order, [1, 2, 3], "and the queue must be fair");
});

test("beta117: a throwing job still releases the mutex", async () => {
  const m = new Mutex();
  await assert.rejects(m.run(async () => { throw new Error("merge-back blew up"); }));
  assert.equal(await m.run(async () => "recovered"), "recovered", "one failure must not deadlock the run");
});

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/** A pool whose slots are plain records, so leasing is testable without git. */
function fakePool(size, log = []) {
  return new WorktreePool({
    size,
    sessionBranch: "harness/feat",
    deps: {
      create: async (slot, branch) => { log.push(`create:${slot}:${branch}`); return `/wt/${slot}`; },
      reset: async (wt, sha) => { log.push(`reset:${wt.slot}:${sha}`); },
      destroy: async (wt) => { log.push(`destroy:${wt.slot}`); },
    },
  });
}

test("beta117: a slot is created only when a second worker actually needs one", async () => {
  // Sized 2, but a run whose sub-tasks never overlap must pay for ONE npm ci,
  // not two. At 25s each that is the difference between a cost and a tax.
  const log = [];
  const pool = fakePool(2, log);
  for (let i = 0; i < 5; i++) {
    const wt = await pool.acquire(`sha${i}`);
    pool.release(wt);
  }
  assert.equal(pool.createdCount, 1, "sequential use must never create a second checkout");
  assert.equal(log.filter((l) => l.startsWith("create:")).length, 1);
});

test("beta117: genuine overlap creates the second slot, and no more", async () => {
  const pool = fakePool(2);
  const a = await pool.acquire("sha");
  const b = await pool.acquire("sha");
  assert.notEqual(a.slot, b.slot, "two concurrent workers must not share a checkout");
  assert.equal(pool.createdCount, 2);
  pool.release(a);
  pool.release(b);
  assert.equal(pool.createdCount, 2, "released slots are reused, not recreated");
});

test("beta117: a third worker waits for a slot rather than creating one", async () => {
  const pool = fakePool(2);
  const a = await pool.acquire("sha");
  const b = await pool.acquire("sha");
  let got = null;
  const pending = pool.acquire("sha").then((wt) => (got = wt));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got, null, "the pool must cap concurrency, not exceed it");
  pool.release(a);
  assert.equal(await settleWithin(pending, 500), "resolved", "releasing a slot must hand it to the waiter, not strand it");
  assert.equal(got.slot, a.slot, "the freed slot goes to the waiter");
});

test("beta117: every lease is repositioned before use", async () => {
  // A slot still holding the last sub-task's tree would give the next worker a
  // stale checkout and produce a diff against the wrong base.
  const log = [];
  const pool = fakePool(1, log);
  const a = await pool.acquire("shaA");
  pool.release(a);
  const b = await pool.acquire("shaB");
  assert.deepEqual(
    log.filter((l) => l.startsWith("reset:")),
    ["reset:1:shaA", "reset:1:shaB"],
    "including the very first use, which starts from whatever the branch last held",
  );
  pool.release(b);
});

test("beta117: a failed create does not permanently shrink the pool", async () => {
  let fail = true;
  const pool = new WorktreePool({
    size: 1,
    sessionBranch: "harness/feat",
    deps: {
      create: async (slot) => { if (fail) { fail = false; throw new Error("disk full"); } return `/wt/${slot}`; },
      reset: async () => {},
      destroy: async () => {},
    },
  });
  await assert.rejects(pool.acquire("sha"), /disk full/);
  const retry = pool.acquire("sha");
  assert.equal(await settleWithin(retry, 500), "resolved", "a slot that failed to create must be offered again, not lost");
  assert.equal((await retry).slot, 1, "a transient failure must be retryable");
});

test("beta117: draining destroys every created slot and nothing else", async () => {
  const log = [];
  const pool = fakePool(3, log);
  const a = await pool.acquire("sha");
  const b = await pool.acquire("sha");
  pool.release(a);
  pool.release(b);
  await pool.drain();
  assert.deepEqual(log.filter((l) => l.startsWith("destroy:")).sort(), ["destroy:1", "destroy:2"], "the third was never created");
});

test("beta117: draining survives a slot that refuses to delete", async () => {
  const pool = new WorktreePool({
    size: 1,
    sessionBranch: "harness/feat",
    deps: {
      create: async (slot) => `/wt/${slot}`,
      reset: async () => {},
      destroy: async () => { throw new Error("directory busy"); },
    },
  });
  pool.release(await pool.acquire("sha"));
  await pool.drain();
  assert.equal(pool.createdCount, 0, "a shipped run must not fail on cleanup");
});

test("beta117: a size-0 pool is inert, which is how serial runs stay unchanged", async () => {
  const pool = fakePool(0);
  assert.equal(pool.enabled, false);
  await assert.rejects(pool.acquire("sha"), /disabled/);
});

test("beta117: slot branches are SIBLINGS of the session branch, never children", () => {
  // Not cosmetic. Git stores refs as a directory tree, so a session branch at
  // refs/heads/harness/feat makes refs/heads/harness/feat/w1 unrepresentable
  // and `worktree add` dies with "cannot lock ref". The child form is the
  // obvious naming and it cannot work.
  const b = slotBranch("harness/feat-ab12cd34", 1);
  assert.equal(b, "harness/feat-ab12cd34-w1");
  assert.ok(!b.startsWith("harness/feat-ab12cd34/"), "a child ref would collide with the session branch itself");
  assert.notEqual(slotBranch("harness/feat", 1), slotBranch("harness/feat", 2));
  assert.equal(slotBranch("harness/feat/", 2), "harness/feat-w2", "a trailing slash must not produce a child ref");
});

test("beta117: real git refuses a child ref, which is why slots are siblings", () => {
  const { session } = makeRepoWithWorktrees();
  const child = join(session, "..", "child-probe");
  assert.throws(
    () => git(session, "worktree", "add", "-q", "-b", "harness/feat/w9", child, "harness/feat"),
    /cannot lock ref|already exists|not a valid/i,
    "if this ever stops throwing, the sibling naming can be simplified",
  );
  const sibling = join(session, "..", "sibling-probe");
  git(session, "worktree", "add", "-q", "-b", slotBranch("harness/feat", 9), sibling, "harness/feat");
  assert.ok(git(sibling, "rev-parse", "HEAD"), "the sibling form must actually work");
});

// ---------------------------------------------------------------------------
// End to end: the loop, real git, two workers at once
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

let OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}
const schemaPath = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "state", "schema.sql");

function cfg(concurrency, parallel = true) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: { max_cycles: 1, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, subtask_concurrency: concurrency, parallel_independent_subtasks: parallel },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: false, prune_terminal_sessions_days: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: [], bash_denylist_tokens: [], path_denylist: [], allow_git_push: false, allow_network_commands: false },
  };
}

function makeStore(worktreePath) {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  db.prepare(`INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
    worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
    VALUES ('S1','T1','C1','U1','u1','o/r','harness/feat', ?, 'crystallising', ?, ?, 50, 0, 0)`)
    .run(worktreePath, Date.now(), Date.now());
  const events = [];
  return {
    db, events,
    audit(event, payload, sessionId) {
      events.push({ event, payload });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?,?,?,?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    close() { db.close(); },
  };
}

/** Pooled-slot deps backed by real git, mirroring what index.ts wires up. */
function pooledDeps(root, session, made) {
  return {
    allocatePooledWorktree: async ({ sessionBranch, slotBranch, slot }) => {
      const p = join(root, `slot-${slot}`);
      git(session, "worktree", "add", "-q", "-B", slotBranch, p, sessionBranch);
      git(p, "config", "user.name", "T");
      git(p, "config", "user.email", "t@e.com");
      git(p, "config", "commit.gpgsign", "false");
      made.push(p);
      return p;
    },
    resetPooledWorktree: async (wt, sha) => { git(wt, "reset", "--hard", sha); git(wt, "clean", "-fd"); },
    releasePooledWorktree: async ({ worktreePath }) => {
      git(session, "worktree", "remove", "--force", worktreePath);
      return { ok: true };
    },
    gitRun: async (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: ENV }),
    worktreeHeadSha: async (wt) => git(wt, "rev-parse", "HEAD"),
  };
}

test("beta117 e2e: two concurrent workers get different checkouts and both land",
  { skip: OrchestratorLoop === null }, async () => {
    const { session } = makeRepoWithWorktrees();
    const root = dirname(session);
    const state = makeStore(session);
    const made = [];
    const seenWorktrees = [];
    let inFlight = 0, maxInFlight = 0;

    const plan = { repo: "o/r", branch: "harness/feat", worktreePath: session, subTasks: [
      { seq: 1, title: "a", intent: "", filesLikelyTouched: ["a.txt"], successCriteria: [], estimatedTokens: 100 },
      { seq: 2, title: "b", intent: "", filesLikelyTouched: ["b.txt"], successCriteria: [], estimatedTokens: 100 },
    ], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

    const loop = new OrchestratorLoop({
      config: cfg(2), state,
      budget: new BudgetEnforcer(cfg(2).budgets, state),
      pat: new PatRouter(cfg(2).pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async ({ worktreePath, subTask }) => {
        seenWorktrees.push(worktreePath);
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        // A real worker writes and commits in the checkout it was handed.
        const f = subTask.seq === 1 ? "a.txt" : "b.txt";
        writeFileSync(join(worktreePath, f), `written by seq ${subTask.seq}\n`);
        git(worktreePath, "add", "-A");
        git(worktreePath, "commit", "-q", "-m", `harness(${subTask.seq})`);
        inFlight--;
        return { status: "completed", filesChanged: [f], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
      },
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      ...pooledDeps(root, session, made),
    });

    const outcome = await loop.run("S1", { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" });
    assert.equal(outcome.status, "shipped");
    assert.equal(maxInFlight, 2, "the whole point: two workers actually ran at once");
    assert.equal(new Set(seenWorktrees).size, 2, "and each was handed its OWN checkout, not the shared one");

    // Both workers' files must be on the session branch.
    assert.equal(readFileSync(join(session, "a.txt"), "utf8"), "written by seq 1\n");
    assert.equal(readFileSync(join(session, "b.txt"), "utf8"), "written by seq 2\n");
    assert.ok(state.events.some((e) => e.event === "loop.parallel_enabled"), "the run must record that it went parallel");
    assert.equal(state.events.filter((e) => e.event === "loop.parallel_merge_back").length, 2, "both sub-tasks merged back");
    state.close();
  });

test("beta117 e2e: a serial run never creates a slot and uses the session worktree",
  { skip: OrchestratorLoop === null }, async () => {
    // The default path. b117 must be invisible to it.
    const { session } = makeRepoWithWorktrees();
    const root = dirname(session);
    const state = makeStore(session);
    const made = [];
    const seenWorktrees = [];
    const plan = { repo: "o/r", branch: "harness/feat", worktreePath: session, subTasks: [
      { seq: 1, title: "a", intent: "", filesLikelyTouched: ["a.txt"], successCriteria: [], estimatedTokens: 100 },
      { seq: 2, title: "b", intent: "", filesLikelyTouched: ["b.txt"], successCriteria: [], estimatedTokens: 100 },
    ], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

    const loop = new OrchestratorLoop({
      config: cfg(1, false), state,
      budget: new BudgetEnforcer(cfg(1).budgets, state),
      pat: new PatRouter(cfg(1).pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async ({ worktreePath }) => {
        seenWorktrees.push(worktreePath);
        return { status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
      },
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      ...pooledDeps(root, session, made),
    });

    await loop.run("S1", { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" });
    assert.deepEqual([...new Set(seenWorktrees)], [session], "serial work stays in the session worktree");
    assert.equal(made.length, 0, "and pays for no slot at all");
    assert.ok(!state.events.some((e) => e.event === "loop.parallel_enabled"));
    state.close();
  });

test("beta117 e2e: without the pooled deps, concurrency degrades to the old behaviour",
  { skip: OrchestratorLoop === null }, async () => {
    // Every pre-b117 test stubs the orchestrator without these deps. They must
    // keep working rather than crash on a missing capability.
    const { session } = makeRepoWithWorktrees();
    const state = makeStore(session);
    const seenWorktrees = [];
    const plan = { repo: "o/r", branch: "harness/feat", worktreePath: session, subTasks: [
      { seq: 1, title: "a", intent: "", filesLikelyTouched: ["a.txt"], successCriteria: [], estimatedTokens: 100 },
      { seq: 2, title: "b", intent: "", filesLikelyTouched: ["b.txt"], successCriteria: [], estimatedTokens: 100 },
    ], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

    const loop = new OrchestratorLoop({
      config: cfg(2), state,
      budget: new BudgetEnforcer(cfg(2).budgets, state),
      pat: new PatRouter(cfg(2).pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async ({ worktreePath }) => {
        seenWorktrees.push(worktreePath);
        return { status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
      },
      runAdversary: async () => ({ verdict: "pass", findings: [], summary: "", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
      pushBranchAndOpenPr: async () => "https://x/pr/1",
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    });

    const outcome = await loop.run("S1", { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" });
    assert.equal(outcome.status, "shipped");
    assert.deepEqual([...new Set(seenWorktrees)], [session]);
    state.close();
  });
