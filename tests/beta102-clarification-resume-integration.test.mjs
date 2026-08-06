// beta.102 — END-TO-END clarification pause -> resume, with REAL git.
//
// WHY THIS EXISTS. b101 fixed the defect that destroyed six worker commits in
// the b100 smoke, and shipped real-git tests proving `worktree add -B` orphans
// commits and that `preserveLocalBranch` prevents it. But those tests exercised
// the GIT LAYER only. The layer where the b100 bug actually lived --
// harness_answer -> full re-plan -> fresh allocation -> branch reset -- was
// verified by READING the code, not by running it.
//
// That is the same gap that produced the bug: three separate comments and the
// CHANGELOG all asserted the resume "continues in place" while the code
// force-removed the worktree and reset the branch. Nobody was lying; nobody had
// executed the path.
//
// So this drives the WHOLE chain for real:
//   real OrchestratorLoop -> real sqlite state -> real GitAdapter on a local
//   remote -> real harness_answer tool -> real re-plan -> real re-allocation.
// Only the three LLM turns (lead, worker, adversary) are stubbed, and the
// stubbed worker does genuine `git commit`s through the real adapter, because
// commits are the thing under test.
//
// The load-bearing assertion is a single line: after the resume, the commits
// made BEFORE the pause must still be reachable. In b100 they were not.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
const { BudgetEnforcer } = await import("../dist/budgets/enforcer.js");
const { PatRouter } = await import("../dist/auth/pat-router.js");
const { registerHarnessTools } = await import("../dist/tools/registration.js");
const { DatabaseSync } = await import("node:sqlite");

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const IDENT = { name: "Harness Test", email: "harness@test.local" };
// beta.103: `-c commit.gpgsign=false` keeps this hermetic. Without it the test
// inherits the developer's global git config, and a machine that signs commits
// fails here for reasons that have nothing to do with the harness (a local run
// hit `gpg: signing failed: Cannot allocate memory` mid-suite).
const git = (args, cwd) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

// The b100 shape: the plan names a file in a directory the repo does not have,
// and the worker correctly puts the work where the convention actually lives.
const FICTIONAL = "src/components/layout/grc-nav.tsx";
const REAL = "src/components/ui/sidebar.tsx";

const tmpRoots = [];
test.after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function makeWorld() {
  const base = mkdtempSync(join(tmpdir(), "oah-e2e-"));
  tmpRoots.push(base);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const worktreesRoot = join(base, "wt");

  git(["init", "--bare", "-b", "main", origin]);
  mkdirSync(seed, { recursive: true });
  git(["init", "-b", "main"], seed);
  git(["config", "user.name", IDENT.name], seed);
  git(["config", "user.email", IDENT.email], seed);
  mkdirSync(join(seed, "src/components/ui"), { recursive: true });
  writeFileSync(join(seed, "src/components/ui/sidebar.tsx"), "export const Sidebar = () => null;\n");
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "-A"], seed);
  git(["commit", "-m", "initial"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-u", "origin", "main"], seed);

  const bare = join(worktreesRoot, ".repos", "o", "r.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(["clone", "--bare", origin, bare]);

  const adapter = new GitAdapter({ worktreesRoot, logger: QUIET, bootstrapDeps: false });
  return { base, origin, seed, worktreesRoot, bare, adapter };
}

/**
 * Mirrors index.ts's allocateWorktree closure, including the one line under
 * test there: `preserveLocalBranch: !!brief.resumeFromClarification`. (That the
 * real index.ts contains that line is asserted separately in the b101 suite;
 * here we need an allocator we can drive against a local remote.)
 */
function allocate(w, brief) {
  git(["remote", "set-url", "origin", w.origin], w.bare); // see b101 suite: allocate() repoints it
  return w.adapter.allocate({
    repoFullName: "o/r",
    baseBranch: "main",
    sessionBranch: "harness/feat-x",
    sessionId: `pending-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    ghToken: "",
    commitIdentity: IDENT,
    preserveLocalBranch: !!brief.resumeFromClarification,
  });
}

function config() {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: { max_cycles: 2, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, lead_timeout_seconds: 60, session_hard_timeout_seconds: 3600 },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
  };
}

function makeStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  const audits = [];
  return {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    audits,
  };
}

const BRIEF = {
  title: "continuity module",
  motivation: "m",
  acceptanceCriteria: ["ship the continuity module"],
  filesLikelyTouched: [],
  outOfScope: [],
  riskLevel: "low",
};

function insertSession(db, id) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, crystallised_prompt)
     VALUES (?, 'T1', 'C1', 'U1', 'u1', 'o/r', 'harness/feat-x', '', 'crystallising', ?, ?, 50, 0, 0, ?)`,
  ).run(id, now, now, JSON.stringify(BRIEF));
}

/** Probes that read the REAL worktree, so a mismatch fails for the real reason. */
function realProbes(getWorktree) {
  return () => ({
    remoteBranchExists: async () => ({ exists: false, detail: "" }),
    prUrlPresent: async () => ({ present: false, detail: "" }),
    fileWrittenSince: async (p) => ({ written: existsSync(join(getWorktree(), p)), detail: "" }),
    fileExistsOnDisk: async (p) => {
      const full = join(getWorktree(), p);
      const ok = existsSync(full);
      return { exists: ok, nonEmpty: ok, detail: ok ? "file present" : "no file matching contract path" };
    },
    commitMadeSince: async (baseSha) => {
      const head = git(["rev-parse", "HEAD"], getWorktree());
      return { made: head !== baseSha, detail: `HEAD ${head.slice(0, 7)} != base ${String(baseSha).slice(0, 7)}` };
    },
    fileCommittedSince: async (p, baseSha) => {
      const out = git(["log", `${baseSha}..HEAD`, "--name-only", "--pretty=format:"], getWorktree());
      const hit = out.split("\n").map((s) => s.trim()).includes(p);
      return { committed: hit, detail: hit ? "committed" : "not in range", diffLines: hit ? 5 : 0 };
    },
  });
}

/**
 * Drive a full run: cycle 1 mismatches on seq 2 and pauses; the real
 * harness_answer then resumes into a re-plan.
 */
async function runScenario(opts = {}) {
  const w = makeWorld();
  const state = makeStore();
  const cfg = config();
  insertSession(state.db, "S1");

  let worktree = "";
  const allocations = [];
  let leadCalls = 0;
  const preCommits = [];

  const loop = new OrchestratorLoop({
    config: cfg,
    state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat: new PatRouter(cfg.pat_routing),
    logger: QUIET,
    runLead: async (brief) => {
      leadCalls++;
      // `breakResume` simulates a FUTURE regression (or an as-yet-unknown code
      // path) that loses the branch, so we can prove the ledger guard is a real
      // backstop and not just decoration.
      worktree = await allocate(w, opts.breakResume ? {} : brief);
      allocations.push({ path: worktree, resume: !!brief.resumeFromClarification });
      const subTasks =
        leadCalls === 1
          ? [
              // Contract matches what the worker will do -> passes.
              { seq: 1, title: "zod schemas", intent: "add schemas", filesLikelyTouched: ["src/lib/schema.ts"],
                successCriteria: ["file written"], estimatedTokens: 100, taskMode: "mutate",
                verify: [{ kind: "file_written", path: "src/lib/schema.ts" }, { kind: "commit_made" }] },
              // The b100 shape: contract names the FICTIONAL path -> mismatch.
              { seq: 2, title: "sidebar nav entry", intent: "add nav entry", filesLikelyTouched: [FICTIONAL],
                successCriteria: ["nav entry added"], estimatedTokens: 100, taskMode: "mutate",
                verify: [{ kind: "file_written", path: FICTIONAL }, { kind: "commit_made" }] },
            ]
          : [
              // b100's real re-plan produced a single read-only audit sub-task.
              { seq: 1, title: "audit", intent: "verify the module", filesLikelyTouched: [],
                successCriteria: ["audited"], estimatedTokens: 100, taskMode: "observe" },
            ];
      return { repo: "o/r", branch: "harness/feat-x", worktreePath: worktree, subTasks, reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    },
    runWorker: async ({ subTask }) => {
      if (subTask.taskMode === "observe") {
        return { status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "audited" };
      }
      // A real commit through the real adapter.
      const file = subTask.seq === 1 ? "src/lib/schema.ts" : REAL;
      mkdirSync(dirname(join(worktree, file)), { recursive: true });
      writeFileSync(join(worktree, file), `// ${subTask.title}\nexport const x = ${subTask.seq};\n`);
      const sha = await w.adapter.commit(worktree, `harness(${subTask.seq}): ${subTask.title}`, IDENT);
      preCommits.push(sha);
      return {
        status: "completed", filesChanged: [file], commitSha: sha,
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn",
        // Verbatim b100 shape: a misleading first line, the real reason lower.
        finalMessage: subTask.seq === 2
          ? [
              "That's fine, it's a harmless temp file outside the repo. Sub-task complete.",
              "",
              `I could not use ${FICTIONAL} because that directory does not exist;`,
              `the GRC nav lives in ${REAL}, so I added the entry there.`,
            ].join("\n")
          : "done",
      };
    },
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    buildVerifyProbes: realProbes(() => worktree),
    releaseWorktree: async () => ({ ok: true, path: worktree }),
    worktreeHeadSha: async (p) => git(["rev-parse", "HEAD"], p),
    worktreeMergeBase: async (p) => git(["merge-base", "HEAD", "origin/main"], p),
    unreachableCommits: async (p, from, shas) => w.adapter.unreachableCommits(p, from, shas),
    listRepoFiles: async (p) => w.adapter.listTrackedFiles(p),
  });

  const first = await loop.run("S1", BRIEF);

  // --- the real harness_answer tool, on the real runtime ---
  let resumePromise = null;
  const runtime = {
    state,
    config: cfg,
    loop: { run: (...a) => (resumePromise = loop.run(...a)) },
  };
  const tools = new Map();
  registerHarnessTools(
    { logger: QUIET, registerTool: (def) => { tools.set(def.name, { ...def, execute: (i) => def.execute("cid", i) }); return () => {}; } },
    runtime,
  );

  return { w, state, loop, first, allocations, preCommits, tools,
    answer: async (text) => {
      const res = await tools.get("harness_answer").execute({ sessionId: "S1", answer: text, invokedBy: "U1" });
      if (resumePromise) await resumePromise;
      return res;
    } };
}

// --- 1. the pause itself -----------------------------------------------------

test("beta102: a real committed mismatch pauses the run in awaiting_clarification", async () => {
  const s = await runScenario();
  assert.equal(s.first.status, "awaiting_clarification", `got ${s.first.status}`);
  const row = s.state.db.prepare(`SELECT status, clarification_question, clarification_seq, worktree_path FROM sessions WHERE id='S1'`).get();
  assert.equal(row.status, "awaiting_clarification");
  assert.equal(row.clarification_seq, 2);
  // b111 reworded this question (see contract-clarify.ts). What matters here is
  // unchanged: the stored question describes the mismatch and names the file.
  assert.match(row.clarification_question, /did not change\s+everything the plan expected/);
  assert.match(row.clarification_question, /grc-nav\.tsx/);
});

test("beta102: the paused sub-task stays failed_verification -- nothing is accepted", async () => {
  const s = await runScenario();
  const st = s.state.db.prepare(`SELECT status, commit_sha FROM sub_tasks WHERE session_id='S1' AND seq=2`).get();
  assert.equal(st.status, "failed_verification");
  assert.ok(st.commit_sha, "the real commit is still recorded on the ledger");
});

test("beta102: the operator is shown the REAL reason, not the misleading first line", async () => {
  const s = await runScenario();
  const q = s.state.db.prepare(`SELECT clarification_question FROM sessions WHERE id='S1'`).get().clarification_question;
  assert.doesNotMatch(q, /harmless temp file/, "the b100 regression");
  assert.match(q, /that directory does not exist/);
});

// --- 2. THE LOAD-BEARING TEST ------------------------------------------------

test("beta102: resuming through harness_answer PRESERVES the pre-pause commits", async () => {
  const s = await runScenario();
  const branchBefore = git(["rev-parse", "refs/heads/harness/feat-x"], s.w.bare);
  assert.equal(s.preCommits.length, 2, "two real commits landed before the pause");
  assert.equal(branchBefore, s.preCommits[1], "branch is at the second commit");

  await s.answer("The plan path was wrong; the worker's placement is correct. Accept it and proceed.");

  // A re-plan DOES allocate a new worktree -- that is expected and unchanged.
  assert.equal(s.allocations.length, 2, "the resume re-planned and re-allocated");
  assert.notEqual(s.allocations[0].path, s.allocations[1].path, "a genuinely new worktree");
  assert.equal(s.allocations[1].resume, true, "allocation was told this is a clarification resume");

  // THE ASSERTION. In b100 every one of these commits was orphaned here.
  const wt2 = s.allocations[1].path;
  for (const sha of s.preCommits) {
    git(["merge-base", "--is-ancestor", sha, "HEAD"], wt2); // throws if unreachable
  }
  assert.ok(existsSync(join(wt2, "src/lib/schema.ts")), "seq-1's file survived the resume");
  assert.ok(existsSync(join(wt2, REAL)), "seq-2's file survived the resume");
  assert.equal(
    git(["rev-parse", "refs/heads/harness/feat-x"], s.w.bare), s.preCommits[1],
    "the branch ref never moved backwards",
  );
});

test("beta102: the run reaches a terminal state after the resume (no dead end)", async () => {
  const s = await runScenario();
  await s.answer("Accept the placement and proceed.");
  const row = s.state.db.prepare(`SELECT status FROM sessions WHERE id='S1'`).get();
  assert.ok(["done", "failed", "shipped"].includes(row.status), `unexpected terminal status ${row.status}`);
});

// --- 3. the guard that would have caught b100 --------------------------------

test("beta102: the ledger reachability guard runs and reports the commits intact", async () => {
  const s = await runScenario();
  await s.answer("Accept the placement and proceed.");
  const checked = s.state.audits.filter((a) => a.event === "loop.ledger_reachability_checked");
  assert.ok(checked.length >= 1, "the guard must run on review -- this is the proof-of-life signal");
  for (const c of checked) assert.equal(c.payload.ok, true, "no commit may be unreachable after a correct resume");
  assert.equal(
    s.state.audits.filter((a) => a.event === "loop.ledger_commits_unreachable").length, 0,
    "nothing was orphaned",
  );
});

test("beta102: no rescue ref is needed on a correct resume", async () => {
  const s = await runScenario();
  await s.answer("Accept the placement and proceed.");
  // A rescue ref here would mean something still tried to reset the branch.
  assert.equal(git(["for-each-ref", "--format=%(refname)", "refs/harness-rescue/"], s.w.bare), "");
});

// --- 4. the backstop: if the branch DOES lose work, nothing ships ------------

test("beta102: when a resume orphans commits anyway, the guard fails the run and blocks the PR", async () => {
  // Defence in depth. Fix 1 prevents the known cause; this proves that if some
  // other path ever loses commits, the run stops instead of reviewing and
  // shipping a diff missing the work -- which is precisely what b100 did.
  const s = await runScenario({ breakResume: true });
  await s.answer("Accept the placement and proceed.");

  const unreachable = s.state.audits.filter((a) => a.event === "loop.ledger_commits_unreachable");
  assert.equal(unreachable.length, 1, "the guard must fire when the ledger cannot be reached from HEAD");
  assert.equal(unreachable[0].payload.unreachable.length, 2, "both orphaned commits named");

  const row = s.state.db.prepare(`SELECT status, final_pr_url FROM sessions WHERE id='S1'`).get();
  assert.equal(row.status, "failed", "must fail rather than ship an incomplete branch");
  assert.ok(!row.final_pr_url, "no PR may be opened");

  // And the b101 net kept the work recoverable rather than destroying it.
  const rescue = git(["for-each-ref", "--format=%(refname)", "refs/harness-rescue/"], s.w.bare).split("\n").filter(Boolean);
  assert.equal(rescue.length, 1, "the orphaned tip was parked");
  assert.equal(git(["rev-parse", rescue[0]], s.w.bare), s.preCommits[1]);
});

// --- 5. the ledger must survive a re-plan clobbering sub_tasks rows ----------

test("beta102: a clarification re-plan CLOBBERS a sub_tasks row's commit_sha", async () => {
  // Documents the defect that motivated the audit-log union. sub_tasks ids are
  // `<session>-c<cycle>-s<seq>` written with INSERT OR REPLACE, and the resume
  // re-plans from cycle 1 -- so the new plan's seq 1 overwrites the original.
  const s = await runScenario();
  const before = s.state.db.prepare(`SELECT commit_sha FROM sub_tasks WHERE id='S1-c1-s1'`).get();
  assert.ok(before.commit_sha, "seq 1 recorded its commit before the pause");

  await s.answer("Accept the placement and proceed.");

  const after = s.state.db.prepare(`SELECT commit_sha, description FROM sub_tasks WHERE id='S1-c1-s1'`).get();
  assert.equal(after.description, "audit", "the row now belongs to the RE-PLAN's sub-task");
  assert.ok(!after.commit_sha, "and the original commit_sha is gone -- sub_tasks alone is not a reliable ledger");
});

test("beta102: the append-only audit log still holds every commit after the re-plan", async () => {
  const s = await runScenario();
  await s.answer("Accept the placement and proceed.");
  const shas = s.state.audits
    .filter((a) => a.event === "loop.worker_end_turn" && a.payload.commitSha)
    .map((a) => a.payload.commitSha);
  for (const sha of s.preCommits) {
    assert.ok(shas.includes(sha), `commit ${sha.slice(0, 7)} survives in the audit log`);
  }
});

test("beta102: mergeLedgerCommits de-duplicates and prefers the richer source", async () => {
  const { mergeLedgerCommits } = await import("../dist/orchestrator/ledger-integrity.js");
  const merged = mergeLedgerCommits(
    [{ seq: 1, commitSha: "AAA111", title: "from sub_tasks" }],
    [{ seq: 1, commitSha: "aaa111" }, { seq: 2, commitSha: "bbb222" }],
  );
  assert.equal(merged.length, 2, "case-insensitive de-dupe");
  assert.equal(merged[0].title, "from sub_tasks", "first source wins");
  assert.equal(merged[1].commitSha, "bbb222", "the audit-only commit is still recovered");
});

test("beta102: mergeLedgerCommits drops blank and malformed entries", async () => {
  const { mergeLedgerCommits } = await import("../dist/orchestrator/ledger-integrity.js");
  assert.deepEqual(mergeLedgerCommits([{ seq: 1, commitSha: "" }, { seq: 2, commitSha: "  " }], []), []);
});

// --- 6. the b100 counterfactual ----------------------------------------------

test("beta102: WITHOUT the resume marker the commits are destroyed (b100 reproduced)", async () => {
  // Proves the test would actually FAIL if the fix regressed, rather than
  // passing for some incidental reason.
  const s = await runScenario();
  const before = git(["rev-parse", "refs/heads/harness/feat-x"], s.w.bare);
  const wt = await allocate(s.w, { /* no resumeFromClarification -- pre-b101 */ });
  const after = git(["rev-parse", "refs/heads/harness/feat-x"], s.w.bare);

  assert.notEqual(after, before, "the pre-b101 path resets the branch");
  assert.deepEqual(
    (await s.w.adapter.unreachableCommits(wt, "HEAD", s.preCommits)).sort(),
    [...s.preCommits].sort(),
    "both commits unreachable -- exactly the b100 outcome",
  );
  // ...and b101's net caught them anyway.
  const rescue = git(["for-each-ref", "--format=%(refname)", "refs/harness-rescue/"], s.w.bare).split("\n").filter(Boolean);
  assert.equal(rescue.length, 1, "the rescue ref saved the work");
  assert.equal(git(["rev-parse", rescue[0]], s.w.bare), before);
});
