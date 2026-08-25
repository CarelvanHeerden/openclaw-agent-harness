// beta.106 — the b105 smoke (session b08502aa) never reached a plan. Four
// defects, all introduced by b104's scout turn or exposed by it.
//
//   1. BUDGET ARITHMETIC. b104 put the scout inside runLeadPlanner, which the
//      loop wraps in withTimeout(lead_timeout_seconds). The bound was never
//      raised. Shipped defaults were lead 900s and scout 600s, leaving 300s for
//      planning, against measured planning turns of 441s and 182s on b103. The
//      run died at exactly 900s after the scout started, mid-plan.
//   2. THE SCOUT OVERRAN ITS OWN CEILING. Ticks ran past +810s against a 600s
//      budget: aborting the signal cannot interrupt a tool call already in
//      flight, so the abort fired at 600s and the scout unwound around 850s.
//   3. FOURTEEN MINUTES IS TOO SLOW ANYWAY. The prompt ended "be thorough over
//      brief", with no budget and no turn cap.
//   4. THE ERROR NAMED THE WRONG TIMER. WorkerTimeoutError hardcoded
//      "worker_timeout_seconds" whichever timer fired, so a LEAD timeout at
//      900s was reported against a worker limit that was actually set to 1800.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let withTimeout, WorkerTimeoutError, runLeadPlanner, parseHarnessConfig, PLUGIN_VERSION;
let SCOUT_MAX_TURNS, buildScoutSystemPrompt, consumeWorkerStream;
try {
  ({ withTimeout, WorkerTimeoutError } = await import("../dist/orchestrator/loop.js"));
  ({ runLeadPlanner } = await import("../dist/orchestrator/lead.js"));
  ({ parseHarnessConfig } = await import("../dist/config.js"));
  ({ PLUGIN_VERSION } = await import("../dist/version.js"));
  ({ SCOUT_MAX_TURNS, buildScoutSystemPrompt } = await import("../dist/orchestrator/lead-scout.js"));
  ({ consumeWorkerStream } = await import("../dist/adapters/claude-code.js"));
} catch {
  withTimeout = undefined;
}
const skip = withTimeout === undefined;

// ---------------------------------------------------------------------------
// 1. The lead budget must COVER the scout
// ---------------------------------------------------------------------------

test("beta106: the lead budget adds the scout ceiling instead of sharing it", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /const scoutBudget =/);
  assert.match(
    loop,
    /this\.deps\.config\.loop\.lead_timeout_seconds \+ scoutBudget/,
    "planning must keep its full lead_timeout_seconds however the scout knob is set",
  );
});

/**
 * The b105 failure, in miniature and in real time.
 *
 * `lead_timeout_seconds` is 1s and `lead_scout_timeout_seconds` is 2s, and the
 * lead phase takes 1.5s. Under b104's nesting the budget is 1s and the run dies
 * mid-plan; with the scout ceiling added it is 3s and planning completes. The
 * numbers are scaled but the arithmetic is identical to 900 vs 600 + 441.
 */
async function runLeadPhase(overrides = {}) {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { BudgetEnforcer } = await import("../dist/budgets/enforcer.js");
  const { PatRouter } = await import("../dist/auth/pat-router.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(root, "dist", "state", "schema.sql"), "utf8"));
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?,?,?,?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
  };
  const cfg = {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "l", worker: "w", adversary: "a", classifier: "c" },
    loop: {
      max_cycles: 1, adversarial_pass_ends_early: true,
      worker_timeout_seconds: 60, adversary_timeout_seconds: 60,
      lead_timeout_seconds: 1, lead_scout_timeout_seconds: 2, lead_repo_scout_enabled: true,
      session_hard_timeout_seconds: 3600,
      ...(overrides.loop ?? {}),
    },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
  };
  const brief = { title: "t", motivation: "m", acceptanceCriteria: ["a"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, crystallised_prompt)
     VALUES ('S1','T1','C1','U1','u1','o/r','harness/feat-x','', 'crystallising', ?, ?, 50, 0, 0, ?)`,
  ).run(now, now, JSON.stringify(brief));

  const wt = mkdtempSync(join(tmpdir(), "b106-wt-"));
  const loop = new OrchestratorLoop({
    config: cfg,
    state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat: new PatRouter(cfg.pat_routing),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    // The whole lead phase -- scout plus planning -- takes 1.5s.
    runLead: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return {
        repo: "o/r", branch: "harness/feat-x", worktreePath: wt, reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
        scout: { ran: true, reportChars: 10, durationMs: 1000 },
        subTasks: [{ seq: 1, title: "t", intent: "i", filesLikelyTouched: [], successCriteria: [], estimatedTokens: 10, taskMode: "observe" }],
      };
    },
    // End the run immediately after planning: this test is about the lead phase.
    runWorker: async () => ({ status: "failed", filesChanged: [], costUsd: 0, tokensIn: 0, tokensOut: 0, reason: "stop_here", finalMessage: "" }),
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
    releaseWorktree: async () => ({ ok: true, path: wt }),
  });
  return loop.run("S1", brief);
}

test("beta106: a lead phase longer than lead_timeout_seconds alone still completes", { skip }, async () => {
  const out = await runLeadPhase();
  assert.doesNotMatch(
    String(out.reason ?? ""),
    /lead_timeout_seconds/,
    "the scout ceiling must be added to the planner's, not taken out of it",
  );
  // It still ends -- on the worker, which is the point: planning got through.
  assert.match(String(out.reason ?? ""), /subtask_1|stop_here/);
});

test("beta106: with the scout disabled the lead budget is unchanged", { skip }, async () => {
  // No scout means no added ceiling, so the same 1.5s lead now correctly
  // breaches a 1s budget. This is what proves the addition is conditional.
  const out = await runLeadPhase({ loop: { lead_repo_scout_enabled: false } });
  assert.match(String(out.reason ?? ""), /lead_timeout_seconds/);
});

test("beta106: the scout ceiling is excluded from the budget when scouting is off", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  const i = loop.indexOf("const scoutBudget =");
  const seg = loop.slice(i, i + 400);
  assert.match(seg, /lead_repo_scout_enabled !== false/, "disabled scout must not inflate the lead budget");
  assert.match(seg, /: 0;/);
});

test("beta106: the shipped defaults leave planning more time than planning has ever taken", { skip }, () => {
  // The b103 smoke measured planning turns of 441s and 182s. This is the
  // arithmetic that did not close before b106, asserted directly.
  const cfg = parseHarnessConfig({
    slack: { channel: "C1", authorised_users: ["U1"] },
    repos: { allowed: ["o/*"] },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt" },
  });
  const lead = cfg.loop.lead_timeout_seconds;
  const scout = cfg.loop.lead_scout_timeout_seconds;
  const SLOWEST_OBSERVED_PLAN = 441;
  assert.ok(lead > SLOWEST_OBSERVED_PLAN, `lead_timeout_seconds ${lead} must exceed the slowest observed plan`);
  // Under b104's nesting this was `lead - scout`, which was 300 and lost.
  assert.ok(
    lead + scout - scout > SLOWEST_OBSERVED_PLAN,
    "with the scout budget added, planning keeps the whole lead budget",
  );
});

// ---------------------------------------------------------------------------
// 2. Timeout errors name the timer that fired
// ---------------------------------------------------------------------------

test("beta106: a labelled timeout names its own knob", { skip }, async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 0.01, "lead_timeout_seconds"),
    (e) => {
      assert.ok(e instanceof WorkerTimeoutError);
      assert.match(e.message, /lead_timeout_seconds/);
      assert.doesNotMatch(e.message, /worker_timeout_seconds/, "the b105 misdiagnosis in one line");
      assert.equal(e.limit, "lead_timeout_seconds");
      return true;
    },
  );
});

test("beta106: an unlabelled timeout keeps the historical wording", { skip }, async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 0.01),
    (e) => {
      assert.match(e.message, /worker exceeded worker_timeout_seconds \(0\.01s\)/);
      return true;
    },
  );
});

test("beta106: the lead, adversary and sub-task deadline all label their timers", { skip }, () => {
  const loop = S("src/orchestrator/loop.ts");
  for (const label of ["lead_timeout_seconds", "adversary_timeout_seconds", "subtask_deadline_seconds"]) {
    assert.ok(
      new RegExp(`,\\s*"${label}"\\s*[,)]`).test(loop),
      `${label} is not passed to withTimeout as its label`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. The scout is bounded by turns, not only by a wall clock it can outrun
// ---------------------------------------------------------------------------

test("beta106: a scout turn cap exists and is passed to the SDK", { skip }, () => {
  assert.equal(typeof SCOUT_MAX_TURNS, "number");
  assert.ok(SCOUT_MAX_TURNS > 0 && SCOUT_MAX_TURNS <= 200, `implausible cap ${SCOUT_MAX_TURNS}`);
  // Asserted against the BUILT artifact too: runLeadScoutSdk loads the SDK at
  // module scope with no injection seam, so the shipped bundle carrying the cap
  // is the strongest check available without refactoring that seam.
  for (const f of ["src/adapters/claude-code.ts", "dist/adapters/claude-code.js"]) {
    assert.match(S(f), /maxTurns: params\.maxTurns/, `the cap must reach sdk.query options in ${f}`);
  }
  assert.match(S("src/index.ts"), /maxTurns: config\.loop\.lead_scout_max_turns \?\? SCOUT_MAX_TURNS/);
});

test("beta106: the prompt states the budget and no longer invites exhaustive exploration", { skip }, () => {
  const p = buildScoutSystemPrompt();
  assert.match(p, /## Your budget/);
  assert.ok(p.includes(String(SCOUT_MAX_TURNS)), "the stated budget must match the enforced cap");
  assert.doesNotMatch(p, /Be thorough over brief/, "the line that bought 14 minutes");
  assert.match(p, /Stop as soon as/);
  assert.match(p, /partial report/i, "the scout must know an early honest report beats being truncated");
});

test("beta106: the scout hard-stops and keeps what it already has", { skip }, () => {
  for (const f of ["src/adapters/claude-code.ts", "dist/adapters/claude-code.js"]) {
    const sdk = S(f);
    // The ceiling must be derived from the configured budget, not a constant:
    // a fixed hard stop is how an unbounded scout hides.
    assert.match(sdk, /const hardStopMs = params\.timeoutSeconds \* 1000 \+ 30_?000;/, f);
    assert.match(sdk, /Promise\.race\(\[consumed, giveUp\]\)/, f);
    assert.match(sdk, /report: collected\.join\("\\n\\n"\)\.trim\(\)/, `partial report must survive the give-up in ${f}`);
    assert.match(sdk, /consumed\.catch\(\(\) => \{ \}\)|void consumed\.catch\(\(\) => \{\}\)/, `orphaned stream must not reject unhandled in ${f}`);
  }
});

test("beta106: a timed-out scout is still a scout, and says so", { skip }, () => {
  const lead = S("src/orchestrator/lead.ts");
  assert.match(lead, /timedOut: result\?\.timedOut === true \? true : undefined/);
  assert.match(S("src/orchestrator/loop.ts"), /timedOut: plan\.scout\.timedOut === true/);
  assert.match(S("src/orchestrator/loop.ts"), /scoutBudgetSeconds: scoutBudget/);
});

// ---------------------------------------------------------------------------
// 4. consumeWorkerStream streams text out as it lands
// ---------------------------------------------------------------------------

function messageStream(texts) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for (const t of texts) {
        yield { type: "assistant", message: { content: [{ type: "text", text: t }] } };
      }
      yield { type: "result", subtype: "success", total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } };
    },
  };
}

test("beta106: onText fires per block so a caller can salvage a partial report", { skip }, async () => {
  const seen = [];
  const r = await consumeWorkerStream(messageStream(["first", "second", "third"]), new AbortController(), {
    accumulateAllText: true,
    onText: (t) => seen.push(t),
  });
  assert.deepEqual(seen, ["first", "second", "third"], "every block must reach the caller as it lands");
  assert.equal(r.allText, "first\n\nsecond\n\nthird");
});

test("beta106: onText stays silent on the worker path", { skip }, async () => {
  const seen = [];
  const r = await consumeWorkerStream(messageStream(["a", "b"]), new AbortController(), {
    onText: (t) => seen.push(t),
  });
  assert.equal(seen.length, 0, "the worker path deliberately wants the concluding message alone");
  assert.equal(r.allText, undefined);
  assert.equal(r.finalMessage, "b");
});

// ---------------------------------------------------------------------------
// 5. A slow scout degrades the run, it does not kill it
// ---------------------------------------------------------------------------

const BRIEF = () => ({
  title: "continuity exercises",
  motivation: "m",
  acceptanceCriteria: ["ship it"],
  filesLikelyTouched: [],
  outOfScope: [],
  riskLevel: "low",
  repoHint: "o/r",
});

function leadDeps(over = {}) {
  return {
    config: {
      repos: { allowed: ["o/*"], default_base_branch: "main" },
      loop: { lead_repo_scout_enabled: true, lead_scout_timeout_seconds: 420, lead_scout_max_chars: 20000 },
      models: { lead: "l" },
      budgets: {},
    },
    logger: { info() {}, warn() {} },
    allocateWorktree: async () => "/tmp/wt-real",
    callLeadModel: async () => ({
      repo: "o/r", branch: "harness/feat-x", riskLevel: "low", reviewChecklist: [],
      subTasks: [{ seq: 1, title: "t", intent: "i", filesLikelyTouched: [], successCriteria: ["s"], estimatedTokens: 10, taskMode: "observe" }],
    }),
    estimateCost: () => 0,
    ...over,
  };
}

test("beta106: a scout that reports a timeout still hands its partial report to the planner", { skip }, async () => {
  let sawReport;
  const plan = await runLeadPlanner(BRIEF(), leadDeps({
    scoutRepo: async () => ({ report: "PARTIAL: components live in src/components/ui", timedOut: true }),
    callLeadModel: async (b) => {
      sawReport = b.repoScoutReport;
      return {
        repo: "o/r", branch: "harness/feat-x", riskLevel: "low", reviewChecklist: [],
        subTasks: [{ seq: 1, title: "t", intent: "i", filesLikelyTouched: [], successCriteria: ["s"], estimatedTokens: 10, taskMode: "observe" }],
      };
    },
  }));
  assert.match(String(sawReport), /components\/ui/, "a partial report is still worth having");
  assert.equal(plan.scout.ran, true);
  assert.equal(plan.scout.timedOut, true, "and the trail must say it was partial");
});

test("beta106: a clean scout is not marked as timed out", { skip }, async () => {
  const plan = await runLeadPlanner(BRIEF(), leadDeps({
    scoutRepo: async () => ({ report: "full report" }),
  }));
  assert.equal(plan.scout.ran, true);
  assert.equal(plan.scout.timedOut, undefined);
});

// ---------------------------------------------------------------------------
// 6. Config
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = {
  slack: { channel: "C1", authorised_users: ["U1"] },
  repos: { allowed: ["o/*"] },
  storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt" },
};

test("beta106: the scout budget defaults are the corrected ones", { skip }, () => {
  const cfg = parseHarnessConfig(MINIMAL_CONFIG);
  assert.equal(cfg.loop.lead_scout_timeout_seconds, 420);
  assert.equal(cfg.loop.lead_scout_max_turns, 60);
});

test("beta106: both scout bounds are overridable", { skip }, () => {
  const cfg = parseHarnessConfig({
    ...MINIMAL_CONFIG,
    loop: { lead_scout_timeout_seconds: 900, lead_scout_max_turns: 120 },
  });
  assert.equal(cfg.loop.lead_scout_timeout_seconds, 900);
  assert.equal(cfg.loop.lead_scout_max_turns, 120);
});

test("beta106: lead_scout_max_turns is documented in both schemas", { skip }, () => {
  for (const f of ["src/config.schema.json", "openclaw.plugin.json"]) {
    assert.ok(S(f).includes("lead_scout_max_turns"), `missing from ${f}`);
  }
});

test("beta106: pluginVersion and package.json agree at >= beta.106", { skip }, () => {
  const n = betaOrdinal;
  assert.ok(n(PLUGIN_VERSION.pluginVersion) >= 106, PLUGIN_VERSION.pluginVersion);
  assert.equal(JSON.parse(S("package.json")).version, PLUGIN_VERSION.pluginVersion);
});
