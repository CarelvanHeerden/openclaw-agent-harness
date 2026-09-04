/**
 * beta.132: the answer nobody was listening for, and the resume that pays twice.
 *
 * WHAT HAPPENED. b131's verification run asked for more time on a red build --
 * correctly, with $28 of a $40 cap unspent. The operator answered "1 hour",
 * 28 seconds into a 5-minute window, and was told:
 *
 *     "Recorded. The run is still waiting at its review boundary and will pick
 *      this up within a few seconds."
 *
 * Nothing picked it up. The process holding the question had already exited,
 * and b129 read the wait WINDOW as proof of life -- but the window only records
 * what the loop intended before it died. $11.07 of finished work and PR #1073
 * sat there with the session parked in `awaiting_clarification`.
 *
 * WHY THE OBVIOUS FIX IS WRONG. "Just resume it" costs more than the question
 * was worth: every resume path in the harness re-plans from scratch. A fresh
 * lead call and scout (mean $6.24 across this repo's own audit history),
 * `cycles_ran` reset, and completed sub-tasks re-run against a branch that
 * already carries their commits. So a dead listener FINISHES THE SHIP instead:
 * exactly what "ship" or silence would have produced, which is the outcome the
 * operator was already choosing between.
 *
 * AND THE ONE NOBODY ASKED FOR. The same re-plan fires unattended on plugin
 * boot, for any session left non-terminal, via `recovery.auto_resuming`. b81
 * stopped it for `executing` only. Restarting the container is how a new build
 * gets installed, so a boot landing on a live run is routine -- 2b4c1d33 was at
 * `planning` with a $6.03 plan and two finished cycles when one picked it up.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let timeExtension, recoveryGuard, registerHarnessTools, Database;
try {
  timeExtension = await import("../dist/orchestrator/time-extension.js");
  recoveryGuard = await import("../dist/state/recovery-guard.js");
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  timeExtension = null;
}

const skip = timeExtension === null ? "dist/ not built" : false;
const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(resolve(here, "..", p), "utf8");

// ---------------------------------------------------------------------------
// Is anybody there?
// ---------------------------------------------------------------------------

test("beta132: a missing heartbeat is 'nobody is listening', not 'probably fine'", { skip }, () => {
  const { listenerLooksAlive } = timeExtension;
  // The direction of this default is the whole point. Reading absence as life
  // is what told 2b4c1d33's operator to wait for a process that had exited.
  assert.equal(listenerLooksAlive(undefined), false);
  assert.equal(listenerLooksAlive(null), false);
  assert.equal(listenerLooksAlive(0), false);
  assert.equal(listenerLooksAlive(NaN), false);
});

test("beta132: a heartbeat from this second is alive; one from a minute ago is not", { skip }, () => {
  const { listenerLooksAlive, LISTENER_STALE_MS } = timeExtension;
  const now = 1_000_000;
  assert.equal(listenerLooksAlive(now, now), true);
  // The poll sleeps at most 5s, so a few missed ticks must still read as alive
  // -- a slow disk is not a dead process.
  assert.equal(listenerLooksAlive(now - 6_000, now), true);
  assert.equal(listenerLooksAlive(now - LISTENER_STALE_MS, now), true, "exactly at the limit is still alive");
  assert.equal(listenerLooksAlive(now - LISTENER_STALE_MS - 1, now), false);
  assert.equal(listenerLooksAlive(now - 60_000, now), false);
});

test("beta132: the loop stamps the heartbeat before its first sleep", { skip }, () => {
  // An operator watching the thread answers in seconds. If the first stamp
  // waited for the first tick, the fastest answers -- the ones most likely to
  // reach a live loop -- would be the ones judged dead.
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("stampClarificationHeartbeat(p.sessionId)");
  assert.ok(i > 0, "the heartbeat must be stamped in the ask");
  const j = src.indexOf('let answer = ""', i);
  assert.ok(j > i, "the first stamp must come before the poll loop is entered");
  // And again on every tick, or a five-minute window looks dead after twenty
  // seconds of perfectly healthy waiting.
  assert.equal(src.split("stampClarificationHeartbeat(p.sessionId)").length - 1, 2);
});

test("beta132: clearing the pause clears the heartbeat with it", { skip }, () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("const clearPause");
  const block = src.slice(i, i + 700);
  // A heartbeat left behind on a finished pause is a corpse that reads as
  // alive to the next question on the same row.
  assert.match(block, /clarification_heartbeat_at = NULL/);
});

// ---------------------------------------------------------------------------
// harness_answer, end to end
// ---------------------------------------------------------------------------

const MARKER = (waitUntilMs) => JSON.stringify({ kind: "time_extension", waitUntilMs });

function makeRuntime() {
  const db = new Database(":memory:");
  db.exec(S("dist/state/schema.sql"));
  const audits = [];
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload), Date.now());
    },
    close() {},
  };
  const loopCalls = [];
  return {
    state,
    audits,
    loopCalls,
    loop: { run: async (sessionId, brief) => { loopCalls.push({ sessionId, brief }); return { status: "shipped", sessionId, cycles: 1, totalCostUsd: 0.1 }; } },
    crystallise: async () => ({ kind: "brief", costUsd: 0, brief: { title: "t", motivation: "m", acceptanceCriteria: [], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" } }),
    anthropicApiKey: async () => "sk-test",
    githubServiceFor: () => "github-o",
    githubToken: async () => "gh",
    gitResolutionFor: () => ({ credentialService: "github-o", provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" }),
    gitToken: async () => "gh",
    budget: { getDailySpend: () => 0 },
    config: {
      storage: { audit_retention_days: 90 },
      slack: { listener_enabled: false, channel: "C1", authorised_users: ["U1"] },
      repos: { allowed: ["o/*"] },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
      pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{owner}", auth: { api_key_env: "GH_TOKEN" } },
      budgets: { session_default_usd: 18 },
    },
  };
}

function tools(runtime) {
  const map = new Map();
  registerHarnessTools(
    {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerTool: (def) => {
        map.set(def.name, { ...def, execute: (input) => def.execute("test-call-id", input) });
        return () => map.delete(def.name);
      },
    },
    runtime,
  );
  return map;
}

/** A session parked on a time-extension question, as the live loop leaves it. */
function seedPaused(runtime, { heartbeatAt, waitUntilMs, prUrl = null, branch = "harness/feat-x" }) {
  const id = "sess-b132";
  runtime.state.db
    .prepare(
      `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
                             status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran,
                             estimated_usd, clarification_question, clarification_seq, clarification_subtask,
                             clarification_heartbeat_at, final_pr_url)
       VALUES (?, 'T1', 'C1', 'U1', 'U1', 'o/r', ?, '/tmp/wt', 'awaiting_clarification', ?, ?, ?, 40, 11.07, 2, 40,
               'Out of time, not out of money', -3, ?, ?, ?)`,
    )
    .run(
      id, branch, JSON.stringify({ title: "t", motivation: "m", acceptanceCriteria: [], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" }),
      Date.now(), Date.now(), MARKER(waitUntilMs), heartbeatAt, prUrl,
    );
  return id;
}

test("beta132: a LIVE loop still just gets the answer handed to it", { skip }, async () => {
  const runtime = makeRuntime();
  const t = tools(runtime);
  const id = seedPaused(runtime, { heartbeatAt: Date.now(), waitUntilMs: Date.now() + 300_000 });

  const r = await t.get("harness_answer").execute({ sessionId: id, answer: "1 hour", invokedBy: "U1" });

  assert.equal(r.details.timeExtensionAnswered, true);
  assert.equal(r.details.listenerLost, undefined);
  assert.equal(runtime.loopCalls.length, 0, "the loop never left; re-driving it would start a second run");
  const row = runtime.state.db.prepare("SELECT status, clarification_answer FROM sessions WHERE id = ?").get(id);
  assert.equal(row.status, "awaiting_clarification", "the live loop owns the transition out of this");
  assert.equal(row.clarification_answer, "1 hour");
});

test("beta132: a DEAD loop is not promised a pickup -- the ship is finished instead", { skip }, async () => {
  const runtime = makeRuntime();
  const t = tools(runtime);
  const prUrl = "https://github.com/o/r/pull/1073";
  // The exact shape of the failure: well inside the window, heartbeat long cold.
  const id = seedPaused(runtime, { heartbeatAt: Date.now() - 120_000, waitUntilMs: Date.now() + 270_000, prUrl });

  const r = await t.get("harness_answer").execute({ sessionId: id, answer: "1 hour", invokedBy: "U1" });

  assert.equal(r.details.listenerLost, true);
  assert.equal(r.details.shipped, true);
  assert.equal(r.details.prUrl, prUrl);
  assert.equal(runtime.loopCalls.length, 0, "resuming here re-plans from scratch and re-spends lead + scout");

  const row = runtime.state.db
    .prepare("SELECT status, merge_recommendation, merge_recommendation_reason, clarification_question FROM sessions WHERE id = ?")
    .get(id);
  assert.equal(row.status, "done", "the session must not be left parked for a process that is gone");
  assert.equal(row.merge_recommendation, "needs_human_review");
  assert.equal(row.clarification_question, null, "the question is over");

  // The operator is owed the truth about what did NOT happen: the repair the
  // time was being bought for. Saying "shipped" alone implies a green build.
  assert.match(r.content[0].text, /CI/);
  assert.match(r.content[0].text, new RegExp(prUrl.replace(/[/.]/g, "\\$&")));
  assert.ok(runtime.audits.some((a) => a.event === "tool.answer_time_extension_listener_lost"));
});

test("beta132: a dead loop that never pushed keeps its worktree rather than inventing a ship", { skip }, async () => {
  const runtime = makeRuntime();
  const t = tools(runtime);
  // b129's review-boundary ask fires BEFORE the push, so there is no PR to
  // point at. Claiming one, or reaping the commits, are both worse than saying
  // where the work is.
  const id = seedPaused(runtime, { heartbeatAt: Date.now() - 120_000, waitUntilMs: Date.now() + 270_000, prUrl: null });

  const r = await t.get("harness_answer").execute({ sessionId: id, answer: "yes", invokedBy: "U1" });

  assert.equal(r.details.listenerLost, true);
  assert.equal(r.details.shipped, false);
  assert.equal(r.details.worktreePreserved, true);
  assert.equal(runtime.loopCalls.length, 0);
  const row = runtime.state.db.prepare("SELECT status, worktree_preserved FROM sessions WHERE id = ?").get(id);
  assert.equal(row.status, "aborted");
  assert.equal(row.worktree_preserved, 1, "terminal status + no flag = the next boot's heal deletes the commits");
  assert.match(r.content[0].text, /harness\/feat-x/, "say where the work is");
});

test("beta132: an answer arriving as the window closes is left to the loop, not raced", { skip }, async () => {
  const runtime = makeRuntime();
  const t = tools(runtime);
  // Heartbeat fresh, window a moment expired: the loop is mid-shutdown and
  // about to ship on its own. Writing a verdict from here would collide with
  // the one it is already writing.
  const id = seedPaused(runtime, { heartbeatAt: Date.now(), waitUntilMs: Date.now() - 500 });

  const r = await t.get("harness_answer").execute({ sessionId: id, answer: "30 minutes", invokedBy: "U1" });

  assert.equal(r.details.timeExtensionAnswered, true);
  assert.equal(r.details.windowOpen, false);
  assert.equal(r.details.listenerLost, undefined);
  const row = runtime.state.db.prepare("SELECT status FROM sessions WHERE id = ?").get(id);
  assert.equal(row.status, "awaiting_clarification", "untouched; the live loop finishes its own shutdown");
  // And it must not pretend the answer landed in time.
  assert.match(r.content[0].text, /already shipping|may not act/i);
});

test("beta132: 'ship' from an operator whose loop has died still ships", { skip }, async () => {
  const runtime = makeRuntime();
  const t = tools(runtime);
  const id = seedPaused(runtime, { heartbeatAt: null, waitUntilMs: Date.now() + 270_000, prUrl: "https://github.com/o/r/pull/9" });

  const r = await t.get("harness_answer").execute({ sessionId: id, answer: "ship", invokedBy: "U1" });

  // The reply is not parsed at all on this path, and it should not be: every
  // answer to a question nobody heard has the same outcome.
  assert.equal(r.details.shipped, true);
  assert.equal(runtime.loopCalls.length, 0);
});

// ---------------------------------------------------------------------------
// The re-plan nobody asked for
// ---------------------------------------------------------------------------

test("beta132: recovery resumes a session that has nothing to lose", { skip }, () => {
  const { decideRecoveryResume } = recoveryGuard;
  const base = { enabled: true, hasPlan: false, cyclesRan: 0, prUrl: "" };
  // No plan: the cheap re-drive this path was built for.
  assert.equal(decideRecoveryResume(base).resume, true);
  // Planned but died before running anything -- the plan is all that is lost,
  // and re-planning is the recovery.
  assert.equal(decideRecoveryResume({ ...base, hasPlan: true }).resume, true);
});

test("beta132: recovery REFUSES a session holding a plan and finished cycles", { skip }, () => {
  const { decideRecoveryResume } = recoveryGuard;
  // 2b4c1d33's shape: a $6.03 plan, two finished cycles, nothing pushed.
  const v = decideRecoveryResume({ enabled: true, hasPlan: true, cyclesRan: 2, prUrl: "" });
  assert.equal(v.resume, false);
  assert.equal(v.outcome, "preserve_worktree");
  // One cycle is already worker spend worth protecting.
  assert.equal(decideRecoveryResume({ enabled: true, hasPlan: true, cyclesRan: 1, prUrl: "" }).resume, false);
});

test("beta132: a refused session that already pushed is surfaced against its PR", { skip }, () => {
  const { decideRecoveryResume } = recoveryGuard;
  const v = decideRecoveryResume({ enabled: true, hasPlan: true, cyclesRan: 3, prUrl: "https://github.com/o/r/pull/7" });
  assert.equal(v.resume, false);
  // Nothing to rescue -- the work is on the remote. Only a verdict is missing.
  assert.equal(v.outcome, "ship_for_review");
  assert.equal(
    decideRecoveryResume({ enabled: true, hasPlan: true, cyclesRan: 3, prUrl: "   " }).outcome,
    "preserve_worktree",
    "a blank url is not a PR",
  );
});

test("beta132: the guard can be switched off", { skip }, () => {
  const { decideRecoveryResume } = recoveryGuard;
  assert.equal(
    decideRecoveryResume({ enabled: false, hasPlan: true, cyclesRan: 5, prUrl: "" }).resume,
    true,
    "false must restore the pre-beta.132 re-drive exactly",
  );
});

test("beta132: the refusal is wired into bootstrap ahead of the re-drive", { skip }, () => {
  const src = S("src/index.ts");
  const guard = src.indexOf("decideRecoveryResume({");
  const redrive = src.indexOf("recovery auto-resuming session (agent-orchestrated mode)");
  assert.ok(guard > 0, "the guard must be called");
  assert.ok(guard < redrive, "a guard that runs after the re-drive has already spent the money");
  assert.match(src, /recovery\.replan_refused/);
});

test("beta132: b81's 'commits are preserved' promise is now actually kept", { skip }, () => {
  // `failed` is terminal and the startup heal reaps every terminal session's
  // worktree, so this path told operators to go and get commits that the next
  // container bounce deleted -- the same broken promise b129 fixed for aborts.
  const src = S("src/index.ts");
  const i = src.indexOf('"recovery.resume_at_subtask",');
  assert.ok(i > 0, "the b81 audit call must still be there");
  const block = src.slice(Math.max(0, i - 800), i);
  assert.ok(
    /status = 'failed', worktree_preserved = 1/.test(block),
    "b81 marks the session failed, which is terminal, and the heal reaps terminal sessions' worktrees",
  );
});

test("beta132: the comment about resumes and planning cost states which era it describes", { skip }, () => {
  // The original comment asserted the lead cost "stays 0 on a resumed run that
  // skips planning, so a resume cannot bill the same plan twice". That was
  // false for eleven releases -- every resume re-planned and billed a second
  // lead call -- and believing it is part of how that survived. b132 kept the
  // claim and contradicted it in place.
  //
  // rc.2 made it true again: an answer given against a stored plan resumes it
  // and never calls the lead. So the comment must now say BOTH things, and be
  // explicit about which is the historical claim and which is current
  // behaviour. A comment that silently reverts to the bare original is the
  // regression this test is here to catch.
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("let leadPlanningCostUsd = 0");
  assert.ok(i > 0);
  const block = src.slice(Math.max(0, i - 1400), i);
  assert.match(block, /beta\.132/, "the correction is still attributed");
  assert.match(block, /every resume re-planned from scratch/, "the historical failure is still described");
  assert.match(block, /rc\.2/, "and so is the change that fixed it");
  assert.match(block, /resumeExistingPlan/, "naming the mechanism, so the claim is checkable");
});
