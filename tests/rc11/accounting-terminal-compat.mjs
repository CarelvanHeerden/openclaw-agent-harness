import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultWorker,
  makeWorld,
  mutateSubTask,
  runScenario,
  scenarioAvailable,
} from "../helpers/scenario.mjs";

const { buildHeadline } = await import("../../dist/orchestrator/progress.js");
const { assertDowngradeSafe, downgradeBlockers } = await import("../../dist/state/runtime-compat.js");
const { registerHarnessTools } = await import("../../dist/tools/registration.js");
const { DatabaseSync } = await import("node:sqlite");
const { readFileSync, mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const available = await scenarioAvailable();

test("rc.11: every protocol retry has required provider and attempt accounting", { skip: !available }, async () => {
  const world = await makeWorld();
  const fallback = defaultWorker({ adapter: world.adapter });
  let calls = 0;
  const result = await runScenario({
    world,
    subTasks: [mutateSubTask({ path: "src/accounted.ts" })],
    worker: async (params) => {
      calls += 1;
      if (calls === 1) {
        return {
          status: "completed",
          filesChanged: [],
          commitShas: [],
          costUsd: 0.12,
          tokensIn: 1,
          tokensOut: 1,
          reason: "end_turn",
          finalMessage: "I still need to make the requested change.",
        };
      }
      const done = await fallback(params);
      return { ...done, costUsd: 0.34 };
    },
  });
  assert.equal(result.out.status, "shipped");
  assert.equal(calls, 2);
  const provider = result.db.prepare(
    `SELECT attempt,status,cost_usd,verification_json FROM provider_calls
      WHERE session_id='S1' AND role='worker' ORDER BY attempt`,
  ).all();
  assert.equal(provider.length, 2);
  assert.deepEqual(provider.map((row) => row.attempt), [1, 2]);
  assert.ok(provider.every((row) => row.status === "completed"));
  assert.ok(provider.every((row) => row.verification_json));
  assert.ok(Math.abs(provider.reduce((sum, row) => sum + row.cost_usd, 0) - 0.46) < 1e-9);
  const attempts = result.db.prepare(
    `SELECT attempt,worker_status,verification_status,task_outcome
       FROM sub_task_attempts WHERE session_id='S1' AND seq=1 ORDER BY attempt`,
  ).all();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].verification_status, "passed");
});

const ciSuccess = (names) => async () => ({
  state: "success",
  checkTotal: names.length,
  checksReadable: true,
  statusReadable: true,
  reason: "test says success",
  checksSource: "check_runs",
  checkNames: names,
});

test("rc.11: touching every expected path cannot pass without required behavior checks on the candidate SHA", { skip: !available }, async () => {
  const result = await runScenario({
    subTasks: [mutateSubTask({
      path: "src/comments-only.ts",
      extra: {
        requiredBehaviorChecks: [
          { id: "typecheck", ciCheck: "typecheck", required: true },
          { id: "security", ciCheck: "test", required: true },
        ],
      },
    })],
    deps: { ciSnapshot: ciSuccess(["lint"]) },
  });
  assert.equal(result.out.status, "failed");
  assert.match(result.out.reason, /behavior_verification_failed/);
  assert.ok(result.sawEvent("loop.behavior_verification_failed"));
});

test("rc.11: required behavior checks pass only on the exact CI-polled candidate SHA", { skip: !available }, async () => {
  const result = await runScenario({
    subTasks: [mutateSubTask({
      path: "src/behavior.ts",
      extra: {
        requiredBehaviorChecks: [
          { id: "typecheck", ciCheck: "typecheck", required: true },
          { id: "security", ciCheck: "test", required: true },
        ],
      },
    })],
    deps: { ciSnapshot: ciSuccess(["Typecheck", "Focused security tests"]) },
  });
  assert.equal(result.out.status, "shipped");
  const passed = result.events("loop.behavior_verification_passed");
  assert.equal(passed.length, 1);
  assert.equal(passed[0].payload.candidateSha, result.events("loop.ci_success")[0].payload.sha);
});

test("rc.11: provider dispatch is refused when the required start row cannot persist", { skip: !available }, async () => {
  let workerCalls = 0;
  const result = await runScenario({
    seedSession({ db }) {
      db.exec(
        `CREATE TRIGGER deny_provider_start BEFORE INSERT ON provider_calls
         BEGIN SELECT RAISE(ABORT, 'accounting unavailable'); END`,
      );
    },
    subTasks: [mutateSubTask({ path: "src/no-dispatch.ts" })],
    worker: async () => {
      workerCalls += 1;
      throw new Error("provider must not be called");
    },
  });
  assert.equal(workerCalls, 0);
  assert.equal(result.session().accounting_state, "incomplete");
  assert.equal(result.session().status, "accounting_incomplete");
  assert.match(result.out.reason, /accounting_incomplete/);
});

test("rc.11: a provider response that cannot persist stops without blind retry", { skip: !available }, async () => {
  let workerCalls = 0;
  const result = await runScenario({
    seedSession({ db }) {
      db.exec(
        `CREATE TRIGGER deny_provider_finish BEFORE UPDATE OF status ON provider_calls
         WHEN NEW.status != 'started'
         BEGIN SELECT RAISE(ABORT, 'result persistence unavailable'); END`,
      );
    },
    subTasks: [mutateSubTask({ path: "src/unknown-cost.ts" })],
    worker: async () => {
      workerCalls += 1;
      return {
        status: "completed",
        filesChanged: [],
        costUsd: 0.4,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: "provider responded",
      };
    },
  });
  assert.equal(workerCalls, 1, "the unrecorded result is never blindly retried");
  assert.equal(result.session().accounting_state, "incomplete");
  assert.equal(result.session().status, "accounting_incomplete");
});

test("rc.11: provider cost must reconcile into aggregate accounting before progress", { skip: !available }, async () => {
  let workerCalls = 0;
  const result = await runScenario({
    seedSession({ db }) {
      db.exec(
        `CREATE TRIGGER deny_session_cost BEFORE UPDATE OF cost_usd ON sessions
         WHEN NEW.cost_usd != OLD.cost_usd
         BEGIN SELECT RAISE(ABORT, 'aggregate cost unavailable'); END`,
      );
    },
    subTasks: [mutateSubTask({ path: "src/cost-reconcile.ts" })],
    worker: async () => {
      workerCalls += 1;
      return {
        status: "completed",
        filesChanged: [],
        costUsd: 0.4,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: "provider responded",
      };
    },
  });
  assert.equal(workerCalls, 1);
  assert.equal(result.session().accounting_state, "incomplete");
  assert.equal(result.session().status, "accounting_incomplete");
  assert.match(result.out.reason, /aggregate cost unavailable/);
});

function headline(over = {}) {
  return buildHeadline({
    phase: "Aborted",
    status: "aborted",
    terminal: true,
    total: 13,
    done: 2,
    current: null,
    spentUsd: 5.77,
    budgetUsd: 50,
    prNumber: null,
    deployStatus: null,
    worktreePreserved: true,
    failureDetail:
      "Operator requested cancellation and classification as FAILED SMOKE TEST (rc.10). Preserve completed work and forensic evidence.",
    terminalCause: "user_cancel",
    terminalClassification: "failed_smoke_test",
    ...over,
  });
}

test("rc.11: exact Preserve cancellation text cannot invent higher-budget or resume advice", () => {
  const text = headline();
  assert.match(text, /FAILED SMOKE TEST/);
  assert.doesNotMatch(text, /higher cap/i);
  assert.doesNotMatch(text, /harness_revise|resume/i);
});

test("rc.11: only a typed budget cause gets higher-cap advice", () => {
  assert.doesNotMatch(headline({ terminalCause: "user_cancel", terminalClassification: "operator_cancelled" }), /higher cap/i);
  assert.match(
    headline({ terminalCause: "budget_exhausted", terminalClassification: "operator_cancelled" }),
    /higher cap/i,
  );
});

function compatDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../dist/state/schema.sql", import.meta.url), "utf8"));
  const insert = db.prepare(
    `INSERT INTO sessions
      (id,slack_thread,slack_channel,requester,requester_gh,repo,branch,worktree_path,status,
       created_at,updated_at,budget_usd,cost_usd,cycles_ran,minimum_runtime_version)
     VALUES (?, ?, 'C','U','u','o/r','b','/w', ?,0,0,50,0,0,?)`,
  );
  return { db, insert };
}

test("rc.11: downgrade is blocked while any incompatible session is nonterminal", () => {
  const { db, insert } = compatDb();
  insert.run("pending-amendment", "T1", "awaiting_clarification", "2.0.0-rc.11");
  insert.run("active-observe", "T2", "executing", "2.0.0-rc.11");
  insert.run("finished", "T3", "aborted", "2.0.0-rc.11");
  assert.equal(downgradeBlockers(db, "2.0.0-rc.10").length, 2);
  assert.throws(() => assertDowngradeSafe(db, "2.0.0-rc.10"), /downgrade.*refused/i);
  db.prepare(`UPDATE sessions SET status='aborted' WHERE status != 'aborted'`).run();
  assert.doesNotThrow(() => assertDowngradeSafe(db, "2.0.0-rc.10"));
});

test("rc.11: an unknown status is not a downgrade fence because force resume can pass it", async () => {
  const { db, insert } = compatDb();
  const wt = mkdtempSync(join(tmpdir(), "rc11-force-resume-"));
  mkdirSync(join(wt, ".git"));
  try {
    insert.run("guarded", "TG", "requires_rc11", "2.0.0-rc.11");
    db.prepare(
      `UPDATE sessions SET crystallised_prompt=?, worktree_path=? WHERE id='guarded'`,
    ).run(JSON.stringify({ title: "t", motivation: "m", acceptanceCriteria: [] }), wt);
    const audits = [];
    const state = {
      db,
      isOpen: () => true,
      audit(event, payload, sessionId) { audits.push({ event, payload, sessionId }); },
    };
    let resumed = 0;
    const runtime = {
      state,
      config: {
        slack: { authorised_users: ["U1"] },
        storage: { worktree_root: wt },
        loop: { session_hard_timeout_seconds: 3600 },
      },
      loop: {
        runningSessionIds: () => [],
        run: async () => { resumed += 1; return { status: "failed" }; },
      },
    };
    const tools = new Map();
    registerHarnessTools(
      {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        registerTool(def) {
          tools.set(def.name, { execute: (input) => def.execute("call", input) });
          return () => {};
        },
      },
      runtime,
    );
    const result = await tools.get("harness_resume").execute({
      sessionId: "guarded",
      invokedBy: "U1",
      force: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.details.ok, true);
    assert.equal(resumed, 1, "force:true passes an unfamiliar nonterminal status");
    assert.ok(audits.some((entry) => entry.event === "tool.resume_forced"));
    // Therefore the preflight, not the status/version marker, is the gate.
    db.prepare(`UPDATE sessions SET status='requires_rc11' WHERE id='guarded'`).run();
    assert.throws(() => assertDowngradeSafe(db, "2.0.0-rc.10"));
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});
