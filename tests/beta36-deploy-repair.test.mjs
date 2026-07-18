/**
 * beta.36: post-merge Vercel deploy-repair state machine.
 *
 * The orchestrator is deps-injected, so we drive the full state machine with
 * stub deps and assert the control flow for every branch:
 *   - deploy repaired on attempt N (< max)  -> outcome "repaired", no revert
 *   - all attempts fail                       -> revert ALL merges, leave last PR
 *   - repair budget exhausted mid-loop        -> "budget_paused", revert
 *   - a repair attempt fails to ship          -> revert, stop early
 *   - revert itself fails                      -> "revert_failed", loud message
 * Also asserts the revert list is newest-first and includes the ORIGINAL
 * merge + every repair merge.
 */
import test from "node:test";
import assert from "node:assert/strict";

let runDeployRepair;
try {
  ({ runDeployRepair } = await import("../dist/orchestrator/deploy-repair.js"));
} catch {
  runDeployRepair = null;
}

const logger = { info() {}, warn() {}, error() {} };

function makeDeps(overrides = {}) {
  const calls = { attempts: [], verifies: [], reverts: [], persists: [], audits: [] };
  const deps = {
    audit: (event, payload, sid) => calls.audits.push({ event, payload, sid }),
    logger,
    persist: (sid, patch) => calls.persists.push({ sid, patch }),
    runRepairAttempt: async (args) => {
      calls.attempts.push(args);
      // default: each attempt ships + merges a new SHA, deploy still errors
      return { shipped: true, prUrl: `https://gh/pull/${100 + args.attempt}`, prNumber: 100 + args.attempt, mergeSha: `repair${args.attempt}`, costUsd: 1 };
    },
    verifyDeploy: async (args) => {
      calls.verifies.push(args);
      return { status: "error", detail: "still failing" };
    },
    revertMerges: async (args) => {
      calls.reverts.push(args);
      return { ok: true, pushedToMain: true, detail: "reverted to main" };
    },
    ...overrides,
  };
  return { deps, calls };
}

const input = {
  sessionId: "S1",
  repoFullName: "o/r",
  originalMergeSha: "orig0",
  originalDeploy: { status: "error", detail: "boom", logsExcerpt: "TypeError x" },
  maxAttempts: 3,
  repairBudgetUsd: 10,
};

test("repaired on attempt 2 -> no revert", { skip: runDeployRepair === null }, async () => {
  let n = 0;
  const { deps, calls } = makeDeps({
    verifyDeploy: async () => {
      n++;
      return n >= 2 ? { status: "ready", detail: "ok", deploymentUrl: "https://app" } : { status: "error", detail: "still failing" };
    },
  });
  const r = await runDeployRepair(deps, input);
  assert.equal(r.outcome, "repaired");
  assert.equal(r.attempts, 2);
  assert.equal(calls.reverts.length, 0, "must NOT revert on success");
  assert.match(r.message, /repaired after 2/i);
});

test("all attempts fail -> revert ALL merges newest-first, keep last PR", { skip: runDeployRepair === null }, async () => {
  const { deps, calls } = makeDeps();
  const r = await runDeployRepair(deps, input);
  assert.equal(r.outcome, "reverted");
  assert.equal(r.attempts, 3);
  assert.equal(calls.reverts.length, 1);
  // newest-first: repair3, repair2, repair1, then original
  assert.deepEqual(calls.reverts[0].shas, ["repair3", "repair2", "repair1", "orig0"]);
  assert.equal(r.reviewPrUrl, "https://gh/pull/103", "last repair PR is left for review");
});

test("budget exhausted mid-loop -> budget_paused + revert to working main", { skip: runDeployRepair === null }, async () => {
  // Each attempt costs 6; budget 10 -> attempt 1 spends 6 (leaves 4), attempt
  // 2 starts (4>0) spends 6 -> total 12; before attempt 3 remaining < 0 -> pause.
  const { deps, calls } = makeDeps({
    runRepairAttempt: async (args) => ({ shipped: true, prUrl: `https://gh/pull/${100 + args.attempt}`, prNumber: 100 + args.attempt, mergeSha: `repair${args.attempt}`, costUsd: 6 }),
  });
  const r = await runDeployRepair(deps, { ...input, repairBudgetUsd: 10 });
  assert.equal(r.outcome, "budget_paused");
  assert.equal(calls.reverts.length, 1, "must revert to a working main on budget pause");
  assert.match(r.message, /budget/i);
});

test("repair attempt fails to ship -> revert + stop early", { skip: runDeployRepair === null }, async () => {
  const { deps, calls } = makeDeps({
    runRepairAttempt: async (args) => {
      calls.attempts.push(args);
      return { shipped: false, costUsd: 0.5, reason: "lead failed", prUrl: "https://gh/pull/999" };
    },
  });
  const r = await runDeployRepair(deps, input);
  assert.equal(r.outcome, "reverted");
  assert.equal(calls.attempts.length, 1, "stop after first non-shipping attempt");
  // only the original merge to revert (no repair merged)
  assert.deepEqual(calls.reverts[0].shas, ["orig0"]);
  assert.equal(r.reviewPrUrl, "https://gh/pull/999");
});

test("revert itself fails -> revert_failed, loud message", { skip: runDeployRepair === null }, async () => {
  const { deps } = makeDeps({
    revertMerges: async () => { throw new Error("branch protected + PR merge blocked"); },
  });
  const r = await runDeployRepair(deps, input);
  assert.equal(r.outcome, "revert_failed");
  assert.match(r.message, /main may be in a BROKEN state|BROKEN/i);
});

test("emits repair_started and a terminal audit event", { skip: runDeployRepair === null }, async () => {
  const { deps, calls } = makeDeps();
  await runDeployRepair(deps, input);
  const events = calls.audits.map((a) => a.event);
  assert.ok(events.includes("deploy.repair_started"));
  assert.ok(events.includes("deploy.repair_reverted"));
});
