/**
 * rc.9 -- "the check failed" and "I could not run the check" are different facts.
 *
 * Twenty minutes after the restart that emptied its worktrees root, the
 * StitchGuard status surface was still composed. Nothing in it was false. It
 * simply had no vocabulary for the situation it was in: a verification result
 * carried `passed: false` whether the file was genuinely absent or the harness
 * could not reach the place the file would have been, and the difference lived
 * only in a free-text `detail` that several paths dropped on the floor.
 *
 * The sharpest instance is `fileExistsOnDisk`. With the worktree gone, `stat`
 * throws, the committed-file listing throws and was swallowed to `[]`, and the
 * verdict reads:
 *
 *   no file matching contract path (checked literal + 0 committed)
 *
 * That sentence describes a worker who did not write a file. It was produced by
 * a harness that could not look.
 *
 * Fail-closed does not change here, and these tests pin that: an indeterminate
 * check still FAILS. What changes is that it says so.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let verify, progress, Database;
try {
  verify = await import("../dist/orchestrator/verify.js");
  progress = await import("../dist/orchestrator/progress.js");
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  verify = null;
}
const skip = verify === null;

const CONTRACT = "okf/api/webhooks/client-offboarding-slack.md";

/* ------------------------------------------------------------------ *
 * The evaluator
 * ------------------------------------------------------------------ */

test("rc.9: an unperformable check still FAILS -- fail-closed is not what changed", { skip }, () => {
  const out = verify.evaluateVerification([
    { kind: "file_written", passed: false, indeterminate: true, detail: "the worktree does not exist" },
  ]);
  assert.equal(out.ok, false, "an unanswered question must never pass");
});

test("rc.9: the summary distinguishes absent from unanswerable", { skip }, () => {
  const absent = verify.evaluateVerification([
    { kind: "file_written", passed: false, path: CONTRACT, detail: "no file matching contract path" },
  ]);
  assert.match(absent.summary, /FAILED/);
  assert.ok(!/COULD NOT BE PERFORMED/.test(absent.summary), "a genuine absence must not be softened");

  const unanswerable = verify.evaluateVerification([
    { kind: "file_written", passed: false, indeterminate: true, path: CONTRACT, detail: "the worktree /data/worktrees/f7c4e585 does not exist" },
  ]);
  assert.match(unanswerable.summary, /COULD NOT BE PERFORMED/);
  // The load-bearing clause. Without it a reader draws the rc.8 conclusion.
  assert.match(unanswerable.summary, /not evidence the work is missing/);
  assert.match(unanswerable.summary, /failing closed/);
});

test("rc.9: a mixed run reports both, separately, with counts that add up", { skip }, () => {
  const out = verify.evaluateVerification([
    { kind: "commit_made", passed: true, detail: "1 commit" },
    { kind: "file_written", passed: false, path: "src/a.ts", detail: "no file matching contract path" },
    { kind: "file_in_pr", passed: false, indeterminate: true, detail: "could not list the files in PR #1168; github PR #1168 files lookup HTTP 403" },
  ]);
  assert.equal(out.ok, false);
  assert.match(out.summary, /1\/3 observable check\(s\) FAILED/);
  assert.match(out.summary, /a further 1 COULD NOT BE PERFORMED/);
  // An operator reading this can tell which one to chase.
  assert.match(out.summary, /HTTP 403/);
});

test("rc.9: results that say nothing about determinacy behave exactly as before", { skip }, () => {
  // Every existing probe and every existing test double omits the field. The
  // absence of the flag must mean "this check ran", or this change would
  // quietly reclassify the whole suite.
  const out = verify.evaluateVerification([
    { kind: "file_written", passed: false, detail: "missing" },
    { kind: "commit_made", passed: false, detail: "no commit" },
  ]);
  assert.equal(out.summary, "2/2 observable check(s) FAILED: file_written (missing); commit_made (no commit)");

  const pass = verify.evaluateVerification([{ kind: "commit_made", passed: true, detail: "1 commit" }]);
  assert.equal(pass.summary, "all 1 observable check(s) passed");
  assert.equal(verify.evaluateVerification([]).summary, "no observable checks (SDK signal trusted)");
});

/* ------------------------------------------------------------------ *
 * Probe-level: where the conflation actually happened
 * ------------------------------------------------------------------ */

test("rc.9: a PR lookup that FAILED is not a branch with no PR", { skip }, async () => {
  // `res.ok` was never checked. A 403 body parses to `[]`, `count` is 0, and
  // the verdict is "no PR found for branch" -- definitive, and built on a
  // request that never succeeded.
  const failedLookup = async () => ({
    count: 0, prs: [], indeterminate: true,
    detail: "github PR lookup HTTP 403 for head=Stitch-Vercel:harness/client-offboarding",
  });

  const opened = await verify.verifySubTaskOutput(
    [{ kind: "pr_opened" }],
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: "abc" },
    { prForBranch: failedLookup },
  );
  assert.equal(opened.ok, false);
  assert.equal(opened.results[0].indeterminate, true);
  assert.match(opened.summary, /COULD NOT BE PERFORMED/);
  assert.match(opened.summary, /HTTP 403/);

  const state = await verify.verifySubTaskOutput(
    [{ kind: "pr_state", state: "merged" }],
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: "abc" },
    { prForBranch: failedLookup },
  );
  assert.match(state.results[0].detail, /could not determine whether a PR exists/);
  assert.equal(state.results[0].indeterminate, true);

  // And a genuine "no PR" is still reported as a genuine no.
  const genuinelyNone = await verify.verifySubTaskOutput(
    [{ kind: "pr_opened" }],
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: "abc" },
    { prForBranch: async () => ({ count: 0, prs: [], detail: "github PR count 0 for head=x:y" }) },
  );
  assert.equal(genuinelyNone.results[0].indeterminate, undefined);
  assert.ok(!/COULD NOT BE PERFORMED/.test(genuinelyNone.summary));
});

test("rc.9: an unlistable PR is not a PR that omits the file", { skip }, async () => {
  const out = await verify.verifySubTaskOutput(
    [{ kind: "file_in_pr", path: CONTRACT, prNumber: 1168 }],
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: "abc" },
    { prFiles: async () => ({ files: [], indeterminate: true, detail: "PR files lookup error: fetch failed" }) },
  );
  assert.equal(out.ok, false);
  assert.equal(out.results[0].indeterminate, true);
  assert.match(out.results[0].detail, /could not list the files in PR #1168/);
  assert.ok(!/not found in PR/.test(out.results[0].detail), "an unanswered lookup must not assert absence");
});

test("rc.9: a missing worktree is reported as a missing worktree, not a missing file", { skip }, async () => {
  // The exact rc.8 sentence this replaces:
  //   "no file matching contract path (checked literal + 0 committed)"
  const out = await verify.verifySubTaskOutput(
    [{ kind: "file_written", path: CONTRACT }],
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: "abc" },
    {
      fileExistsOnDisk: async () => ({
        exists: false, nonEmpty: false, indeterminate: true,
        detail: "the worktree /data/worktrees/f7c4e585 does not exist, so this check could not be performed -- this is NOT evidence the file is missing",
      }),
    },
  );
  assert.equal(out.ok, false, "still fails closed");
  assert.match(out.summary, /COULD NOT BE PERFORMED/);
  assert.match(out.summary, /worktree .* does not exist/);
});

test("rc.9: the probe itself checks the worktree exists before concluding absence", { skip }, () => {
  const src = readFileSync(new URL("../src/orchestrator/verify-probes.ts", import.meta.url), "utf8");
  assert.match(src, /if \(!existsSync\(worktreePath\)\)/, "the disk probe must check where it is looking");
  assert.match(src, /NOT evidence the file is missing/);
  // The swallowed listing error was the other half of it.
  assert.match(src, /could not list committed files in/);
  // And the remote probes now read their HTTP status instead of parsing a
  // failure body into an empty list.
  assert.ok(src.includes("res.ok ? {} : { indeterminate: true }"), "remote lookups must carry their own failures");
  assert.match(src, /res\.status === 200 \|\| res\.status === 404 \? \{\} : \{ indeterminate: true \}/);
});

/* ------------------------------------------------------------------ *
 * The status surface
 * ------------------------------------------------------------------ */

function seedDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, status TEXT, repo TEXT, branch TEXT, requester TEXT,
      cycles_ran INTEGER DEFAULT 1, cost_usd REAL DEFAULT 0, budget_usd REAL DEFAULT 10,
      pr_number INTEGER, final_pr_url TEXT, deploy_status TEXT,
      clarification_question TEXT, clarification_seq INTEGER, last_progress_at INTEGER,
      estimated_usd REAL, merge_recommendation TEXT, merge_recommendation_reason TEXT,
      lead_plan_json TEXT,
      storage_state TEXT, storage_reason TEXT, storage_checked_at INTEGER,
      last_checkpoint_sha TEXT, last_checkpoint_bundle TEXT,
      worktree_preserved INTEGER, created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
    );
    CREATE TABLE sub_tasks (session_id TEXT, cycle INTEGER, seq INTEGER, description TEXT,
      status TEXT, cost_usd REAL, started_at INTEGER, completed_at INTEGER,
      files_touched TEXT, commit_sha TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, event TEXT, payload TEXT, created_at INTEGER);
  `);
  return db;
}

test("rc.9: the status surface reports missing storage instead of reading as reassurance", { skip }, () => {
  const db = seedDb();
  db.prepare(`INSERT INTO sessions (id, status, repo, branch, requester, storage_state, storage_reason, storage_checked_at)
              VALUES ('s1','awaiting_clarification','Stitch-Vercel/StitchGuard','harness/co','U1',?,?,?)`)
    .run("missing_worktree", "the recorded worktree /data/worktrees/f7c4e585 no longer exists, and this session recorded 9 commit(s) that may have existed only there", 1_700_000_000_000);

  const snap = progress.buildProgressSnapshot(db, "s1");
  assert.equal(snap.storage.state, "missing_worktree");
  assert.match(snap.storage.reason, /9 commit/);
  assert.match(snap.headline, /LOCAL STORAGE MISSING_WORKTREE/);
  assert.equal(snap.storage.durableCheckpoint, null, "no bundle was verified, so none is claimed");
});

test("rc.9: `unknown` storage is carried, not shouted -- and never rendered as healthy", { skip }, () => {
  const db = seedDb();
  db.prepare(`INSERT INTO sessions (id, status, repo, branch, requester) VALUES ('s2','executing','o/r','b','U1')`).run();
  const snap = progress.buildProgressSnapshot(db, "s2");
  assert.equal(snap.storage.state, "unknown", "never checked is not ok");
  assert.equal(snap.storage.checkedAt, null);
  assert.ok(!/LOCAL STORAGE/.test(snap.headline), "an unchecked healthy run is not spammed with a warning");

  // A session nobody has heard of is unknown too, not fine.
  assert.equal(progress.buildProgressSnapshot(db, "nope").storage.state, "unknown");
});

test("rc.9: a verified checkpoint is reported, and a DB checkpoint alone is not", { skip }, () => {
  const db = seedDb();
  db.prepare(`INSERT INTO sessions (id, status, repo, branch, requester, storage_state, last_checkpoint_bundle, last_checkpoint_sha)
              VALUES ('s3','executing','o/r','b','U1','ok',?,?)`)
    .run("/data/checkpoints/checkpoints/s3/1757870000000-3f2a91c4e5b6.json", "3f2a91c4e5b60718293a4b5c6d7e8f9012345678");
  const snap = progress.buildProgressSnapshot(db, "s3");
  assert.equal(snap.storage.durableCheckpoint.sha, "3f2a91c4e5b60718293a4b5c6d7e8f9012345678");
  assert.match(snap.storage.durableCheckpoint.manifest, /\.json$/);
});

test("rc.9: building a snapshot writes NOTHING -- monitoring stays read-only and idempotent", { skip }, () => {
  // Requirement: the monitor's stop/deadline/terminal behaviour must remain
  // read-only. The rc.9 additions read two new columns; they must not have
  // turned the polling surface into a writer.
  const db = seedDb();
  db.prepare(`INSERT INTO sessions (id, status, repo, branch, requester, storage_state) VALUES ('s4','done','o/r','b','U1','ok')`).run();
  db.prepare(`INSERT INTO sub_tasks VALUES ('s4',1,1,'t','completed',0,0,0,'[]','abc')`).run();

  const fingerprint = () =>
    JSON.stringify([
      db.prepare(`SELECT * FROM sessions`).all(),
      db.prepare(`SELECT * FROM sub_tasks`).all(),
      db.prepare(`SELECT * FROM audit_log`).all(),
    ]);

  const before = fingerprint();
  const a = progress.buildProgressSnapshot(db, "s4");
  const b = progress.buildProgressSnapshot(db, "s4");
  const c = progress.buildProgressSnapshot(db, "s4");
  assert.equal(fingerprint(), before, "polling must not mutate a single row");

  // Idempotent: the same inputs give the same answer, including at terminal.
  assert.equal(a.terminal, true);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(JSON.stringify(b), JSON.stringify(c));
});

test("rc.9: a terminal session with missing storage does not get a clean-looking headline", { skip }, () => {
  // `done` is the most dangerous status to be wrong about, because it is the
  // one that stops people looking.
  const db = seedDb();
  db.prepare(`INSERT INTO sessions (id, status, repo, branch, requester, storage_state, storage_reason)
              VALUES ('s5','done','o/r','b','U1','missing_objects','the worktree exists but its git object store does not; the checkout is unusable')`).run();
  const snap = progress.buildProgressSnapshot(db, "s5");
  assert.equal(snap.terminal, true);
  assert.match(snap.headline, /LOCAL STORAGE MISSING_OBJECTS/);
  assert.match(snap.headline, /unusable/);
});
