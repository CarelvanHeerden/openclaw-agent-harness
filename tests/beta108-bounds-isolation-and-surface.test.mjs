/**
 * beta.108 -- bounded adoption, session-scoped branches, phase timing, and the
 * Slack surface.
 *
 * Every case here is anchored to something that actually happened in the b106
 * revise on PR #932 (session 21c9c44e) or the b106 smoke (06b91509), because
 * the whole release exists to answer that evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adoptOrphanFindings,
  ADOPTABLE_SEVERITIES,
  mapFindingsToSubTasks,
} from "../dist/orchestrator/revise-mapping.js";
import { sessionScopedBranch } from "../dist/orchestrator/lead.js";
import { buildHeadline, mergeAdvice, renderWorklog } from "../dist/orchestrator/progress.js";
import { buildHarnessHelp } from "../dist/tools/help-content.js";
import { parseHarnessConfig } from "../dist/config.js";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/* ------------------------------------------------------------------ *
 * Fix 1 -- adoption is bounded by severity and by count
 * ------------------------------------------------------------------ */

// The shape of the b106 revise's cycle-3 review: a handful of real lows, and a
// pile of `info` entries that exist only to record that an EARLIER finding was
// verified fixed. Seven of that cycle's eighteen findings read this way.
const REVISE_SUBTASKS = [
  { seq: 1, filesLikelyTouched: ["src/app/(portal)/grc/continuity/page.tsx"] },
  { seq: 2, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/[id]/files/route.ts"] },
  { seq: 3, filesLikelyTouched: ["src/lib/grc/continuity-client.ts"] },
];

const INFO_ACK = {
  id: 15,
  severity: "info",
  dimension: "spec",
  file: "src/components/grc/continuity-exercise-form-modal.tsx",
  title: "Findings 2, 3, 4, 5, 7 verified resolved (no action)",
};

const REAL_LOW = {
  id: 12,
  severity: "low",
  dimension: "quality",
  file: "src/lib/grc/continuity-helpers.ts",
  title: "CONTINUITY_FILE_KINDS comment is now definitively wrong",
};

const owned = (st) => st.filesLikelyTouched ?? [];

test("beta108: an info-severity acknowledgement is never adopted", () => {
  const got = adoptOrphanFindings(REVISE_SUBTASKS, [INFO_ACK], owned);
  assert.equal(
    got.length,
    0,
    "info is how the adversary records that a PRIOR finding was fixed; adopting one " +
      "puts a worker on a finding that says the code is already correct",
  );
});

test("beta108: info is refused even when it has a STRONG claim", () => {
  // beta.118: INFO_ACK above shares only `src/` with every sub-task, so once the
  // b118 depth floor landed it was refused for being shallow and the severity
  // gate stopped being the thing under test -- deleting that gate changed
  // nothing. This finding sits squarely inside seq 3's own directory, so it
  // would certainly be adopted on the strength of its path. Only the severity
  // filter can turn it away.
  const infoWithDepth = {
    ...INFO_ACK,
    file: "src/lib/grc/continuity-notes.ts",
    title: "Finding 9 verified resolved in src/lib/grc (no action)",
  };
  assert.equal(adoptOrphanFindings(REVISE_SUBTASKS, [infoWithDepth], owned).length, 0);
  // Same path, real severity -> adopted. So the path really was strong enough.
  const sameFileButReal = { ...infoWithDepth, severity: "low" };
  const adopted = adoptOrphanFindings(REVISE_SUBTASKS, [sameFileButReal], owned);
  assert.equal(adopted.length, 1, "the fixture must be adoptable but for its severity");
  assert.equal(adopted[0].seq, 3);
});

test("beta108: a real low-severity finding IS still adopted", () => {
  const got = adoptOrphanFindings(REVISE_SUBTASKS, [REAL_LOW], owned);
  assert.equal(got.length, 1, "the severity filter must not swallow genuine work");
  assert.equal(got[0].seq, 3, "src/lib/grc/* is nearest to the continuity-client sub-task");
});

test("beta108: every severity above info stays adoptable", () => {
  for (const sev of ["low", "medium", "high", "critical"]) {
    assert.ok(ADOPTABLE_SEVERITIES.has(sev), `${sev} must remain adoptable`);
  }
  assert.ok(!ADOPTABLE_SEVERITIES.has("info"));
});

test("beta108: adoption is capped per cycle", () => {
  // Ten adoptable findings, which is the order of magnitude the b106 revise
  // actually produced (10 misses in cycle 2, 11 in cycle 3).
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i,
    severity: "low",
    dimension: "quality",
    file: `src/lib/grc/thing-${i}.ts`,
    title: `low finding ${i}`,
  }));
  assert.equal(adoptOrphanFindings(REVISE_SUBTASKS, many, owned, { maxPerCycle: 3 }).length, 3);
  assert.equal(adoptOrphanFindings(REVISE_SUBTASKS, many, owned, { maxPerCycle: 0 }).length, 0);
  assert.equal(adoptOrphanFindings(REVISE_SUBTASKS, many, owned).length, 10, "uncapped by default");
});

test("beta108: the cap spends itself on the WORST findings, not the first ones", () => {
  // The adversary emits in its own order, which is not priority order. If the
  // cap simply took the first N, a run could adopt three lows and drop a
  // critical -- the exact opposite of what a cap is for.
  const misses = [
    { id: 1, severity: "low", dimension: "quality", file: "src/lib/grc/a.ts", title: "low a" },
    { id: 2, severity: "low", dimension: "quality", file: "src/lib/grc/b.ts", title: "low b" },
    { id: 3, severity: "critical", dimension: "security", file: "src/lib/grc/c.ts", title: "critical c" },
    { id: 4, severity: "medium", dimension: "quality", file: "src/lib/grc/d.ts", title: "medium d" },
  ];
  const got = adoptOrphanFindings(REVISE_SUBTASKS, misses, owned, { maxPerCycle: 2 });
  assert.equal(got.length, 2);
  const ids = got.map((a) => a.finding?.id ?? a.findingId).sort();
  assert.deepEqual(ids, [3, 4], `expected the critical and the medium, got ${JSON.stringify(got)}`);
});

test("beta108: mapFindingsToSubTasks threads the cap through", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    id: 200 + i,
    severity: "low",
    dimension: "quality",
    file: `src/lib/grc/x-${i}.ts`,
    title: `low ${i}`,
  }));
  const res = mapFindingsToSubTasks(REVISE_SUBTASKS, many, owned, {
    adoptOrphans: true,
    maxAdoptionsPerCycle: 2,
  });
  const adopted = res.adoptions ?? [];
  assert.ok(adopted.length <= 2, `cap must survive the mapping call, got ${adopted.length}`);
});

/* ------------------------------------------------------------------ *
 * Fix 2 -- session-scoped, stable branch names
 * ------------------------------------------------------------------ */

test("beta108: two sessions drawing the same slug get different branches", () => {
  const a = sessionScopedBranch("harness/feat-db-field", "21c9c44e-4177-45f9-88ac-05babc93d4a7");
  const b = sessionScopedBranch("harness/feat-db-field", "06b91509-239d-4c2a-893e-a0cdb9ac5676");
  assert.notEqual(a, b, "identical lead slugs must not collapse onto one branch");
  assert.ok(a.startsWith("harness/feat-db-field-"));
  assert.ok(b.startsWith("harness/feat-db-field-"));
});

test("beta108: the same session always derives the same branch", () => {
  // Load-bearing for clarification re-drives: those re-plan from scratch and
  // nothing obliges the lead to re-emit its earlier slug. If the name moved,
  // b101's preserveLocalBranch would look for a branch that no longer exists
  // and fall through to reset_to_base -- the b100 lost-commits shape.
  const id = "21c9c44e-4177-45f9-88ac-05babc93d4a7";
  assert.equal(sessionScopedBranch("harness/feat-x", id), sessionScopedBranch("harness/feat-x", id));
});

test("beta108: suffixing is idempotent across re-plans", () => {
  const id = "21c9c44e-4177-45f9-88ac-05babc93d4a7";
  const once = sessionScopedBranch("harness/feat-x", id);
  assert.equal(sessionScopedBranch(once, id), once, "a re-plan must not stack suffixes");
});

test("beta108: no session id leaves the branch alone", () => {
  assert.equal(sessionScopedBranch("harness/feat-x", ""), "harness/feat-x");
});

const BRIEF = (over = {}) => ({
  title: "t", motivation: "m", acceptanceCriteria: ["a"], repoHint: "o/r",
  filesLikelyTouched: [], constraints: [], intent: "mutate", ...over,
});

function leadDeps(over = {}) {
  return {
    config: {
      repos: { allowed: ["o/*"], default_base_branch: "main" },
      loop: { lead_repo_scout_enabled: false },
      models: { lead: "l" }, budgets: {},
    },
    logger: { info() {}, warn() {} },
    allocateWorktree: async () => "/tmp/wt",
    callLeadModel: async () => ({
      repo: "o/r", branch: "harness/feat-db-field", riskLevel: "low", reviewChecklist: ["c"],
      subTasks: [{
        seq: 1, title: "t", intent: "i", filesLikelyTouched: ["a.ts"],
        successCriteria: ["x"], estimatedTokens: 100, contractScope: "local",
        taskMode: "mutate", verify: [{ kind: "commit_made" }],
        workerContext: { rationale: "r", changeSpec: "c" },
      }],
    }),
    estimateCost: () => 0,
    ...over,
  };
}

test("beta108: the planner suffixes the branch the lead invented", async () => {
  const { runLeadPlanner } = await import("../dist/orchestrator/lead.js");
  const plan = await runLeadPlanner(BRIEF(), leadDeps({ sessionId: "21c9c44e-4177-45f9" }));
  assert.notEqual(
    plan.branch,
    "harness/feat-db-field",
    "the lead's raw slug must not reach git -- two threads can draw the same one",
  );
  assert.equal(plan.branch, "harness/feat-db-field-21c9c44e");
});

test("beta108: two sessions planning the SAME slug end on different branches", async () => {
  const { runLeadPlanner } = await import("../dist/orchestrator/lead.js");
  const a = await runLeadPlanner(BRIEF(), leadDeps({ sessionId: "21c9c44e-4177" }));
  const b = await runLeadPlanner(BRIEF(), leadDeps({ sessionId: "06b91509-239d" }));
  assert.notEqual(a.branch, b.branch, "this is the cross-talk failure mode, end to end");
});

test("beta108: a revise plan keeps the pinned branch exactly", async () => {
  const { runLeadPlanner } = await import("../dist/orchestrator/lead.js");
  const plan = await runLeadPlanner(
    BRIEF({ pinnedBranch: "harness/feat/grc-continuity-exercises-b106" }),
    leadDeps({ sessionId: "21c9c44e-4177" }),
  );
  assert.equal(
    plan.branch,
    "harness/feat/grc-continuity-exercises-b106",
    "a revise must land on the existing PR's branch, suffix or no suffix",
  );
});

test("beta108: a planner given no session id is unchanged from b107", async () => {
  const { runLeadPlanner } = await import("../dist/orchestrator/lead.js");
  const plan = await runLeadPlanner(BRIEF(), leadDeps());
  assert.equal(plan.branch, "harness/feat-db-field");
});

test("beta108: a revise keeps its pinned branch un-suffixed", () => {
  const lead = S("src/orchestrator/lead.ts");
  const i = lead.indexOf("if (brief.pinnedBranch)");
  const j = lead.indexOf("sanitizeRemoteSubTasks(raw", i);
  assert.ok(i > 0 && j > i);
  const block = lead.slice(i, j);
  assert.match(block, /raw\.branch = brief\.pinnedBranch;/);
  assert.match(
    block,
    /else if \(deps\.sessionId\)[\s\S]*sessionScopedBranch/,
    "the suffix must be the ELSE of pinnedBranch -- a revise has to keep the existing PR's branch",
  );
});

test("beta108: index.ts passes the session id to the planner", () => {
  assert.match(S("src/index.ts"), /sessionId: ctx\?\.sessionId,/);
});

/* --- the live-branch refusal, against real git --- */

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "b108-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed");
  git(root, "clone", "-q", "--bare", seed, origin);
  return { root, origin };
}

test("beta108: a branch held by a live session is refused, not silently shared", async () => {
  const { root, origin } = scratchRepo();
  try {
    const { GitAdapter } = await import("../dist/adapters/git-worktree.js");
    const adapter = new GitAdapter({
      worktreesRoot: join(root, "wt"),
      logger: { info() {}, warn() {}, error() {} },
      bootstrapDeps: false,
    });
    const ctx = (sessionId) => ({
      repoFullName: "acme/thanos",
      baseBranch: "main",
      sessionBranch: "harness/feat-db-field",
      sessionId,
      commitIdentity: { name: "t", email: "t@t" },
    });

    // Point the bare path at our local origin so no network is involved.
    const bare = adapter.repoBarePath("acme/thanos");
    mkdirSync(join(bare, ".."), { recursive: true });
    execFileSync("cp", ["-a", origin, bare]);
    git(bare, "remote", "set-url", "origin", origin);

    let released = false;
    const first = adapter.allocate(ctx("session-A")).finally(() => {
      released = true;
    });

    // Second session, same branch, while the first allocation is in flight.
    let refusal;
    try {
      await adapter.allocate(ctx("session-B"));
    } catch (err) {
      refusal = String(err);
    }
    await first.catch(() => {});

    assert.ok(released, "sanity: the first allocation settled");
    assert.ok(refusal, "a second session on a live branch must be refused");
    assert.match(refusal, /already being built by another live session/);
    assert.match(refusal, /session-A/, "the refusal must name the holder so it can be diagnosed");
    assert.match(
      refusal,
      /single pull request/,
      "and must say WHY -- GitHub folds a second push onto one branch into one PR",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("beta108: the same session may re-allocate its own branch", async () => {
  const { inFlightBranchHolders } = await import("../dist/adapters/git-worktree.js");
  assert.deepEqual(inFlightBranchHolders(), [], "no allocation should be left in flight");
});

/* ------------------------------------------------------------------ *
 * Fix 3 -- phase timing
 * ------------------------------------------------------------------ */

test("beta108: review and ship both emit a phase timing", () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /private emitPhaseTiming\(/);
  assert.match(loop, /this\.emitPhaseTiming\(sessionId, "review", cycle, reviewStart/);
  // b130 re-anchored this to the start of the push rather than the start of
  // the ship-attempt loop, which spanned every cycle and made the phases sum
  // to more than the run. The property b108 cares about -- that shipping is
  // timed at all -- is unchanged.
  assert.match(loop, /this\.emitPhaseTiming\(sessionId, "ship", cycle, shipPhaseStart/);
  assert.match(loop, /this\.emitPhaseTiming\(sessionId, "executing", cycle, executeStart/);
  assert.match(loop, /"loop\.phase_timing"/);
});

test("beta108: phase timing cannot fail a run", () => {
  const loop = S("src/orchestrator/loop.ts");
  const i = loop.indexOf("private emitPhaseTiming(");
  const body = loop.slice(i, i + 900);
  assert.match(body, /try \{/);
  assert.match(body, /\} catch \{/, "an audit write must never propagate out of an observability call");
});

/* ------------------------------------------------------------------ *
 * Fix 4 -- no-change cycle early exit
 * ------------------------------------------------------------------ */

test("beta108: the early exit is guarded on every precondition", () => {
  const loop = S("src/orchestrator/loop.ts");
  const i = loop.indexOf("early_exit_no_change_cycle");
  assert.ok(i > 0, "the guard must exist");
  const block = loop.slice(i, i + 1200);
  assert.match(block, /cycle > 1/, "a first cycle with no diff still deserves a review");
  assert.match(block, /lastReview/, "there must be a prior verdict to carry forward");
  assert.match(block, /cycleBaseSha/, "an unreadable sha must not read as 'no change'");
  assert.match(block, /tipNow === cycleBaseSha/);
  assert.match(block, /loop\.cycle_no_change_early_exit/);
  assert.match(block, /carriedBlocking/, "the carried review must still govern whether shipping is safe");
});

test("beta108: the cycle base sha is captured BEFORE the workers run", () => {
  const loop = S("src/orchestrator/loop.ts");
  const base = loop.indexOf("const cycleBaseSha");
  const exit = loop.indexOf("tipNow === cycleBaseSha");
  assert.ok(base > 0 && exit > base, "the base must be read before the comparison, not after");
});

/* ------------------------------------------------------------------ *
 * Fix 5 -- the Slack surface
 * ------------------------------------------------------------------ */

const DONE = {
  phase: "Done",
  status: "done",
  terminal: true,
  total: 8,
  done: 8,
  current: null,
  spentUsd: 11.14,
  budgetUsd: 10,
  prNumber: 932,
  deployStatus: null,
};

// The verbatim reason PR #932 shipped with.
const REAL_REASON =
  'The adversary\'s final verdict was "revise", not "pass". The review loop did not sign off on this change.\n\n' +
  "CONVERGING: adversary findings were trending down across cycles (19 → 17 → 18) but the run hit the 3-cycle " +
  "ceiling before a clean pass. This looks worth extending: re-run `harness_revise` on this PR to continue from " +
  "the current findings — a clean sign-off was plausibly one or two cycles away.";

test("beta108: a do_not_merge terminal says so in the headline", () => {
  const h = buildHeadline({
    ...DONE,
    mergeRecommendation: "do_not_merge",
    mergeRecommendationReason: REAL_REASON,
  });
  assert.match(h, /PR #932/);
  assert.match(h, /Do not merge yet/, "this is the whole point: b106 shipped twice reading only 'Done'");
  // Not merely /revise/i: the reason's own first sentence contains the word
  // ("final verdict was \"revise\""), so a loose match passes even with the
  // actionable clause removed. Assert the instruction itself.
  assert.match(h, /Ask me to revise it/, "knowing a PR is bad is not knowing what to do about it");
  assert.ok(h.length < 400, `a Slack headline must stay short, got ${h.length} chars`);
});

test("beta108: the headline carries only the first sentence of the reason", () => {
  const h = buildHeadline({
    ...DONE,
    mergeRecommendation: "do_not_merge",
    mergeRecommendationReason: REAL_REASON,
  });
  assert.ok(!h.includes("19 → 17 → 18"), "the full paragraph belongs in the tools, not the thread");
});

test("beta108: a merge-ready terminal says THAT plainly too", () => {
  const h = buildHeadline({ ...DONE, mergeRecommendation: "merge", mergeRecommendationReason: "All checks passed." });
  assert.match(h, /Ready to merge/, "'Done' alone leaves the reader unsure whether it is safe");
  assert.ok(!/Do not merge/.test(h));
});

test("beta108: needs_human_review is distinguished from both", () => {
  const h = mergeAdvice("needs_human_review", "CI never reported a conclusion.");
  assert.match(h, /human/i);
  assert.ok(!/Do not merge yet/.test(h));
});

test("beta108: a session with no recommendation is unchanged from b107", () => {
  assert.equal(mergeAdvice(null, null), "");
  assert.equal(mergeAdvice("", "x"), "");
  const h = buildHeadline(DONE);
  assert.equal(h, "Done — PR #932 ($11.14/$10.00, 111% of cap).");
});

test("beta108: a non-terminal headline is untouched", () => {
  const h = buildHeadline({
    ...DONE,
    status: "executing",
    terminal: false,
    phase: "Executing",
    done: 2,
    current: { seq: 3, title: "Add continuity routes" },
    mergeRecommendation: "do_not_merge",
    mergeRecommendationReason: REAL_REASON,
  });
  assert.match(h, /Executing sub-task 3\/8/);
  assert.ok(!/Do not merge/.test(h), "merge advice belongs only on a terminal line");
});

/* --- the work log --- */

test("beta108: the work log reports what each sub-task did", () => {
  const lines = renderWorklog(
    [
      {
        seq: 1,
        title: "Continuity exercise API routes",
        status: "done",
        startedAt: 1000,
        completedAt: 39000,
        filesTouched: JSON.stringify(["a.ts", "b.ts"]),
        commitSha: "bb345173",
      },
      { seq: 2, title: "POI approval select", status: "done", startedAt: 0, completedAt: 5000, filesTouched: null, commitSha: null },
      { seq: 3, title: "Sidebar nav entry", status: "running", startedAt: 0, completedAt: null, filesTouched: null, commitSha: null },
      { seq: 4, title: "Help topic", status: "pending", startedAt: null, completedAt: null, filesTouched: null, commitSha: null },
      { seq: 5, title: "Broken one", status: "failed", startedAt: 0, completedAt: 2000, filesTouched: null, commitSha: null },
    ],
    5,
  );
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^✓ 1\/5 {2}Continuity exercise API routes/);
  assert.match(lines[0], /2 files/);
  assert.match(lines[0], /38s/);
  // A no-change sub-task is a real revise outcome -- four of five in the b106
  // revise's last cycle ended this way -- and must read differently to a commit.
  assert.match(lines[1], /^· 2\/5/);
  assert.match(lines[1], /no change/);
  assert.match(lines[2], /^⟳ 3\/5/);
  assert.match(lines[3], /^◦ 4\/5/);
  assert.match(lines[4], /^✗ 5\/5/);
});

test("beta108: the work log tolerates legacy non-JSON files_touched", () => {
  const [line] = renderWorklog(
    [{ seq: 1, title: "t", status: "done", startedAt: 0, completedAt: 1000, filesTouched: "a.ts, b.ts, c.ts", commitSha: "abc" }],
    1,
  );
  assert.match(line, /3 files/, "older rows stored a comma-separated string");
});

test("beta108: long durations read in minutes", () => {
  const [line] = renderWorklog(
    [{ seq: 1, title: "t", status: "done", startedAt: 0, completedAt: 650154, filesTouched: null, commitSha: "abc" }],
    1,
  );
  assert.match(line, /10m 50s/);
});

test("beta108: the snapshot exposes the work log", () => {
  const src = S("src/orchestrator/progress.ts");
  assert.match(src, /worklog: string\[\];/);
  assert.match(src, /worklog: renderWorklog\(stRows, all\.length\)/);
  assert.match(src, /files_touched AS filesTouched, commit_sha AS commitSha/);
});

test("beta108: harness_progress tells the agent to edit in place", () => {
  const reg = S("src/tools/registration.ts");
  const i = reg.indexOf('name: "harness_progress"');
  const desc = reg.slice(i, i + 1600);
  assert.match(desc, /worklog/);
  assert.match(desc, /EDIT your previous progress message in place/i);
  assert.match(desc, /merge recommendation/i);
  assert.ok(
    !/The harness NEVER posts to Slack itself/.test(desc),
    "that stopped being true at b77 and the stale claim misleads the agent",
  );
});

/* ------------------------------------------------------------------ *
 * Fix 6 -- harness_help
 * ------------------------------------------------------------------ */

test("beta108: help answers in outcomes, not tool names", () => {
  const help = buildHarnessHelp("all");
  assert.ok(help.summary.length > 40);
  for (const group of Object.values(help.capabilities)) {
    for (const cap of group) {
      assert.ok(cap.what.length > 20, `capability text too thin: ${cap.what}`);
      assert.ok(
        !/^harness_/.test(cap.what),
        `a capability must describe an outcome, not a tool: ${cap.what}`,
      );
    }
  }
});

test("beta108: help covers the whole lifecycle", () => {
  const help = buildHarnessHelp("all");
  for (const k of ["starting", "during", "after", "budget"]) {
    assert.ok(help.capabilities[k]?.length > 0, `missing help group: ${k}`);
  }
});

test("beta108: help states the limits that cost people time", () => {
  const limits = buildHarnessHelp("all").limits.join(" ");
  assert.match(limits, /not push to main/i);
  assert.match(limits, /will not merge/i, "the merge gate is the most-misunderstood behaviour");
  assert.match(limits, /thread/i, "one thread is one run");
});

test("beta108: revise is discoverable from the after-a-PR group", () => {
  const after = buildHarnessHelp("after");
  // Against the capability's OWN tool list, not a flat stringify of the whole
  // payload -- ALL_TOOLS would satisfy a loose match even if no capability
  // pointed at revise, which is exactly the discoverability gap b108 closes.
  const capTools = after.capabilities.after.flatMap((c) => c.tools);
  assert.ok(capTools.includes("harness_revise"), `no after-PR capability offers revise: ${capTools}`);
  const flat = JSON.stringify(after);
  assert.match(flat, /SAME pull request/i, "the in-place update is the surprising part");
  assert.ok(after.capabilities.starting === undefined, "a narrowed topic must narrow");
});

test("beta108: the help tool list matches what is actually registered", () => {
  const reg = S("src/tools/registration.ts");
  const registered = [...reg.matchAll(/name: "(harness_[a-z_]+)"/g)].map((m) => m[1]).sort();
  const advertised = [...buildHarnessHelp("all").tools].sort();
  assert.deepEqual(
    advertised,
    [...new Set(registered)],
    "help must not drift from registration the way the README did",
  );
});

test("beta108: every capability points at tools that exist", () => {
  const help = buildHarnessHelp("all");
  const known = new Set(help.tools);
  for (const [group, caps] of Object.entries(help.capabilities)) {
    for (const cap of caps) {
      for (const t of cap.tools) {
        assert.ok(known.has(t), `${group} advertises unknown tool ${t}`);
      }
    }
  }
});

test("beta108: harness_help is registered and in the manifest", () => {
  assert.match(S("src/tools/registration.ts"), /name: "harness_help"/);
  assert.ok(JSON.parse(S("openclaw.plugin.json")).contracts.tools.includes("harness_help"));
});

test("beta108: the README lists every registered tool", () => {
  const readme = S("README.md");
  for (const t of buildHarnessHelp("all").tools) {
    assert.ok(readme.includes(`\`${t}\``), `README does not document ${t}`);
  }
});

/* ------------------------------------------------------------------ *
 * Built-artifact wiring
 *
 * These read dist/ rather than src/. A source grep proves the code was
 * written; it cannot prove the shipped bundle still carries it, and the
 * mutation harness operates on dist. For pure wiring -- a value threaded from
 * config to a call, an audit name -- this is the level that actually holds.
 * ------------------------------------------------------------------ */

const D = (p) => readFileSync(new URL(`../dist/${p}`, import.meta.url), "utf8");

test("beta108: the built loop threads the adoption cap from config", () => {
  assert.match(
    D("orchestrator/loop.js"),
    /maxAdoptionsPerCycle: this\.deps\.config\.loop\.revise_max_adoptions_per_cycle \?\? 3,/,
    "an undefined cap means Infinity, i.e. uncapped -- the b106 revise's 21 misses",
  );
});

test("beta108: the built loop carries the no-change early exit", () => {
  const loop = D("orchestrator/loop.js");
  assert.match(loop, /tipNow && tipNow === cycleBaseSha/);
  assert.match(loop, /loop\.cycle_no_change_early_exit/);
});

test("beta108: the built loop emits phase timings under the agreed event name", () => {
  const loop = D("orchestrator/loop.js");
  assert.match(loop, /"loop\.phase_timing"/, "reports group by this name; renaming it silently blinds them");
  for (const phase of ['"review"', '"ship"', '"executing"']) {
    assert.ok(loop.includes(`emitPhaseTiming(sessionId, ${phase}`), `no phase timing for ${phase}`);
  }
});

test("beta108: the built snapshot really renders the work log", () => {
  assert.match(
    D("orchestrator/progress.js"),
    /worklog: renderWorklog\(stRows, all\.length\)/,
    "an empty array would leave the poller with a phase and nothing else",
  );
});

/* ------------------------------------------------------------------ *
 * Config, manifest, version
 * ------------------------------------------------------------------ */

const MINIMAL_CONFIG = {
  slack: { authorised_users: ["U1"] },
  repos: { allowed: ["acme/*"], default_base_branch: "main" },
};

test("beta108: new keys carry their documented defaults", () => {
  const c = parseHarnessConfig(MINIMAL_CONFIG);
  assert.equal(c.loop.revise_max_adoptions_per_cycle, 3);
  assert.equal(c.loop.early_exit_no_change_cycle, true);
});

test("beta108: new keys are overridable", () => {
  const c = parseHarnessConfig({
    ...MINIMAL_CONFIG,
    loop: { revise_max_adoptions_per_cycle: 0, early_exit_no_change_cycle: false },
  });
  assert.equal(c.loop.revise_max_adoptions_per_cycle, 0);
  assert.equal(c.loop.early_exit_no_change_cycle, false);
});

test("beta108: new keys are declared in both schemas", () => {
  for (const f of ["src/config.schema.json", "openclaw.plugin.json"]) {
    const flat = S(f);
    assert.match(flat, /revise_max_adoptions_per_cycle/, `${f} missing the adoption cap`);
    assert.match(flat, /early_exit_no_change_cycle/, `${f} missing the early exit`);
  }
});

test("beta108: parallel sub-tasks are GONE, not merely off", () => {
  // The original reason they were off still holds and is why they were deleted
  // rather than fixed: every sub-task shares ONE worktree (plan.worktreePath)
  // and GitAdapter.commit stages with an unscoped `git add -A`, so two
  // concurrent workers sweep each other's half-finished edits into their
  // commits. The b91 overlap guard compares DECLARED scope only, and b106
  // measured committedCount 141 against declaredCount 7.
  //
  // v2.0.0 removed the mechanism. The keys are still ACCEPTED (the gateway
  // manifest is additionalProperties:false, so dropping them would reject an
  // operator's whole config) but they are dropped at parse time, so nothing
  // downstream can read a setting nothing obeys.
  const c = parseHarnessConfig({
    ...MINIMAL_CONFIG,
    loop: { ...(MINIMAL_CONFIG.loop ?? {}), parallel_independent_subtasks: true, subtask_concurrency: 8 },
  });
  assert.equal(c.loop.parallel_independent_subtasks, undefined, "the removed key must not survive parse");
  assert.equal(c.loop.subtask_concurrency, undefined, "the removed key must not survive parse");
  assert.match(S("src/adapters/git-worktree.ts"), /"add", "-A"/);
});

test("beta108: pluginVersion and package.json agree at >= beta.108", () => {
  const betaNum = betaOrdinal;
  const pkg = JSON.parse(S("package.json")).version;
  assert.ok(betaNum(pkg) >= 108, `expected >= beta.108, got ${pkg}`);
  const ver = S("src/version.ts");
  assert.ok(ver.includes(pkg), `src/version.ts disagrees with package.json (${pkg})`);
});
