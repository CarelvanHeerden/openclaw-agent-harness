// rc.10 — attempt history, and what a continuation is allowed to inherit.
//
// Two of the report's bounded concerns, which turned out to be one missing
// thing: nothing recorded what a sub-task's EARLIER attempts did.
//
//   Mutable ledger (report §3). `sub_tasks` holds one row per (cycle, seq) and
//   every retry overwrites it. Task 3 finished showing $0.4262756 and
//   commit_sha NULL. Both are true of its last attempt and false of the
//   sub-task: audits 5590 and 5620 are two separate worker turns, and there is
//   a commit from the work in between. Anyone reading the ledger to ask what
//   the sub-task cost, or whether it committed anything, got a confident wrong
//   answer, and the truth was only recoverable by replaying the audit log.
//
//   Resume verification baseline (report §2). Audit 5621 checked all five of
//   task 3's contract paths against the resumed worker-start SHA 065063e --
//   which IS the commit the previous attempt of that same sub-task had made.
//   That attempt committed nothing new, so failing was right, and the report
//   is careful to say so. The case it flags is the next one along: a
//   continuation asked to add only the missing test and template commits
//   those, and is then told the two implementation files it already wrote are
//   not committed, because they sit behind the new base. The only way a worker
//   can satisfy that is to edit a correct file for the sake of editing it.
//
// The rule these tests pin: a contract path may be satisfied by a commit from
// an EARLIER ATTEMPT OF THE SAME SUB-TASK, reported with provenance -- and
// nothing else changes. `commit_made` still demands a new commit, so an
// attempt that does nothing still fails, and a commit from elsewhere on the
// branch still cannot answer for a contract path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

let verifySubTaskOutput, createVerifyProbes, GitAdapter, DatabaseSync;
try {
  ({ verifySubTaskOutput } = await import("../dist/orchestrator/verify.js"));
  ({ createVerifyProbes } = await import("../dist/orchestrator/verify-probes.js"));
  ({ GitAdapter } = await import("../dist/adapters/git-worktree.js"));
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  verifySubTaskOutput = null;
}
const skip = verifySubTaskOutput === null;

const IDENT = { name: "Harness Test", email: "harness@test.local" };
const git = (args, cwd) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const dirs = [];
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A worktree with one commit per "attempt", so the SHAs are real. */
function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), "rc10-attempts-"));
  dirs.push(base);
  const wt = join(base, "wt");
  mkdirSync(wt, { recursive: true });
  git(["init", "-b", "main"], wt);
  git(["config", "user.name", IDENT.name], wt);
  git(["config", "user.email", IDENT.email], wt);
  const write = (rel, body) => {
    const abs = join(wt, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const commit = (msg) => {
    git(["add", "-A"], wt);
    git(["commit", "-m", msg], wt);
    return git(["rev-parse", "HEAD"], wt);
  };
  write("README.md", "# seed\n");
  const seed = commit("seed");
  return { base, wt, write, commit, seed };
}

function probesFor(wt) {
  return createVerifyProbes({
    git: new GitAdapter({
      worktreeRoot: join(wt, "..", "root"),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    }),
    pat: { resolve: () => ({ service: "s" }) },
    config: { repos: { default_base_branch: "main" }, loop: {} },
    resolveGitToken: async () => "",
  })({ plan: { repo: "o/r", branch: "b", worktreePath: wt }, requester: "u", worktreePath: wt, baseSha: "" });
}

// ---------------------------------------------------------------------------
// 1. Verification: an earlier attempt of THIS sub-task counts, with provenance
// ---------------------------------------------------------------------------

const CONTRACT = [
  { kind: "commit_made" },
  { kind: "file_committed", path: "src/lib/config/stitchguard-config.ts" },
  { kind: "file_committed", path: "src/lib/it/client-offboarding-slack.ts" },
  { kind: "file_committed", path: ".env.example" },
  { kind: "file_committed", path: "src/__tests__/lib/it/client-offboarding-orchestrator.test.ts" },
];

test("rc.10 (audit 5621): the continuation is not asked to re-edit correct files", { skip }, async () => {
  const repo = makeRepo();
  // Attempt 1: the implementation, exactly as 065063e did.
  repo.write("src/lib/config/stitchguard-config.ts", "export const cfg = 1;\n");
  repo.write("src/lib/it/client-offboarding-slack.ts", "export const slack = 1;\n");
  const attempt1 = repo.commit("feat(3): dedicated config and slack factory");

  // Attempt 2 resumes from attempt 1's commit and adds ONLY what was missing.
  repo.write(".env.example", "CLIENT_OFFBOARDING_SLACK_CHANNEL_ID=\n");
  repo.write("src/__tests__/lib/it/client-offboarding-orchestrator.test.ts", "test('x', () => {});\n");
  repo.commit("feat(3): template and tests");

  const out = await verifySubTaskOutput(
    CONTRACT,
    {
      defaultBranch: "main",
      subTaskStartMs: 0,
      baseSha: attempt1, // the resumed worker-start SHA, as in 5621
      priorAttemptCommits: [attempt1],
    },
    probesFor(repo.wt),
  );

  assert.equal(out.ok, true, `expected a pass, got: ${out.summary}`);
  const byPath = new Map(out.results.filter((r) => r.path).map((r) => [r.path, r]));
  // The two files this attempt actually committed pass on their own merits.
  assert.match(byPath.get(".env.example").detail, /appears in .*\.\.HEAD/);
  assert.ok(
    !/earlier attempt/.test(byPath.get(".env.example").detail),
    "a file committed by THIS attempt is credited to this attempt, not to history",
  );
  // The two from attempt 1 pass, and SAY they came from attempt 1. A silent
  // pass here would be the same kind of dishonesty as the failure it replaces.
  for (const p of ["src/lib/config/stitchguard-config.ts", "src/lib/it/client-offboarding-slack.ts"]) {
    assert.equal(byPath.get(p).passed, true, `${p} should be credited`);
    assert.match(byPath.get(p).detail, /earlier attempt of this sub-task/);
    assert.match(byPath.get(p).detail, new RegExp(attempt1.slice(0, 12)));
  }
});

test("rc.10 (audit 5621): an attempt that commits nothing still fails", { skip }, async () => {
  // The actual 5621 situation, which was a legitimate failure and must stay
  // one. Otherwise the relaxation above would turn "I did nothing" into a pass
  // for any sub-task whose earlier attempt had done something.
  const repo = makeRepo();
  repo.write("src/lib/config/stitchguard-config.ts", "export const cfg = 1;\n");
  repo.write("src/lib/it/client-offboarding-slack.ts", "export const slack = 1;\n");
  const attempt1 = repo.commit("feat(3): implementation only");

  const out = await verifySubTaskOutput(
    CONTRACT,
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: attempt1, priorAttemptCommits: [attempt1] },
    probesFor(repo.wt),
  );

  assert.equal(out.ok, false);
  const commitMade = out.results.find((r) => r.kind === "commit_made");
  assert.equal(commitMade.passed, false, "no new commit is still no new commit");
  // And the genuinely missing deliverables are still missing.
  const env = out.results.find((r) => r.path === ".env.example");
  assert.equal(env.passed, false);
});

test("rc.10: an unrelated commit cannot satisfy a contract path", { skip }, async () => {
  // The guard rail on the relaxation. The credit is keyed on the commits this
  // sub-task's own attempts recorded, not on a window of branch history, so
  // work that merely happens to be nearby does not count.
  const repo = makeRepo();
  repo.write("src/lib/config/stitchguard-config.ts", "export const cfg = 1;\n");
  const someoneElse = repo.commit("chore: unrelated work by another sub-task");
  repo.write("docs/notes.md", "notes\n");
  const attempt1 = repo.commit("feat(3): attempt 1 did only this");
  repo.write("other.txt", "x\n");
  repo.commit("feat(3): attempt 2");

  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "src/lib/config/stitchguard-config.ts" }],
    // Only attempt 1 is this sub-task's; `someoneElse` is not offered.
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: attempt1, priorAttemptCommits: [attempt1] },
    probesFor(repo.wt),
  );
  assert.equal(out.ok, false, "a commit from another sub-task must not count");
  assert.ok(!/earlier attempt/.test(out.results[0].detail));
  assert.ok(someoneElse.length > 0);
});

test("rc.10: with no recorded attempts the behaviour is exactly as before", { skip }, async () => {
  const repo = makeRepo();
  repo.write("src/a.ts", "export const a = 1;\n");
  const base = repo.commit("first");
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "src/a.ts" }],
    { defaultBranch: "main", subTaskStartMs: 0, baseSha: base },
    probesFor(repo.wt),
  );
  assert.equal(out.ok, false, "unchanged: the file is behind the base and nothing vouches for it");
});

// ---------------------------------------------------------------------------
// 2. The ledger itself
// ---------------------------------------------------------------------------

test("rc.10 (report §3): attempt rows are append-only and sum honestly", { skip }, async () => {
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../dist/state/schema.sql", import.meta.url), "utf8"));
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES ('S1','T','C','U','u','o/r','b','', 'running', 0, 0, 50, 0, 0)`,
  ).run();

  // The two turns audits 5590 and 5620 record, plus the commit in between.
  const rows = [
    { attempt: 1, status: "completed", cost: 0.3, commit: null },
    { attempt: 2, status: "completed", cost: 0.4262756, commit: "065063e" },
    { attempt: 3, status: "failed_verification", cost: 0.4262756, commit: null },
  ];
  for (const r of rows) {
    db.prepare(
      `INSERT INTO sub_task_attempts (id, session_id, sub_task_id, cycle, seq, attempt, status,
         cost_usd, base_sha, commit_sha, commit_shas, files_touched, summary, started_at, ended_at)
       VALUES (?, 'S1', 'st3', 1, 3, ?, ?, ?, NULL, ?, ?, '[]', NULL, NULL, 0)`,
    ).run(`S1:1:3:${r.attempt}`, r.attempt, r.status, r.cost, r.commit, JSON.stringify(r.commit ? [r.commit] : []));
  }

  // What the mutable row would have told you, and what is actually true.
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS attempts, SUM(cost_usd) AS total,
              SUM(CASE WHEN commit_sha IS NOT NULL THEN 1 ELSE 0 END) AS committing
         FROM sub_task_attempts WHERE session_id = 'S1' AND cycle = 1 AND seq = 3`,
    )
    .get();
  assert.equal(agg.attempts, 3);
  assert.ok(Math.abs(agg.total - 1.1525512) < 1e-9, `cost is the sum of attempts, got ${agg.total}`);
  assert.equal(agg.committing, 1, "the sub-task DID commit, even though its final row says otherwise");

  // Append-only: re-recording attempt 2 must not be able to overwrite it.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO sub_task_attempts (id, session_id, cycle, seq, attempt, status, cost_usd, ended_at)
           VALUES ('S1:1:3:2','S1',1,3,2,'rewritten',0,0)`,
        )
        .run(),
    /UNIQUE|PRIMARY KEY|constraint/i,
  );
});

test("rc.10: recording history never breaks a run", { skip }, async () => {
  // The table is for reporting. A run must not die because a row could not be
  // written, so the recorder swallows and logs -- asserted here because the
  // failure it prevents would only ever show up in production.
  const src = readFileSync(new URL("../src/orchestrator/legacy-loop.ts", import.meta.url), "utf8");
  const i = src.indexOf("private recordSubTaskAttempt");
  assert.ok(i > 0, "the recorder exists");
  const body = src.slice(i, src.indexOf("private priorAttemptCommits"));
  assert.match(body, /catch \(err\)/, "the insert is wrapped");
  assert.match(body, /logger\.warn/, "and the failure is at least reported");
});

const { readFileSync } = await import("node:fs");
