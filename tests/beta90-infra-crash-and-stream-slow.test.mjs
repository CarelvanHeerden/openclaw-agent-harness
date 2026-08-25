// beta.90 — two observability+recovery features, both proven against the b89
// DR/BCP smoke (session 041bd3d3):
//
// Feature 1: INFRA-crash-aware adversary-review recovery. All 11 sub-tasks
//   self-verified GREEN, but the CYCLE-1 adversary review crashed on
//   `ENOSPC: no space left on device`. The old gate required cycle>=2 + a prior
//   review, so a cycle-1 infra crash => HARD FAIL, no PR. An INFRA crash is an
//   environment failure, not a code signal; with green self-verify it must open
//   a needs_human_review PR without a prior review.
//
// Feature 2: worker_stream_slow liveness. Sub-task 2's worker SDK stream opened
//   then went idle ~15 min with NO signal in harness_progress. A 30s tick now
//   detects a token/activity-idle stream and surfaces loop.worker_stream_slow +
//   a heartbeat bump. OBSERVABILITY ONLY — it never aborts (a slow stream
//   recovered on b89).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

// ---------------------------------------------------------------------------
// Unit: isInfraCrash / INFRA_CRASH_RE
// ---------------------------------------------------------------------------
const { isInfraCrash, INFRA_CRASH_RE } = await import("../dist/orchestrator/infra-crash.js");

test("beta90: isInfraCrash matches INFRA classes, not QUALITY errors", () => {
  // INFRA => true
  assert.equal(isInfraCrash("ENOSPC: no space left on device, write"), true);
  assert.equal(isInfraCrash("Error: no space left on device"), true);
  assert.equal(isInfraCrash("disk quota exceeded"), true);
  assert.equal(isInfraCrash("ENOMEM: cannot allocate memory"), true);
  assert.equal(isInfraCrash("cannot allocate memory"), true);
  assert.equal(isInfraCrash("EIO: i/o error"), true);
  assert.equal(isInfraCrash("EMFILE: too many open files, open '/x'"), true);
  assert.equal(isInfraCrash("spawn EMFILE"), true);
  assert.equal(isInfraCrash("read ECONNRESET"), true);
  assert.equal(isInfraCrash("socket hang up"), true);
  assert.equal(isInfraCrash("connect ETIMEDOUT 1.2.3.4:443"), true);
  assert.equal(isInfraCrash("write EPIPE"), true);

  // QUALITY / semantic => false
  assert.equal(isInfraCrash("verdict JSON invalid"), false);
  assert.equal(isInfraCrash("[adversary] extractJson failed: no JSON in output"), false);
  assert.equal(isInfraCrash("simulated cycle-2 adversary SDK crash"), false);

  // Empty / nullish => false (absence is NOT assumed infra)
  assert.equal(isInfraCrash(""), false);
  assert.equal(isInfraCrash(undefined), false);
  assert.equal(isInfraCrash(null), false);

  // regex is case-insensitive
  assert.equal(INFRA_CRASH_RE.test("enospc"), true);
});

// ---------------------------------------------------------------------------
// Unit: evaluateStreamSlowTick (pure tick logic)
// ---------------------------------------------------------------------------
const { evaluateStreamSlowTick } = await import("../dist/adapters/claude-sdk.js");

test("beta90: stream-slow tick fires only when idle past threshold; advancing resets; disabled never fires", () => {
  const idleWarnMs = 90_000;

  // Tokens/activity NOT advancing, idle >= threshold => FIRE.
  const idle = evaluateStreamSlowTick({
    marker: 0, lastMarker: 0, nowMs: 100_000, lastActivityAtMs: 0, idleWarnMs,
  });
  assert.equal(idle.advanced, false);
  assert.equal(idle.idleMs, 100_000);
  assert.equal(idle.fire, true, "idle past threshold must fire");

  // Idle but UNDER the threshold => no fire.
  const young = evaluateStreamSlowTick({
    marker: 5, lastMarker: 5, nowMs: 30_000, lastActivityAtMs: 0, idleWarnMs,
  });
  assert.equal(young.advanced, false);
  assert.equal(young.fire, false, "idle under threshold must not fire");

  // Activity ADVANCED => resets clock, never fires (even if a long time passed).
  const advanced = evaluateStreamSlowTick({
    marker: 12, lastMarker: 5, nowMs: 999_999, lastActivityAtMs: 0, idleWarnMs,
  });
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.idleMs, 0, "advancing resets idle to 0");
  assert.equal(advanced.fire, false, "advancing must not fire");

  // DISABLED (idleWarnMs <= 0) => never fires regardless of idle.
  const disabled = evaluateStreamSlowTick({
    marker: 0, lastMarker: 0, nowMs: 10_000_000, lastActivityAtMs: 0, idleWarnMs: 0,
  });
  assert.equal(disabled.fire, false, "disabled (0) must never fire");
});

// ---------------------------------------------------------------------------
// Behavioral: review-crash eligibility matrix (seeded in-memory DB loop)
// ---------------------------------------------------------------------------
let OrchestratorLoop, BudgetEnforcer, PatRouter, Database;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
  ({ BudgetEnforcer } = await import("../dist/budgets/enforcer.js"));
  ({ PatRouter } = await import("../dist/auth/pat-router.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  OrchestratorLoop = null;
}

const schemaPath = resolve(here, "..", "dist", "state", "schema.sql");

function config(overrides = {}) {
  return {
    slack: { channel: "C1", authorised_users: ["U1"], reactions: { ship_it: "rocket", abort: "x", pause: "pause_button", budget_bump: "moneybag" } },
    budgets: { monthly_per_user_usd: 1000, session_default_usd: 50, session_hard_ceiling_usd: 200, daily_warn_usd: 100, monthly_warn_ratio: 0.8 },
    repos: { allowed: ["o/*"], can_create: false, create_org: "", create_visibility: "private", default_base_branch: "main" },
    models: { lead: "claude-fable-5", worker: "claude-sonnet-5", adversary: "claude-fable-5", classifier: "claude-haiku-4-5" },
    loop: { max_cycles: 3, adversarial_pass_ends_early: true, worker_timeout_seconds: 60, adversary_timeout_seconds: 60, session_hard_timeout_seconds: 3600, graceful_pr_on_review_crash: true },
    storage: { state_db_path: ":memory:", worktree_root: "/tmp/wt", audit_retention_days: 90, prune_terminal_sessions: 365 },
    pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{user}-{org}" },
    safety: { worker_permission_mode: "acceptEdits", bash_whitelist: ["git", "echo"], bash_denylist_tokens: ["rm"], path_denylist: [".env"] },
    ...overrides,
  };
}

function makeStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(schemaPath, "utf8"));
  const audits = [];
  return {
    db,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    audits,
    close() { db.close(); },
  };
}

function insertSession(db, id, budget = 50) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES (?, 'T1', 'C1', 'U1', 'u1', '', '', '', 'crystallising', ?, ?, ?, 0, 0)`,
  ).run(id, Date.now(), Date.now(), budget);
}

const commitSubTask = (seq) => ({
  seq, title: `t${seq}`, intent: "commit the change", filesLikelyTouched: [],
  successCriteria: ["commit made"], estimatedTokens: 100,
});
const greenProbes = () => ({
  remoteBranchExists: async () => ({ exists: true, detail: "" }),
  prUrlPresent: async () => ({ present: true, url: "https://github.com/o/r/pull/1", detail: "" }),
  fileWrittenSince: async () => ({ written: true, detail: "" }),
  fileExistsOnDisk: async () => ({ exists: true, nonEmpty: true, detail: "" }),
  commitMadeSince: async () => ({ made: true, detail: "" }),
  fileCommittedSince: async () => ({ committed: true, detail: "" }),
});
const brief = { title: "t", motivation: "m", acceptanceCriteria: ["c"], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" };
const plan = { repo: "o/r", branch: "harness/x", worktreePath: "/tmp/wt/s", subTasks: [commitSubTask(1)], reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };

// Feature 1a, as REVISED in rc.3.
//
// beta.90 shipped this case: an infra crash (ENOSPC) on cycle 1 with green
// self-verification opened a needs_human_review PR, attaching a synthesized
// `revise` report, so an out-of-disk error could not sink a finished run.
//
// The external review (§2) pointed out what that meant in practice: the code in
// that PR had been reviewed by nobody. "Self-verified green" is the worker's own
// probe on its own work. The harness advertises that nothing is pushed until the
// adversary passes, and this was one of three paths where that was not true.
//
// rc.3 keeps beta.90's premise -- an infra error says nothing about the code --
// and changes its conclusion. The commits are still not lost: the worktree is
// preserved and stays resumable. Only the automatic push is withdrawn. Where a
// PRIOR review exists, the infra path still ships (asserted below).
test("rc3: a cycle-1 INFRA crash with NO prior review preserves the worktree instead of pushing",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "I1");
    let prCalls = 0, releaseCalls = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      // CYCLE-1 adversary crashes with an INFRASTRUCTURE error.
      runAdversary: async () => { throw new Error("ENOSPC: no space left on device, write"); },
      pushBranchAndOpenPr: async () => { prCalls++; return "https://github.com/o/r/pull/90"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => { releaseCalls++; return { ok: true, path: "/tmp/wt/s" }; },
    });

    const outcome = await loop.run("I1", brief);
    assert.equal(outcome.status, "failed", "nothing reviewed this code, so it is not pushed");
    assert.equal(prCalls, 0, "no PR is opened for code no adversary has seen");
    assert.equal(releaseCalls, 0, "the worktree is kept, so the work is recoverable");
    assert.match(outcome.reason, /no adversary review has ever run/i);
    assert.match(outcome.reason, /harness_resume/, "the operator is told how to get the work");

    const row = state.db.prepare(`SELECT status, worktree_preserved, final_pr_url FROM sessions WHERE id='I1'`).get();
    assert.equal(row.status, "failed");
    assert.equal(row.final_pr_url, null);
    // rc.3: without this flag the startup self-heal reaps the very directory
    // this path just promised to keep (beta.129 fixed the abort path and missed
    // this one).
    assert.equal(row.worktree_preserved, 1, "the preserved worktree must survive a restart");

    const rec = state.audits.filter((e) => e.event === "loop.review_crash_recovery");
    assert.equal(rec.length, 1);
    assert.equal(rec[0].payload.eligible, false, "infra no longer waives the prior-review requirement");
    assert.equal(rec[0].payload.infra, true, "recovery audit still flags infra=true");
    assert.equal(rec[0].payload.hasPriorReview, false);
    assert.equal(rec[0].payload.selfVerifyGreen, true);

    const refused = state.audits.filter((e) => e.event === "loop.salvage_refused_unreviewed");
    assert.equal(refused.length, 1, "the refusal is auditable, not silent");
    assert.equal(refused[0].payload.path, "review_crash");
    assert.equal(state.audits.filter((e) => e.event === "loop.shipped").length, 0);
    state.close();
  });

// Feature 1b: a QUALITY crash on cycle 1 (green) is NOT eligible => preserve.
test("beta90 F1: cycle-1 QUALITY crash (non-infra) with green self-verify is NOT eligible (preserve-worktree fail)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "Q1");
    let prCalls = 0, releaseCalls = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => { throw new Error("verdict JSON invalid: no JSON in output"); },
      pushBranchAndOpenPr: async () => { prCalls++; return "unused"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => { releaseCalls++; return { ok: true, path: "/tmp/wt/s" }; },
    });
    const outcome = await loop.run("Q1", brief);
    assert.equal(outcome.status, "failed", "a quality crash on cycle 1 is not salvageable");
    assert.equal(prCalls, 0, "no PR for a non-infra cycle-1 crash");
    assert.equal(releaseCalls, 0, "worktree preserved");
    const rec = state.audits.filter((e) => e.event === "loop.review_crash_recovery")[0];
    assert.equal(rec.payload.eligible, false);
    assert.equal(rec.payload.infra, false);
    const preserved = state.audits.filter((e) => e.event === "loop.failed_worktree_preserved");
    assert.equal(preserved.length, 1);
    state.close();
  });

// Feature 1c: INFRA crash but self-verify FAILED => NOT eligible (green gate holds).
test("beta90 F1: INFRA crash with self-verify FAILED is NOT eligible (green gate still required)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "IF1");
    let prCalls = 0;
    // RED probes -> self-verify fails.
    const redProbes = () => ({
      remoteBranchExists: async () => ({ exists: false, detail: "" }),
      prUrlPresent: async () => ({ present: false, url: "", detail: "" }),
      fileWrittenSince: async () => ({ written: false, detail: "" }),
      fileExistsOnDisk: async () => ({ exists: false, nonEmpty: false, detail: "" }),
      commitMadeSince: async () => ({ made: false, detail: "no commit" }),
      fileCommittedSince: async () => ({ committed: false, detail: "" }),
    });
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      // Worker "completes" but the verify probes are all red -> self-verify not green.
      runWorker: async () => ({ status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => { throw new Error("read ECONNRESET"); },
      pushBranchAndOpenPr: async () => { prCalls++; return "unused"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: redProbes,
      releaseWorktree: async () => ({ ok: true, path: "/tmp/wt/s" }),
    });
    const outcome = await loop.run("IF1", brief);
    // The run may terminate before the review crash when self-verify is red;
    // the key invariant is that NO needs_human_review PR was opened via the
    // infra path (green self-verify is a hard requirement). If a review-crash
    // recovery decision WAS reached, it must be ineligible.
    assert.equal(outcome.status !== "shipped", true, "must not ship on failed self-verify");
    const rec = state.audits.filter((e) => e.event === "loop.review_crash_recovery");
    if (rec.length > 0) {
      assert.equal(rec[0].payload.eligible, false, "infra crash without green self-verify is ineligible");
      assert.equal(rec[0].payload.selfVerifyGreen, false);
    }
    const shipped = state.audits.filter((e) => e.event === "loop.shipped" && e.payload.viaInfraCrash === true);
    assert.equal(shipped.length, 0, "no infra-crash PR when self-verify is not green");
    state.close();
  });

// Feature 1d: NON-INFRA cycle-2 crash with prior review + green => STILL eligible
// (no regression of the beta.62 path).
test("beta90 F1: cycle-2 crash with prior review + green (non-infra) still eligible (no regression)",
  { skip: OrchestratorLoop === null }, async () => {
    const state = makeStore();
    insertSession(state.db, "R2");
    let advCall = 0, prCalls = 0;
    const loop = new OrchestratorLoop({
      config: config(),
      state,
      budget: new BudgetEnforcer(config().budgets, state),
      pat: new PatRouter(config().pat_routing),
      logger: { info() {}, warn() {}, error() {} },
      runLead: async () => plan,
      runWorker: async () => ({ status: "completed", filesChanged: ["a"], commitSha: "sha1", costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn" }),
      runAdversary: async () => {
        advCall++;
        // beta.109: `medium`, not `low`. A revise carrying only lows now ends the
        // loop (ship_when_no_blocking_findings), so a fixture that needs a SECOND
        // cycle has to carry something genuinely blocking.
        if (advCall === 1) return { verdict: "revise", findings: [{ dimension: "quality", severity: "medium", title: "f", detail: "d" }], summary: "revise", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
        throw new Error("simulated cycle-2 adversary SDK crash"); // NON-infra
      },
      pushBranchAndOpenPr: async () => { prCalls++; return "https://github.com/o/r/pull/62"; },
      readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
      buildVerifyProbes: greenProbes,
      releaseWorktree: async () => ({ ok: true, path: "/tmp/wt/s" }),
    });
    const outcome = await loop.run("R2", brief);
    assert.equal(outcome.status, "shipped", "cycle-2 + prior review + green still ships");
    assert.equal(prCalls, 1);
    const rec = state.audits.filter((e) => e.event === "loop.review_crash_recovery")[0];
    assert.equal(rec.payload.eligible, true);
    assert.equal(rec.payload.infra, false, "non-infra cycle-2 path: infra=false");
    assert.equal(rec.payload.hasPriorReview, true);
    const shipped = state.audits.filter((e) => e.event === "loop.shipped")[0];
    assert.equal(shipped.payload.viaInfraCrash, false);
    state.close();
  });

// ---------------------------------------------------------------------------
// Source wiring assertions
// ---------------------------------------------------------------------------
test("beta90 F1: infra-crash module exports + is imported by the loop (source)", () => {
  const mod = S("src/orchestrator/infra-crash.ts");
  assert.match(mod, /export const INFRA_CRASH_RE/);
  assert.match(mod, /export function isInfraCrash/);
  assert.match(mod, /041bd3d3/, "doc comment references the smoke session");
  assert.match(mod, /beta\.90/, "doc comment references beta.90");
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /import \{ isInfraCrash \} from "\.\/infra-crash\.js"/);
  assert.match(loop, /const infra = isInfraCrash\(String\(\(err as Error\)\?\.message \?\? err\)\)/);
  assert.match(loop, /viaInfraCrash: infra/);
});

test("beta90 F2: consumeWorkerStream has stream-slow tick wired; observability only (source)", () => {
  const sdk = S("src/adapters/claude-sdk.ts");
  assert.match(sdk, /onStreamSlow\?:/);
  assert.match(sdk, /streamIdleWarnSeconds\?:/);
  assert.match(sdk, /export function evaluateStreamSlowTick/);
  // stream-slow is observability only: the detector must not call abort in its tick
  const tickBlock = sdk.slice(sdk.indexOf("STREAM-SLOW liveness detector"), sdk.indexOf("armStreamOpenWatchdog();"));
  assert.doesNotMatch(tickBlock, /abort\.abort\(\)/, "stream-slow tick must never abort");
  // must thread through the worker path
  const worker = S("src/orchestrator/worker.ts");
  assert.match(worker, /onStreamSlow/);
  assert.match(worker, /streamIdleWarnSeconds: deps\.config\.loop\.worker_stream_idle_warn_seconds \?\? 90/);
});

test("beta90 F2: loop emits loop.worker_stream_slow + bumps last_progress_at (source)", () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /"loop\.worker_stream_slow"/);
  assert.match(loop, /makeStreamSlowCallback/);
  // reuses the beta.63 last_progress_at heartbeat mechanism
  const body = loop.slice(loop.indexOf("private makeStreamSlowCallback"), loop.indexOf("private checkpoint"));
  assert.match(body, /UPDATE sessions SET last_progress_at = \?, updated_at = \? WHERE id = \?/);
  assert.match(body, /worker stream idle/);
});

// ---------------------------------------------------------------------------
// Config + manifest
// ---------------------------------------------------------------------------
test("beta90: worker_stream_idle_warn_seconds config default 90 + clamp [30,600] (source)", () => {
  const src = S("src/config.ts");
  assert.match(src, /worker_stream_idle_warn_seconds\?: number/);
  assert.match(src, /worker_stream_idle_warn_seconds: 90/);
  assert.match(src, /if \(merged\.loop\.worker_stream_idle_warn_seconds < 30\) merged\.loop\.worker_stream_idle_warn_seconds = 30/);
  assert.match(src, /if \(merged\.loop\.worker_stream_idle_warn_seconds > 600\) merged\.loop\.worker_stream_idle_warn_seconds = 600/);
});

test("beta90: worker_stream_idle_warn_seconds declared in manifest (additionalProperties:false)", () => {
  const manifest = JSON.parse(S("openclaw.plugin.json"));
  const loopProps = manifest.configSchema.properties.loop.properties;
  assert.ok(loopProps.worker_stream_idle_warn_seconds, "must be declared or additionalProperties:false rejects the whole config");
  assert.equal(loopProps.worker_stream_idle_warn_seconds.type, "integer");
  assert.equal(loopProps.worker_stream_idle_warn_seconds.default, 90);
  assert.equal(loopProps.worker_stream_idle_warn_seconds.minimum, 30);
  assert.equal(loopProps.worker_stream_idle_warn_seconds.maximum, 600);
});

// ---------------------------------------------------------------------------
// Version bump
// ---------------------------------------------------------------------------
test("beta90: version >= beta.90", () => {
  const betaNum = betaOrdinal;
  assert.ok(betaNum(JSON.parse(S("package.json")).version) >= 90, "package.json >= beta.90");
  assert.ok(betaNum(S("src/version.ts").match(/pluginVersion: "([^"]+)"/)[1]) >= 90, "version.ts >= beta.90");
});
