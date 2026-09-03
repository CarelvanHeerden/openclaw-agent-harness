// beta.123 — the layer the suite did not have.
//
// 1808 test cases, 157 files, and four of them asserted what a RUN terminates
// as. Everything else checked that a function decided correctly in isolation,
// or grepped a source file to confirm a call site exists. So every defect that
// reached a smoke test since b118 was of one species: correct components,
// wrong composition.
//
//   b119 take-2  the abort probe was right; the caller collapsed its throw
//                into "no commits" and deleted 27 commits.
//   b121         the slug logic was right; the pinning sat one layer too low.
//   b122         the basename rescue and the auto-resolve both decided
//                perfectly, marked the sub-task complete -- and left the cycle
//                failure flag standing, so the run died anyway. Both had been
//                doing that since the day they shipped, under 33 green tests.
//
// None of those are visible to a unit test, by construction. What finds them is
// running the real orchestrator and asking what came out the other end.
//
// So: real OrchestratorLoop, real GitAdapter against a real bare repo on disk,
// real verification probes (b123 lifted them out of index.ts for exactly this),
// real state machine, real SQLite. Fakes ONLY at the edges the harness cannot
// own in a test -- the model calls (lead, worker, adversary) and the GitHub API
// (push/PR). A scripted worker really does write files and really does commit
// them, so verification is answering questions about a genuine git history.
//
// The default scenario SHIPS. Each test perturbs one thing and asserts what
// that does to the outcome.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..", "..");

export const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
export const IDENT = { name: "Harness Test", email: "harness@test.local" };

export const git = (args, cwd) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const worlds = [];
test.after(() => {
  for (const d of worlds) rmSync(d, { recursive: true, force: true });
});

/** Is the build present? Every scenario suite skips cleanly without it. */
export async function scenarioAvailable() {
  try {
    await import("../../dist/orchestrator/loop.js");
    await import("../../dist/orchestrator/verify-probes.js");
    return true;
  } catch {
    return false;
  }
}

/**
 * A repo on disk: bare origin, a seeded main, and a bare mirror under the
 * worktree root where GitAdapter expects to find it.
 *
 * `files` seeds the initial commit. Shape it like the repo under test when a
 * scenario depends on the layout -- the b122 fixture needs a tests directory
 * that really exists, because the rename it replays is a real `git mv`.
 */
export async function makeWorld({ files } = {}) {
  const { GitAdapter } = await import("../../dist/adapters/git-worktree.js");
  const base = mkdtempSync(join(tmpdir(), "scenario-"));
  worlds.push(base);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const worktreesRoot = join(base, "wt");
  git(["init", "--bare", "-b", "main", origin]);
  mkdirSync(seed, { recursive: true });
  git(["init", "-b", "main"], seed);
  git(["config", "user.name", IDENT.name], seed);
  git(["config", "user.email", IDENT.email], seed);
  const seeded = files ?? { "README.md": "# seed\n" };
  for (const [rel, content] of Object.entries(seeded)) {
    mkdirSync(dirname(join(seed, rel)), { recursive: true });
    writeFileSync(join(seed, rel), content);
  }
  git(["add", "-A"], seed);
  git(["commit", "-m", "initial"], seed);
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-u", "origin", "main"], seed);
  const bare = join(worktreesRoot, ".repos", "o", "r.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(["clone", "--bare", origin, bare]);
  return {
    base,
    origin,
    bare,
    worktreesRoot,
    adapter: new GitAdapter({ worktreesRoot, logger: QUIET, bootstrapDeps: false }),
  };
}

export function makeConfig(over = {}) {
  const cfg = {
    slack: {
      channel: "C1",
      authorised_users: ["U1"],
      reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" },
    },
    budgets: {
      monthly_per_user_usd: 1000,
      session_default_usd: 50,
      session_hard_ceiling_usd: 200,
      daily_warn_usd: 100,
      daily_max_usd: 500,
      monthly_warn_ratio: 0.8,
    },
    repos: {
      allowed: ["o/*"],
      can_create: false,
      create_org: "",
      create_visibility: "private",
      default_base_branch: "main",
    },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: {
      max_cycles: 2,
      adversarial_pass_ends_early: true,
      worker_timeout_seconds: 60,
      adversary_timeout_seconds: 60,
      lead_timeout_seconds: 60,
      session_hard_timeout_seconds: 3600,
      subtask_deadline_seconds: 120,
      // beta.130: the production default is 300s of polling for an operator
      // who, in a scenario test, is never going to reply. Every other timeout
      // here is already scaled down to test time; this one was missed, and it
      // did not matter until b130 taught the CI gate to ask as well. Then any
      // mutation that nudged a run onto the ask stopped FAILING and started
      // HANGING for five minutes -- eleven of them, which is how a 7-minute
      // CI step became a 90-minute one. Tests that exercise the ask set their
      // own value; this is only the floor for tests that never meant to.
      time_extension_wait_seconds: 2,
    },
    storage: {
      state_db_path: ":memory:",
      worktree_root: "/tmp/wt",
      audit_retention_days: 90,
      prune_terminal_sessions: 365,
    },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: {
      worker_permission_mode: "acceptEdits",
      bash_whitelist: ["git"],
      bash_denylist_tokens: ["rm"],
      path_denylist: [".env"],
    },
  };
  // Shallow-merge one level down so a caller can override a single loop key.
  for (const [k, v] of Object.entries(over)) {
    cfg[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...cfg[k], ...v } : v;
  }
  return cfg;
}

/** An in-memory state store with the real schema and a recording audit log. */
export async function makeState() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(root, "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?,?,?,?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload ?? {}), Date.now());
    },
  };
  return { db, state, audits };
}

/**
 * A mutate sub-task with an EXPLICIT contract.
 *
 * `verify` overrides the regex inference in verify-contract.ts, so a scenario
 * states exactly what it wants checked instead of depending on how a title
 * happens to read. Getting this wrong is silent: an empty contract means no
 * verification runs at all and the scenario ships no matter what the worker
 * did, which is a green test that proves nothing.
 */
export function mutateSubTask({ seq = 1, title = "do a thing", path, intent = "i", extra = {} } = {}) {
  return {
    seq,
    title,
    intent,
    filesLikelyTouched: path ? [path] : [],
    successCriteria: [`${path} is committed`],
    verify: path ? [{ kind: "commit_made" }, { kind: "file_committed", path }] : [{ kind: "commit_made" }],
    estimatedTokens: 10,
    taskMode: "mutate",
    ...extra,
  };
}

/**
 * The default worker: writes each of the sub-task's declared paths and commits
 * them. Enough for verification to have something true to find.
 */
export function defaultWorker({ adapter }) {
  return async ({ subTask, worktreePath, plan }) => {
    const wt = worktreePath ?? plan.worktreePath;
    const written = [];
    for (const rel of subTask.filesLikelyTouched ?? []) {
      const abs = join(wt, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `// ${subTask.title}\nexport const x${subTask.seq} = ${subTask.seq};\n`);
      written.push(rel);
    }
    const commitSha = written.length ? await adapter.commit(wt, `feat(${subTask.seq}): ${subTask.title}`, IDENT) : undefined;
    return {
      status: "completed",
      filesChanged: written,
      commitSha,
      commitShas: commitSha ? [commitSha] : [],
      costUsd: 0.01,
      tokensIn: 10,
      tokensOut: 10,
      reason: "end_turn",
      finalMessage: "done",
    };
  };
}

/**
 * Build and run a scenario.
 *
 * Everything is overridable, and every default is the boring success case, so
 * a test reads as "the happy path, except X" and the assertion is about the
 * run's terminal status rather than a row somewhere.
 */
export async function runScenario(opts = {}) {
  const { OrchestratorLoop } = await import("../../dist/orchestrator/loop.js");
  const { BudgetEnforcer } = await import("../../dist/budgets/enforcer.js");
  const { PatRouter } = await import("../../dist/auth/pat-router.js");
  const { createVerifyProbes } = await import("../../dist/orchestrator/verify-probes.js");

  const world = opts.world ?? (await makeWorld({ files: opts.seedFiles }));
  const cfg = opts.config ?? makeConfig(opts.configOver ?? {});
  const { db, state, audits } = opts.stateBundle ?? (await makeState());
  const sessionId = opts.sessionId ?? "S1";
  const branch = opts.branch ?? "harness/feat-x";

  const brief = opts.brief ?? {
    title: "t",
    motivation: "m",
    acceptanceCriteria: ["a"],
    filesLikelyTouched: [],
    outOfScope: [],
    riskLevel: "low",
  };

  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, crystallised_prompt)
     VALUES (?, 'T1','C1','U1','u1','o/r',?,'', 'crystallising', ?, ?, ?, 0, 0, ?)`,
  ).run(sessionId, branch, now, now, opts.budgetUsd ?? 50, JSON.stringify(brief));
  if (opts.seedSession) opts.seedSession({ db, state, world });

  const subTasks = opts.subTasks ?? [mutateSubTask({ seq: 1, title: "add a thing", path: "src/thing.ts" })];

  let worktree = "";
  const allocate = async () => {
    git(["remote", "set-url", "origin", world.origin], world.bare);
    worktree = await world.adapter.allocate({
      repoFullName: "o/r",
      baseBranch: "main",
      sessionBranch: branch,
      sessionId,
      ghToken: "",
      commitIdentity: IDENT,
      ...(opts.allocateExtra ?? {}),
    });
    return worktree;
  };

  const pat = new PatRouter(cfg.pat_routing);
  const realProbes = createVerifyProbes({
    git: world.adapter,
    pat,
    config: cfg,
    resolveGitToken: async () => "",
  });

  const calls = { lead: 0, worker: 0, adversary: 0, push: 0 };
  const workerImpl = opts.worker ?? defaultWorker({ adapter: world.adapter });

  const deps = {
    config: cfg,
    state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat,
    logger: opts.logger ?? QUIET,
    runLead: opts.runLead ?? (async () => {
      calls.lead++;
      const wt = await allocate();
      // beta.127 (#157): `leadCostUsd` / `scoutCostUsd` let a scenario express a
      // planner that costs money. Default 0, so every existing scenario is
      // unchanged. `actualCostUsd` is planning + scout, matching what
      // runLeadPlanner computes -- the real spend, as opposed to
      // `approxCostUsd`, which is a forecast of what the plan will cost to
      // EXECUTE and was easy to mistake for the same thing.
      const scoutCostUsd = opts.scoutCostUsd ?? 0;
      const leadCostUsd = opts.leadCostUsd ?? 0;
      return {
        repo: "o/r",
        branch,
        worktreePath: wt,
        reviewChecklist: [],
        riskLevel: "low",
        approxCostUsd: 0,
        actualCostUsd: leadCostUsd + scoutCostUsd,
        ...(scoutCostUsd ? { scout: { ran: true, reportChars: 128, costUsd: scoutCostUsd } } : {}),
        subTasks,
      };
    }),
    runWorker: async (params) => {
      calls.worker++;
      return workerImpl(params, { world, calls });
    },
    runAdversary: opts.runAdversary ?? (async () => ({
      verdict: "pass",
      findings: [],
      summary: "looks good",
      costUsd: 0.01,
      tokensIn: 1,
      tokensOut: 1,
    })),
    pushBranchAndOpenPr: opts.pushBranchAndOpenPr ?? (async () => {
      calls.push++;
      return "https://github.com/o/r/pull/1";
    }),
    readReactions: opts.readReactions ?? (async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false })),
    // The REAL probes, against the REAL repo. This is the point of the harness:
    // a stub here would let the test decide the answer verification should be
    // discovering, which is how b122 shipped a probe that could not read a
    // rename.
    buildVerifyProbes: opts.buildVerifyProbes ?? ((args) => realProbes({ ...args, plan: { ...args.plan, repo: "o/r" } })),
    releaseWorktree: opts.releaseWorktree ?? (async () => ({ ok: true, path: worktree })),
    worktreeHeadSha: opts.worktreeHeadSha ?? (async (p) => git(["rev-parse", "HEAD"], p)),
    worktreeMergeBase: async (p) => git(["merge-base", "HEAD", "origin/main"], p),
    unreachableCommits: async (p, from, shas) => world.adapter.unreachableCommits(p, from, shas),
    listRepoFiles: async (p) => world.adapter.listTrackedFiles(p),
    worktreeCommittedFiles: async (p, base) => world.adapter.listCommittedFiles(p, base),
    ...(opts.deps ?? {}),
  };

  const loop = new OrchestratorLoop(deps);
  const out = await loop.run(sessionId, brief);

  const events = (name) => audits.filter((a) => a.event === name);
  const sawEvent = (name) => events(name).length > 0;
  const session = () => db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  const subTaskRows = () =>
    db.prepare(`SELECT seq, cycle, status, summary, commit_sha FROM sub_tasks WHERE session_id = ? ORDER BY cycle, seq`).all(sessionId);

  return { out, audits, events, sawEvent, session, subTaskRows, db, state, world, calls, worktree: () => worktree, branch };
}
