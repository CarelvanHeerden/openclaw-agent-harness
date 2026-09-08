// rc.3 -- a focused revision is judged against two windows, not one.
//
// StitchGuard PR #1168, revision session 51fd67cc. The operator asked for two
// changes to an existing feature PR: add sidebar workflow-manifest
// declarations, and move Source Code column filtering from client-side to
// server-side. The revise brief correctly prohibited new schema or migration
// redesign.
//
// The harness then compared the complete original feature diff against that
// two-item plan. Roughly 46 legitimate pre-existing feature files came back as
// revision scope violations: the Prisma models and their migration, the feature
// APIs, the UI pages, the tests, the OpenAPI artifacts, the generated OKF
// documentation. The revision-only "no schema redesign" instruction was read as
// a prohibition the existing feature had already broken, and the adversary
// spent cycles telling workers to delete the persistence the feature was
// built on.
//
// Correctness and scope are different questions and need different windows.
// The adversary keeps `originalPrBase..HEAD`, because whether the PR is right
// is a property of the whole feature. Scope enforcement gets
// `revisionStartSha..HEAD`, because whether THIS revision stayed in its lane
// can only be asked of what this revision committed. Neither sha can be
// recovered from branch state afterwards, so both are persisted at the one
// moment they are knowable.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");
const skip = existsSync(join(root, "dist", "orchestrator", "loop.js")) ? false : "dist not built";
const skipDist = { skip };

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

const temps = [];
test.after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// The shape the defect report names: a feature that really does contain schema,
// a migration, an API route, a UI page, tests, an OpenAPI artifact and
// generated documentation.
const FEATURE_FILES = [
  "prisma/schema.prisma",
  "prisma/migrations/20260101000000_sast/migration.sql",
  "src/app/api/security/sast-sheet/route.ts",
  "src/app/security/sast/page.tsx",
  "src/__tests__/api/sast.test.ts",
  "openapi/security.yaml",
  "docs/okf/sast.md",
];

// What the operator actually asked this revision to change.
const REVISION_FILES = ["src/lib/workflow-manifest.ts", "src/app/security/sast/filters.tsx"];

/**
 * A repo whose history is the #1168 shape:
 *   A  main
 *   B  the feature (every file in FEATURE_FILES)
 *   C  the revision (REVISION_FILES only)
 */
async function makeFeatureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "rc3-revbase-"));
  temps.push(dir);
  const g = (args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const put = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  put("README.md", "# app\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const originalPrBase = g(["rev-parse", "HEAD"]);

  for (const f of FEATURE_FILES) put(f, `// ${f}\n`);
  g(["add", "-A"]);
  g(["commit", "-qm", "feat: SAST sheet"]);
  const revisionStart = g(["rev-parse", "HEAD"]);

  for (const f of REVISION_FILES) put(f, `// ${f}\n`);
  g(["add", "-A"]);
  g(["commit", "-qm", "revise: manifest + server-side filtering"]);

  return { dir, g, put, originalPrBase, revisionStart };
}

async function loopFor(repo, { originalPrBase, revisionStart }) {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const adapter = new GitAdapter({ worktreesRoot: repo.dir, logger: QUIET, bootstrapDeps: false });
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran,
       plan_base_sha, original_pr_base_sha, revision_start_sha)
     VALUES ('S1','T','C','U1','u1','o/r','harness/x', ?, 'reviewing', ?, ?, 50, 0, 2, ?, ?, ?)`,
  ).run(repo.dir, now, now, originalPrBase, originalPrBase, revisionStart ?? null);
  const loop = new OrchestratorLoop({
    state,
    logger: QUIET,
    config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    worktreeHeadSha: async (p) => adapter.baseSha(p),
    worktreeCommittedFiles: async (p, base) => adapter.listCommittedFiles(p, base),
  });
  return { loop, db, state, audits };
}

/** A plan whose declared scope is only what the revision was asked to touch. */
const revisionPlan = (worktreePath) => ({
  repo: "o/r",
  branch: "harness/x",
  worktreePath,
  riskLevel: "low",
  reviewChecklist: [],
  approxCostUsd: 0,
  subTasks: REVISION_FILES.map((path, i) => ({
    seq: i + 1,
    title: `revise ${path}`,
    intent: "i",
    filesLikelyTouched: [path],
    successCriteria: [],
    estimatedTokens: 10,
    taskMode: "mutate",
    verify: [{ kind: "file_committed", path }],
  })),
});

// ---------------------------------------------------------------------------
// 12-15. THE ORIGINAL FEATURE IS NOT A REVISION SCOPE VIOLATION
// ---------------------------------------------------------------------------

test("12-15: pre-existing feature files are not reported as revision scope violations", skipDist, async () => {
  const repo = await makeFeatureRepo();
  const { loop, audits } = await loopFor(repo, repo);

  const findings = await loop.runFinalScopeCheck("S1", revisionPlan(repo.dir), 2);

  assert.deepEqual(
    findings.map((f) => f.file),
    [],
    "the schema, the migration, the APIs, the pages, the tests, the OpenAPI file and the generated docs are the feature, not scope creep",
  );

  const windows = audits.find((a) => a.event === "loop.review_diff_windows_selected");
  assert.ok(windows, "the two windows have to be visible; one of them silently widening is the whole defect");
  assert.equal(windows.payload.correctnessBase, repo.originalPrBase);
  assert.equal(windows.payload.scopeBase, repo.revisionStart);

  const grandfathered = audits.find((a) => a.event === "loop.revision_scope_grandfathered");
  assert.ok(grandfathered, "and what the narrower window spared has to be named");
  for (const f of FEATURE_FILES) {
    assert.ok(grandfathered.payload.files.includes(f), `${f} should be grandfathered, not silently dropped`);
  }
});

test("16: a new unauthorized schema edit AFTER the revision start is still reported", skipDist, async () => {
  const repo = await makeFeatureRepo();
  // The worker goes and redesigns the schema anyway -- the one thing the
  // revision brief prohibited. This commit is inside the revision window.
  repo.put("prisma/schema.prisma", "// redesigned\n");
  repo.g(["add", "-A"]);
  repo.g(["commit", "-qm", "chore: redesign the schema"]);

  const { loop } = await loopFor(repo, repo);
  const findings = await loop.runFinalScopeCheck("S1", revisionPlan(repo.dir), 2);

  assert.deepEqual(
    findings.map((f) => f.file),
    ["prisma/schema.prisma"],
    "grandfathering is about WHEN a file was committed, not about which file it is",
  );
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[0].source, "deterministic_scope");
});

test("36: an ordinary non-revision run is judged exactly as before", skipDist, async () => {
  const repo = await makeFeatureRepo();
  // No revision_start_sha: this is a plain feature session, and every file the
  // branch committed is in the window.
  const { loop, audits } = await loopFor(repo, { originalPrBase: repo.originalPrBase, revisionStart: null });
  const findings = await loop.runFinalScopeCheck("S1", revisionPlan(repo.dir), 1);

  assert.deepEqual(
    findings.map((f) => f.file).sort(),
    [...FEATURE_FILES].sort(),
    "an undeclared file on an ordinary run is still out of scope",
  );
  assert.equal(
    audits.some((a) => a.event === "loop.review_diff_windows_selected"),
    false,
    "there is only one window here, and saying otherwise would be noise",
  );
  assert.ok(audits.some((a) => a.event === "loop.final_scope_check_ran"));
});

test("the adversary keeps the whole-PR window even while scope is narrowed", () => {
  const src = S("src/orchestrator/loop.ts");
  // The adversary base is read from plan_base_sha and nothing else. If it ever
  // starts reading revision_start_sha, a revision stops being reviewed against
  // the feature it is changing.
  const i = src.indexOf("adversaryBaseSha = r?.plan_base_sha");
  assert.ok(i > 0, "the adversary reads the fork point");
  assert.ok(
    !src.slice(i - 400, i + 400).includes("revision_start_sha"),
    "correctness is a property of the finished PR, not of the last two commits",
  );
});

// ---------------------------------------------------------------------------
// 13, 17. THE BASELINE IS CAPTURED, NOT INFERRED
// ---------------------------------------------------------------------------

test("13: the revision start sha is captured at plan-ready, before any worker runs", skipDist, async (t) => {
  const helpers = await import("./helpers/scenario.mjs");
  if (!(await helpers.scenarioAvailable())) return t.skip("scenario helpers unavailable");

  // A feature already on the branch, then a revise session over it.
  const r = await helpers.runScenario({
    brief: {
      title: "Revise: SAST sheet",
      motivation: "m",
      acceptanceCriteria: ["a"],
      filesLikelyTouched: [],
      outOfScope: [],
      riskLevel: "low",
      reviseOfSessionId: "S-original",
      pinnedBranch: "harness/feat-x",
    },
  });

  const captured = r.events("loop.revise_baseline_captured");
  assert.equal(captured.length, 1, "captured once, at the only moment HEAD still means 'before the revision'");
  assert.equal(captured[0].payload.reviseOfSessionId, "S-original");
  const row = r.session();
  assert.ok(row.revision_start_sha, "and persisted, because branch state cannot be re-read for it later");
  assert.equal(row.original_pr_base_sha, row.plan_base_sha, "the fork point under its revise-side name");
  // The sub-task committed after this point, so the start sha is genuinely the
  // pre-revision head and not the current tip.
  assert.notEqual(row.revision_start_sha, r.subTaskRows()[0].commit_sha);
});

test("an ordinary run captures no revise baseline at all", skipDist, async (t) => {
  const helpers = await import("./helpers/scenario.mjs");
  if (!(await helpers.scenarioAvailable())) return t.skip("scenario helpers unavailable");
  const r = await helpers.runScenario();
  assert.equal(r.sawEvent("loop.revise_baseline_captured"), false);
  assert.equal(r.session().revision_start_sha, null);
});

test("17: harness_revise stores the ROOT feature brief and the operator's directives separately", { skip }, async () => {
  const { registerHarnessTools } = await import("../dist/tools/registration.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));

  const now = Date.now();
  const seedSession = (id, brief, extra = {}) =>
    db
      .prepare(
        `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
           status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran,
           pr_number, final_pr_url, merge_recommendation, original_feature_brief)
         VALUES (?, ?, '', 'U1', 'u1', 'o/r', 'harness/feat', '', 'done', ?, ?, ?, 50, 1, 2, 1168,
                 'https://github.com/o/r/pull/1168', 'do_not_merge', ?)`,
      )
      .run(id, `agent:${id}`, JSON.stringify(brief), now, now, extra.originalFeatureBrief ?? null);

  const featureBrief = {
    title: "SAST sheet",
    motivation: "the feature",
    acceptanceCriteria: ["persist SAST findings", "expose them through an API"],
    filesLikelyTouched: FEATURE_FILES,
    outOfScope: [],
    riskLevel: "medium",
  };
  seedSession("S-feature", featureBrief);
  // A first revision of it -- so the row `harness_revise` is pointed at is
  // itself a revise brief, with the feature's criteria already buried inside.
  seedSession("S-revise-1", {
    title: "Revise: SAST sheet",
    motivation: "m",
    acceptanceCriteria: ["Address each adversary finding...", "--- original acceptance criteria (must still hold) ---", "persist SAST findings"],
    filesLikelyTouched: [],
    outOfScope: [],
    riskLevel: "low",
    reviseOfSessionId: "S-feature",
  });
  db.prepare(
    `INSERT INTO reviews (id, session_id, cycle, verdict, findings, summary, cost_usd, created_at)
     VALUES ('r1','S-revise-1',1,'revise', ?, 's', 0, ?)`,
  ).run(
    JSON.stringify([
      { severity: "high", dimension: "correctness", title: "parseInt accepts trailing junk", detail: "d", file: "src/lib/header.ts" },
    ]),
    now,
  );

  const audits = [];
  const tools = new Map();
  registerHarnessTools(
    {
      logger: QUIET,
      registerTool(spec) {
        tools.set(spec.name, spec);
        return () => {};
      },
    },
    {
      config: {
        slack: { authorised_users: ["U1"] },
        budgets: {},
        repos: { allowed: ["o/r"] },
        brief: {},
        loop: {},
      },
      state: { db, isOpen: () => true, audit: (event, payload, sessionId) => audits.push({ event, payload, sessionId }) },
      loop: { run: async () => {} },
      budget: { getDailySpend: () => 0 },
    },
  );

  const out = await tools.get("harness_revise").execute(null, {
    requester: "U1",
    sessionId: "S-revise-1",
    guidance: "Move Source Code filtering to the server. Do not redesign the schema.",
  });
  assert.equal(out.details.ok, true);

  const row = db
    .prepare(`SELECT original_feature_brief, operator_revision_brief FROM sessions WHERE id = ?`)
    .get(out.details.sessionId);

  const original = JSON.parse(row.original_feature_brief);
  assert.equal(original.title, "SAST sheet", "'original' has to mean the feature, not the previous revision of it");
  assert.deepEqual(original.acceptanceCriteria, featureBrief.acceptanceCriteria);

  const revision = JSON.parse(row.operator_revision_brief);
  assert.match(revision.guidance, /Do not redesign the schema/);
  assert.equal(revision.reviseOfSessionId, "S-revise-1");
  assert.equal(revision.prNumber, 1168);
  assert.equal(revision.directives.length, 1, "the findings this revision was opened for, on their own");
  assert.match(revision.directives[0], /parseInt accepts trailing junk/);
});

test("the revise baseline columns are additive, so an existing database opens unchanged", { skip }, async () => {
  const { openStateStoreSync } = await import("../dist/state/store.js");
  const dir = mkdtempSync(join(tmpdir(), "rc3-migrate-"));
  temps.push(dir);
  const path = join(dir, "state.db");

  // A pre-rc.3 database: the sessions table without any of the four columns.
  const { DatabaseSync } = await import("node:sqlite");
  const old = new DatabaseSync(path);
  old.exec(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, slack_thread TEXT, slack_channel TEXT, requester TEXT NOT NULL,
       requester_gh TEXT NOT NULL, repo TEXT, branch TEXT, worktree_path TEXT, status TEXT NOT NULL,
       crystallised_prompt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
       budget_usd REAL NOT NULL, cost_usd REAL NOT NULL, cycles_ran INTEGER NOT NULL DEFAULT 0)`,
  );
  old.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
       status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES ('old','T','C','U1','u1','o/r','b','/w','done','{}',1,1,50,1,1)`,
  ).run();
  old.close();

  const store = openStateStoreSync(path);
  const cols = store.db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
  for (const c of ["original_pr_base_sha", "revision_start_sha", "original_feature_brief", "operator_revision_brief"]) {
    assert.ok(cols.includes(c), `${c} must be added to an existing table, not require a rebuild`);
  }
  assert.equal(store.db.prepare(`SELECT id FROM sessions WHERE id='old'`).get().id, "old", "and the existing row survives");
  store.db.close();
});
