// beta.44: revise flow (harness_revise + harness_list_revisable).
//
// A shipped PR with merge_recommendation != 'merge' + N adversary findings
// must be revisable self-service: revise loads the stored findings + branch,
// pins the branch, re-runs the loop, and UPDATES THE SAME PR. These tests
// guard the wiring end-to-end: brief fields, branch pinning in the lead,
// existing-branch checkout in the git adapter, the 422-already-exists PR
// reuse, and the two tools being registered + returning a picker when no
// target is given.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");

const regSrc = S("src/tools/registration.ts");
const leadSrc = S("src/orchestrator/fable5-lead.ts");
const gitSrc = S("src/adapters/git-worktree.ts");
const ghSrc = S("src/adapters/github.ts");
const indexSrc = S("src/index.ts");
const refinerSrc = S("src/crystallise/prompt-refiner.ts");
const manifestSrc = S("openclaw.plugin.json");

test("beta44: RunnableBrief + CrystallisedBrief carry reviseOfSessionId + pinnedBranch", () => {
  assert.match(regSrc, /reviseOfSessionId\?: string;/, "RunnableBrief must have reviseOfSessionId");
  assert.match(regSrc, /pinnedBranch\?: string;/, "RunnableBrief must have pinnedBranch");
  assert.match(refinerSrc, /reviseOfSessionId\?: string;/, "CrystallisedBrief must have reviseOfSessionId");
  assert.match(refinerSrc, /pinnedBranch\?: string;/, "CrystallisedBrief must have pinnedBranch");
});

test("beta44: lead planner pins the branch verbatim when brief.pinnedBranch is set", () => {
  // The override must happen on `raw` BEFORE validatePlan, so the plan's
  // branch is the pinned one (not the slugified lead output).
  assert.match(
    leadSrc,
    /if\s*\(\s*brief\.pinnedBranch\s*\)\s*\{[\s\S]*raw\.branch\s*=\s*brief\.pinnedBranch/,
    "runLeadPlanner must override raw.branch with brief.pinnedBranch",
  );
  // And it must run before validatePlan (branch must start with harness/).
  const pinIdx = leadSrc.indexOf("brief.pinnedBranch");
  const validateIdx = leadSrc.indexOf("validatePlan(raw");
  assert.ok(pinIdx > -1 && validateIdx > -1 && pinIdx < validateIdx, "pin must be applied before validatePlan(raw)");
});

test("beta44: git.allocate checks out the existing branch (no -B, no base) on reuseExistingBranch", () => {
  assert.match(gitSrc, /reuseExistingBranch\?: boolean;/, "GitContext must declare reuseExistingBranch");
  assert.match(
    gitSrc,
    /if\s*\(\s*ctx\.reuseExistingBranch\s*\)\s*\{[\s\S]*worktree",\s*"add",\s*wt,\s*ctx\.sessionBranch/,
    "reuse path must run `worktree add <wt> <sessionBranch>` (checkout existing tip, no -B/base)",
  );
  // Non-reuse path must still reset to base with -B.
  assert.match(
    gitSrc,
    /worktree",\s*"add",\s*"-B",\s*ctx\.sessionBranch,\s*wt,\s*ctx\.baseBranch/,
    "non-reuse path must keep the -B <branch> <wt> <base> form",
  );
});

test("beta44: runLead dep threads reuseExistingBranch from brief.pinnedBranch", () => {
  assert.match(
    indexSrc,
    /reuseExistingBranch:\s*!!brief\.pinnedBranch/,
    "allocateWorktree call must pass reuseExistingBranch: !!brief.pinnedBranch",
  );
});

test("beta44: createPullRequest returns the existing PR on 422 'already exists' (revise updates same PR)", async () => {
  // Behavioral: stub fetch so POST /pulls returns 422 already-exists, then the
  // lookup GET returns the existing open PR. createPullRequest must resolve to
  // that PR with updatedExisting: true rather than throwing.
  const { createPullRequest } = await import(
    "../dist/adapters/github.js?beta44=" + Date.now()
  );
  const realFetch = globalThis.fetch;
  let sawLookup = false;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts && opts.method === "POST" && u.endsWith("/pulls")) {
      return new Response(
        JSON.stringify({ message: "A pull request already exists for owner:harness/x." }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/pulls?head=")) {
      sawLookup = true;
      return new Response(
        JSON.stringify([{ number: 858, html_url: "https://github.com/o/r/pull/858", node_id: "N1" }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error("unexpected fetch " + u);
  };
  try {
    const out = await createPullRequest({
      repoFullName: "owner/repo",
      head: "harness/x",
      base: "main",
      title: "t",
      body: "b",
      ghToken: "tok",
      draft: false,
    });
    assert.equal(out.number, 858, "must resolve to the existing PR number");
    assert.equal(out.updatedExisting, true, "must flag updatedExisting");
    assert.ok(sawLookup, "must have looked up the existing PR by head");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("beta44: createPullRequest still throws on a non-'already exists' 422", async () => {
  const { createPullRequest } = await import(
    "../dist/adapters/github.js?beta44b=" + Date.now()
  );
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (opts && opts.method === "POST") {
      return new Response(JSON.stringify({ message: "Validation failed: base is invalid" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("should not look up PR for a non-already-exists 422");
  };
  try {
    await assert.rejects(
      () =>
        createPullRequest({
          repoFullName: "o/r",
          head: "harness/x",
          base: "nope",
          title: "t",
          body: "b",
          ghToken: "tok",
          draft: false,
        }),
      /PR create failed 422/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("beta44: both tools registered in manifest + registration + compliance", () => {
  assert.match(manifestSrc, /"harness_revise"/, "manifest must declare harness_revise");
  assert.match(manifestSrc, /"harness_list_revisable"/, "manifest must declare harness_list_revisable");
  assert.match(regSrc, /name:\s*"harness_revise"/, "harness_revise must be registered");
  assert.match(regSrc, /name:\s*"harness_list_revisable"/, "harness_list_revisable must be registered");
});

test("beta44: harness_revise with no target returns needsSelection (picker), not an error", () => {
  // Source-level: the no-target branch must set needsSelection true.
  assert.match(
    regSrc,
    /prNumber === undefined && !sessionId[\s\S]*needsSelection:\s*true/,
    "no-target revise must return needsSelection: true",
  );
});

test("beta44: revise brief is built from stored findings + pins branch + links reviseOf", () => {
  // buildReviseBrief must set pinnedBranch to the prior branch, reviseOfSessionId,
  // and fold the findings into acceptanceCriteria.
  assert.match(regSrc, /pinnedBranch:\s*row\.branch/, "revise brief must pin the prior branch");
  assert.match(regSrc, /reviseOfSessionId:\s*row\.id/, "revise brief must link reviseOfSessionId");
  assert.match(regSrc, /latestFindings\(/, "revise must load latest review findings");
  // The revisable query must require a shipped PR that isn't merge-ready.
  assert.match(
    regSrc,
    /status = 'done'[\s\S]*pr_number IS NOT NULL[\s\S]*merge_recommendation != 'merge'/,
    "listRevisableRows must select shipped PRs with a non-merge recommendation",
  );
});
