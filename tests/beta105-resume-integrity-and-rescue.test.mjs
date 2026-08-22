// beta.105 — the four defects the b103 DR/BCP smoke (session b8ece861,
// ProjectThanos, branch harness/feat-grc-continuity-exercises) exposed. Every
// fixture below is real data from that run.
//
//   1. RESUME-TIME LEDGER GUARD. Eight of ten recorded commits stopped being
//      ancestors of the branch tip when a clarification resume re-allocated the
//      worktree. The b101 guard would have caught it instantly, but it only ran
//      before adversary review, and the run stalled at a second clarification
//      and was aborted -- so it never ran at all. Found four hours later by hand.
//   2. BRANCH-ALLOCATION OBSERVABILITY. Nothing durable said which of the three
//      checkout paths allocation took. `preserveLocalBranch` is a REQUEST that
//      falls through silently when no local branch of that name exists, so the
//      flag being set proved nothing about what happened.
//   3. BASENAME RESCUE. Seq 9 planned `src/components/layout/sidebar.tsx` and
//      committed `src/components/ui/sidebar.tsx`. No rederive fired at all,
//      because rederive only applies remaps EARLIER sub-tasks taught it and no
//      prior sub-task had touched `src/components/`. Escalated to a human; cost
//      an hour of dead time for a mechanically-obvious correction.
//   4. THE `git mv` CONTRADICTION. Seq 3 `git mv`'d pre-existing test files onto
//      the contract's paths. `file_committed` PASSED and `file_written` FAILED
//      on the same file in the same commit, because git mv preserves mtime.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let proposeBasenameRescue, repoDirsFromFiles, describeBasenameRescue, verifySubTaskOutput, parseHarnessConfig, PLUGIN_VERSION;
try {
  ({ proposeBasenameRescue, repoDirsFromFiles, describeBasenameRescue } = await import("../dist/orchestrator/basename-rescue.js"));
  ({ verifySubTaskOutput } = await import("../dist/orchestrator/verify.js"));
  ({ parseHarnessConfig } = await import("../dist/config.js"));
  ({ PLUGIN_VERSION } = await import("../dist/version.js"));
} catch {
  proposeBasenameRescue = undefined;
}
const skip = proposeBasenameRescue === undefined;

// The real seq-9 mismatch from session b8ece861.
const PLANNED = "src/components/layout/sidebar.tsx";
const COMMITTED = "src/components/ui/sidebar.tsx";
// A repo listing shaped like ProjectThanos: `components/ui` exists,
// `components/layout` does not.
const REPO_FILES = [
  "src/components/ui/sidebar.tsx",
  "src/components/ui/button.tsx",
  "prisma/schema.prisma",
  "src/app/(portal)/grc/page.tsx",
];

// ---------------------------------------------------------------------------
// 1. proposeBasenameRescue — the five conditions, each one load-bearing
// ---------------------------------------------------------------------------

test("beta105: the real b103 seq-9 mismatch is rescued", { skip }, () => {
  const r = proposeBasenameRescue({
    expected: [PLANNED],
    actual: [COMMITTED],
    repoDirs: repoDirsFromFiles(REPO_FILES),
  });
  assert.ok(r, "the exact mismatch that cost an hour of clarification must resolve itself");
  assert.equal(r.from, PLANNED);
  assert.equal(r.to, COMMITTED);
  assert.equal(r.via.from, "src/components/layout");
  assert.equal(r.via.to, "src/components/ui");
  assert.equal(r.via.basename, "sidebar.tsx");
  assert.match(describeBasenameRescue(r), /sidebar\.tsx/);
});

test("beta105: a MULTI-file mismatch is never rescued", { skip }, () => {
  const r = proposeBasenameRescue({
    expected: [PLANNED, "src/components/layout/nav.tsx"],
    actual: [COMMITTED, "src/components/ui/nav.tsx"],
    repoDirs: repoDirsFromFiles([...REPO_FILES, "src/components/ui/nav.tsx"]),
  });
  assert.equal(r, undefined, "several files diverging can be a wrong sub-task, not a naming drift");
});

test("beta105: differing basenames are never rescued", { skip }, () => {
  const r = proposeBasenameRescue({
    expected: ["src/components/layout/sidebar.tsx"],
    actual: ["src/components/ui/button.tsx"],
    repoDirs: repoDirsFromFiles(REPO_FILES),
  });
  assert.equal(r, undefined, "the shared basename is the whole anchor");
});

test("beta105: a planned directory that DOES exist is never rescued", { skip }, () => {
  // The plan named a real location and the worker went elsewhere. That is a
  // genuine disagreement about where work belongs -- a human must see it.
  const r = proposeBasenameRescue({
    expected: ["src/components/ui/sidebar.tsx"],
    actual: ["src/components/layout/sidebar.tsx"],
    repoDirs: repoDirsFromFiles([...REPO_FILES, "src/components/layout/nav.tsx"]),
  });
  assert.equal(r, undefined);
});

test("beta105: a committed directory that does NOT exist is never rescued", { skip }, () => {
  const r = proposeBasenameRescue({
    expected: [PLANNED],
    actual: ["src/totally/invented/sidebar.tsx"],
    repoDirs: repoDirsFromFiles(REPO_FILES),
  });
  assert.equal(r, undefined, "a second fiction is not evidence");
});

test("beta105: identical paths propose nothing", { skip }, () => {
  assert.equal(
    proposeBasenameRescue({ expected: [COMMITTED], actual: [COMMITTED], repoDirs: repoDirsFromFiles(REPO_FILES) }),
    undefined,
  );
});

test("beta105: repoDirsFromFiles walks every ancestor directory", { skip }, () => {
  const dirs = repoDirsFromFiles(["src/components/ui/sidebar.tsx"]);
  for (const d of ["", "src", "src/components", "src/components/ui"]) {
    assert.ok(dirs.has(d), `expected ancestor '${d}'`);
  }
  assert.equal(dirs.has("src/components/layout"), false);
});

// ---------------------------------------------------------------------------
// 2. file_written and the `git mv` contradiction
// ---------------------------------------------------------------------------

// A file that exists and is non-empty but whose mtime predates the sub-task --
// exactly what `git mv` of a pre-existing file leaves behind.
// Mirrors the real probe: a stale file comes back exists+!nonEmpty+stale.
const staleButPresent = {
  fileExistsOnDisk: async () => ({ exists: true, nonEmpty: false, stale: true, detail: "present but mtime 4m before sub-task start" }),
  fileWrittenSince: async () => ({ written: false, detail: "unused" }),
  commitMadeSince: async () => ({ made: true, detail: "" }),
  fileCommittedSince: async () => ({ committed: true, detail: "" }),
};

test("beta105: file_written FAILS on a stale mtime when the path was NOT introduced here", { skip }, async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_written", path: COMMITTED }],
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "aaa1111", cycle: 1, acceptRenameAsWrite: true },
    { ...staleButPresent, filePathIntroducedSince: async () => ({ introduced: false, changeType: "", detail: "not added or renamed-to" }) },
  );
  assert.equal(out.ok, false, "a merely pre-existing file must still fail; this is not a blanket relaxation");
});

test("beta105: file_written PASSES when git says the path was RENAMED-TO in this sub-task", { skip }, async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_written", path: COMMITTED }],
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "aaa1111", cycle: 1, acceptRenameAsWrite: true },
    { ...staleButPresent, filePathIntroducedSince: async () => ({ introduced: true, changeType: "renamed", detail: "renamed at " + COMMITTED }) },
  );
  assert.equal(out.ok, true, "git mv preserves mtime; the rename IS the authorship evidence");
  assert.match(out.results[0].detail, /renamed/);
});

test("beta105: the rename fallback is OFF when acceptRenameAsWrite is not set", { skip }, async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_written", path: COMMITTED }],
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "aaa1111", cycle: 1 },
    { ...staleButPresent, filePathIntroducedSince: async () => ({ introduced: true, changeType: "renamed", detail: "" }) },
  );
  assert.equal(out.ok, false, "the config flag must actually gate the behaviour");
});

test("beta105: a MISSING file is still failed even when git reports the rename", { skip }, async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_written", path: COMMITTED }],
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "aaa1111", cycle: 1, acceptRenameAsWrite: true },
    {
      ...staleButPresent,
      fileExistsOnDisk: async () => ({ exists: false, nonEmpty: false, detail: "missing" }),
      filePathIntroducedSince: async () => ({ introduced: true, changeType: "renamed", detail: "" }),
    },
  );
  assert.equal(out.ok, false, "presence on disk is still required; only the freshness half is replaced");
});

test("beta105: file_committed and file_written now AGREE on a git-mv'd file", { skip }, async () => {
  // The b103 seq-3 split verdict, reproduced end to end.
  const probes = {
    ...staleButPresent,
    fileCommittedSince: async () => ({ committed: true, detail: "committed in range" }),
    filePathIntroducedSince: async () => ({ introduced: true, changeType: "renamed", detail: "" }),
  };
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: COMMITTED }, { kind: "file_written", path: COMMITTED }],
    { defaultBranch: "main", subTaskStartMs: Date.now(), baseSha: "aaa1111", cycle: 1, acceptRenameAsWrite: true },
    probes,
  );
  const byKind = Object.fromEntries(out.results.map((r) => [r.kind, r.passed]));
  assert.equal(byKind.file_committed, byKind.file_written, "two checks must not disagree about one file");
  assert.equal(out.ok, true);
});

// ---------------------------------------------------------------------------
// 3. pathIntroducedSince against real git
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "b105-git-"));
  const g = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", dir, ...args], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  return { dir, g };
}

test("beta105: pathIntroducedSince sees a git mv as a rename, and a modify as neither", { skip }, async () => {
  const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
  const { dir, g } = makeRepo();
  try {
    mkdirSync(join(dir, "__tests__"), { recursive: true });
    writeFileSync(join(dir, "__tests__/a-api.test.ts"), "test('x', () => {});\n");
    writeFileSync(join(dir, "keep.txt"), "one\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD").trim();

    // The b103 seq-3 shape: move a pre-existing test onto the contract's path.
    mkdirSync(join(dir, "src/__tests__"), { recursive: true });
    g("mv", "__tests__/a-api.test.ts", "src/__tests__/a.test.ts");
    writeFileSync(join(dir, "keep.txt"), "two\n");
    g("add", "-A");
    g("commit", "-qm", "move test, touch keep");

    const git = new GitAdapter({ logger: { info() {}, warn() {}, error() {} } });
    const moved = await git.pathIntroducedSince(dir, base, "src/__tests__/a.test.ts");
    assert.equal(moved.introduced, true, "a git mv destination must count as introduced");
    assert.equal(moved.changeType, "renamed");

    const touched = await git.pathIntroducedSince(dir, base, "keep.txt");
    assert.equal(touched.introduced, false, "a modification is not authorship at this path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("beta105: pathIntroducedSince reports a brand-new file as added", { skip }, async () => {
  const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
  const { dir, g } = makeRepo();
  try {
    writeFileSync(join(dir, "seed.txt"), "seed\n");
    g("add", "-A");
    g("commit", "-qm", "base");
    const base = g("rev-parse", "HEAD").trim();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/new.ts"), "export const x = 1;\n");
    g("add", "-A");
    g("commit", "-qm", "add new");

    const git = new GitAdapter({ logger: { info() {}, warn() {}, error() {} } });
    const r = await git.pathIntroducedSince(dir, base, "src/new.ts");
    assert.equal(r.introduced, true);
    assert.equal(r.changeType, "added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The resume guard and the allocation decision, against a real loop and real git
// ---------------------------------------------------------------------------

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const IDENT = { name: "Harness Test", email: "harness@test.local" };
const g2 = (args, cwd) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

const worlds = [];
test.after(() => {
  for (const d of worlds) rmSync(d, { recursive: true, force: true });
});

async function makeWorld() {
  const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
  const base = mkdtempSync(join(tmpdir(), "b105-e2e-"));
  worlds.push(base);
  const origin = join(base, "origin.git");
  const seed = join(base, "seed");
  const worktreesRoot = join(base, "wt");
  g2(["init", "--bare", "-b", "main", origin]);
  mkdirSync(seed, { recursive: true });
  g2(["init", "-b", "main"], seed);
  g2(["config", "user.name", IDENT.name], seed);
  g2(["config", "user.email", IDENT.email], seed);
  mkdirSync(join(seed, "src/components/ui"), { recursive: true });
  writeFileSync(join(seed, "src/components/ui/sidebar.tsx"), "export const Sidebar = () => null;\n");
  g2(["add", "-A"], seed);
  g2(["commit", "-m", "initial"], seed);
  g2(["remote", "add", "origin", origin], seed);
  g2(["push", "-u", "origin", "main"], seed);
  const bare = join(worktreesRoot, ".repos", "o", "r.git");
  mkdirSync(dirname(bare), { recursive: true });
  g2(["clone", "--bare", origin, bare]);
  return { base, origin, bare, worktreesRoot, adapter: new GitAdapter({ worktreesRoot, logger: QUIET, bootstrapDeps: false }) };
}

function alloc(w, extra = {}) {
  g2(["remote", "set-url", "origin", w.origin], w.bare);
  return w.adapter.allocate({
    repoFullName: "o/r", baseBranch: "main", sessionBranch: "harness/feat-x",
    sessionId: `s-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    ghToken: "", commitIdentity: IDENT, ...extra,
  });
}

test("beta105: allocation reports reset_to_base on a first run, and preserve_local on a resume", { skip }, async () => {
  const w = await makeWorld();
  const seen = [];
  const wt1 = await alloc(w, { onBranchDecision: (d) => seen.push(d) });
  assert.equal(seen[0].path, "reset_to_base", "no local branch yet");
  assert.equal(seen[0].localBranchExists, false);

  writeFileSync(join(wt1, "new.txt"), "work\n");
  await w.adapter.commit(wt1, "worker commit", IDENT);
  const tip = g2(["rev-parse", "HEAD"], wt1);
  await w.adapter.releaseByPath(wt1, "o/r");

  const seen2 = [];
  await alloc(w, { preserveLocalBranch: true, onBranchDecision: (d) => seen2.push(d) });
  assert.equal(seen2[0].path, "preserve_local", "the resume must keep the branch where it is");
  assert.equal(seen2[0].preserveRequested, true);
  assert.equal(seen2[0].localBranchExists, true);
  assert.equal(seen2[0].tipBefore, tip, "the pre-allocation tip is recorded, so a later move is provable");
});

test("beta105: a requested preservation with NO local branch is reported as a reset", { skip }, async () => {
  // The b103 shape: the request is set, but the ref is about to move anyway.
  // Before b105 this was indistinguishable from a preserved allocation.
  const w = await makeWorld();
  const seen = [];
  await alloc(w, { preserveLocalBranch: true, onBranchDecision: (d) => seen.push(d) });
  assert.equal(seen[0].preserveRequested, true);
  assert.equal(seen[0].localBranchExists, false);
  assert.notEqual(seen[0].path, "preserve_local", "the request did NOT preserve anything; the trail must say so");
});

test("beta105: a resume onto a branch missing this run's commits fails BEFORE any worker turn", { skip }, async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { BudgetEnforcer } = await import("../dist/budgets/enforcer.js");
  const { PatRouter } = await import("../dist/auth/pat-router.js");
  const { DatabaseSync } = await import("node:sqlite");
  const schemaPath = join(root, "dist", "state", "schema.sql");

  const w = await makeWorld();
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  const audits = [];
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      audits.push({ event, payload });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?,?,?,?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
  };
  const cfg = {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: { max_cycles: 2, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, lead_timeout_seconds: 60, session_hard_timeout_seconds: 3600 },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
  };
  const brief = { title: "t", motivation: "m", acceptanceCriteria: ["a"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, crystallised_prompt)
     VALUES (?, 'T1','C1','U1','u1','o/r','harness/feat-x','', 'crystallising', ?, ?, 50, 0, 0, ?)`,
  ).run("S1", now, now, JSON.stringify(brief));

  // A commit this run made, on a branch nobody will check out: the exact state
  // the b103 resume left behind. It is a real object, just not an ancestor.
  const scratch = await alloc(w);
  writeFileSync(join(scratch, "orphan.txt"), "work that must not be silently dropped\n");
  const orphan = await w.adapter.commit(scratch, "orphaned worker commit", IDENT);
  await w.adapter.releaseByPath(scratch, "o/r");
  // Roll the branch back off it, in the bare repo, the way the b103 resume did.
  g2(["update-ref", "refs/heads/harness/feat-x", `${orphan}~1`], w.bare);
  state.audit("loop.worker_end_turn", { sessionId: "S1", seq: 1, commitShas: [orphan] }, "S1");

  let workerTurns = 0;
  let worktree = "";
  const loop = new OrchestratorLoop({
    config: cfg,
    state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat: new PatRouter(cfg.pat_routing),
    logger: QUIET,
    runLead: async () => {
      worktree = await alloc(w);
      return {
        repo: "o/r", branch: "harness/feat-x", worktreePath: worktree, reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
        subTasks: [{ seq: 1, title: "t", intent: "i", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 10, taskMode: "observe" }],
      };
    },
    runWorker: async () => {
      workerTurns++;
      return { status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "" };
    },
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "", costUsd: 0, tokensIn: 0, tokensOut: 0 }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    buildVerifyProbes: () => ({
      remoteBranchExists: async () => ({ exists: false, detail: "" }),
      prUrlPresent: async () => ({ present: false, detail: "" }),
      fileWrittenSince: async () => ({ written: true, detail: "" }),
      commitMadeSince: async () => ({ made: true, detail: "" }),
      fileCommittedSince: async () => ({ committed: true, detail: "", diffLines: 1 }),
    }),
    releaseWorktree: async () => ({ ok: true, path: worktree }),
    worktreeHeadSha: async (p) => g2(["rev-parse", "HEAD"], p),
    worktreeMergeBase: async (p) => g2(["merge-base", "HEAD", "origin/main"], p),
    unreachableCommits: async (p, from, shas) => w.adapter.unreachableCommits(p, from, shas),
    listRepoFiles: async (p) => w.adapter.listTrackedFiles(p),
  });

  const out = await loop.run("S1", brief);
  assert.equal(out.status, "failed", `expected a hard stop, got ${out.status}`);
  assert.match(String(out.reason ?? ""), /ledger_commits_unreachable_at_resume/);
  assert.equal(workerTurns, 0, "the loss must be caught before a single worker turn is paid for");
  const checked = audits.filter((a) => a.event === "loop.ledger_reachability_checked");
  assert.ok(checked.some((a) => a.payload.phase === "resume"), "the resume-phase check must be in the audit trail");
});

// ---------------------------------------------------------------------------
// 5. Wiring — the resume guard, the allocation audit, the rescue call site
// ---------------------------------------------------------------------------

test("beta105: the ledger guard is a SHARED method with a resume and a review call site", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /private async checkLedgerReachability\(/, "extracted, not duplicated");
  const calls = [...loop.matchAll(/this\.checkLedgerReachability\(/g)];
  assert.equal(calls.length, 2, "exactly two call sites: resume and review");
  assert.match(loop, /checkLedgerReachability\(sessionId, plan\.worktreePath, 1, "resume"\)/);
  assert.match(loop, /checkLedgerReachability\(sessionId, plan\.worktreePath, cycle, "review"\)/);
});

test("beta105: the resume guard fails the run rather than reviewing a truncated branch", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /ledger_commits_unreachable_at_resume/);
  assert.match(loop, /resume_ledger_guard_enabled !== false/);
});

test("beta105: the resume guard runs BEFORE any worker turn is dispatched", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  const guardAt = loop.indexOf('checkLedgerReachability(sessionId, plan.worktreePath, 1, "resume")');
  const conventionsAt = loop.indexOf("repo_conventions_ingested");
  assert.ok(guardAt > 0 && conventionsAt > 0);
  assert.ok(guardAt < conventionsAt, "detect the loss before spending anything on the re-planned run");
});

test("beta105: the ledger check short-circuits on an empty ledger", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /if \(ledger\.length === 0\) return none;/, "a fresh run must not pay for this");
});

test("beta105: allocation reports which of the three checkout paths it took", { skip }, () => {
  const gw = S("src/adapters/git-worktree.ts");
  assert.match(gw, /export interface BranchAllocationDecision/);
  assert.match(gw, /onBranchDecision\?: \(d: BranchAllocationDecision\) => void;/);
  for (const p of ["preserve_local", "reuse_remote", "reset_to_base"]) {
    assert.ok(gw.includes(`decide("${p}"`), `no decision emitted for the ${p} path`);
  }
});

test("beta105: a requested preservation that falls through to a reset WARNS", { skip }, () => {
  const gw = S("src/adapters/git-worktree.ts");
  assert.match(gw, /preserveRequested && !localExists/);
  assert.match(gw, /preserveLocalBranch requested but no LOCAL branch/);
});

test("beta105: the decision reaches the session audit trail", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /loop\.branch_allocation/);
  const idx = S("src/index.ts");
  assert.match(idx, /onBranchDecision,/, "index must forward the callback into GitContext");
});

test("beta105: the basename rescue is tried BEFORE the clarification escalation", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  const rescueAt = loop.indexOf("basename_rescue_enabled !== false");
  const escalateAt = loop.indexOf("loop.contract_path_mismatch_escalated");
  assert.ok(rescueAt > 0 && escalateAt > 0);
  assert.ok(rescueAt < escalateAt, "asking a human must remain the LAST resort");
});

test("beta105: a rescue only continues when re-verification actually passes", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /loop\.contract_path_basename_rescued/);
  assert.match(loop, /if \(reverified\.ok\) \{/, "nothing may be waved through unverified");
  assert.match(loop, /source: "basename_rescue"/, "a rescue must write back to the plan like a learned remap");
});

test("beta105: a throwing rescue leaves the pre-b105 escalation intact", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /basename rescue failed \(non-fatal; escalating as before\)/);
});

test("beta105: file_written's rename fallback is wired end to end", { skip }, () => {
  assert.match(S("src/orchestrator/verify.ts"), /filePathIntroducedSince\?: \(/);
  assert.match(S("src/orchestrator/verify.ts"), /ctx\.acceptRenameAsWrite && probes\.filePathIntroducedSince/);
  // beta.123: the probes moved out of index.ts into their own module so tests
  // could reach the real ones. The three-call-site invariant below is the part
  // of this test worth keeping -- behaviour cannot easily assert "all three
  // places agree" -- so it is repointed rather than pruned.
  assert.match(S("src/orchestrator/verify-probes.ts"), /filePathIntroducedSince: async \(path: string, baseSha: string\)/);
  assert.match(S("src/adapters/git-worktree.ts"), /--diff-filter=AR/);
  const loop = S("src/orchestrator/loop.ts");
  assert.equal(
    [...loop.matchAll(/acceptRenameAsWrite: this\.deps\.config\.loop\.file_written_accepts_rename !== false/g)].length,
    3,
    "the first-pass verify, the env-wait retry and the rescue re-verify must all agree",
  );
});

// ---------------------------------------------------------------------------
// 6. Config
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["o/*"] },
  storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt" },
};

test("beta105: the new keys default to on", { skip }, () => {
  const cfg = parseHarnessConfig(MINIMAL_CONFIG);
  assert.equal(cfg.loop.resume_ledger_guard_enabled, true);
  assert.equal(cfg.loop.basename_rescue_enabled, true);
  assert.equal(cfg.loop.file_written_accepts_rename, true);
});

test("beta105: each new key can be switched off independently", { skip }, () => {
  const cfg = parseHarnessConfig({
    ...MINIMAL_CONFIG,
    loop: { resume_ledger_guard_enabled: false, basename_rescue_enabled: false, file_written_accepts_rename: false },
  });
  assert.equal(cfg.loop.resume_ledger_guard_enabled, false);
  assert.equal(cfg.loop.basename_rescue_enabled, false);
  assert.equal(cfg.loop.file_written_accepts_rename, false);
});

test("beta105: the new keys are documented in both schemas", { skip }, () => {
  for (const f of ["src/config.schema.json", "openclaw.plugin.json"]) {
    const j = S(f);
    for (const k of ["resume_ledger_guard_enabled", "basename_rescue_enabled", "file_written_accepts_rename"]) {
      assert.ok(j.includes(k), `${k} missing from ${f}`);
    }
  }
});

test("beta105: pluginVersion and package.json agree at >= beta.105", { skip }, () => {
  const n = betaOrdinal;
  assert.ok(n(PLUGIN_VERSION.pluginVersion) >= 105, PLUGIN_VERSION.pluginVersion);
  assert.equal(JSON.parse(S("package.json")).version, PLUGIN_VERSION.pluginVersion);
});
