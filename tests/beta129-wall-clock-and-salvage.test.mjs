/**
 * beta.129 -- the wall clock, and the salvage that never salvaged.
 *
 * The run these tests are written against is session d48ba433: 122 minutes,
 * $21.55 of a $40 budget, thirty completed sub-tasks, a cycle-4 adversary
 * verdict of `pass` with zero blocking findings -- and a terminal status of
 * `aborted`, no PR recorded, and a deleted worktree. Four separate defects had
 * to line up for that, and each one gets a test here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync as Database } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const distReady = existsSync(join(root, "dist", "orchestrator", "loop.js"));
const skipDist = { skip: distReady ? false : "run `npm run build` first" };

// ---------------------------------------------------------------------------
// 1. THE PROBE THAT COULD NOT SAY YES
// ---------------------------------------------------------------------------

test("the injected HEAD probe must throw, because the salvage guard reads silence as 'no commits'", () => {
  const src = S("src/index.ts");
  const line = src.split("\n").find((l) => l.includes("worktreeHeadSha:"));
  assert.ok(line, "the probe is still wired in index.ts");
  assert.ok(
    !/\.catch\(\(\)\s*=>\s*""\)/.test(line),
    "swallowing the sha here is what made abortHasSalvageableCommits' throw-handler unreachable",
  );
});

test("every OTHER caller of worktreeHeadSha guards itself, so the throw is safe to let out", () => {
  const src = S("src/orchestrator/loop.ts");
  const unguarded = src
    .split("\n")
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /worktreeHeadSha\(/.test(l) && !/\.catch\(/.test(l))
    // The salvage guard is the one caller that WANTS the throw; it has its own
    // try/catch and turns a failure into "protect the work".
    .filter(({ l }) => !/head = await this\.deps\.worktreeHeadSha/.test(l))
    // The interface declaration is not a call.
    .filter(({ l }) => !/worktreeHeadSha\?:/.test(l));
  assert.deepEqual(
    unguarded.map(({ n }) => n),
    [],
    "a best-effort caller without its own catch would now propagate and kill the run",
  );
});

test("the guard compares HEAD against the fork point, never against an empty base", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("private async abortHasSalvageableCommits");
  const body = src.slice(i, src.indexOf("\n  }", i));
  assert.ok(
    !/commitMadeSince\(/.test(body),
    "the old probe answers `!!base && head !== base`; with the empty base b120 passed it, it could only ever say false",
  );
  assert.match(body, /head !== baseSha/);
});

// ---------------------------------------------------------------------------
// 2. THE PROBE, BEHAVIOURALLY
// ---------------------------------------------------------------------------

const loadScenario = async () => {
  const mod = await import("./helpers/scenario.mjs");
  return (await mod.scenarioAvailable()) ? mod : null;
};

test("an abort holding commits past the fork point does NOT report 'nothing to salvage'", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  // Let the first sub-task run and commit, THEN abort. Aborting before any
  // worker dispatches would be a session with genuinely nothing to keep, which
  // is the opposite case and is covered below.
  let reactionCalls = 0;
  const r = await scenario.runScenario({
    readReactions: async () => ({
      shipIt: false,
      abort: reactionCalls++ > 0,
      pause: false,
      budgetBump: false,
    }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/7",
  });

  assert.equal(
    r.events("loop.abort_nothing_to_salvage").length,
    0,
    "this is the d48ba433 signature: real commits, and the abort said there was nothing to keep",
  );
  const kept = r.events("loop.abort_salvaged_to_pr").length + r.events("loop.abort_worktree_preserved").length;
  assert.ok(kept > 0, "the work must be either pushed or preserved, never simply dropped");
});

test("an abort whose HEAD never moved off the fork point still releases the worktree", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const FORK = "b".repeat(40);
  const r = await scenario.runScenario({
    seedSession: ({ db }) => {
      db.prepare(`UPDATE sessions SET plan_base_sha = ? WHERE id = 'S1'`).run(FORK);
    },
    // HEAD readable, and identical to the fork point: genuinely no commits.
    worktreeHeadSha: async () => FORK,
    deps: { worktreeHeadSha: async () => FORK },
    readReactions: async () => ({ shipIt: false, abort: true, pause: false, budgetBump: false }),
  });

  assert.equal(
    r.events("loop.abort_nothing_to_salvage").length,
    1,
    "protecting empty directories forever is the other way to get this wrong",
  );
});

test("a HEAD probe that returns nothing is 'could not ask', not 'nothing committed'", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  // This is the exact shape b128 shipped: `git.baseSha(p).catch(() => "")`.
  // Every failure mode -- a deleted worktree, a broken git, a permissions
  // error -- arrived here as an empty string, and b120 read it as consent to
  // delete.
  // The probe only goes blind once the abort is in flight: a worktree that
  // vanishes at teardown is the real shape of this, and blinding it from the
  // start would just fail sub-task verification instead.
  let reactionCalls = 0;
  let aborting = false;
  const r = await scenario.runScenario({
    deps: {
      worktreeHeadSha: async (p) => (aborting ? "" : scenario.git(["rev-parse", "HEAD"], p)),
    },
    readReactions: async () => {
      const abort = reactionCalls++ > 0;
      if (abort) aborting = true;
      return { shipIt: false, abort, pause: false, budgetBump: false };
    },
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/9",
  });

  assert.equal(r.events("loop.abort_nothing_to_salvage").length, 0);
  assert.ok(r.events("loop.abort_commit_probe_indeterminate").length > 0, "and it must say it could not tell");
});

test("a HEAD probe that throws is recorded as indeterminate and protects the work", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const r = await scenario.runScenario({
    deps: {
      worktreeHeadSha: async () => {
        throw new Error("fatal: not a git repository");
      },
    },
    readReactions: async () => ({ shipIt: false, abort: true, pause: false, budgetBump: false }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/8",
  });

  assert.equal(r.events("loop.abort_nothing_to_salvage").length, 0);
  assert.ok(
    r.events("loop.abort_commit_probe_indeterminate").length > 0,
    "an unanswerable probe must say so out loud rather than resolving to deletion",
  );
});

// ---------------------------------------------------------------------------
// 3. THE PRESERVE THAT EXPIRED AT THE NEXT RESTART
// ---------------------------------------------------------------------------

const healMod = async () => {
  try {
    return await import("../dist/state/worktree-heal.js");
  } catch {
    return null;
  }
};

function healStore() {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(root, "dist", "state", "schema.sql"), "utf8"));
  return { db, audit() {} };
}

function seedHealSession(db, id, status, worktreePath, preserved) {
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, worktree_preserved)
     VALUES (?, ?, 'C', 'U', 'u', 'o/r', 'harness/x', ?, ?, ?, ?, 50, 0, 0, ?)`,
  ).run(id, `T-${id}`, worktreePath, status, Date.now(), Date.now(), preserved ?? null);
}

test("a worktree an abort deliberately preserved survives the startup self-heal", skipDist, async () => {
  const mod = await healMod();
  if (!mod) return;
  const state = healStore();
  seedHealSession(state.db, "kept", "aborted", "/wt/pending-900", 1);
  const removed = [];
  const result = await mod.healOrphanedWorktrees(state, {
    logger: { info() {}, warn() {}, error() {} },
    listWorktreeDirs: async () => ["/wt/pending-900"],
    releaseByPath: async (p) => {
      removed.push(p);
      return { ok: true, path: p };
    },
    fallbackRepoFullName: "o/r",
  });
  assert.deepEqual(removed, [], "b120 preserved the commits and the next container bounce deleted them anyway");
  assert.equal(result.protected_preserved, 1);
});

test("an ordinary aborted session's leftovers are still reaped", skipDist, async () => {
  const mod = await healMod();
  if (!mod) return;
  const state = healStore();
  seedHealSession(state.db, "gone", "aborted", "/wt/pending-901", null);
  const removed = [];
  await mod.healOrphanedWorktrees(state, {
    logger: { info() {}, warn() {}, error() {} },
    listWorktreeDirs: async () => ["/wt/pending-901"],
    releaseByPath: async (p) => {
      removed.push(p);
      return { ok: true, path: p };
    },
    fallbackRepoFullName: "o/r",
  });
  assert.deepEqual(removed, ["/wt/pending-901"], "the guard must be narrow, or the disk fills up instead");
});

// ---------------------------------------------------------------------------
// 4. A CEILING MUST NOT DISCARD FINISHED WORK
// ---------------------------------------------------------------------------

const loadLoop = async () => {
  try {
    return (await import("../dist/orchestrator/loop.js")).OrchestratorLoop;
  } catch {
    return null;
  }
};

const NO_REACTIONS = { shipIt: false, abort: false, pause: false, budgetBump: false };
const at = (over = {}) => ({
  currentStatus: "reviewing",
  cycle: 4,
  maxCycles: 3,
  reactions: NO_REACTIONS,
  budgetExhausted: false,
  hardTimeout: false,
  ...over,
});

test("a passing verdict outranks the wall clock", skipDist, async () => {
  const Loop = await loadLoop();
  if (!Loop) return;
  const d = Loop.advance(at({ verdict: "pass", hardTimeout: true }));
  assert.equal(d.nextStatus, "done", "d48ba433 earned this verdict and was aborted two milliseconds later");
  assert.equal(d.reason, "adversary_pass");
});

test("a passing verdict also outranks the daily cap, because landing it costs no model spend", skipDist, async () => {
  const Loop = await loadLoop();
  if (!Loop) return;
  assert.equal(Loop.advance(at({ verdict: "pass", budgetExhausted: true })).nextStatus, "done");
});

test("a ship-it reaction outranks the wall clock too", skipDist, async () => {
  const Loop = await loadLoop();
  if (!Loop) return;
  const d = Loop.advance(at({ verdict: "revise", hardTimeout: true, reactions: { ...NO_REACTIONS, shipIt: true } }));
  assert.equal(d.nextStatus, "done");
  assert.equal(d.reason, "user_ship_it_reaction");
});

test("an unfinished run still aborts on the clock", skipDist, async () => {
  const Loop = await loadLoop();
  if (!Loop) return;
  const d = Loop.advance(at({ verdict: "revise", hardTimeout: true }));
  assert.equal(d.nextStatus, "aborted");
  assert.equal(d.reason, "hard_timeout", "the ceiling still stops work that is NOT finished; that half was never broken");
});

test("a blocking verdict is a failure on the clock, not a pass", skipDist, async () => {
  const Loop = await loadLoop();
  if (!Loop) return;
  assert.equal(Loop.advance(at({ verdict: "block", hardTimeout: true })).nextStatus, "aborted");
  assert.equal(Loop.advance(at({ verdict: "block" })).nextStatus, "failed");
});

test("an explicit abort reaction beats everything, including a pass", skipDist, async () => {
  const Loop = await loadLoop();
  if (!Loop) return;
  const d = Loop.advance(at({ verdict: "pass", reactions: { ...NO_REACTIONS, abort: true } }));
  assert.equal(d.nextStatus, "aborted", "a human saying stop is not a race the harness gets to win");
});

// ---------------------------------------------------------------------------
// 5. RESERVING A CYCLE, NOT A CONSTANT
// ---------------------------------------------------------------------------

const loadReserve = async () => {
  try {
    return (await import("../dist/orchestrator/abort-salvage.js")).shouldReserveTimeToShip;
  } catch {
    return null;
  }
};

const HOUR = 3600_000;

test("with room for another cycle the loop keeps revising", skipDist, async () => {
  const reserve = await loadReserve();
  if (!reserve) return;
  assert.equal(
    reserve({
      now: 0,
      hardDeadlineMs: HOUR,
      reserveSeconds: 600,
      totalBudgetSeconds: 7200,
      hasWork: true,
      observedCycleMs: 25 * 60_000,
    }),
    false,
    "an hour left and cycles running 25 minutes: there is room, so do not land early",
  );
});

test("a cycle that will not fit lands the work instead of starting it", skipDist, async () => {
  const reserve = await loadReserve();
  if (!reserve) return;
  assert.equal(
    reserve({
      now: 0,
      hardDeadlineMs: 20 * 60_000,
      reserveSeconds: 600,
      totalBudgetSeconds: 7200,
      hasWork: true,
      observedCycleMs: 25 * 60_000,
    }),
    true,
    "this is exactly d48ba433: ~20 minutes left, 25-minute cycles, and b120 waved it through",
  );
});

test("b120's constant-only behaviour is preserved when nothing has been measured yet", skipDist, async () => {
  const reserve = await loadReserve();
  if (!reserve) return;
  const args = { now: 0, hardDeadlineMs: 20 * 60_000, reserveSeconds: 600, totalBudgetSeconds: 7200, hasWork: true };
  assert.equal(reserve(args), false, "at the first review boundary there is no cycle length to reason with");
  assert.equal(reserve({ ...args, observedCycleMs: 0 }), false);
});

test("one pathological cycle cannot disable revising for the rest of the run", skipDist, async () => {
  const reserve = await loadReserve();
  if (!reserve) return;
  // A 90-minute cycle on a 2h budget would otherwise claim more runway than
  // exists and land every subsequent run after cycle 1.
  assert.equal(
    reserve({
      now: 0,
      hardDeadlineMs: 75 * 60_000,
      reserveSeconds: 600,
      totalBudgetSeconds: 7200,
      hasWork: true,
      observedCycleMs: 90 * 60_000,
    }),
    false,
    "the cycle allowance is capped at half the budget for exactly this reason",
  );
});

test("no work means nothing to reserve for", skipDist, async () => {
  const reserve = await loadReserve();
  if (!reserve) return;
  assert.equal(
    reserve({ now: 0, hardDeadlineMs: 1000, reserveSeconds: 600, hasWork: false, observedCycleMs: HOUR }),
    false,
  );
});

// ---------------------------------------------------------------------------
// 6. THE CI REPAIR GRANT NOW COSTS TIME
// ---------------------------------------------------------------------------

test("a red build does NOT buy a repair cycle there is no time to run", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  // b127 granted this cycle on money alone. On d48ba433 it handed one out with
  // roughly twenty minutes left against twenty-five-minute cycles, and the run
  // was guillotined during the review that would have shipped it -- so the
  // repair cost $7 and fixed nothing.
  const r = await scenario.runScenario({
    configOver: {
      loop: { max_cycles: 1, session_hard_timeout_seconds: 4 },
      ci: { max_repair_cycles: 1, poll_interval_seconds: 1 },
    },
    runAdversary: async () => {
      await new Promise((res) => setTimeout(res, 1500));
      return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
    },
    deps: {
      ciSnapshot: async () => ({
        state: "failure",
        checkTotal: 1,
        checksReadable: true,
        statusReadable: true,
        reason: "test says failure",
        checksSource: "check_runs",
      }),
      ciFailingLogs: async () => `Summary of all failing tests
FAIL src/a.test.ts
  ● a thing › does the thing
    expect(received).toBe(expected)`,
    },
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/12",
  });

  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 0, "there was no time for it");
  const declined = r.events("loop.ci_repair_declined");
  assert.equal(declined.length, 1, "and refusing silently is how b127 looked like it had not noticed");
  assert.equal(declined[0].payload.reason, "wall_clock");
  assert.equal(declined[0].payload.clockOk, false);
  assert.equal(r.session().cycles_ran, 1, "the cycle must not run");
});

test("the CI repair grant is priced in minutes as well as dollars", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("const canRepair =");
  assert.ok(i > 0);
  const decl = src.slice(src.lastIndexOf("const repairCeiling", 0, i) >= 0 ? i - 1400 : i - 1400, i + 200);
  assert.match(decl, /clockOk/, "b127 asked only whether the money was there");
  assert.match(src.slice(i, i + 200), /&& clockOk/);
  // b131 re-ordered this ladder so the ceiling is named before the clock -- see
  // beta131-ci-repair-routing.test.mjs. What b129 needs from it is unchanged:
  // the clock must be one of the reasons a repair can be refused.
  assert.match(src, /reason:\s*\n?\s*repairCeiling === 0 \? "disabled"/);
  assert.match(src, /: !clockOk \? "wall_clock"/);
});

// ---------------------------------------------------------------------------
// 7. BUYING MORE CLOCK
// ---------------------------------------------------------------------------

const loadTimeExt = async () => {
  try {
    return await import("../dist/orchestrator/time-extension.js");
  } catch {
    return null;
  }
};

test("a bare duration is an approval, because this prompt asks about nothing else", skipDist, async () => {
  const m = await loadTimeExt();
  if (!m) return;
  const opts = { defaultSeconds: 1800 };
  assert.deepEqual(m.parseTimeExtensionReply("1 hour", opts), {
    approved: true,
    seconds: 3600,
    interpretation: "explicit_duration",
  });
  assert.equal(m.parseTimeExtensionReply("give it 45 minutes", opts).seconds, 2700);
  assert.equal(m.parseTimeExtensionReply("90m", opts).seconds, 5400);
  assert.equal(m.parseTimeExtensionReply("1.5 hours", opts).seconds, 5400);
});

test("a plain yes takes the configured default", skipDist, async () => {
  const m = await loadTimeExt();
  if (!m) return;
  const r = m.parseTimeExtensionReply("yes", { defaultSeconds: 1800 });
  assert.equal(r.approved, true);
  assert.equal(r.seconds, 1800);
  assert.equal(r.interpretation, "approved_default");
  assert.equal(m.parseTimeExtensionReply("keep going", { defaultSeconds: 600 }).seconds, 600);
});

test('"no more than 20 minutes" is an approval, not a refusal', skipDist, async () => {
  const m = await loadTimeExt();
  if (!m) return;
  // Matching declines anywhere in the string would read the leading "no" as a
  // refusal and throw away the twenty minutes the operator just granted.
  const r = m.parseTimeExtensionReply("no more than 20 minutes", { defaultSeconds: 1800 });
  assert.equal(r.approved, true);
  assert.equal(r.seconds, 1200);
});

test("refusals and unreadable replies both land the work", skipDist, async () => {
  const m = await loadTimeExt();
  if (!m) return;
  const opts = { defaultSeconds: 1800 };
  for (const reply of ["no", "ship", "ship it", "stop", "abort", "enough"]) {
    const r = m.parseTimeExtensionReply(reply, opts);
    assert.equal(r.approved, false, `"${reply}" must not buy more time`);
    assert.equal(r.interpretation, "declined");
  }
  for (const reply of ["", "   ", "what?", "the sidebar test is wrong"]) {
    const r = m.parseTimeExtensionReply(reply, opts);
    assert.equal(r.approved, false, `"${reply}" is not a grant`);
    assert.equal(r.seconds, 0);
  }
});

test("nobody extends past the ceiling however they phrase it", skipDist, async () => {
  const m = await loadTimeExt();
  if (!m) return;
  const r = m.parseTimeExtensionReply("400 hours", { defaultSeconds: 1800 });
  assert.equal(r.seconds, m.MAX_EXTENSION_SECONDS);
});

test("the pause marker round-trips so harness_answer can tell a live loop from a dead one", skipDist, async () => {
  const m = await loadTimeExt();
  if (!m) return;
  const marker = m.renderTimeExtensionMarker(1234567);
  assert.equal(m.isTimeExtensionPause(marker), true);
  assert.equal(m.readTimeExtensionWaitUntil(marker), 1234567);
  assert.equal(m.isTimeExtensionPause(JSON.stringify({ kind: "brief_confirmation" })), false);
  assert.equal(m.isTimeExtensionPause(null), false);
  assert.equal(m.isTimeExtensionPause("not json"), false);
});

test("the question states the money left, the clock left, and the fallback", skipDist, async () => {
  const m = await loadTimeExt();
  if (!m) return;
  const q = m.renderTimeExtensionQuestion({
    cycle: 4,
    blockingFindings: 3,
    spentUsd: 21.55,
    budgetUsd: 40,
    remainingSeconds: 600,
    observedCycleSeconds: 1500,
    defaultSeconds: 1800,
    waitSeconds: 300,
  });
  assert.match(q, /\$21\.55 of \$40\.00/, "the unspent money is the reason this question exists");
  assert.match(q, /3 blocking finding/);
  assert.match(q, /25 min/, "and the measured cycle length is why another one does not fit");
  assert.match(q, /ships anyway/i, "an unanswered question must never strand the work");
});

test("answering a live time-extension pause records the reply without starting a second run", () => {
  const src = S("src/tools/registration.ts");
  const i = src.indexOf("isTimeExtensionPause(row.clarification_subtask)");
  assert.ok(i > 0, "harness_answer must recognise the pause");
  const body = src.slice(i, i + 1200);
  assert.match(body, /readTimeExtensionWaitUntil/, "and must check whether a loop is still waiting");
  assert.ok(
    !/loop\.run\(/.test(body.slice(0, body.indexOf("Fall through"))),
    "re-driving the loop here would run a second session against the same worktree",
  );
});

test("a granted extension is persisted, so a crash-resume honours what was paid for", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("if (grantedSeconds > 0)");
  assert.ok(i > 0);
  const body = src.slice(i, i + 900);
  assert.match(body, /hardDeadlineMs \+= grantedSeconds \* 1000/);
  assert.match(body, /timeExtensionCyclesGranted \+= 1/, "more time is useless without a cycle to spend it on");
  // b130 moved the write into a helper so the CI-repair ask shares it. What
  // matters is that the granted ceiling still reaches the row.
  assert.match(body, /persistExtendedDeadline\(sessionId, sessionTimeoutSeconds\)/);
  assert.match(
    src.slice(src.indexOf("private persistExtendedDeadline")),
    /UPDATE sessions SET hard_timeout_seconds/,
  );
});

test("the extension cycle joins the loop bound, or the grant is a lie", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(
    src,
    /while \(cycle < this\.deps\.config\.loop\.max_cycles \+ cycleExtensionsGranted \+ ciRepairCyclesGranted \+ timeExtensionCyclesGranted\)/,
    "b124 and b127 each had to learn this: a grant the bound does not know about does not run",
  );
});

// ---------------------------------------------------------------------------
// 7b. THE ASK, END TO END
//
// Driven directly rather than through a full scenario, because provoking the
// reserve guard with real cycle timings would make the test a stopwatch race.
// What matters here is the contract: it asks, it waits, it reads the answer
// written by harness_answer, and it never hangs.
// ---------------------------------------------------------------------------

async function askHarness(over = {}) {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig, QUIET } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES ('S9','T','C','U','u','o/r','harness/x','/wt/s9','reviewing', ?, ?, 40, 21.55, 4)`,
  ).run(now, now);

  const loop = new OrchestratorLoop({
    state,
    logger: QUIET,
    config: makeConfig({
      loop: {
        ...makeConfig().loop,
        time_extension_wait_seconds: 3,
        time_extension_default_seconds: 1800,
        ...(over.loop ?? {}),
      },
    }),
    readReactions: async () => NO_REACTIONS,
    ...(over.deps ?? {}),
  });

  const ask = loop.askForTimeExtension({
    sessionId: "S9",
    cycle: 4,
    blockingFindings: 3,
    spentUsd: 21.55,
    budgetUsd: 40,
    remainingMs: 60_000,
    observedCycleMs: 25 * 60_000,
  });
  return { ask, db, state, audits, loop };
}

test("the ask posts a question, waits, and honours the answer written into the row", skipDist, async (t) => {
  let h;
  try {
    h = await askHarness();
  } catch {
    return t.skip("scenario helpers unavailable");
  }

  // The question must be visible to the operator BEFORE the answer arrives --
  // that is the whole point, and a question nobody can see is a hang.
  await new Promise((r) => setTimeout(r, 150));
  const paused = h.db.prepare(`SELECT status, clarification_question, clarification_seq FROM sessions WHERE id='S9'`).get();
  assert.equal(paused.status, "awaiting_clarification");
  assert.match(paused.clarification_question, /wall clock/i);
  assert.equal(paused.clarification_seq, -3);

  // This is what harness_answer does, and nothing else.
  h.db.prepare(`UPDATE sessions SET clarification_answer = '1 hour' WHERE id='S9'`).run();

  const granted = await h.ask;
  assert.equal(granted, 3600, "an hour asked for is an hour granted");

  const after = h.db.prepare(`SELECT status, clarification_question FROM sessions WHERE id='S9'`).get();
  assert.equal(after.status, "reviewing", "the loop resumes where it paused; it does not re-plan");
  assert.equal(after.clarification_question, null, "and the question is cleared so nothing else answers it");
});

test("silence ships the work rather than stranding it", skipDist, async (t) => {
  let h;
  try {
    h = await askHarness({ loop: { time_extension_wait_seconds: 1 } });
  } catch {
    return t.skip("scenario helpers unavailable");
  }
  const granted = await h.ask;
  assert.equal(granted, 0, "an unanswered question must never be the reason a PR is missing");
  assert.ok(
    h.audits.some((a) => a.event === "loop.time_extension_timeout"),
    "and the report has to be able to say the operator was asked and did not reply",
  );
});

test("a refusal is honoured immediately and audited with its reading", skipDist, async (t) => {
  let h;
  try {
    h = await askHarness();
  } catch {
    return t.skip("scenario helpers unavailable");
  }
  await new Promise((r) => setTimeout(r, 150));
  h.db.prepare(`UPDATE sessions SET clarification_answer = 'ship it' WHERE id='S9'`).run();
  assert.equal(await h.ask, 0);
  const declined = h.audits.find((a) => a.event === "loop.time_extension_declined");
  assert.ok(declined, "a decline is a decision and belongs in the audit trail");
  assert.equal(declined.payload.interpretation, "declined");
});

test("disabling the wait restores b120: land it, ask nothing", skipDist, async (t) => {
  let h;
  try {
    h = await askHarness({ loop: { time_extension_wait_seconds: 0 } });
  } catch {
    return t.skip("scenario helpers unavailable");
  }
  assert.equal(await h.ask, 0);
  assert.equal(
    h.db.prepare(`SELECT clarification_question FROM sessions WHERE id='S9'`).get().clarification_question,
    null,
    "with the wait switched off nobody should be interrupted at all",
  );
});

test("a granted extension buys a cycle, but no progress with blocking findings does not open a PR", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const bundle = await scenario.makeState();
  // Answer the moment the question appears, standing in for harness_answer.
  const answerer = setInterval(() => {
    try {
      const row = bundle.db.prepare(`SELECT clarification_seq FROM sessions WHERE id = 'S1'`).get();
      if (row?.clarification_seq === -3) {
        bundle.db.prepare(`UPDATE sessions SET clarification_answer = '1 hour' WHERE id = 'S1'`).run();
      }
    } catch { /* the row is not there yet */ }
  }, 25);

  let r;
  try {
    r = await scenario.runScenario({
      stateBundle: bundle,
      configOver: {
        loop: {
          // A ceiling the first cycle does not breach, but leaves no room for a
          // second -- d48ba433 in miniature. The guard fires when
          // `remaining < 25% of total + the measured cycle`, so the window is
          // `elapsed < total < 2.67 x elapsed`, and the slow adversary below
          // keeps elapsed comfortably inside it.
          max_cycles: 1,
          session_hard_timeout_seconds: 5,
          time_extension_wait_seconds: 5,
          time_extension_default_seconds: 1800,
        },
      },
      // Slow enough that the first cycle provably eats past the reserve, so
      // the guard fires on measurement rather than on a stopwatch race.
      runAdversary: async () => {
        await new Promise((res) => setTimeout(res, 2000));
        return {
          verdict: "revise",
          findings: [{ severity: "high", kind: "spec", file: "src/thing.ts", detail: "not finished" }],
          summary: "still work to do",
          costUsd: 0.02,
          tokensIn: 1,
          tokensOut: 1,
        };
      },
      pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/11",
    });
  } finally {
    clearInterval(answerer);
  }

  assert.ok(r.events("loop.time_extension_requested").length > 0, "the clock should have squeezed the cycle out");
  assert.equal(r.events("loop.time_extension_granted").length, 1);
  assert.equal(
    r.session().cycles_ran,
    2,
    "an extension the loop bound ignores is not an extension -- b124 and b127 both learned this the hard way",
  );
  assert.equal(
    r.events("loop.pr_opened").length,
    0,
    "the extra cycle changed nothing while a HIGH finding remained, so opening a PR would misrepresent completion",
  );
  assert.equal(r.session().final_pr_url, null);
  assert.equal(r.events("loop.cycle_no_change_blocked").length, 1);
});

// ---------------------------------------------------------------------------
// 8. THE KNOB NOBODY COULD FIND
// ---------------------------------------------------------------------------

const loadConfirm = async () => {
  try {
    return await import("../dist/tools/brief-confirmation.js");
  } catch {
    return null;
  }
};

const BRIEF = {
  title: "Add a thing",
  motivation: "because",
  acceptanceCriteria: ["it works"],
  filesLikelyTouched: [],
  outOfScope: [],
  riskLevel: "high",
};

test("the confirmation gate advertises the clock, not just the cap", skipDist, async () => {
  const m = await loadConfirm();
  if (!m) return;
  const text = m.renderBriefConfirmation({
    brief: BRIEF,
    estimatedUsd: 12,
    effectiveBudget: 10,
    hardTimeoutSeconds: 7200,
  });
  assert.match(text, /time budget/i, "b123 parsed this and no message ever mentioned it");
  assert.match(text, /2h/, "the operator cannot judge the default without being told it");
  assert.match(text, /whether or not the budget is spent/i, "which is the whole failure mode");
});

test("a ceiling that is not a whole number of hours is stated honestly", skipDist, async () => {
  const m = await loadConfirm();
  if (!m) return;
  const render = (hardTimeoutSeconds) =>
    m.renderBriefConfirmation({ brief: BRIEF, estimatedUsd: 12, effectiveBudget: 10, hardTimeoutSeconds });
  // Rounding to whole hours told the first local b129 run its 50-minute
  // ceiling was "1h". The operator budgets against the number they are shown,
  // so overstating the runway is the one direction that cannot be tolerated.
  assert.match(render(3000), /50m/, "50 minutes must not round up to an hour");
  assert.doesNotMatch(render(3000), /\b1h\b/);
  assert.match(render(1200), /20m/, "and 20 minutes must not collapse to 0h");
  assert.doesNotMatch(render(1200), /0h/);
  assert.match(render(5400), /1h 30m/, "an hour and a half is not two hours");
  assert.match(render(7200), /2h\b/, "the whole-hour default still reads cleanly");
});

test("the syntax the gate advertises is syntax the parser actually accepts", skipDist, async () => {
  const m = await loadConfirm();
  if (!m) return;
  const text = m.renderBriefConfirmation({
    brief: BRIEF,
    estimatedUsd: 12,
    effectiveBudget: 10,
    hardTimeoutSeconds: 7200,
  });
  // Pull the worked example straight out of the message and feed it back in.
  // A gate that documents a phrasing it cannot parse is worse than a silent
  // one, because the operator believes the run has four hours.
  const example = /"(confirm, budget \$40 with a time budget of 4 hours)"/.exec(text)?.[1];
  assert.ok(example, "the message must carry a concrete worked example");
  const parsed = m.parseConfirmationReply(example);
  assert.equal(parsed.budgetUsd, 40);
  assert.equal(parsed.timeoutSeconds, 14400);
  assert.equal(parsed.approves, true, "and it must read as an approval, not as a correction to the spec");
});

// ---------------------------------------------------------------------------
// 9. THE REPORT STOPS LYING
// ---------------------------------------------------------------------------

test("the terminal-cause section knows that aborts are terminal", () => {
  const src = S("scripts/smoke-report.mjs");
  const i = src.indexOf('rule("6. TERMINAL CAUSE")');
  const body = src.slice(i, i + 2000);
  assert.match(body, /"loop\.aborted"/, "two smokes in three releases reported 'no terminal cause' on a hard_timeout");
  assert.match(body, /abort reason:/);
  assert.match(body, /abort_nothing_to_salvage/, "and must flag the salvage claim rather than repeating it");
});

test("the CI section reports what CI concluded, not what the first poll could not see", () => {
  const src = S("scripts/smoke-report.mjs");
  const i = src.indexOf('rule("3. CI SIGNAL PATH');
  const body = src.slice(i, src.indexOf('rule("4.', i));
  assert.match(body, /loop\.ci_failure/, "a red build outranks an early 'read 0 runs' snapshot");
  assert.match(body, /snapshot taken before CI had started/);
});

test("the header finds a PR that was opened mid-run", () => {
  const src = S("scripts/smoke-report.mjs");
  assert.match(src, /loop\.pr_opened/, "since b127 the PR exists long before final_pr_url is written");
  const loop = S("dist/orchestrator/loop.js");
  assert.match(loop, /^\s*this\.deps\.state\.audit\("loop\.pr_opened"/m);
  assert.match(
    loop,
    /UPDATE sessions SET final_pr_url = \?, pr_number = \?, updated_at = \? WHERE id = \?/,
    "the row should know its own PR the moment the PR exists",
  );
});
