// beta.104 — the lead gets to see the repository.
//
// THE DEFECT. Every lead call ran through `structuredCall`, which sets
// `tools: []` and disallows Read/Glob/Grep, and `runLeadPlanner` called the
// lead model BEFORE `allocateWorktree` — so there was no worktree either. The
// lead planned entire features, file paths and verbatim code excerpts included,
// having never opened a single file of the repo it was planning against. The
// b67 gate simultaneously REQUIRED those excerpts, so the harness was mandating
// fabrication and then spending five downstream mechanisms detecting it.
//
// In the b102 smoke (session 670c8440, ProjectThanos PR #906) that produced
// `loop.plan_paths_suspect count=7` in a single plan: `(app)` where the repo
// uses `(portal)`, `components/layout` where it uses `components/ui`. Workers
// re-explored anyway — context that is confidently wrong is worse than none —
// which is where the wall-clock went.
//
// The fixtures below are that run's real paths.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let scout, runLeadPlanner, isRepoAllowed, buildAdversarySystemPrompt, parseHarnessConfig;
try {
  scout = await import("../dist/orchestrator/lead-scout.js");
  ({ runLeadPlanner, isRepoAllowed } = await import("../dist/orchestrator/lead.js"));
  ({ buildAdversarySystemPrompt } = await import("../dist/orchestrator/adversary.js"));
  ({ parseHarnessConfig } = await import("../dist/config.js"));
} catch {
  scout = undefined;
}
const skip = scout === undefined;

const FICTIONAL = "src/app/(app)/grc/continuity-exercises/page.tsx";
const REAL = "src/app/(portal)/grc/continuity-exercises/page.tsx";
const REPORT = `The app router uses the route group (portal), not (app). Verified: src/app/(portal)/grc/ contains 9 feature directories and src/app/(app) does not exist.\n\n${REAL} would be the correct location.`;

const CONFIG = {
  repos: { allowed: ["Stitch-Vercel/*"], default_base_branch: "main" },
  loop: {},
};
const BRIEF = () => ({
  title: "Add continuity exercises",
  motivation: "DR/BCP evidence",
  acceptanceCriteria: ["exercises can be listed"],
  filesLikelyTouched: [FICTIONAL],
  outOfScope: [],
  repoHint: "Stitch-Vercel/ProjectThanos",
  riskLevel: "medium",
});
const PLAN = () => ({
  repo: "Stitch-Vercel/ProjectThanos",
  branch: "harness/continuity",
  subTasks: [{
    seq: 1, title: "page", intent: "i", filesLikelyTouched: [REAL],
    successCriteria: ["x"], estimatedTokens: 1000, contractScope: "local",
    taskMode: "mutate", verify: [{ kind: "commit_made" }],
    workerContext: { rationale: "r", changeSpec: `create ${REAL} following the sibling risk-reviews page` },
  }],
  reviewChecklist: ["c"],
  riskLevel: "medium",
});

/** runLeadPlanner deps with a scout that succeeds unless overridden. */
function deps(over = {}) {
  const calls = { scout: 0, lead: 0, briefSeenByLead: undefined };
  return {
    calls,
    d: {
      config: CONFIG,
      logger: { info() {}, warn() {} },
      callLeadModel: async (b) => { calls.lead += 1; calls.briefSeenByLead = b; return PLAN(); },
      allocateWorktree: async () => "/tmp/wt",
      estimateCost: () => 1,
      scoutRepo: async () => { calls.scout += 1; return { report: REPORT, costUsd: 0.4 }; },
      ...over,
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The scout runs, and its findings reach the planning call
// ---------------------------------------------------------------------------

test("beta104: the scout runs BEFORE the lead model and its report reaches the brief", { skip }, async () => {
  const order = [];
  const { d, calls } = deps({
    scoutRepo: async () => { order.push("scout"); return { report: REPORT }; },
    callLeadModel: async (b) => { order.push("lead"); calls.briefSeenByLead = b; return PLAN(); },
  });
  const plan = await runLeadPlanner(BRIEF(), d);
  assert.deepEqual(order, ["scout", "lead"], "planning blind is the whole defect; the scout must precede the plan");
  assert.equal(calls.briefSeenByLead.repoScoutReport, REPORT);
  assert.equal(plan.scout.ran, true);
  assert.equal(plan.scout.reportChars, REPORT.length);
});

test("beta104: the worktree is still allocated from the PLAN, not the scout", { skip }, async () => {
  let allocatedFor;
  const { d } = deps({ allocateWorktree: async (repo, branch) => { allocatedFor = { repo, branch }; return "/tmp/wt"; } });
  await runLeadPlanner(BRIEF(), d);
  assert.deepEqual(allocatedFor, { repo: "Stitch-Vercel/ProjectThanos", branch: "harness/continuity" },
    "the scout's throwaway worktree must not become the run's worktree");
});

// ---------------------------------------------------------------------------
// 2. Every failure path degrades to the pre-b104 blind plan, never to a crash
// ---------------------------------------------------------------------------

test("beta104: a THROWING scout does not fail the run; the lead plans blind", { skip }, async () => {
  const { d, calls } = deps({ scoutRepo: async () => { throw new Error("worktree allocation failed"); } });
  const plan = await runLeadPlanner(BRIEF(), d);
  assert.equal(calls.lead, 1, "the plan must still be produced");
  assert.equal(calls.briefSeenByLead.repoScoutReport, undefined);
  assert.equal(plan.scout.ran, false);
  assert.equal(plan.scout.skippedReason, "error");
  assert.match(plan.scout.error, /worktree allocation failed/);
});

test("beta104: an EMPTY report is treated as no report, not as an empty authority", { skip }, async () => {
  const { d, calls } = deps({ scoutRepo: async () => ({ report: "   " }) });
  const plan = await runLeadPlanner(BRIEF(), d);
  assert.equal(calls.briefSeenByLead.repoScoutReport, undefined,
    "an empty 'repo investigation' section would tell the lead the repo contains nothing");
  assert.equal(plan.scout.skippedReason, "empty_report");
});

test("beta104: no resolvable repoHint skips the scout rather than guessing a repo", { skip }, async () => {
  // This fixture's allow-list is `Stitch-Vercel/*`, a glob, which names no
  // single repo to clone. b113 lets a SOLE CONCRETE allow-list entry stand in
  // for a missing hint; a glob is still not one, so the skip holds and only
  // the label sharpened to say why.
  const { d, calls } = deps();
  const plan = await runLeadPlanner({ ...BRIEF(), repoHint: undefined }, d);
  assert.equal(calls.scout, 0);
  assert.equal(plan.scout.skippedReason, "no_repo_hint_and_no_sole_allowed_repo");
});

test("beta104: a repoHint outside the allow-list is never checked out", { skip }, async () => {
  const { d, calls } = deps();
  const plan = await runLeadPlanner({ ...BRIEF(), repoHint: "attacker/evil" }, d);
  assert.equal(calls.scout, 0, "scouting clones and reads a repo; the allow-list must gate it");
  assert.equal(plan.scout.skippedReason, "repo_not_allowed");
});

test("beta104: the allow-list gate honours owner/* globs, as validatePlan does", { skip }, () => {
  assert.equal(isRepoAllowed("Stitch-Vercel/ProjectThanos", ["Stitch-Vercel/*"]), true,
    "an exact-match-only gate would silently disable the scout for most repos");
  assert.equal(isRepoAllowed("Stitch-Vercel/ProjectThanos", ["Stitch-Vercel/ProjectThanos"]), true);
  assert.equal(isRepoAllowed("other/repo", ["Stitch-Vercel/*"]), false);
  assert.equal(isRepoAllowed("notarepo", ["Stitch-Vercel/*"]), false);
});

test("beta104: lead_repo_scout_enabled:false restores the exact pre-b104 behaviour", { skip }, async () => {
  const { d, calls } = deps({ config: { ...CONFIG, loop: { lead_repo_scout_enabled: false } } });
  const plan = await runLeadPlanner(BRIEF(), d);
  assert.equal(calls.scout, 0);
  assert.equal(calls.briefSeenByLead.repoScoutReport, undefined);
  assert.equal(plan.scout.skippedReason, "disabled");
});

test("beta104: an unwired scoutRepo dep is not an error", { skip }, async () => {
  const { d, calls } = deps({ scoutRepo: undefined });
  const plan = await runLeadPlanner(BRIEF(), d);
  assert.equal(calls.lead, 1);
  assert.equal(plan.scout.skippedReason, "unwired");
});

test("beta104: the report is bounded before it reaches the prompt", { skip }, async () => {
  const huge = "x".repeat(60000);
  const { d, calls } = deps({
    config: { ...CONFIG, loop: { lead_scout_max_chars: 5000 } },
    scoutRepo: async () => ({ report: huge }),
  });
  await runLeadPlanner(BRIEF(), d);
  const seen = calls.briefSeenByLead.repoScoutReport;
  assert.ok(seen.length < 6000, `b98 died on an oversized lead input; got ${seen.length} chars`);
  assert.match(seen, /truncated/);
});

// ---------------------------------------------------------------------------
// 3. Bounding and rendering — pure
// ---------------------------------------------------------------------------

test("beta104: truncation keeps the HEAD, where the paths and conventions are", { skip }, () => {
  const r = scout.boundScoutReport(`${REAL} is the real location.\n${"filler ".repeat(5000)}`, 200);
  assert.ok(r.startsWith(REAL), "the scout reports locations first and traps last");
  assert.match(r, /chars omitted/);
});

test("beta104: a report under the ceiling is passed through untouched", { skip }, () => {
  assert.equal(scout.boundScoutReport(REPORT, 20000), REPORT);
});

test("beta104: no report renders to nothing, so the prompt is unchanged when the scout is off", { skip }, () => {
  assert.equal(scout.renderScoutForPrompt(undefined), "");
  assert.equal(scout.renderScoutForPrompt("  "), "");
});

test("beta104: the rendered block frames the report as the ONLY source of repo facts", { skip }, () => {
  const r = scout.renderScoutForPrompt(REPORT);
  assert.match(r, /ONLY source of repo facts/,
    "without this the planner treats the report as background and keeps inventing paths");
  assert.match(r, /MUST come from this report/);
  assert.match(r, /NO repo access now/);
  assert.ok(r.includes(REAL));
});

test("beta104: the scout is told the upstream paths are UNVERIFIED guesses", { skip }, () => {
  const m = scout.buildScoutUserMessage(BRIEF());
  assert.match(m, /UNVERIFIED/);
  assert.ok(m.includes(FICTIONAL), "the guessed path must be handed over for checking, not silently trusted");
});

test("beta104: the scout is told not to assume conventional layouts", { skip }, () => {
  const p = scout.buildScoutSystemPrompt();
  assert.match(p, /route groups/i, "route groups are the exact b102 failure ((app) vs (portal))");
  assert.match(p, /Do not assume conventional layouts/i);
  assert.match(p, /READ-ONLY/);
  assert.match(p, /NOT JSON/, "this turn has no schema; a JSON demand here would re-create the b40 drift");
});

// ---------------------------------------------------------------------------
// 4. Read-only is enforced, and reviewer independence survives
// ---------------------------------------------------------------------------

test("beta104: the scout's tool allow-list contains no way to mutate the worktree", { skip }, () => {
  assert.deepEqual([...scout.SCOUT_ALLOWED_TOOLS].sort(), ["Glob", "Grep", "Read"]);
  for (const t of ["Write", "Edit", "Bash", "Task", "NotebookEdit"]) {
    assert.ok(!scout.SCOUT_ALLOWED_TOOLS.includes(t), `${t} must never be available to the scout`);
    assert.ok(scout.SCOUT_DENIED_TOOLS.includes(t), `${t} must also be denied explicitly`);
  }
});

test("beta104: the SDK call enforces read-only three times over", { skip }, () => {
  const src = S("src/adapters/claude-sdk.ts");
  const fn = src.slice(src.indexOf("export async function runLeadScoutSdk"));
  const body = fn.slice(0, fn.indexOf("\n// ---- Structured-output helpers"));
  assert.match(body, /tools: \[\.\.\.params\.allowedTools\]/, "the allow-list is the authoritative switch");
  assert.match(body, /disallowedTools: \[\.\.\.params\.deniedTools\]/);
  assert.match(body, /if \(allowed\.has\(toolName\)\) return \{ behavior: "allow"/);
  assert.match(body, /behavior: "deny"/, "anything off the allow-list must be refused at canUseTool too");
});

test("beta104: the ADVERSARY still cannot see the scout report", { skip }, () => {
  // The reviewer's prompt is built from a hand-written projection of the brief,
  // never the brief object. If that ever becomes JSON.stringify(brief), the
  // reviewer starts reviewing against the planner's own investigation and
  // independence is gone.
  const prompt = buildAdversarySystemPrompt({
    crystallisedPrompt: `Title: ${BRIEF().title}\nMotivation: m\nAcceptance criteria:\n- a`,
    diffPath: "/tmp/d.diff",
    repoPath: "/tmp/wt",
    reviewChecklist: ["exercises can be listed"],
    model: "m",
    timeoutSeconds: 60,
  });
  assert.ok(!prompt.includes(REPORT), "the report must not reach the reviewer");
  assert.ok(!prompt.includes("repoScoutReport"));
  assert.ok(!/ONLY source of repo facts/.test(prompt));
});

test("beta104: index.ts builds the adversary prompt from a projection, not the brief object", { skip }, () => {
  const src = S("src/index.ts");
  const at = src.indexOf("crystallisedPrompt:");
  assert.ok(at > 0);
  const block = src.slice(at, at + 400);
  assert.ok(!/JSON\.stringify\(brief\)/.test(block),
    "serialising the whole brief here would leak the scout report to the reviewer");
  assert.match(block, /Title: \$\{brief\.title\}/);
});

// ---------------------------------------------------------------------------
// 5. The planning prompt stops asking for code the lead never read
// ---------------------------------------------------------------------------

test("beta104: the lead is no longer told codeExcerpts is code it read", { skip }, () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.ok(!src.includes("the ACTUAL code you read, verbatim, with `path` and `startLine`"),
    "the pre-b104 wording demanded excerpts from a toolless call — it mandated fabrication");
  assert.match(src, /code quoted from your repo investigation below/);
  assert.match(src, /NEVER write an excerpt you cannot point to in that report/);
});

test("beta104: the report is sent ONCE — system prompt only, stripped from the brief JSON", { skip }, () => {
  const src = S("src/adapters/claude-sdk.ts");
  assert.match(src, /const \{ repoScoutReport: _scoutInSystemPrompt, \.\.\.briefForMessage \} = params\.brief;/);
  assert.match(src, /JSON\.stringify\(briefForMessage\)/,
    "sending the report in both places pays for it twice and buries the framing");
});

test("beta104: the planning call itself still has no tools", { skip }, () => {
  const src = S("src/adapters/claude-sdk.ts");
  const at = src.indexOf("async function structuredCall");
  const sc = src.slice(at, src.indexOf("export async function runCrystalliserSdk", at));
  assert.match(sc, /\n {8}tools: \[\],/,
    "b28/b40: a tool-enabled planner wrote its plan to a file instead of returning JSON");
});

// ---------------------------------------------------------------------------
// 6. Wiring
// ---------------------------------------------------------------------------

test("beta104: the scout worktree skips the dependency bootstrap and is always released", { skip }, () => {
  const src = S("src/index.ts");
  const at = src.indexOf("scoutRepo: async (");
  assert.ok(at > 0, "scoutRepo must be wired into the lead deps");
  const block = src.slice(at, src.indexOf("allocateWorktree: async (repo, branch)", at));
  assert.match(block, /bootstrapDeps: false/, "npm ci for a read-only look would add minutes to every run");
  assert.match(block, /\} finally \{/, "a scout failure must not leak a worktree");
  assert.match(block, /releaseByPath\(scoutWorktree, repoFullName\)/);
});

test("beta104: a per-allocation bootstrapDeps overrides the adapter default", { skip }, () => {
  const src = S("src/adapters/git-worktree.ts");
  assert.match(src, /const bootstrap = ctx\.bootstrapDeps \?\? this\.opts\.bootstrapDeps;/);
  assert.match(src, /if \(bootstrap !== false\) \{/,
    "undefined must keep bootstrapping, so the real run worktree is unaffected");
});

test("beta104: the loop audits whether the lead actually saw the repo", { skip }, () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /"loop\.lead_scout"/,
    "b102 could not tell a delivered dispatch hint from a dropped one; the scout must not repeat that");
  assert.match(src, /skippedReason: plan\.scout\.skippedReason/);
  assert.match(src, /reportChars: plan\.scout\.reportChars/);
});

// A report spanning several assistant messages, driven through the real stream
// consumer. Keeping only the last message would silently drop the front of the
// report -- which is where the scout puts the paths and conventions, so the
// truncation would be invisible AND maximally damaging.
async function* multiMessageStream() {
  yield { type: "system", subtype: "init", session_id: "scout-1" };
  yield { type: "assistant", message: { content: [{ type: "text", text: "The route group is (portal), not (app)." }] } };
  yield { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Grep", input: {} }] } };
  yield { type: "assistant", message: { content: [{ type: "text", text: `Tests live in __tests__/, e.g. ${REAL}` }] } };
  yield { type: "result", subtype: "success", total_cost_usd: 0.4, usage: { input_tokens: 10, output_tokens: 20 } };
}

test("beta104: a report spanning several messages is returned whole, not just its last chunk", { skip }, async () => {
  const { consumeWorkerStream } = await import("../dist/adapters/claude-sdk.js");
  const r = await consumeWorkerStream(multiMessageStream(), new AbortController(), { accumulateAllText: true });
  assert.ok(r.allText.includes("(portal), not (app)"), "the FIRST text block carries the finding that matters most");
  assert.ok(r.allText.includes("__tests__/"));
  assert.equal(r.finalMessage.includes("(portal), not (app)"), false, "finalMessage keeps its existing last-message meaning");
});

test("beta104: the worker path is unchanged — no accumulation unless asked", { skip }, async () => {
  const { consumeWorkerStream } = await import("../dist/adapters/claude-sdk.js");
  const r = await consumeWorkerStream(multiMessageStream(), new AbortController(), {});
  assert.equal(r.allText, undefined, "workers want the concluding statement alone; this must not change under them");
  assert.match(r.finalMessage, /__tests__/);
});

test("beta104: the scout call opts into accumulation", { skip }, () => {
  const src = S("src/adapters/claude-sdk.ts");
  const fn = src.slice(src.indexOf("export async function runLeadScoutSdk"));
  assert.match(fn.slice(0, 4000), /accumulateAllText: true/);
});

// ---------------------------------------------------------------------------
// 7. Config + version
// ---------------------------------------------------------------------------

test("beta104: the new keys carry their documented defaults", { skip }, () => {
  const cfg = parseHarnessConfig({
    slack: { channel: "C1", authorised_users: ["U1"] },
    repos: { allowed: ["example-org/*"], default_base_branch: "main" },
  });
  assert.equal(cfg.loop.lead_repo_scout_enabled, true);
  // b106 lowered this 600 -> 420 and made the loop ADD it to the lead budget.
  assert.equal(cfg.loop.lead_scout_timeout_seconds, 420);
  // b107 raised this 20000 -> 32000 after b106 truncated a real report at it.
  assert.equal(cfg.loop.lead_scout_max_chars, 32000);
});

test("beta104: an operator can turn the scout off", { skip }, () => {
  const cfg = parseHarnessConfig({
    slack: { channel: "C1", authorised_users: ["U1"] },
    repos: { allowed: ["example-org/*"], default_base_branch: "main" },
    loop: { lead_repo_scout_enabled: false, lead_scout_max_chars: 4000 },
  });
  assert.equal(cfg.loop.lead_repo_scout_enabled, false);
  assert.equal(cfg.loop.lead_scout_max_chars, 4000);
});

test("beta104: the new keys are declared in the plugin manifest", () => {
  const loop = JSON.parse(S("openclaw.plugin.json")).configSchema.properties.loop.properties;
  assert.equal(loop.lead_repo_scout_enabled.default, true);
  assert.equal(loop.lead_scout_timeout_seconds.default, 420);
  assert.equal(loop.lead_scout_max_chars.default, 32000);
});

test("beta104: pluginVersion and package.json agree at >= beta.104", { skip }, async () => {
  const { PLUGIN_VERSION } = await import("../dist/version.js");
  const pkg = JSON.parse(S("package.json"));
  assert.equal(PLUGIN_VERSION.pluginVersion, pkg.version);
  const n = betaOrdinal(pkg.version);
  assert.ok(n >= 104, `expected >= beta.104, got ${pkg.version}`);
});
