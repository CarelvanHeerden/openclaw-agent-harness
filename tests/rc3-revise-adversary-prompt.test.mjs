// rc.3 -- the revise adversary prompt says which instruction is which.
//
// A revise brief flattens three different things into one string: what the
// feature was originally asked to do, what the operator now wants changed, and
// what this revision must not do. On StitchGuard PR #1168 the adversary read
// the third as a complaint about the first. "No new schema or migration
// redesign" was a rule for the two-file revision; the adversary treated it as
// proof that the feature's Prisma models and migration should never have been
// there, and produced a high-severity finding telling workers to delete the
// persistence the whole PR was built on -- every cycle.
//
// The fix is not a stronger instruction, it is a structure: five labelled
// sections and an explicit statement that the exclusions are not retroactive.
// An ordinary run has nothing to separate and keeps the prompt it always had.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");
const skip = existsSync(join(root, "dist", "orchestrator", "adversary.js")) ? false : "dist not built";
const skipDist = { skip };

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

const BASE_INPUT = {
  crystallisedPrompt: "Title: Revise: SAST sheet\nMotivation: m\nAcceptance criteria:\n- Address each adversary finding",
  diffPath: "/tmp/x.diff",
  repoPath: "/tmp/wt",
  reviewChecklist: ["check the manifest"],
  model: "m",
  timeoutSeconds: 60,
};

const REVISION = {
  originalFeatureContract: [
    "Title: SAST sheet",
    "Motivation: security findings need a home",
    "Acceptance criteria:",
    "- persist SAST findings",
    "- expose them through an API",
  ].join("\n"),
  directives: [
    "Add sidebar workflow-manifest declarations",
    "Move Source Code column filtering from client-side to dataset-wide server filtering",
  ],
  guidance: "Two focused changes only. Do not redesign the schema or add a migration.",
  outOfScopeRules: ["No new schema or migration redesign"],
  deltaFiles: ["src/lib/workflow-manifest.ts", "src/app/security/sast/filters.tsx"],
  revisionStartSha: "1410e98db1f00bbe850ab73a8f3784c6f6c023f3",
  originalPrBaseSha: "d6541d5bb69d6fc7bcee06db82f382a1bf6c0e06",
};

// ---------------------------------------------------------------------------
// 17. THE SECTIONS, AND THE PRECEDENCE BETWEEN THEM
// ---------------------------------------------------------------------------

test("17: a revise prompt carries all five labelled sections, in order", skipDist, async () => {
  const { buildAdversarySystemPrompt } = await import("../dist/orchestrator/adversary.js");
  const prompt = buildAdversarySystemPrompt({ ...BASE_INPUT, revision: REVISION });

  const order = [
    "## ORIGINAL FEATURE CONTRACT",
    "## OPERATOR REVISION DIRECTIVES",
    "## REVISION-ONLY OUT-OF-SCOPE RULES",
    "## REVISION DELTA",
    "## COMPLETE PR DIFF FOR CORRECTNESS CONTEXT",
  ];
  let cursor = -1;
  for (const heading of order) {
    const at = prompt.indexOf(heading);
    assert.ok(at > 0, `${heading} is missing`);
    assert.ok(at > cursor, `${heading} is out of order; the contract has to be read before the exclusions`);
    cursor = at;
  }
});

test("17: the feature contract is the source of truth, and the directives are additive", skipDist, async () => {
  const { buildAdversarySystemPrompt } = await import("../dist/orchestrator/adversary.js");
  const prompt = buildAdversarySystemPrompt({ ...BASE_INPUT, revision: REVISION });

  assert.match(prompt, /## ORIGINAL FEATURE CONTRACT \(SOURCE OF TRUTH for spec fidelity\)/);
  assert.ok(prompt.includes("- persist SAST findings"), "the feature's own criteria, not the revise brief's paraphrase");
  assert.match(prompt, /ORIGINAL FEATURE CONTRACT remains authoritative/);
  assert.match(prompt, /ADDITIVE corrections/);
  for (const d of REVISION.directives) assert.ok(prompt.includes(`- ${d}`), `directive missing: ${d}`);
  assert.ok(prompt.includes(REVISION.guidance), "and the operator's own words, verbatim");
});

test("17: the exclusions are stated as forward-looking, never retroactive", skipDist, async () => {
  const { buildAdversarySystemPrompt } = await import("../dist/orchestrator/adversary.js");
  const prompt = buildAdversarySystemPrompt({ ...BASE_INPUT, revision: REVISION });

  assert.ok(prompt.includes("- No new schema or migration redesign"), "the rule itself is still stated");
  assert.match(prompt, /not retroactive/i);
  assert.match(prompt, /do NOT prohibit code the feature already landed/i);
  // The exact #1168 misreading, named so it cannot be inferred the other way.
  assert.match(prompt, /It is NOT a finding that the feature's existing models and migration exist/);
  assert.match(
    prompt,
    /Do NOT recommend removing original feature code merely because it falls outside the narrow revision task/,
  );
});

test("17: scope is judged against the delta, correctness against the whole PR", skipDist, async () => {
  const { buildAdversarySystemPrompt } = await import("../dist/orchestrator/adversary.js");
  const prompt = buildAdversarySystemPrompt({ ...BASE_INPUT, revision: REVISION });

  for (const f of REVISION.deltaFiles) assert.ok(prompt.includes(`- ${f}`), `delta file missing: ${f}`);
  assert.ok(prompt.includes("1410e98db1f0..HEAD"), "the delta window is named by its base");
  assert.ok(prompt.includes("d6541d5bb69d..HEAD"), "and the correctness window by its own");
  assert.match(prompt, /Judge SCOPE against the revision delta; judge CORRECTNESS against the whole diff/);
  // The point of keeping the wide window: a revision can break what it never
  // touched, and a defect the feature shipped with is still a defect.
  assert.match(prompt, /a defect in the original feature is still a defect/);
});

test("a revision with no directives or delta yet still renders every section", skipDist, async () => {
  const { buildAdversarySystemPrompt } = await import("../dist/orchestrator/adversary.js");
  const prompt = buildAdversarySystemPrompt({
    ...BASE_INPUT,
    revision: { ...REVISION, directives: [], outOfScopeRules: [], deltaFiles: [], guidance: undefined },
  });
  assert.match(prompt, /## OPERATOR REVISION DIRECTIVES/);
  assert.ok(prompt.includes("- (none recorded)"), "an empty section says so rather than vanishing");
  assert.ok(prompt.includes("- (no files committed by this revision yet)"));
  // Cycle 1 of a revise runs before any worker commits; the prompt must still
  // be readable, and must not silently become an ordinary-run prompt.
  assert.equal(prompt.includes("## The brief (SOURCE OF TRUTH"), false);
});

// ---------------------------------------------------------------------------
// 36. AN ORDINARY RUN IS UNTOUCHED
// ---------------------------------------------------------------------------

test("36: an ordinary run keeps the single-brief prompt, byte for byte", skipDist, async () => {
  const { buildAdversarySystemPrompt } = await import("../dist/orchestrator/adversary.js");
  const prompt = buildAdversarySystemPrompt(BASE_INPUT);

  assert.match(prompt, /## The brief \(SOURCE OF TRUTH for spec fidelity\)/);
  assert.ok(prompt.includes(BASE_INPUT.crystallisedPrompt));
  for (const heading of ["ORIGINAL FEATURE CONTRACT", "OPERATOR REVISION DIRECTIVES", "REVISION DELTA"]) {
    assert.equal(prompt.includes(heading), false, `${heading} has no meaning on a run that is not a revision`);
  }
  // Everything the ordinary prompt has always carried is still there.
  for (const marker of ["## Dimensions", "## Finding discipline (CRITICAL)", "## Runtime banner", "## Verdict rules"]) {
    assert.ok(prompt.includes(marker), `${marker} must survive the restructure`);
  }
});

test("buildRevisionBriefSections is the only thing that switches the two prompts", skipDist, async () => {
  const { buildRevisionBriefSections } = await import("../dist/orchestrator/adversary.js");
  assert.equal(buildRevisionBriefSections(BASE_INPUT), null, "no revision context, no sections");
  assert.ok(Array.isArray(buildRevisionBriefSections({ ...BASE_INPUT, revision: REVISION })));
});

// ---------------------------------------------------------------------------
// THE CONTEXT IS BUILT FROM WHAT WAS PINNED, NOT FROM THE FLATTENED BRIEF
// ---------------------------------------------------------------------------

async function loopWithSession(row) {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran,
       plan_base_sha, original_pr_base_sha, revision_start_sha, original_feature_brief, operator_revision_brief)
     VALUES ('S1','T','C','U1','u1','o/r','harness/x','/w','reviewing', ?, ?, ?, 50, 0, 2, ?, ?, ?, ?, ?)`,
  ).run(
    row.crystallisedPrompt ?? "{}",
    now,
    now,
    "d6541d5bb69d6fc7bcee06db82f382a1bf6c0e06",
    row.originalPrBaseSha ?? null,
    row.revisionStartSha ?? null,
    row.originalFeatureBrief ?? null,
    row.operatorRevisionBrief ?? null,
  );
  const loop = new OrchestratorLoop({
    state,
    logger: QUIET,
    config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    worktreeCommittedFiles: async () => ["src/lib/workflow-manifest.ts"],
  });
  return { loop, db, audits };
}

const PLAN = { repo: "o/r", branch: "harness/x", worktreePath: "/w", riskLevel: "low", reviewChecklist: [], approxCostUsd: 0, subTasks: [] };

test("the context comes from the pinned columns, and the delta from the pinned sha", skipDist, async () => {
  const { loop } = await loopWithSession({
    originalPrBaseSha: "d6541d5bb69d6fc7bcee06db82f382a1bf6c0e06",
    revisionStartSha: "1410e98db1f00bbe850ab73a8f3784c6f6c023f3",
    originalFeatureBrief: JSON.stringify({
      title: "SAST sheet",
      motivation: "security findings need a home",
      acceptanceCriteria: ["persist SAST findings"],
      outOfScope: ["multi-tenant rollout"],
    }),
    operatorRevisionBrief: JSON.stringify({
      guidance: "Do not redesign the schema.",
      directives: ["parseInt accepts trailing junk"],
    }),
    crystallisedPrompt: JSON.stringify({
      title: "Revise: SAST sheet",
      motivation: "m",
      acceptanceCriteria: [],
      // The feature's own exclusion is repeated here; only the NEW one belongs
      // in the revision-only section.
      outOfScope: ["multi-tenant rollout", "No new schema or migration redesign"],
    }),
  });

  const ctx = await loop.buildRevisionReviewContext("S1", PLAN);
  assert.ok(ctx);
  assert.match(ctx.originalFeatureContract, /Title: SAST sheet/);
  assert.match(ctx.originalFeatureContract, /- persist SAST findings/);
  assert.deepEqual(ctx.directives, ["parseInt accepts trailing junk"]);
  assert.equal(ctx.guidance, "Do not redesign the schema.");
  assert.deepEqual(
    ctx.outOfScopeRules,
    ["No new schema or migration redesign"],
    "an exclusion the FEATURE already declared is not a revision-only rule; repeating it there invites the retroactive reading back in",
  );
  assert.deepEqual(ctx.deltaFiles, ["src/lib/workflow-manifest.ts"]);
  assert.equal(ctx.revisionStartSha, "1410e98db1f00bbe850ab73a8f3784c6f6c023f3");
  assert.equal(ctx.originalPrBaseSha, "d6541d5bb69d6fc7bcee06db82f382a1bf6c0e06");
});

test("an ordinary session, and a pre-rc.3 revise, both build no context", skipDist, async () => {
  const plain = await loopWithSession({});
  assert.equal(await plain.loop.buildRevisionReviewContext("S1", PLAN), undefined);

  // A revise session started before the columns existed: the row has a
  // revision_start_sha but no briefs. Better the old prompt than half of one.
  const partial = await loopWithSession({ revisionStartSha: "1410e98d" });
  assert.equal(await partial.loop.buildRevisionReviewContext("S1", PLAN), undefined);
});

test("the review passes the revision context to BOTH adversary calls", () => {
  const src = S("src/orchestrator/loop.ts");
  const calls = [...src.matchAll(/this\.deps\.runAdversary\(\{/g)];
  assert.equal(calls.length, 2, "the plain review and the runtime-enriched re-review");
  for (const c of calls) {
    const window = src.slice(c.index, c.index + 500);
    assert.match(window, /revision: revisionContext/, "a re-review with the flattened brief would undo the fix");
  }
  assert.match(S("src/index.ts"), /^\s+revision,$/m, "and the adapter has to forward it");
});
