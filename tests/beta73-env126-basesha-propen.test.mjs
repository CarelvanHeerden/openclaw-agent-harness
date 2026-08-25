// beta.73 — three fixes from the session 70341bc3 forensic (the beta.72
// validation run that PASSED the adversary but ended `failed` with no PR):
//
//   Fix 1 (env-126): convention checks 126'd with "sh: tsc: Permission denied"
//     because the worktrees tmpfs was mounted `noexec`. That is a SANDBOX/env
//     restriction, not a code-quality failure — like exit-127 it must be
//     `unrunnable` (non-blocking), never a gate that discards a passing run.
//
//   Fix 2 (D2, base sha): the brief carried `branchHint:
//     harness/grc-changes-export-mode` (an existing open-PR branch) but reuse
//     was gated on `pinnedBranch` (unset for harness_run), so the worktree
//     reset to main. Fix: promote a branchHint that names an EXISTING remote
//     branch to pinned/reuse so the branch HEAD is checked out.
//
//   Fix 3 (D3, silent PR-open): finaliseFailed emitted no audit for its reason,
//     and the main PR-open path had no start/failed events — so a push/PR
//     failure was invisible (2-min gap, then a bare worktree_released:failed).
//     Fix: finaliseFailed audits `loop.failed{reason}`; the PR-open path emits
//     `loop.pr_open_started` + `loop.pr_open_failed{error}`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { classifyFinding } = await import("../dist/orchestrator/finding-classify.js");
const { runLeadPlanner } = await import("../dist/orchestrator/lead.js");

const F = (o) => ({ dimension: "fit", severity: "medium", title: "", detail: "", ...o });

// ---------------------------------------------------------------------------
// Fix 1 — exit-126 / permission-denied classifies as ENV (non-blocking)
// ---------------------------------------------------------------------------

test("beta73 fix1: exit-126 'Permission denied' finding classifies as env", () => {
  assert.equal(
    classifyFinding(F({ title: "typecheck failed (exit 126)", detail: "sh: 1: tsc: Permission denied" })),
    "env",
  );
});

test("beta73 fix1: 'cannot execute' / noexec phrasings classify as env", () => {
  assert.equal(classifyFinding(F({ detail: "eslint: cannot execute" })), "env");
  assert.equal(classifyFinding(F({ detail: "binary on a noexec mount" })), "env");
});

test("beta73 fix1: a REAL code defect still classifies diff_addressable (not swallowed)", () => {
  assert.equal(
    classifyFinding(F({ dimension: "quality", title: "off-by-one in pagination", detail: "limit should be total not total-1" })),
    "diff_addressable",
  );
});

test("beta73 fix1: exit-127 (beta.69) still classifies env — no regression", () => {
  assert.equal(classifyFinding(F({ title: "lint failed (exit 127)", detail: "eslint: not found" })), "env");
});

test("beta73 fix1: repo-conventions treats exit-126/permission-denied as unrunnable (source)", () => {
  const src = readFileSync(join(root, "src/orchestrator/repo-conventions.ts"), "utf8");
  assert.match(src, /out\.status === 126/, "must check exit 126");
  assert.match(src, /permission denied\|cannot execute/i, "must match permission-denied/cannot-execute");
  // the 126 branch must push unrunnable:true (non-fatal), like the 127 branch
  const idx126 = src.indexOf("out.status === 126");
  const tail = src.slice(idx126, idx126 + 400);
  assert.match(tail, /unrunnable:\s*true/, "exit-126 branch must mark unrunnable");
});

// ---------------------------------------------------------------------------
// Fix 2 — D2 branchHint -> pinned/reuse promotion (behavioral)
// ---------------------------------------------------------------------------

function leadDeps({ branchExists, capture }) {
  return {
    config: {
      repos: { allowed: ["Stitch-Vercel/*"], default_base_branch: "main" },
      models: { worker: "claude-sonnet-5" },
      loop: { enforce_worker_context: false, worker_timeout_seconds: 60 },
    },
    logger: { info: () => {}, warn: () => {} },
    callLeadModel: async () => ({
      repo: "Stitch-Vercel/ProjectThanos",
      branch: "harness/fresh-generated-name",
      riskLevel: "low",
      subTasks: [{ seq: 1, title: "t", intent: "i", taskMode: "observe", filesLikelyTouched: [], successCriteria: ["ok"] }],
    }),
    allocateWorktree: async (repo, branch) => {
      capture.repo = repo;
      capture.branch = branch;
      return "/tmp/wt";
    },
    estimateCost: () => 0.1,
    remoteBranchExists: async (_repo, branch) => branchExists.includes(branch),
  };
}

test("beta73 fix2: a branchHint that EXISTS on origin is promoted to pinned (branch reused)", async () => {
  const capture = {};
  const brief = {
    title: "Add tests",
    motivation: "m",
    acceptanceCriteria: ["a"],
    repoHint: "Stitch-Vercel/ProjectThanos",
    branchHint: "harness/grc-changes-export-mode",
    riskLevel: "low",
  };
  const plan = await runLeadPlanner(brief, leadDeps({ branchExists: ["harness/grc-changes-export-mode"], capture }));
  // Promotion sets brief.pinnedBranch, which the lead uses to OVERRIDE raw.branch.
  assert.equal(brief.pinnedBranch, "harness/grc-changes-export-mode", "branchHint promoted to pinnedBranch");
  assert.equal(plan.branch, "harness/grc-changes-export-mode", "plan branch = the existing branch, not the generated name");
  assert.equal(capture.branch, "harness/grc-changes-export-mode", "worktree allocated on the existing branch");
});

test("beta73 fix2: a branchHint that does NOT exist is left alone (fresh branch, no reuse)", async () => {
  const capture = {};
  const brief = {
    title: "New feature",
    motivation: "m",
    acceptanceCriteria: ["a"],
    repoHint: "Stitch-Vercel/ProjectThanos",
    branchHint: "harness/brand-new-thing",
    riskLevel: "low",
  };
  const plan = await runLeadPlanner(brief, leadDeps({ branchExists: [], capture }));
  assert.equal(brief.pinnedBranch, undefined, "non-existent branchHint must NOT be promoted");
  assert.equal(plan.branch, "harness/fresh-generated-name", "keeps the lead's generated branch name");
});

test("beta73 fix2: an ALREADY pinned brief (revise) is untouched by the promotion", async () => {
  const capture = {};
  const brief = {
    title: "Revise",
    motivation: "m",
    acceptanceCriteria: ["a"],
    repoHint: "Stitch-Vercel/ProjectThanos",
    branchHint: "harness/some-hint",
    pinnedBranch: "harness/already-pinned",
    riskLevel: "low",
  };
  const plan = await runLeadPlanner(brief, leadDeps({ branchExists: ["harness/some-hint"], capture }));
  assert.equal(brief.pinnedBranch, "harness/already-pinned", "existing pin is not overwritten by the hint");
  assert.equal(plan.branch, "harness/already-pinned");
});

test("beta73 fix2: no remoteBranchExists dep -> promotion skipped (back-compat)", async () => {
  const capture = {};
  const deps = leadDeps({ branchExists: [], capture });
  delete deps.remoteBranchExists;
  const brief = {
    title: "x", motivation: "m", acceptanceCriteria: ["a"],
    repoHint: "Stitch-Vercel/ProjectThanos", branchHint: "harness/whatever", riskLevel: "low",
  };
  const plan = await runLeadPlanner(brief, deps);
  assert.equal(brief.pinnedBranch, undefined);
  assert.equal(plan.branch, "harness/fresh-generated-name");
});

test("beta73 fix2: git adapter exposes remoteBranchExistsByUrl (worktree-free check) (source)", () => {
  const src = readFileSync(join(root, "src/adapters/git-worktree.ts"), "utf8");
  assert.match(src, /async remoteBranchExistsByUrl\(/, "helper exists");
  assert.match(src, /ls-remote/, "uses ls-remote (no worktree needed)");
  const idx = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.match(idx, /remoteBranchExists:\s*async/, "lead dep wired in index.ts");
  assert.match(idx, /remoteBranchExistsByUrl/, "index uses the worktree-free helper");
});

// ---------------------------------------------------------------------------
// Fix 3 — D3 PR-open observability (source)
// ---------------------------------------------------------------------------

test("beta73 fix3: finaliseFailed audits its reason (loop.failed) — no more silent fails", () => {
  const src = readFileSync(join(root, "src/orchestrator/loop.ts"), "utf8");
  const idx = src.indexOf("private finaliseFailed(");
  assert.ok(idx > 0, "finaliseFailed exists");
  const body = src.slice(idx, idx + 1200);
  assert.match(body, /audit\(\s*["']loop\.failed["']/, "finaliseFailed must audit loop.failed");
  assert.match(body, /reason/, "the audit payload carries the reason");
});

test("beta73 fix3: main PR-open path emits pr_open_started + pr_open_failed", () => {
  const src = readFileSync(join(root, "src/orchestrator/loop.ts"), "utf8");
  assert.match(src, /audit\(\s*["']loop\.pr_open_started["']/, "pr_open_started emitted");
  assert.match(src, /audit\(\s*["']loop\.pr_open_failed["']/, "pr_open_failed emitted");
  // pr_open_failed must carry the underlying error
  const idx = src.indexOf("loop.pr_open_failed");
  assert.match(src.slice(idx, idx + 200), /error:\s*String\(err\)/, "pr_open_failed carries the error");
});

test("beta73 version is >= beta.73 (range floor, so later bumps don't re-break it)", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(betaOrdinal(pkg.version) >= 73, `version should be at or past beta.73, got ${pkg.version}`);
});
