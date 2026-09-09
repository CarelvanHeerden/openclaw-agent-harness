// rc.3 -- a dirty worktree is never "no change", and a commit message is never
// a shell command.
//
// StitchGuard PR #1168, session 51fd67cc, cycle 4: the workers edited files,
// their `git commit -m` carried a Markdown-fenced message, the bash guard read
// the backticks as command substitution and denied it -- correctly. What
// followed was not correct. The harness emitted `subtask_revise_no_change`,
// then `cycle_no_change_early_exit`, carried cycle 3's findings forward and
// terminated, over a worktree that still had the modifications in it.
//
// Two defects, one visible and one not:
//
//   1. `runWorker` gated its own commit on `gitListChangedFiles(base, HEAD)`.
//      That is `git diff --name-only <base> HEAD` -- a comparison of two
//      COMMITS, which cannot see the working tree at all. A worker that never
//      committed leaves base === HEAD, so the answer was empty and the harness
//      skipped the commit it exists to make. Read the other way round, the
//      harness only ever offered to commit when the worker had already
//      committed something itself.
//
//   2. Every "nothing changed" decision downstream -- the contract demotion to
//      `observe`, the `completed_no_change` downgrade, the cycle early exit,
//      and the abort-time salvage probe -- was a SHA comparison, and a SHA
//      comparison is blind to the same thing.
//
// The commit path itself was never the problem: `GitAdapter.commit` has always
// spawned git with an argv array and no shell. These tests pin that so it stays
// true, and cover the reconciliation and the gates that were missing.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");
const skipDist = { skip: existsSync(join(root, "dist", "orchestrator", "worker.js")) ? false : "dist not built" };

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const IDENT = { name: "Harness Test", email: "harness@test.local" };

const temps = [];
test.after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** A plain repo with one commit, plus a GitAdapter pointed at it. */
async function makeRepo() {
  const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
  const dir = mkdtempSync(join(tmpdir(), "rc3-dirty-"));
  temps.push(dir);
  const g = (args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", IDENT.email]);
  g(["config", "user.name", IDENT.name]);
  writeFileSync(join(dir, "README.md"), "# seed\n");
  // A tracked `src/` from the start: `git status --porcelain` collapses a
  // WHOLLY untracked directory to `src/`, and these tests are about which
  // files were nearly lost.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "seed.ts"), "export const seed = 1;\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return { dir, g, adapter: new GitAdapter({ worktreesRoot: dir, logger: QUIET, bootstrapDeps: false }) };
}

function write(dir, rel, body) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

// ---------------------------------------------------------------------------
// 26-28, 33. THE COMMIT MESSAGE IS DATA, NOT A COMMAND
// ---------------------------------------------------------------------------

test("26: a commit message full of backticks is committed verbatim", skipDist, async () => {
  const { dir, g, adapter } = await makeRepo();
  write(dir, "src/thing.ts", "export const x = 1;\n");
  const message = "fix(3): stop `parseInt` accepting `12abc`\n\nSee `src/lib/header.ts`.";
  const sha = await adapter.commit(dir, message, IDENT);
  assert.ok(sha, "the commit must actually happen");
  assert.equal(g(["log", "-1", "--pretty=%B"]).trim(), message.trim());
});

test("27: a multiline Markdown message with fences and lists survives intact", skipDist, async () => {
  const { dir, g, adapter } = await makeRepo();
  write(dir, "src/thing.ts", "export const x = 1;\n");
  const message = [
    "revise(2): dataset-wide Source Code filtering",
    "",
    "- move filtering from the client to the server",
    "- keep the manifest declarations",
    "",
    "```ts",
    "const rows = await prisma.$queryRaw`SELECT 1`;",
    "```",
  ].join("\n");
  await adapter.commit(dir, message, IDENT);
  assert.equal(g(["log", "-1", "--pretty=%B"]).trim(), message.trim());
});

test("28: quotes, semicolons and $(...) in a message are never evaluated", skipDist, async () => {
  const { dir, g, adapter } = await makeRepo();
  write(dir, "src/thing.ts", "export const x = 1;\n");
  const message = `chore: it's "done"; $(touch pwned) \`touch alsopwned\` && rm -rf . | tee /dev/null`;
  await adapter.commit(dir, message, IDENT);
  assert.equal(g(["log", "-1", "--pretty=%B"]).trim(), message.trim());
  assert.equal(existsSync(join(dir, "pwned")), false, "a shell ran the message");
  assert.equal(existsSync(join(dir, "alsopwned")), false, "a shell ran the message");
  assert.equal(existsSync(join(dir, "src", "thing.ts")), true, "`rm -rf .` in the message must be inert");
});

test("28b: the commit path spawns git with an argv array and never a shell", () => {
  const src = S("src/adapters/git-worktree.ts");
  assert.match(src, /spawn\("git", args, \{ env \}\)/, "argv, not a command string");
  assert.ok(!/shell:\s*true/.test(src), "a shell anywhere in the git adapter re-opens the whole class");
  assert.match(src, /"commit", "-m", message,/, "the message stays one argv element");
});

test("33: a genuine git failure keeps stdout and stderr", skipDist, async () => {
  const { dir, adapter } = await makeRepo();
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'hook stdout marker'\necho 'hook stderr marker' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  write(dir, "src/thing.ts", "export const x = 1;\n");
  const err = await adapter.commit(dir, "feat: blocked by a hook", IDENT).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "a rejecting hook must not look like a successful commit");
  // git routes hook stdout onto its own stderr, so both markers arrive there.
  // What matters is that BOTH streams are captured and handed up: the message
  // alone used to carry a trimmed stderr and nothing else.
  assert.equal(typeof err.stdout, "string");
  assert.match(err.stderr, /hook stdout marker/);
  assert.match(err.stderr, /hook stderr marker/);
  assert.equal(err.exitCode, 1);
  assert.match(S("src/adapters/git-worktree.ts"), /e\.stdout = redactSecrets\(out\.trim\(\), token\);/);
});

// ---------------------------------------------------------------------------
// 29, 31, 32. RECONCILING A WORKER TURN AGAINST REAL GIT
// ---------------------------------------------------------------------------

/**
 * Run the real `runWorker` over a real repo, with `act` standing in for the
 * model turn. Whatever `act` does to the worktree is what the reconciliation
 * has to make sense of.
 */
async function turn(repo, act, over = {}) {
  const { runWorker } = await import("../dist/orchestrator/worker.js");
  const { makeConfig } = await import("./helpers/scenario.mjs");
  const a = repo.adapter;
  return await runWorker(
    repo.dir,
    { title: "t", motivation: "m", acceptanceCriteria: ["a"] },
    { seq: 3, title: "declare the workflow routes", intent: "i", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 1 },
    IDENT,
    {
      config: makeConfig(),
      logger: QUIET,
      runWorkerModel: async () => {
        await act(repo);
        return { sdkSessionId: "sdk-1", stopReason: "end_turn", costUsd: 0, tokensIn: 1, tokensOut: 1, logsExcerpt: "" };
      },
      gitCommit: (wt, msg, id) => a.commit(wt, msg, id),
      gitListChangedFiles: (wt, base) => a.listChangedFiles(wt, base),
      gitBaseSha: (wt) => a.baseSha(wt),
      gitHeadSha: (wt) => a.baseSha(wt),
      gitListCommittedFiles: (wt, base) => a.listCommittedFiles(wt, base),
      gitStatusPorcelain: (wt) => a.statusPorcelain(wt),
      buildCanUseTool: () => async () => ({ allow: true }),
      ...over,
    },
  );
}

test("29: a worker whose commit was denied has its work committed by the harness", skipDist, async () => {
  const repo = await makeRepo();
  // Exactly the #1168 cycle-4 shape: the edits land, the worker's own
  // `git commit -m` is refused by the guard, so nothing is committed.
  const r = await turn(repo, ({ dir }) => {
    write(dir, "src/app/api/security/sast-sheet/route.ts", "export const GET = () => new Response('ok');\n");
    write(dir, "src/lib/manifest.ts", "export const manifest = [];\n");
  });

  assert.equal(r.commitReconciliation.state, "harness_commit");
  assert.ok(r.commitSha, "the whole point: the work is committed");
  assert.deepEqual(r.commitReconciliation.dirtyFiles, [], "and nothing is left behind");
  assert.deepEqual(
    r.filesChanged.sort(),
    ["src/app/api/security/sast-sheet/route.ts", "src/lib/manifest.ts"],
    "the ledger records what was committed, not an empty set",
  );
  assert.equal(repo.g(["rev-list", "--count", "HEAD"]), "2");
});

test("31: a worker that committed cleanly is not committed over a second time", skipDist, async () => {
  const repo = await makeRepo();
  const r = await turn(repo, ({ dir, g }) => {
    write(dir, "src/thing.ts", "export const x = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "feat: the worker's own commit"]);
  });

  assert.equal(r.commitReconciliation.state, "worker_commit");
  assert.equal(r.commitSha, repo.g(["rev-parse", "HEAD"]));
  assert.equal(repo.g(["rev-list", "--count", "HEAD"]), "2", "a redundant empty harness commit on top");
  assert.equal(repo.g(["log", "-1", "--pretty=%s"]), "feat: the worker's own commit");
  assert.deepEqual(r.filesChanged, ["src/thing.ts"]);
});

test("32: a worker commit plus a dirty remainder keeps both", skipDist, async () => {
  const repo = await makeRepo();
  const r = await turn(repo, ({ dir, g }) => {
    write(dir, "src/first.ts", "export const a = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "feat: half of it"]);
    write(dir, "src/second.ts", "export const b = 2;\n");
  });

  assert.equal(r.commitReconciliation.state, "worker_commit_remainder");
  assert.equal(repo.g(["rev-list", "--count", "HEAD"]), "3", "the worker's commit and the remainder");
  assert.equal(r.commitSha, repo.g(["rev-parse", "HEAD"]), "commitSha is the final tip");
  assert.equal(r.commitShas.length, 2, "b103: both tips reach the ledger or the guard cannot check reachability");
  assert.ok(r.commitShas.includes(r.commitReconciliation.workerCommitSha));
  assert.deepEqual(r.filesChanged.sort(), ["src/first.ts", "src/second.ts"]);
});

test("a genuinely idle turn is still reported as no change", skipDist, async () => {
  const repo = await makeRepo();
  const r = await turn(repo, () => {});
  assert.equal(r.commitReconciliation.state, "no_change");
  assert.equal(r.commitSha, undefined);
  assert.deepEqual(r.filesChanged, []);
  assert.equal(r.uncommittedFiles, undefined);
  assert.equal(repo.g(["rev-list", "--count", "HEAD"]), "1", "nothing to commit, so nothing committed");
});

test("a commit the harness cannot make is a recoverable uncommitted_changes result", skipDist, async () => {
  const repo = await makeRepo();
  const r = await turn(
    repo,
    ({ dir }) => write(dir, "src/thing.ts", "export const x = 1;\n"),
    { gitCommit: async () => null },
  );
  assert.equal(r.commitReconciliation.state, "uncommitted_changes");
  assert.deepEqual(r.commitReconciliation.dirtyFiles, ["src/thing.ts"]);
  assert.deepEqual(r.uncommittedFiles, ["src/thing.ts"], "the files are on disk and the caller must be told");
});

test("33b: a git error fails the turn and carries git's own words up", skipDist, async () => {
  const repo = await makeRepo();
  const hook = join(repo.dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'lint failed in src/thing.ts' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const r = await turn(repo, ({ dir }) => write(dir, "src/thing.ts", "export const x = 1;\n"));

  assert.equal(r.commitReconciliation.state, "git_error");
  assert.equal(r.status, "failed", "a git failure is not a quiet zero-commit `completed`");
  assert.match(r.reason, /^git_error: /);
  assert.match(r.commitReconciliation.error, /lint failed in src\/thing\.ts/);
  assert.deepEqual(r.uncommittedFiles, ["src/thing.ts"], "and the work is still reported as present");
});

// ---------------------------------------------------------------------------
// 30. A DIRTY TREE CANNOT TAKE A NO-CHANGE EXIT
// ---------------------------------------------------------------------------

test("30: workerLeftUncommittedWork reads the tree, not the sha", skipDist, async () => {
  const { workerLeftUncommittedWork } = await import("../dist/orchestrator/loop.js");
  assert.equal(
    workerLeftUncommittedWork({ commitReconciliation: { state: "no_change", dirtyFiles: [] } }),
    false,
  );
  assert.equal(
    workerLeftUncommittedWork({ commitReconciliation: { state: "uncommitted_changes", dirtyFiles: ["src/a.ts"] } }),
    true,
  );
  // Pre-reconciliation results (and the scenario harness's scripted workers)
  // still carry the beta.53 list, and it means the same thing.
  assert.equal(workerLeftUncommittedWork({ uncommittedFiles: ["src/a.ts"] }), true);
  assert.equal(workerLeftUncommittedWork({}), false);
});

test("30b: all three no-change decisions consult the working tree", () => {
  const src = S("src/orchestrator/loop.ts");

  // (a) the contract demotion to `observe`
  assert.match(
    src,
    /cycle > 1 && st\.taskMode === "mutate" && !result\.commitSha && !workerDirty/,
    "a mutate sub-task with uncommitted edits has not correctly made no change",
  );
  // (b) the `completed_no_change` downgrade
  assert.match(
    src,
    /const workerMadeNoCommit = !result\.commitSha && !workerLeftUncommittedWork\(result\);/,
  );
  // (c) the cycle early exit
  assert.match(src, /dirtyNow\.length === 0 && !cycleResolvedContractWithoutCommit/);
  // and each refusal says so out loud
  assert.equal(
    src.split("loop.cycle_no_change_rejected_dirty").length - 1,
    3,
    "one refusal event per gate",
  );
});

test("35: the PR #1168 cycle-4 sequence cannot terminate as no change", skipDist, async (t) => {
  const helpers = await import("./helpers/scenario.mjs");
  if (!(await helpers.scenarioAvailable())) return t.skip("scenario helpers unavailable");
  const { runScenario, mutateSubTask, IDENT: ID } = helpers;

  // Cycle 1 commits. The adversary then asks for a revision, and on cycle 2 the
  // worker edits the files and its commit is denied -- so the branch tip has
  // not moved and the tree is dirty. That is the exact state in which #1168
  // took `cycle_no_change_early_exit`.
  let cycle = 0;
  const r = await runScenario({
    configOver: { loop: { ...helpers.makeConfig().loop, max_cycles: 2 } },
    subTasks: [mutateSubTask({ seq: 1, title: "declare the workflow routes", path: "src/manifest.ts" })],
    worker: async ({ subTask, worktreePath, plan }, { world }) => {
      cycle += 1;
      const wt = worktreePath ?? plan.worktreePath;
      const rel = subTask.filesLikelyTouched[0];
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), `// pass ${cycle}\nexport const x = ${cycle};\n`);
      if (cycle === 1) {
        const sha = await world.adapter.commit(wt, `feat(1): ${subTask.title}`, ID);
        return { status: "completed", filesChanged: [rel], commitSha: sha, commitShas: [sha], costUsd: 0, tokensIn: 1, tokensOut: 1, reason: "end_turn" };
      }
      // The guard denied `git commit -m` because the message had backticks in
      // it. The edit is real; nothing committed it.
      return {
        status: "completed",
        filesChanged: [],
        commitShas: [],
        uncommittedFiles: [rel],
        costUsd: 0,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        deniedToolCalls: [{ kind: "bash", title: "git commit -m ...", reason: "command substitution" }],
      };
    },
    runAdversary: async () => ({
      verdict: cycle >= 2 ? "pass" : "revise",
      findings:
        cycle >= 2
          ? []
          : [{ severity: "high", dimension: "correctness", title: "parseInt accepts trailing junk", detail: "d", files: ["src/manifest.ts"] }],
      summary: "s",
      costUsd: 0,
      tokensIn: 1,
      tokensOut: 1,
    }),
  });

  assert.ok(cycle >= 2, "the scenario has to actually reach the revise cycle");
  assert.equal(r.sawEvent("loop.cycle_no_change_early_exit"), false, "this is the #1168 termination");
  const rejected = r.events("loop.cycle_no_change_rejected_dirty");
  assert.ok(rejected.length > 0, "and the refusal has to be visible in the audit");
  assert.ok(
    rejected.some((e) => (e.payload.dirtyFiles ?? []).includes("src/manifest.ts")),
    "naming the file that would have been lost",
  );
  // The run fails, and that is the right answer -- the sub-task really did not
  // deliver a commit. What must not happen is the directory going with it.
  assert.equal(r.out.status, "failed");
  assert.equal(r.sawEvent("loop.worktree_released"), false, "#1168's edits were still on disk when the run let go of them");
  assert.ok(r.sawEvent("loop.failed_recoverable_work_detected"));
  assert.equal(r.session().worktree_preserved, 1);
});

test("34e: a failure with nothing to lose still releases the worktree", skipDist, async (t) => {
  const helpers = await import("./helpers/scenario.mjs");
  if (!(await helpers.scenarioAvailable())) return t.skip("scenario helpers unavailable");

  // The worker dies without touching anything: no commit, no files, a clean
  // tree, nothing to preserve.
  const r = await helpers.runScenario({
    worker: async () => ({
      status: "failed",
      filesChanged: [],
      commitShas: [],
      costUsd: 0,
      tokensIn: 1,
      tokensOut: 1,
      reason: "tool_error",
    }),
  });
  assert.equal(r.out.status, "failed");
  assert.equal(r.sawEvent("loop.failed_recoverable_work_detected"), false);
  assert.ok(r.sawEvent("loop.worktree_released"), "the guard has to stay narrow, or every failure leaks a directory");
});

// ---------------------------------------------------------------------------
// 34. WORK SURVIVES A FAILURE
// ---------------------------------------------------------------------------

async function loopOverWorktree(worktreePath, planBaseSha) {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const adapter = new GitAdapter({ worktreesRoot: worktreePath, logger: QUIET, bootstrapDeps: false });
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, plan_base_sha)
     VALUES ('S1','T','C','U1','u1','o/r','harness/x', ?, 'executing', ?, ?, 50, 0, 1, ?)`,
  ).run(worktreePath, now, now, planBaseSha);
  const loop = new OrchestratorLoop({
    state,
    logger: QUIET,
    config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    worktreeHeadSha: async (p) => adapter.baseSha(p),
    worktreeStatusPorcelain: async (p) => adapter.statusPorcelain(p),
  });
  return { loop, db, state, audits };
}

test("34: an abort over a dirty tree does not release the worktree", skipDist, async () => {
  const repo = await makeRepo();
  const head = repo.g(["rev-parse", "HEAD"]);
  write(repo.dir, "src/thing.ts", "export const x = 1;\n");
  const { loop, audits } = await loopOverWorktree(repo.dir, head);

  const salvageable = await loop.abortHasSalvageableCommits("S1", {
    repo: "o/r",
    branch: "harness/x",
    worktree_path: repo.dir,
    requester: "U1",
  });
  assert.equal(salvageable, true, "b120 asked only whether HEAD moved, and deleted the directory when it had not");
  assert.ok(audits.some((a) => a.event === "loop.abort_dirty_worktree_salvageable"));
});

test("34b: an abort over a clean, unmoved tree still releases it", skipDist, async () => {
  const repo = await makeRepo();
  const head = repo.g(["rev-parse", "HEAD"]);
  const { loop } = await loopOverWorktree(repo.dir, head);
  assert.equal(
    await loop.abortHasSalvageableCommits("S1", { repo: "o/r", branch: "harness/x", worktree_path: repo.dir, requester: "U1" }),
    false,
    "the guard has to stay narrow, or every abort leaks a directory",
  );
});

test("34c: preserving a worktree records where it is and what is in it", skipDist, async () => {
  const repo = await makeRepo();
  const head = repo.g(["rev-parse", "HEAD"]);
  write(repo.dir, "src/thing.ts", "export const x = 1;\n");
  const { loop, audits } = await loopOverWorktree(repo.dir, head);

  await loop.finaliseFailedPreserveWorktree("S1", "ledger_commits_unreachable", 3, 1.5);

  const preserved = audits.find((a) => a.event === "loop.failed_worktree_preserved");
  assert.ok(preserved, "the terminal event must still fire");
  assert.equal(preserved.payload.worktreePath, repo.dir);
  assert.equal(preserved.payload.headSha, head);
  assert.deepEqual(preserved.payload.dirtyFiles, ["src/thing.ts"], "'preserved' is not a recovery action without this");
  // rc.4: this used to assert only that the message mentioned `harness_resume`,
  // which was the bug -- harness_resume refuses the `failed` status this very
  // function sets. The message has to point somewhere that actually accepts it.
  assert.match(preserved.payload.recoveryAction, new RegExp(repo.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(preserved.payload.recoveryAction, /harness_resume will refuse/);
  assert.match(preserved.payload.recoveryAction, /harness_link_pr/, "no PR is recorded, so linking comes first");
  assert.match(preserved.payload.recoveryAction, /harness_revise/);
});

test("34d: an unreadable status probe never reads as a clean tree", skipDist, async () => {
  const repo = await makeRepo();
  const head = repo.g(["rev-parse", "HEAD"]);
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, plan_base_sha)
     VALUES ('S1','T','C','U1','u1','o/r','harness/x', ?, 'executing', ?, ?, 50, 0, 1, ?)`,
  ).run(repo.dir, now, now, head);
  const loop = new OrchestratorLoop({
    state,
    logger: QUIET,
    config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    worktreeHeadSha: async () => head,
    worktreeStatusPorcelain: async () => {
      throw new Error("fatal: not a git repository");
    },
  });

  assert.equal(
    await loop.abortHasSalvageableCommits("S1", { repo: "o/r", branch: "harness/x", worktree_path: repo.dir, requester: "U1" }),
    true,
    "beta.129 learned this on the HEAD probe: 'we could not ask' is not 'there is nothing there'",
  );
  assert.ok(audits.some((a) => a.event === "loop.worktree_status_probe_indeterminate"));
});

test("the porcelain adapter reports a git failure instead of an empty tree", skipDist, async () => {
  const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
  const dir = mkdtempSync(join(tmpdir(), "rc3-norepo-"));
  temps.push(dir);
  const adapter = new GitAdapter({ worktreesRoot: dir, logger: QUIET, bootstrapDeps: false });
  await assert.rejects(() => adapter.statusPorcelain(join(dir, "nope")));
});
