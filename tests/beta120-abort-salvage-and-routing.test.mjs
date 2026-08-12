/**
 * beta.120: the six loop fixes the b119 take-2 smoke earned.
 *
 * That run cost ~$18.46 and 121.6 minutes and delivered nothing, and every one
 * of these tests reproduces a specific step of how it managed that:
 *
 *   1. a wall-clock abort DELETED 27 commits, 15 files and a clean typecheck;
 *   2. co-fix routing wrote grants into the ownership map, so the fan-out
 *      compounded 1.9 -> 5.0 (peak 9) across cycles;
 *   3. every co-owner was told "fix this", so none of them did;
 *   4. the deadline was only consulted to decide whether to abort, never
 *      whether there was time left to ship;
 *   5. the worktree vanished with no audit event explaining it;
 *   6. the cycle-extension budget check ignored the session's own budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const S = (p) => readFileSync(resolve(ROOT, p), "utf8");

let salvage = null;
let loopMod = null;
try {
  salvage = await import("../dist/orchestrator/abort-salvage.js");
  loopMod = await import("../dist/orchestrator/loop.js");
} catch {
  /* dist not built: structural tests still run */
}
const skip = { skip: salvage === null ? "dist not built" : false };
const skipLoop = { skip: loopMod === null ? "dist not built" : false };

let progressMod = null;
let openStateStoreSync = null;
try {
  progressMod = await import("../dist/orchestrator/progress.js");
  ({ openStateStoreSync } = await import("../dist/state/store.js"));
} catch {
  /* dist not built */
}
const skipProgress = { skip: progressMod === null ? "dist not built" : false };

/** A terminal, aborted session plus the audit trail an abort leaves behind. */
async function abortedSession(id, costUsd, events) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "b120-"));
  const store = openStateStoreSync(join(dir, "h.db"));
  const now = Date.now();
  store.db
    .prepare(
      `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
         status, cost_usd, budget_usd, cycles_ran, created_at, updated_at)
       VALUES (?, '', '', 'U1', '', 'acme/repo', 'harness/feat-x', ?, 'aborted', ?, 18, 3, ?, ?)`,
    )
    .run(id, join(dir, "wt"), costUsd, now, now);
  for (const [event, payload] of events) {
    store.db
      .prepare(`INSERT INTO audit_log (session_id, event, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, event, JSON.stringify(payload), Date.now());
  }
  return { db: store.db };
}

// ---------------------------------------------------------------------------
// Fix 1: an abort must never destroy work
// ---------------------------------------------------------------------------

test("a resource ceiling ships what it has; a user abort does not", skip, () => {
  const { ABORT_REASONS_WORTH_SHIPPING } = salvage;
  // Running out of runway says nothing about the code.
  assert.ok(ABORT_REASONS_WORTH_SHIPPING.has("hard_timeout"));
  assert.ok(ABORT_REASONS_WORTH_SHIPPING.has("budget_exhausted"));
  assert.ok(ABORT_REASONS_WORTH_SHIPPING.has("daily_max_exhausted"));
  assert.ok(ABORT_REASONS_WORTH_SHIPPING.has("ship_time_reserved"));
  // A human saying "stop" is a judgement, and opening a PR would override it.
  assert.ok(!ABORT_REASONS_WORTH_SHIPPING.has("user_abort_reaction"));
});

test("the salvaged PR says plainly that nothing signed off on it", skip, () => {
  const { describeAbortSalvage } = salvage;
  const msg = describeAbortSalvage("hard_timeout", 3, {
    verdict: "revise",
    findings: [{ severity: "medium" }, { severity: "low" }],
    summary: "",
  });
  assert.match(msg, /NOT machine-approved/);
  assert.match(msg, /wall-clock/, "the human must know it stopped on a clock, not on a quality judgement");
  assert.match(msg, /3 review cycles/);
  assert.match(msg, /2 open findings/);
  assert.match(msg, /NOT fixed/);
  assert.match(msg, /harness_revise/, "the cheapest next step must be named");
});

test("a salvaged PR with no review at all admits that too", skip, () => {
  const msg = salvage.describeAbortSalvage("budget_exhausted", 1, null);
  assert.match(msg, /1 review cycle\b/, "singular, not '1 review cycles'");
  assert.match(msg, /nothing here has been reviewed/);
});

// ---------------------------------------------------------------------------
// Fix 4: reserve wall clock for the ship step
// ---------------------------------------------------------------------------

test("the loop stops revising once there is only enough time left to ship", skip, () => {
  const { shouldReserveTimeToShip } = salvage;
  const now = 1_000_000;
  const base = { now, reserveSeconds: 600, totalBudgetSeconds: 7200, hasWork: true };

  assert.equal(
    shouldReserveTimeToShip({ ...base, hardDeadlineMs: now + 300_000 }),
    true,
    "5 minutes left and a 10-minute reserve: land it",
  );
  assert.equal(
    shouldReserveTimeToShip({ ...base, hardDeadlineMs: now + 3_600_000 }),
    false,
    "an hour left: keep revising",
  );
  assert.equal(
    shouldReserveTimeToShip({ ...base, hardDeadlineMs: now - 1 }),
    false,
    "already past the deadline is the abort path's business, not this one's",
  );
  assert.equal(
    shouldReserveTimeToShip({ ...base, hardDeadlineMs: now + 300_000, hasWork: false }),
    false,
    "nothing to ship yet",
  );
  assert.equal(
    shouldReserveTimeToShip({ ...base, hardDeadlineMs: now + 300_000, reserveSeconds: 0 }),
    false,
    "0 disables the feature",
  );
});

test("the reserve can never be large enough to disable revising", skip, () => {
  const { shouldReserveTimeToShip, MAX_RESERVE_FRACTION } = salvage;
  assert.ok(MAX_RESERVE_FRACTION > 0 && MAX_RESERVE_FRACTION <= 0.5);
  const now = 1_000_000;
  // The trap: a 300s session against the default 600s reserve. Unclamped, the
  // FIRST review boundary already has "too little time left", so the run ships
  // after one cycle and never revises -- the feature would invert itself.
  assert.equal(
    shouldReserveTimeToShip({ now, hardDeadlineMs: now + 300_000, reserveSeconds: 600, totalBudgetSeconds: 300, hasWork: true }),
    false,
    "a reserve longer than the whole session must be clamped, not obeyed",
  );
  // Clamped to 75s of a 300s session: still fires when genuinely nearly out.
  assert.equal(
    shouldReserveTimeToShip({ now, hardDeadlineMs: now + 30_000, reserveSeconds: 600, totalBudgetSeconds: 300, hasWork: true }),
    true,
  );
});

test("advance() lands the run rather than starting a cycle it cannot finish", skipLoop, () => {
  const { OrchestratorLoop } = loopMod;
  const base = {
    currentStatus: "reviewing",
    cyclesRan: 1,
    maxCycles: 3,
    reactions: { shipIt: false, abort: false, pause: false },
    budgetExhausted: false,
    hardTimeout: false,
  };
  assert.deepEqual(
    OrchestratorLoop.advance({ ...base, verdict: "revise", blockingFindings: 2, shipTimeReserved: true }),
    { nextStatus: "done", reason: "ship_time_reserved" },
  );
  // It must not convert a real failure into a ship, or pre-empt a clean pass.
  assert.equal(OrchestratorLoop.advance({ ...base, verdict: "block", shipTimeReserved: true }).nextStatus, "failed");
  assert.equal(
    OrchestratorLoop.advance({ ...base, verdict: "pass", shipTimeReserved: true }).reason,
    "adversary_pass",
  );
  // And an already-expired deadline still aborts (which now salvages).
  assert.equal(
    OrchestratorLoop.advance({ ...base, verdict: "revise", hardTimeout: true, shipTimeReserved: true }).nextStatus,
    "aborted",
  );
  // The flag is opt-in. Anything looser than an explicit `true` -- an omitted
  // field read as truthy, say -- would end every run after its first cycle,
  // which is the whole revise loop switched off by accident.
  assert.equal(
    OrchestratorLoop.advance({ ...base, verdict: "revise", blockingFindings: 2 }).nextStatus,
    "executing",
    "an absent shipTimeReserved must not land the run",
  );
  assert.equal(
    OrchestratorLoop.advance({ ...base, verdict: "revise", blockingFindings: 2, shipTimeReserved: false }).nextStatus,
    "executing",
  );
});

// ---------------------------------------------------------------------------
// Fix 6: an extension may not spend money the requester did not authorise
// ---------------------------------------------------------------------------

test("the cycle extension respects the session's OWN budget, not just the operator ceiling", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("private hasBudgetHeadroomForAnotherCycle");
  assert.ok(i > 0);
  const body = src.slice(i, i + 2200);
  assert.match(body, /sessionBudgetUsd/, "b119 checked only the operator ceiling and the daily cap");
  assert.match(
    body,
    /spentUsd \+ projected > sessionBudgetUsd/,
    "the b119 take-2 run finished at $18.46 against an $18 session budget and would still have qualified",
  );
  // The session budget must be checked BEFORE the operator ceiling, so the
  // tighter, user-facing limit is the one that binds.
  assert.ok(
    body.indexOf("sessionBudgetUsd") < body.indexOf("session_hard_ceiling_usd"),
    "the requester's own number should be the first constraint consulted",
  );
});

// ---------------------------------------------------------------------------
// Fix 5: work loss can never be silent
// ---------------------------------------------------------------------------

test("every worktree release path audits, including the ones that do nothing", () => {
  const src = S("src/orchestrator/loop.ts");
  for (const fn of ["private async tryReleaseWorktree", "private scheduleWorktreeReleaseForSession"]) {
    const i = src.indexOf(fn);
    assert.ok(i > 0, `${fn} not found`);
    const head = src.slice(i, i + 900);
    assert.match(
      head,
      /if \(!this\.deps\.releaseWorktree\) \{[\s\S]*?worktree_release_skipped/,
      `${fn} returned in silence when the dependency was absent -- that is how "the worktree is gone and nothing says why" happens`,
    );
    // An event with no stated cause is barely better than no event: the
    // operator still cannot tell a deliberate skip from a swallowed failure.
    assert.match(
      head,
      /reason_skipped: "no releaseWorktree dependency wired"/,
      `${fn} must say WHY it skipped, not merely that it did`,
    );
  }
  const sched = src.slice(src.indexOf("private scheduleWorktreeReleaseForSession"));
  assert.match(sched.slice(0, 2500), /no session row found/);
  assert.match(sched.slice(0, 2500), /session row has no repo/);
});

// ---------------------------------------------------------------------------
// Fixes 1-3 wiring: the loop actually uses all of this
// ---------------------------------------------------------------------------

test("no abort path can reach the deleting finaliser without passing the salvage gate", () => {
  const src = S("src/orchestrator/loop.ts");
  // Every call site outside the two finalisers themselves must go through the
  // salvaging entry point.
  const rawCalls = [...src.matchAll(/this\.finaliseAbort\(/g)].map((m) => m.index);
  const declIdx = src.indexOf("private finaliseAbort(");
  const salvageIdx = src.indexOf("private async finaliseAbortSalvaging(");
  assert.ok(declIdx > 0 && salvageIdx > 0);
  for (const idx of rawCalls) {
    const insideSalvager = idx > salvageIdx && idx < salvageIdx + 6000;
    assert.ok(
      insideSalvager,
      `raw finaliseAbort call at ${idx} bypasses the salvage gate; route it through finaliseAbortSalvaging`,
    );
  }
  assert.ok(src.includes("finaliseAbortSalvaging(sessionId, \"hard_timeout\""), "the timeout that caused this must be routed");
});

test("the salvage path preserves rather than releases when the push fails", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("private async finaliseAbortSalvaging");
  const body = src.slice(i, i + 7000);
  // Release happens only on the success branch, after a PR exists.
  assert.match(body, /loop\.abort_salvaged_to_pr/);
  assert.match(body, /tryReleaseWorktree\(sessionId, row\.repo, row\.worktree_path, "shipped"\)/);
  // And the failure branch is explicit about keeping the work.
  assert.match(body, /loop\.abort_salvage_pr_failed/);
  assert.match(body, /loop\.abort_worktree_preserved/);
  const relIdx = body.indexOf("tryReleaseWorktree");
  const failIdx = body.indexOf("loop.abort_salvage_pr_failed");
  assert.ok(relIdx < failIdx, "the only release must sit on the shipped branch, above the failure handling");
});

test("a commit probe that cannot answer protects the work instead of deleting it", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("private async abortHasSalvageableCommits");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("\n  }", i));

  // The HEAD probe must not collapse a thrown error into "no commits": that
  // reads as nothing-to-salvage and releases the worktree, which is fail-OPEN
  // and is exactly how b119 take-2 lost 27 commits.
  assert.ok(
    !/worktreeHeadSha\([^)]*\)\.catch\(\(\) => ""\)/.test(body),
    "a throwing HEAD probe must not be indistinguishable from an unborn HEAD",
  );
  assert.match(body, /loop\.abort_commit_probe_indeterminate/, "an unanswerable probe is recorded");

  // Both probes resolve doubt towards keeping the work.
  const headCatch = body.indexOf("catch (probeErr)");
  assert.ok(headCatch > 0, "the HEAD probe has its own catch");
  // Bound the slice to THAT catch block, or a `return true` belonging to the
  // outer catch further down would satisfy this even when the probe fails open.
  const catchBody = body.slice(headCatch, body.indexOf("\n      }", headCatch));
  assert.match(catchBody, /return true;/, "the HEAD-probe catch itself must protect the work");
  assert.ok(!/return false;/.test(catchBody), "and must not resolve doubt towards deletion");
  assert.match(body, /made: true, detail: "probe failed/, "the commitMadeSince probe already failed closed");
  assert.match(body, /assuming there IS work to protect/);
});

test("the abort headline names the cause and says the work survived", skipProgress, async () => {
  // Preserving 27 commits is only half a fix if the operator's one-line summary
  // still reads "Aborted $18.46." and nothing else, which is what the b119
  // take-2 run actually reported.
  const { db } = await abortedSession("s-abort", 18.46, [
    ["loop.aborted", { reason: "hard_timeout", worktreePreserved: true }],
    ["loop.abort_worktree_preserved", { reason: "hard_timeout", worktreePath: "/wt/s-abort", branch: "harness/feat-x" }],
  ]);

  const snap = progressMod.buildProgressSnapshot(db, "s-abort");
  assert.match(snap.headline, /hard_timeout/, "the cause must be named, not left blank");
  assert.match(snap.headline, /NOT lost/i, "and the operator must learn the commits survived");
  assert.match(snap.headline, /harness_revise/, "with the route to continue from them");
});

test("an abort with nothing to preserve does not promise work that isn't there", skipProgress, async () => {
  const { db } = await abortedSession("s-empty", 0.2, [
    ["loop.aborted", { reason: "user_abort_reaction" }],
    ["loop.abort_nothing_to_salvage", { reason: "user_abort_reaction" }],
  ]);

  const snap = progressMod.buildProgressSnapshot(db, "s-empty");
  assert.match(snap.headline, /user_abort_reaction/);
  assert.ok(!/NOT lost/i.test(snap.headline), "no false promise of preserved commits");
});

test("the operator is told where preserved work lives", () => {
  const src = S("src/orchestrator/loop.ts");
  const i = src.indexOf("loop.abort_worktree_preserved");
  const body = src.slice(i, i + 1200);
  assert.match(body, /worktreePath/);
  assert.match(body, /branch/);
  assert.match(body, /harness_revise/, "a preserved branch is only useful if the recovery route is named");
});
