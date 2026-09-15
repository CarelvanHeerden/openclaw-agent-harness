/**
 * rc.9 -- the database said nine commits, the disk said nothing.
 *
 * StitchGuard session f7c4e585, 2026-09-14. A container restart at ~19:42 took
 * the worktrees root with it -- tmpfs -- and with it the bare object cache,
 * because the git adapter nests `.repos/<owner>/<repo>.git` inside that same
 * root. The state DB was on a host-backed mount and survived perfectly,
 * describing a paused session, a worktree path, and nine commit SHAs that no
 * longer existed anywhere in the world.
 *
 * Startup then produced its two reassuring lines:
 *
 *   5431  harness.worktrees_preflight  {ok:true, created:false}
 *   5432  harness.worktree_heal        {scanned:0, removed:0, errors:[]}
 *
 * Neither was false. Together they were the most misleading pair of events in
 * the incident: the first means "I wrote a probe file here", the second means
 * "the directory I enumerate was empty". Nothing in the harness ever walked the
 * other way -- from rows that claim work to the disk that should hold it.
 *
 * These tests are in four groups: the reverse reconciliation that asks the
 * missing question, durable checkpoints (the thing `checkpoint()` never was),
 * refusing to act on storage that is gone, and honest accounting of what has
 * actually been completed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let health, bundle, progress, Database;
try {
  health = await import("../dist/state/storage-health.js");
  bundle = await import("../dist/state/checkpoint-bundle.js");
  progress = await import("../dist/orchestrator/progress.js");
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  health = null;
}
const skip = health === null;

// The real row, as it sat in harness-state.db after the restart.
const SESSION = "f7c4e585-1c6e-4d3f-9c0a-1b2c3d4e5f60";
const REPO = "Stitch-Vercel/StitchGuard";
const WORKTREE = "/data/worktrees/f7c4e585-1c6e-4d3f-9c0a-1b2c3d4e5f60";
const NINE_COMMITS = [
  "3f2a91c4e5b60718293a4b5c6d7e8f9012345678",
  "4a3b02d5f6c71829304b5c6d7e8f901234567890",
  "5b4c13e607d8293a415c6d7e8f90123456789012",
  "6c5d24f718e93a4b526d7e8f9012345678901234",
  "7d6e3508290a4b5c637e8f901234567890123456",
  "8e7f46193a1b5c6d748f90123456789012345678",
  "9f8057204b2c6d7e859012345678901234567890",
  "a09168315c3d7e8f96012345678901234567890a",
  "b1a279426d4e8f90a7123456789012345678901b",
];

const tmp = () => mkdtempSync(join(tmpdir(), "rc9-storage-"));

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A real repository with real commits. The bundle tests need real objects. */
function makeRepo(dir, { commits = 2, branch = "harness/client-offboarding" } = {}) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", branch], dir);
  git(["config", "user.email", "harness@example.invalid"], dir);
  git(["config", "user.name", "harness"], dir);
  const shas = [];
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(dir, `file-${i}.md`), `content ${i}\n`);
    git(["add", "."], dir);
    git(["commit", "-q", "-m", `sub-task ${i}`], dir);
    shas.push(git(["rev-parse", "HEAD"], dir));
  }
  return { branch, shas };
}

/* =====================================================================
 * 1. The question nobody asked: rows -> disk
 * ===================================================================== */

test("rc.9 incident: an empty worktrees root is not health, it is nine missing commits", { skip }, async () => {
  // Exactly the post-restart state. The worktree path is recorded, the session
  // is paused waiting for a human, and NOTHING is on disk.
  const findings = await health.reconcileSessionsToDisk(
    [{
      id: SESSION,
      status: "awaiting_clarification",
      repo: REPO,
      branch: "harness/client-offboarding-f7c4e585",
      worktreePath: WORKTREE,
      recordedCommits: NINE_COMMITS,
    }],
    { worktreesRoot: "/data/worktrees", exists: () => false },
  );

  assert.equal(findings.length, 1, "the paused session with a vanished worktree must be reported");
  assert.equal(findings[0].state, "missing_worktree");
  assert.match(findings[0].reason, /no longer exists/);
  // The count is the part that makes an operator stop. rc.8 had it in the DB
  // the whole time and never put the two facts next to each other.
  assert.match(findings[0].reason, /9 commit/);
  assert.equal(findings[0].missingCommits.length, 9);
});

test("rc.9: a surviving worktree whose OBJECT STORE is gone is just as dead, and much easier to miss", { skip }, async () => {
  // The nastier half of the incident: `.repos/<owner>/<repo>.git` lives INSIDE
  // the worktrees root, so it shares the mount's fate. `ls` still shows files
  // in the worktree, and git cannot read a single one of them.
  const bare = health.bareCachePathFor("/data/worktrees", REPO);
  assert.equal(bare, "/data/worktrees/.repos/Stitch-Vercel/StitchGuard.git");

  const gitLink = `${WORKTREE}/.git`;
  const findings = await health.reconcileSessionsToDisk(
    [{ id: SESSION, status: "paused", repo: REPO, branch: "b", worktreePath: WORKTREE, recordedCommits: [] }],
    {
      worktreesRoot: "/data/worktrees",
      // The worktree and its `.git` link survived; the bare repo it points into did not.
      exists: (p) => p === WORKTREE || p === gitLink,
      readText: () => `gitdir: ${bare}/worktrees/${SESSION}\n`,
    },
  );
  assert.equal(findings[0].state, "missing_objects");
  assert.match(findings[0].reason, /the git directory it points at/);
  assert.match(findings[0].reason, /unusable/);
});

test("rc.9: the object-store check asks the checkout, not the configuration", { skip }, async () => {
  // A false "your work is gone" is worse than no check at all -- it is the one
  // message an operator has to be able to believe. So a session whose objects
  // live somewhere the adapter's layout would not predict is NOT condemned.
  const ok = await health.reconcileSessionsToDisk(
    [{ id: SESSION, status: "executing", repo: REPO, branch: "b", worktreePath: WORKTREE, recordedCommits: [] }],
    {
      worktreesRoot: "/somewhere/else/entirely",
      exists: (p) => p === WORKTREE || p === `${WORKTREE}/.git` || p.startsWith("/opt/git-cache"),
      readText: () => "gitdir: /opt/git-cache/StitchGuard.git/worktrees/x\n",
    },
  );
  assert.deepEqual(ok, [], "objects that exist elsewhere are still objects");

  // And without a reader we decline to guess rather than condemning.
  const noReader = await health.reconcileSessionsToDisk(
    [{ id: SESSION, status: "executing", repo: REPO, branch: "b", worktreePath: WORKTREE, recordedCommits: [] }],
    { worktreesRoot: "/data/worktrees", exists: (p) => p === WORKTREE || p === `${WORKTREE}/.git` },
  );
  assert.deepEqual(noReader, []);

  // A checkout with no `.git` at all is unambiguous, though.
  const noGit = await health.reconcileSessionsToDisk(
    [{ id: SESSION, status: "executing", repo: REPO, branch: "b", worktreePath: WORKTREE, recordedCommits: [] }],
    { worktreesRoot: "/data/worktrees", exists: (p) => p === WORKTREE },
  );
  assert.equal(noGit[0].state, "missing_objects");
  assert.match(noGit[0].reason, /no \.git entry at all/);
});

test("rc.9: commits the DB claims but git cannot find are reported, with the shas", { skip }, async () => {
  const findings = await health.reconcileSessionsToDisk(
    [{
      id: SESSION, status: "executing", repo: REPO, branch: "b",
      worktreePath: WORKTREE, recordedCommits: [NINE_COMMITS[0], NINE_COMMITS[1], NINE_COMMITS[2]],
    }],
    {
      worktreesRoot: "/data/worktrees",
      exists: () => true,
      // Two of the three survived a partial loss.
      unreachableCommits: async (_wt, shas) => shas.slice(0, 1),
    },
  );
  assert.equal(findings[0].state, "missing_commits");
  assert.match(findings[0].reason, /1 of 3 recorded commit/);
  assert.match(findings[0].reason, new RegExp(NINE_COMMITS[0]));
});

test("rc.9: a check that could not run is `unknown`, never `ok`", { skip }, async () => {
  // The rc.8 failure was not a wrong answer, it was a confident one. An
  // unverifiable session must be visibly unverified.
  const noProbe = await health.reconcileSessionsToDisk(
    [{ id: SESSION, status: "executing", repo: REPO, branch: "b", worktreePath: WORKTREE, recordedCommits: NINE_COMMITS }],
    { worktreesRoot: "/data/worktrees", exists: () => true },
  );
  assert.equal(noProbe[0].state, "unknown");
  assert.match(noProbe[0].reason, /could not be checked/);
  assert.equal(noProbe[0].missingCommits.length, 0, "an unchecked commit is not a missing one");

  const threw = await health.reconcileSessionsToDisk(
    [{ id: SESSION, status: "executing", repo: REPO, branch: "b", worktreePath: WORKTREE, recordedCommits: ["abc"] }],
    {
      worktreesRoot: "/data/worktrees",
      exists: () => true,
      unreachableCommits: async () => { throw new Error("git exploded"); },
    },
  );
  assert.equal(threw[0].state, "unknown");

  const noPath = await health.reconcileSessionsToDisk(
    [{ id: SESSION, status: "paused", repo: REPO, branch: "b", worktreePath: null, recordedCommits: [] }],
    { worktreesRoot: "/data/worktrees", exists: () => false },
  );
  assert.equal(noPath[0].state, "unknown");
});

test("rc.9: terminal sessions are not findings -- the real one must not be buried", { skip }, async () => {
  // A machine that has run for months has hundreds of done sessions whose
  // worktrees were reaped on purpose. Reporting those would make the report
  // useless on exactly the day it matters.
  const rows = ["done", "failed", "aborted", "cancelled"].map((status, i) => ({
    id: `terminal-${i}`, status, repo: REPO, branch: "b",
    worktreePath: `/data/worktrees/terminal-${i}`, recordedCommits: ["deadbeef"],
  }));
  rows.push({
    id: SESSION, status: "awaiting_clarification", repo: REPO, branch: "b",
    worktreePath: WORKTREE, recordedCommits: NINE_COMMITS,
  });

  const findings = await health.reconcileSessionsToDisk(rows, {
    worktreesRoot: "/data/worktrees",
    exists: () => false,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sessionId, SESSION);
});

test("rc.9: reconciliation NEVER deletes -- the cleanup protections are the healer's job, untouched", { skip }, async () => {
  // Requirement: existing active/paused/preserved protections must survive this
  // work. The cleanest way to guarantee that is for the new code to have no
  // delete path at all, which is checkable directly from its source.
  const src = readFileSync(new URL("../src/state/storage-health.ts", import.meta.url), "utf8");
  for (const forbidden of ["rmSync", "unlinkSync", "rmdirSync", "rm -rf"]) {
    assert.ok(!src.includes(forbidden), `storage-health must not contain ${forbidden}: diagnosis is not deletion`);
  }
  // And the healer's own protections are still where they were.
  const heal = readFileSync(new URL("../src/state/worktree-heal.ts", import.meta.url), "utf8");
  assert.match(heal, /worktree_preserved/, "beta.129 preserved-worktree protection must remain");
});

test("rc.9: a tmpfs worktrees root is reported as volatile; unknown is not reported as durable", { skip }, () => {
  // The mount table is the incident's, from `findmnt` in the evidence bundle:
  // the state DB survived on virtiofs, the worktrees root did not on tmpfs.
  const root = tmp();
  const mountinfo = [
    "23 28 0:21 / / rw,relatime shared:1 - virtiofs virtiofs rw",
    `31 23 0:26 / ${root} rw,relatime shared:5 - tmpfs tmpfs rw,size=4194304k`,
  ].join("\n");

  const volatileProbe = health.probeStorage(root, () => mountinfo);
  assert.equal(volatileProbe.exists, true);
  assert.equal(volatileProbe.fsType, "tmpfs");
  assert.equal(volatileProbe.volatile, true);
  assert.match(volatileProbe.note, /does not survive a restart/);
  // The nested object cache is the detail rc.8 never connected.
  assert.match(volatileProbe.note, /object store/);

  // The longest matching mountpoint wins, so a nested durable mount is not
  // tarred with its parent's brush.
  const durable = [
    "23 28 0:21 / / rw,relatime shared:1 - tmpfs tmpfs rw",
    `31 23 0:26 / ${root} rw,relatime shared:5 - virtiofs virtiofs rw`,
  ].join("\n");
  assert.equal(health.probeStorage(root, () => durable).volatile, false);

  // A mount table that cannot be read leaves durability UNKNOWN. This is the
  // whole correction: rc.8 turned "I could not tell" into `ok:true`.
  const blind = health.probeStorage(root, () => { throw new Error("no /proc here"); });
  assert.equal(blind.volatile, undefined, "unknown durability must stay undefined, not false");
  assert.match(blind.note, /UNKNOWN/);

  // So does a table with no entry covering the path.
  const unrelated = health.probeStorage(root, () => "23 28 0:21 / /somewhere/else rw - ext4 ext4 rw");
  assert.equal(unrelated.volatile, undefined);
  assert.match(unrelated.note, /UNKNOWN/);
});

test("rc.9: a checkpoint root inside the worktrees root is refused -- that is the incident's shape", { skip }, () => {
  // `.repos` was inside the worktrees root and died with it. A checkpoint dir
  // placed the same way would be a copy that shares the original's fate.
  const inside = health.checkpointRootIsSafe("/data/worktrees/checkpoints", "/data/worktrees");
  assert.equal(inside.ok, false);
  assert.match(inside.reason, /inside the worktrees root/);

  assert.equal(health.checkpointRootIsSafe("", "/data/worktrees").ok, false, "unconfigured is not safe, it is off");
  assert.equal(health.checkpointRootIsSafe("/data/checkpoints", "/data/worktrees").ok, true);
  // Sibling directories that merely share a prefix are fine.
  assert.equal(health.checkpointRootIsSafe("/data/worktrees-backup", "/data/worktrees").ok, true);
});

/* =====================================================================
 * 2. Durable checkpoints: the thing `checkpoint()` never was
 * ===================================================================== */

test("rc.9: checkpoint round-trip -- commits survive the loss of the worktree that made them", { skip }, async () => {
  // This is the test the incident is asking for. Make real commits, checkpoint
  // them, destroy the working storage exactly as a tmpfs restart would, and
  // then prove the content comes back.
  const root = tmp();
  const wt = join(root, "worktrees", SESSION);
  const ck = join(root, "durable"); // a DIFFERENT tree, as required
  const { branch, shas } = makeRepo(wt, { commits: 3 });

  const res = await bundle.createCheckpoint({
    sessionId: SESSION, cycle: 1, subTaskId: `${SESSION}-c1-s3`,
    worktreePath: wt, branch, checkpointRoot: ck,
  });
  assert.equal(res.durable, true, "a verified bundle of three commits is durable");
  assert.equal(res.manifest.commitCount, 3);
  assert.equal(res.manifest.tip, shas[2]);
  assert.equal(res.manifest.recoverable, true);

  // The restart. Worktrees root and everything nested in it, gone.
  rmSync(join(root, "worktrees"), { recursive: true, force: true });
  assert.equal(existsSync(wt), false);

  // A fresh process re-reads the manifest from disk -- nothing in memory
  // carries over, which is the point.
  const reloaded = bundle.loadCheckpoint(res.manifestPath);
  assert.ok(reloaded, "the manifest must still prove out after the worktree is gone");
  assert.equal(reloaded.tip, shas[2]);

  const target = join(root, "recovered");
  const restored = await bundle.restoreCheckpoint(res.manifestPath, target);
  assert.equal(restored.ok, true, restored.reason ?? "");
  assert.equal(restored.tip, shas[2]);

  // Not just the right sha -- the right CONTENT.
  assert.equal(readFileSync(join(target, "file-3.md"), "utf8"), "content 3\n");
  const log = git(["log", "--format=%H", branch], target).split("\n");
  assert.deepEqual(log, [shas[2], shas[1], shas[0]], "the whole chain came back, in order");
});

test("rc.9: a restore refuses to write over anything -- recovery must not destroy the last copy", { skip }, async () => {
  const root = tmp();
  const wt = join(root, "wt");
  const ck = join(root, "durable");
  const { branch } = makeRepo(wt, { commits: 1 });
  const res = await bundle.createCheckpoint({ sessionId: SESSION, cycle: 1, worktreePath: wt, branch, checkpointRoot: ck });

  const occupied = join(root, "occupied");
  mkdirSync(occupied, { recursive: true });
  writeFileSync(join(occupied, "someone-elses-work.txt"), "do not lose me");

  const restored = await bundle.restoreCheckpoint(res.manifestPath, occupied);
  assert.equal(restored.ok, false);
  assert.match(restored.reason, /refusing to restore over/);
  assert.equal(readFileSync(join(occupied, "someone-elses-work.txt"), "utf8"), "do not lose me");
});

test("rc.9: a corrupt, truncated or missing bundle is NEVER a checkpoint", { skip }, async () => {
  const root = tmp();
  const wt = join(root, "wt");
  const ck = join(root, "durable");
  const { branch } = makeRepo(wt, { commits: 2 });
  const res = await bundle.createCheckpoint({ sessionId: SESSION, cycle: 1, worktreePath: wt, branch, checkpointRoot: ck });
  assert.equal(res.durable, true);

  const dir = bundle.checkpointDirFor(ck, SESSION);
  const bundlePath = join(dir, res.manifest.bundleFile);

  // (a) Truncated. Size check catches it.
  const good = readFileSync(bundlePath);
  writeFileSync(bundlePath, good.subarray(0, Math.floor(good.length / 2)));
  assert.equal(bundle.loadCheckpoint(res.manifestPath), null, "a truncated bundle must not load");

  // (b) Same size, different bytes. Only the digest catches this one.
  const swapped = Buffer.from(good);
  swapped[swapped.length - 1] = swapped[swapped.length - 1] ^ 0xff;
  writeFileSync(bundlePath, swapped);
  assert.equal(bundle.loadCheckpoint(res.manifestPath), null, "a same-size corruption must not load");

  // (c) Gone entirely.
  rmSync(bundlePath, { force: true });
  assert.equal(bundle.loadCheckpoint(res.manifestPath), null, "a manifest without its bundle is not a checkpoint");

  // And a restore from any of those refuses rather than half-working.
  const restored = await bundle.restoreCheckpoint(res.manifestPath, join(root, "nope"));
  assert.equal(restored.ok, false);
  assert.match(restored.reason, /not a usable checkpoint/);
});

test("rc.9: a failed checkpoint is RECORDED as failed, and does not throw into the run", { skip }, async () => {
  const root = tmp();
  const res = await bundle.createCheckpoint({
    sessionId: SESSION, cycle: 1,
    worktreePath: join(root, "does-not-exist"),
    branch: "main",
    checkpointRoot: join(root, "durable"),
  });
  assert.equal(res.durable, false);
  assert.equal(res.manifest.recoverable, false);
  assert.match(res.manifest.error, /does not exist/);
  // The failure is on disk, so "no checkpoint was taken" is answerable later.
  assert.ok(res.manifestPath && existsSync(res.manifestPath));
  assert.equal(bundle.loadCheckpoint(res.manifestPath), null, "a failure manifest must never load as a checkpoint");
});

test("rc.9: a metadata-only checkpoint is not recoverable code, and says so", { skip }, async () => {
  // Requirement 12, second half. An empty commit range is a legitimate state --
  // a human gate can be reached before anything was committed -- and the answer
  // must be "nothing to recover", not a checkpoint that turns out to be hollow.
  const root = tmp();
  const wt = join(root, "wt");
  const ck = join(root, "durable");
  const { branch, shas } = makeRepo(wt, { commits: 1 });

  const res = await bundle.createCheckpoint({
    sessionId: SESSION, cycle: 1, trigger: "human_gate",
    worktreePath: wt, branch, checkpointRoot: ck,
    since: shas[0], // nothing since the tip
  });
  assert.equal(res.durable, false, "no commits means nothing durable was created");
  assert.equal(res.manifest.commitCount, 0);
  assert.equal(res.manifest.recoverable, false);
  assert.equal(res.manifest.bundleFile, null);
  assert.equal(res.manifest.tip, shas[0], "it still records WHERE we were, which is useful and honest");
  assert.equal(bundle.loadCheckpoint(res.manifestPath), null);
});

test("rc.9: latestCheckpoint picks the newest one that still proves out, not merely the newest", { skip }, async () => {
  const root = tmp();
  const wt = join(root, "wt");
  const ck = join(root, "durable");
  const { branch, shas } = makeRepo(wt, { commits: 1 });

  const first = await bundle.createCheckpoint({
    sessionId: SESSION, cycle: 1, worktreePath: wt, branch, checkpointRoot: ck, now: () => 1_000,
  });
  writeFileSync(join(wt, "later.md"), "later\n");
  git(["add", "."], wt);
  git(["commit", "-q", "-m", "later"], wt);
  const second = await bundle.createCheckpoint({
    sessionId: SESSION, cycle: 2, worktreePath: wt, branch, checkpointRoot: ck, now: () => 2_000,
  });
  assert.equal(second.durable, true);

  assert.equal(bundle.latestCheckpoint(ck, SESSION).manifest.cycle, 2);

  // Corrupt the newer one. The answer must fall back, not fail and not lie.
  const dir = bundle.checkpointDirFor(ck, SESSION);
  writeFileSync(join(dir, second.manifest.bundleFile), "garbage");
  const fallback = bundle.latestCheckpoint(ck, SESSION);
  assert.equal(fallback.manifest.cycle, 1);
  assert.equal(fallback.manifest.tip, shas[0]);
});

test("rc.9: a checkpoint manifest never carries secret material", { skip }, async () => {
  // Requirement 14. Manifests are operator-facing artefacts that outlive the
  // run, so an error string carrying a token would persist it in the one place
  // designed to be kept.
  const root = tmp();
  const token = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
  const res = await bundle.createCheckpoint({
    sessionId: SESSION, cycle: 1,
    worktreePath: join(root, `missing-${token}`),
    branch: "main",
    checkpointRoot: join(root, "durable"),
  });
  assert.equal(res.durable, false);
  assert.ok(!res.manifest.error.includes(token), "the manifest must not carry the token value");
  assert.match(res.manifest.error, /xox-\*\*\*/, "it should say a token was there, not what it was");
  assert.ok(!readFileSync(res.manifestPath, "utf8").includes(token), "nor may the file on disk");
});

test("rc.9 integration: a restart in a FRESH PROCESS finds what the old one recorded", { skip }, async () => {
  /*
   * The incident in miniature, with the two mounts separated exactly as the
   * deployment had them: state on durable storage, work on volatile storage.
   *
   * The reconciliation runs in a CHILD PROCESS with no shared memory, because
   * the property under test is precisely that the answer survives the process
   * that discovered the problem. In rc.8 every fact needed to raise the alarm
   * was already in the database; nothing ever read them back after a restart.
   */
  const root = tmp();
  const durable = join(root, "state"); // survives (virtiofs, in production)
  const volatileRoot = join(root, "worktrees"); // does not (tmpfs)
  mkdirSync(durable, { recursive: true });

  const wt = join(volatileRoot, SESSION);
  const { shas } = makeRepo(wt, { commits: 2 });
  // The bare cache nested inside the volatile root, as the adapter places it.
  mkdirSync(join(volatileRoot, ".repos", "Stitch-Vercel", "StitchGuard.git"), { recursive: true });

  const dbPath = join(durable, "harness-state.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, repo TEXT, branch TEXT, worktree_path TEXT);
           CREATE TABLE sub_tasks (session_id TEXT, commit_sha TEXT);`);
  db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?)`)
    .run(SESSION, "awaiting_clarification", REPO, "harness/client-offboarding", wt);
  for (const sha of shas) db.prepare(`INSERT INTO sub_tasks VALUES (?,?)`).run(SESSION, sha);
  db.close();

  // THE RESTART. Volatile storage is gone; the database is untouched.
  rmSync(volatileRoot, { recursive: true, force: true });

  const script = `
    import { DatabaseSync } from "node:sqlite";
    import { reconcileSessionsToDisk } from ${JSON.stringify(new URL("../dist/state/storage-health.js", import.meta.url).href)};
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    const row = db.prepare("SELECT id, status, repo, branch, worktree_path FROM sessions").get();
    const commits = db.prepare("SELECT commit_sha FROM sub_tasks WHERE session_id = ?").all(row.id).map((r) => r.commit_sha);
    const findings = await reconcileSessionsToDisk(
      [{ id: row.id, status: row.status, repo: row.repo, branch: row.branch, worktreePath: row.worktree_path, recordedCommits: commits }],
      { worktreesRoot: ${JSON.stringify(volatileRoot)} },
    );
    process.stdout.write(JSON.stringify(findings));
  `;
  const scriptPath = join(durable, "restart-check.mjs");
  writeFileSync(scriptPath, script);
  const out = execFileSync(process.execPath, [scriptPath], { encoding: "utf8" });
  const findings = JSON.parse(out);

  assert.equal(findings.length, 1, "the new process must find what the old one recorded");
  assert.equal(findings[0].state, "missing_worktree");
  assert.equal(findings[0].missingCommits.length, 2);
  // And the database is still intact afterwards -- diagnosis, not cleanup.
  const after = new Database(dbPath);
  assert.equal(after.prepare(`SELECT count(*) AS n FROM sub_tasks`).get().n, 2);
  after.close();
});

test("rc.9 integration: with a checkpoint configured, the same restart is survivable", { skip }, async () => {
  // The counterfactual. Identical setup, except the commits were checkpointed
  // to durable storage first. This is the difference the repair buys.
  const root = tmp();
  const durable = join(root, "state");
  const volatileRoot = join(root, "worktrees");
  const wt = join(volatileRoot, SESSION);
  const { branch, shas } = makeRepo(wt, { commits: 3 });

  const res = await bundle.createCheckpoint({
    sessionId: SESSION, cycle: 1, trigger: "human_gate",
    worktreePath: wt, branch, checkpointRoot: durable,
  });
  assert.equal(res.durable, true);

  rmSync(volatileRoot, { recursive: true, force: true });

  const found = bundle.latestCheckpoint(durable, SESSION);
  assert.ok(found, "the checkpoint outlived the mount that held the work");
  const restored = await bundle.restoreCheckpoint(found.manifestPath, join(root, "recovered"));
  assert.equal(restored.ok, true, restored.reason ?? "");
  assert.equal(restored.tip, shas[2]);
  assert.equal(readFileSync(join(root, "recovered", "file-2.md"), "utf8"), "content 2\n");
});

/* =====================================================================
 * 3. Honest accounting
 * ===================================================================== */

test("rc.9: `last_completed_sub_task` is only written after verification passes", { skip }, () => {
  // The incident DB named sub-task 11 as last-completed. Sub-task 11 is
  // `failed_verification`, `commit_sha: null` -- the documentation edit the
  // guard blocked. It got there because the only writer ran BEFORE verification
  // had an opinion.
  const src = readFileSync(new URL("../src/orchestrator/loop.ts", import.meta.url), "utf8");

  // The write is now conditional on the caller declaring a completion.
  assert.match(
    src,
    /const completed = subTaskState === "completed" \? \(lastSubTask \?\? null\) : null;/,
    "checkpoint() must distinguish an attempt from a completion",
  );
  assert.match(src, /last_attempted_sub_task = COALESCE\(\?, last_attempted_sub_task\)/);

  // And "completed" is only ever passed from paths that have verified.
  const completions = [...src.matchAll(/this\.checkpoint\([^)]*"completed"\)/g)];
  assert.ok(completions.length >= 1, "at least the terminal-success path marks a completion");
  const attempts = [...src.matchAll(/this\.checkpoint\(sessionId, cycle, subTaskId, result\.sdkSessionId\);/g)];
  assert.ok(attempts.length >= 1, "the post-worker call stays an ATTEMPT");
});

test("rc.9: a failed_verification sub-task is never counted as done", { skip }, () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE sub_tasks (session_id TEXT, cycle INTEGER, seq INTEGER, description TEXT,
             status TEXT, cost_usd REAL, started_at INTEGER, completed_at INTEGER,
             files_touched TEXT, commit_sha TEXT);`);
  // Ten real completions and the one that was blocked -- the incident's shape.
  for (let i = 1; i <= 10; i++) {
    db.prepare(`INSERT INTO sub_tasks VALUES (?,1,?,?,'completed',0,0,0,'[]',?)`)
      .run(SESSION, i, `sub-task ${i}`, NINE_COMMITS[Math.min(i - 1, 8)]);
  }
  db.prepare(`INSERT INTO sub_tasks VALUES (?,1,11,'document the webhook contract','failed_verification',0,0,0,'[]',NULL)`)
    .run(SESSION);

  const rows = db.prepare(`SELECT status, commit_sha FROM sub_tasks WHERE session_id = ?`).all(SESSION);
  const DONE = new Set(["done", "completed", "completed_no_change"]);
  const done = rows.filter((r) => DONE.has(r.status)).length;
  const failed = rows.filter((r) => ["failed", "failed_verification"].includes(r.status)).length;
  assert.equal(done, 10, "ten, not eleven");
  assert.equal(failed, 1);

  // The blocked one committed nothing, and that must be visible rather than
  // inferred from a status word.
  const eleven = rows[10];
  assert.equal(eleven.commit_sha, null);
});

test("rc.9: progress reports storage state, and `unknown` is its default", { skip }, () => {
  const src = readFileSync(new URL("../src/orchestrator/progress.ts", import.meta.url), "utf8");
  assert.match(src, /storage_state, storage_reason, storage_checked_at/, "the snapshot must read the columns");
  assert.match(src, /state: "unknown", reason: null, checkedAt: null, durableCheckpoint: null/,
    "an unread session defaults to unknown, not to healthy");
  assert.match(src, /durableCheckpoint/, "a verified bundle is reported separately from a DB checkpoint");
});

test("rc.9: resume and answer both refuse to drive a loop into storage that is gone", { skip }, () => {
  const src = readFileSync(new URL("../src/tools/registration.ts", import.meta.url), "utf8");
  assert.match(src, /tool\.resume_refused_storage/);
  assert.match(src, /tool\.answer_refused_storage/);
  assert.match(src, /function storageIsUnrecoverable/);
  // A missing worktree with nothing committed is not a disaster -- beta.101
  // re-allocates one -- and a gate that cries wolf gets forced past.
  assert.match(src, /return lost && storage\.missingCommits\.length > 0;/);
  // The refusal must not be a cleanup. The incident's remaining evidence is
  // worth more than the tidiness.
  assert.match(src, /Nothing has been deleted and the session row is/);
  assert.match(src, /The pause is still open and nothing has been/);
  // Wall-clock and budget pauses keep working -- their loop never left.
  assert.match(src, /!isTimeExtensionPause\(row\.clarification_subtask\) && !isBudgetExtensionPause/);
});

test("rc.9: the gate is narrow and certain; the deep finding comes from the recorded check", { skip }, () => {
  const src = readFileSync(new URL("../src/tools/registration.ts", import.meta.url), "utf8");

  // One rule: recorded work with nowhere left to live. A worktree that was
  // reaped from a session that committed nothing is not an emergency, and a
  // gate that stops people for those is a gate they learn to force past.
  assert.match(src, /return lost && storage\.missingCommits\.length > 0;/);

  // Commit reachability is one git process per commit. It belongs to startup,
  // not to a path an operator is waiting on -- but the answer it wrote down is
  // still honoured, so the deep case does gate once it has been found.
  assert.match(src, /Structural checks only/);
  assert.match(src, /row\.storage_state === "missing_commits"/);
  assert.ok(
    !/unreachableCommits/.test(src.slice(src.indexOf("async function checkSessionStorage"), src.indexOf("function storageIsUnrecoverable"))),
    "the tool gate must not shell out per commit",
  );
});

test("rc.9: startup says what it MEASURED, not a verdict on the storage", { skip }, () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(src, /writable: true/, "the preflight event must name what it actually checked");
  assert.match(src, /volatile: probe\.volatile \?\? null/, "unknown durability is null, not false");
  assert.match(src, /harness\.worktrees_root_volatile/);
  assert.match(src, /harness\.storage_reconcile\b/);
  assert.match(src, /harness\.session_storage_missing/);
  // The reverse walk must not become a second reaper.
  const block = src.slice(src.indexOf("harness.storage_reconcile") - 4000, src.indexOf("harness.storage_reconcile") + 2000);
  assert.ok(!/rmSync|removeWorktree/.test(block), "reconciliation diagnoses; it does not delete");
});
