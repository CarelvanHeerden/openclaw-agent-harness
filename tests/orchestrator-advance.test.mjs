import test from "node:test";
import assert from "node:assert/strict";

let OrchestratorLoop;
try {
  ({ OrchestratorLoop } = await import("../dist/orchestrator/loop.js"));
} catch {
  OrchestratorLoop = null;
}

const base = {
  currentStatus: "planning",
  cyclesRan: 0,
  maxCycles: 3,
  reactions: { shipIt: false, abort: false, pause: false },
  budgetExhausted: false,
  hardTimeout: false,
};

test("advance: normal progression crystallising -> planning -> executing -> reviewing",
  { skip: OrchestratorLoop === null }, () => {
    assert.equal(OrchestratorLoop.advance({ ...base, currentStatus: "crystallising" }).nextStatus, "planning");
    assert.equal(OrchestratorLoop.advance({ ...base, currentStatus: "planning" }).nextStatus, "executing");
    assert.equal(OrchestratorLoop.advance({ ...base, currentStatus: "executing" }).nextStatus, "reviewing");
  });

test("advance: adversary pass -> done",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "reviewing", verdict: "pass" });
    assert.equal(r.nextStatus, "done");
    assert.equal(r.reason, "adversary_pass");
  });

test("advance: adversary block -> failed",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "reviewing", verdict: "block" });
    assert.equal(r.nextStatus, "failed");
  });

test("advance: adversary revise -> back to executing while cycles remain",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "reviewing", verdict: "revise", cyclesRan: 1, maxCycles: 3 });
    assert.equal(r.nextStatus, "executing");
    assert.equal(r.reason, "adversary_revise");
  });

test("advance: beta.35 — adversary REVISE on last cycle -> SHIP (done), not failed",
  { skip: OrchestratorLoop === null }, () => {
    // beta.35 fix #3: a `revise` (improvable, not broken) verdict on the last
    // cycle now SHIPS the PR with a "shipped without a clean pass" annotation
    // rather than throwing away a correct fix. Merge recommendation will be
    // do_not_merge (human approves), preserving the beta.34 hard gate.
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "reviewing", verdict: "revise", cyclesRan: 2, maxCycles: 3 });
    assert.equal(r.nextStatus, "done");
    assert.equal(r.reason, "shipped_max_cycles_revise");
  });

test("advance: beta.35 — adversary BLOCK on last cycle still FAILS (ships nothing)",
  { skip: OrchestratorLoop === null }, () => {
    // A genuine blocking defect must still hard-fail even on the last cycle;
    // only `revise` gets the ship-anyway treatment.
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "reviewing", verdict: "block", cyclesRan: 2, maxCycles: 3 });
    assert.equal(r.nextStatus, "failed");
    assert.equal(r.reason, "adversary_block");
  });

test("advance: user abort short-circuits everything",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "executing", reactions: { shipIt: false, abort: true, pause: false } });
    assert.equal(r.nextStatus, "aborted");
    assert.equal(r.reason, "user_abort_reaction");
  });

test("advance: budget exhausted -> aborted",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "executing", budgetExhausted: true });
    assert.equal(r.nextStatus, "aborted");
    assert.equal(r.reason, "budget_exhausted");
  });

test("advance: hard timeout -> aborted",
  { skip: OrchestratorLoop === null }, () => {
    const r = OrchestratorLoop.advance({ ...base, currentStatus: "executing", hardTimeout: true });
    assert.equal(r.nextStatus, "aborted");
    assert.equal(r.reason, "hard_timeout");
  });

test("advance: ship-it only counts during reviewing",
  { skip: OrchestratorLoop === null }, () => {
    const rDuringExec = OrchestratorLoop.advance({ ...base, currentStatus: "executing", reactions: { shipIt: true, abort: false, pause: false } });
    // ship-it in executing does NOT prematurely finish (executing -> reviewing)
    assert.equal(rDuringExec.nextStatus, "reviewing");

    const rDuringReview = OrchestratorLoop.advance({ ...base, currentStatus: "reviewing", reactions: { shipIt: true, abort: false, pause: false } });
    assert.equal(rDuringReview.nextStatus, "done");
    assert.equal(rDuringReview.reason, "user_ship_it_reaction");
  });

test("advance: terminal states are stable",
  { skip: OrchestratorLoop === null }, () => {
    for (const s of ["done", "failed", "aborted"]) {
      const r = OrchestratorLoop.advance({ ...base, currentStatus: s });
      assert.equal(r.nextStatus, s);
      assert.equal(r.reason, "terminal");
    }
  });
