import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { DatabaseSync } = await import("node:sqlite");
const {
  buildArtifactSubstitutionAmendment,
  activateTaskAmendment,
  planHash,
} = await import("../../dist/orchestrator/contract-amendment.js");
const {
  resumeActiveDeadline,
  pauseActiveDeadline,
  activeDeadlineSnapshot,
} = await import("../../dist/orchestrator/active-deadline.js");
const { registerHarnessTools } = await import("../../dist/tools/registration.js");

const ANSWER =
  "Continue sub-task 3 without reading, creating or modifying .env or .env.* files, including .env.example. " +
  "Document all new variables and placeholder examples in README.md and CLIENT-OFFBOARDING-AGENT.md instead. " +
  "Complete the credential-isolation implementation and required tests. Preserve completed work and existing scope, " +
  "budget and time limits. Update the sub-task's expected paths and verification contract to replace .env.example " +
  "with those documentation files.";

function task() {
  return {
    seq: 3,
    title: "Isolate Client-Offboarding Configuration and Slack Credentials",
    intent:
      "Add fail-closed dedicated configuration and a dedicated Slack client factory, update the environment example and commit focused configuration tests.",
    filesLikelyTouched: [
      "src/lib/config/stitchguard-config.ts",
      "src/lib/it/client-offboarding-slack.ts",
      ".env.example",
      "src/__tests__/lib/it/client-offboarding-orchestrator.test.ts",
    ],
    successCriteria: [
      "Dedicated credentials never fall back to generic credentials.",
      ".env.example contains disabled, secret-free examples for all required variables.",
      "Focused security tests pass.",
    ],
    estimatedTokens: 4500,
    dependsOn: [1],
    contractScope: "local",
    taskMode: "mutate",
    verify: [
      { kind: "commit_made" },
      { kind: "file_committed", path: "src/lib/config/stitchguard-config.ts" },
      { kind: "file_committed", path: ".env.example" },
      { kind: "file_committed", path: "src/__tests__/lib/it/client-offboarding-orchestrator.test.ts" },
    ],
    workerContext: {
      rationale: "Dedicated credentials prevent cross-integration credential reuse.",
      changeSpec: "Implement the factory and update .env.example with placeholders.",
      gotchas: ["Do not change the generic Slack client."],
    },
  };
}

function plan() {
  return {
    repo: "o/r",
    branch: "harness/x",
    worktreePath: "/tmp/w",
    subTasks: [task()],
    reviewChecklist: [],
    riskLevel: "high",
    approxCostUsd: 1,
  };
}

test("rc.11: exact policy answer becomes a full deterministic artifact substitution", () => {
  const originalPlan = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: originalPlan,
    task: originalPlan.subTasks[0],
    answer: ANSWER,
    blockedPaths: [".env.example"],
    id: "A1",
  });
  assert.equal(out.ok, true, out.reason);
  const revised = out.amendment.revisedTask;
  assert.deepEqual(revised.dependsOn, [1]);
  assert.equal(revised.estimatedTokens, 4500);
  assert.ok(revised.filesLikelyTouched.includes("README.md"));
  assert.ok(revised.filesLikelyTouched.includes("CLIENT-OFFBOARDING-AGENT.md"));
  assert.ok(!revised.filesLikelyTouched.includes(".env.example"));
  assert.ok(revised.successCriteria.some((criterion) => /Dedicated credentials/.test(criterion)));
  assert.ok(revised.successCriteria.some((criterion) => /Focused security tests/.test(criterion)));
  assert.ok(
    revised.requiredBehaviorChecks.some((check) => check.ciCheck === "test"),
    "security behavior remains an exact-SHA CI obligation, not a filename check",
  );
  for (const path of ["README.md", "CLIENT-OFFBOARDING-AGENT.md"]) {
    assert.ok(revised.verify.some((probe) => probe.kind === "file_committed" && probe.path === path));
  }
  assert.ok(!revised.verify.some((probe) => probe.kind === "file_committed" && probe.path === ".env.example"));
  assert.match(revised.workerContext.gotchas.join("\n"), /without reading.*\.env\.example/i);
  const activated = activateTaskAmendment(originalPlan, out.amendment);
  assert.notEqual(planHash(activated), planHash(originalPlan));
});

test("rc.11: the obsolete output disappears while its explicit prohibition remains", () => {
  const originalPlan = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: originalPlan,
    task: originalPlan.subTasks[0],
    answer: ANSWER,
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, true);
  const text = JSON.stringify(out.amendment.revisedTask);
  assert.match(text, /Do not|without reading/i);
  assert.match(text, /\.env\.example/);
  assert.ok(!out.amendment.revisedTask.filesLikelyTouched.includes(".env.example"));
});

test("rc.11: ambiguous or broad guidance cannot activate", () => {
  const p = plan();
  for (const answer of ["Do something else.", "Use README.md.", "Replace .env.example somehow."]) {
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, answer);
  }
});

test("rc.11: the lead is required to plan observe and behavioral contracts", () => {
  const source = readFileSync(new URL("../../src/adapters/claude-code.ts", import.meta.url), "utf8");
  assert.match(source, /LOAD-BEARING OBSERVE CONTRACTS/);
  assert.match(source, /requiredBehaviorChecks/);
  assert.match(source, /existing_repo_path/);
  assert.match(source, /proposed_output_path/);
});

test("rc.11: stale plan or task hashes prevent activation", () => {
  const p = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer: ANSWER,
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, true);
  const changed = structuredClone(p);
  changed.subTasks[0].title = "changed concurrently";
  assert.throws(() => activateTaskAmendment(changed, out.amendment), /stored plan changed/);
});

function deadlineDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../../dist/state/schema.sql", import.meta.url), "utf8"));
  db.prepare(
    `INSERT INTO sessions
       (id,slack_thread,slack_channel,requester,requester_gh,repo,branch,worktree_path,status,
        created_at,updated_at,budget_usd,cost_usd,cycles_ran,hard_timeout_seconds)
     VALUES ('S','T','C','U','u','o/r','b','/w','planning',0,0,50,0,0,18000)`,
  ).run();
  return db;
}

test("rc.11: human pause time is excluded and resume grants no fresh allowance", () => {
  const db = deadlineDb();
  const first = resumeActiveDeadline(db, "S", 18000, 1_000);
  assert.equal(first.remainingMs, 18_000_000);
  const paused = pauseActiveDeadline(db, "S", 6_000);
  assert.equal(paused.elapsedMs, 5_000);
  const resumed = resumeActiveDeadline(db, "S", 18000, 3_606_000);
  assert.equal(resumed.elapsedMs, 5_000, "one hour of human wait is excluded");
  assert.equal(resumed.remainingMs, 18_000_000 - 5_000);
  const afterWork = activeDeadlineSnapshot(db, "S", 3_616_000);
  assert.equal(afterWork.elapsedMs, 15_000, "amendment/execution time consumes the remainder");
});

test("rc.11: an open active segment is charged through restart", () => {
  const db = deadlineDb();
  resumeActiveDeadline(db, "S", 18000, 10_000);
  const restarted = resumeActiveDeadline(db, "S", 18000, 70_000);
  assert.equal(restarted.elapsedMs, 60_000);
  assert.equal(restarted.remainingMs, 18_000_000 - 60_000);
});

test("rc.11: harness_answer atomically persists and activates the revised task before resume", async () => {
  const db = deadlineDb();
  const p = plan();
  const brief = {
    title: "Client offboarding",
    motivation: "m",
    acceptanceCriteria: ["credential isolation remains required"],
    filesLikelyTouched: [],
    outOfScope: [],
    riskLevel: "high",
  };
  db.prepare(
    `UPDATE sessions
        SET status='awaiting_clarification', crystallised_prompt=?, lead_plan_json=?,
            clarification_question='blocked path', clarification_seq=3, clarification_id='Q1',
            clarification_subtask=?, human_pause_started_at=1000, active_limit_ms=18000000
      WHERE id='S'`,
  ).run(
    JSON.stringify(brief),
    JSON.stringify(p),
    JSON.stringify({
      title: p.subTasks[0].title,
      intent: p.subTasks[0].intent,
      task: p.subTasks[0],
      policyConflicts: [{ path: ".env.example", rule: ".env.*" }],
    }),
  );
  const audits = [];
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
      db.prepare(`INSERT INTO audit_log (session_id,event,payload,created_at) VALUES (?,?,?,?)`)
        .run(sessionId ?? null, event, JSON.stringify(payload ?? {}), Date.now());
    },
  };
  let resumed = 0;
  const runtime = {
    state,
    config: {
      slack: { authorised_users: ["U1"] },
      loop: { session_hard_timeout_seconds: 18000, clarification_auto_accept_delegated: false },
      safety: { path_denylist: [".env", ".env.*"], path_denylist_exceptions: [] },
      budgets: { session_hard_ceiling_usd: 100 },
      storage: { worktree_root: "/tmp/unused" },
      pat_routing: { overrides: {} },
      repos: { allowed: ["o/*"], default_base_branch: "main" },
    },
    loop: { run: async () => { resumed += 1; return { status: "failed" }; } },
  };
  const tools = new Map();
  registerHarnessTools(
    {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerTool(def) {
        tools.set(def.name, { ...def, execute: (input) => def.execute("call", input) });
        return () => {};
      },
    },
    runtime,
  );

  const result = await tools.get("harness_answer").execute({
    sessionId: "S",
    answer: ANSWER,
    invokedBy: "U1",
    clarificationSeq: 3,
    clarificationId: "Q1",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.details.ok, true);
  assert.ok(result.details.amendmentId);
  assert.equal(resumed, 1);

  const session = db.prepare(`SELECT status,lead_plan_json,plan_revision FROM sessions WHERE id='S'`).get();
  const revised = JSON.parse(session.lead_plan_json).subTasks[0];
  assert.equal(session.plan_revision, 1);
  assert.equal(session.status, "planning");
  assert.ok(revised.filesLikelyTouched.includes("README.md"));
  assert.ok(!revised.filesLikelyTouched.includes(".env.example"));
  const amendment = db.prepare(`SELECT status,authorised_by FROM task_contract_amendments WHERE session_id='S'`).get();
  assert.equal(amendment.status, "active");
  assert.equal(amendment.authorised_by, "U1");
  assert.ok(audits.some((entry) => entry.event === "tool.answer_contract_amendment_activated"));
});

test("rc.11: a stale or missing clarification id cannot mutate the plan", async () => {
  const db = deadlineDb();
  const p = plan();
  db.prepare(
    `UPDATE sessions SET status='awaiting_clarification', crystallised_prompt=?, lead_plan_json=?,
       clarification_question='q', clarification_seq=3, clarification_id='CURRENT', clarification_subtask=?
     WHERE id='S'`,
  ).run(JSON.stringify({ title: "t", motivation: "m", acceptanceCriteria: [] }), JSON.stringify(p), JSON.stringify({ task: p.subTasks[0] }));
  const state = { db, isOpen: () => true, audit() {} };
  const tools = new Map();
  registerHarnessTools(
    {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerTool(def) {
        tools.set(def.name, { execute: (input) => def.execute("call", input) });
        return () => {};
      },
    },
    {
      state,
      config: {
        slack: { authorised_users: ["U1"] },
        loop: { session_hard_timeout_seconds: 18000 },
        safety: { path_denylist: [".env", ".env.*"], path_denylist_exceptions: [] },
        budgets: {},
        storage: {},
      },
      loop: { run: async () => { throw new Error("must not run"); } },
    },
  );
  for (const clarificationId of [undefined, "STALE"]) {
    const result = await tools.get("harness_answer").execute({
      sessionId: "S",
      answer: ANSWER,
      invokedBy: "U1",
      clarificationSeq: 3,
      clarificationId,
    });
    assert.equal(result.details.staleClarificationId, true);
  }
  assert.equal(db.prepare(`SELECT plan_revision AS n FROM sessions WHERE id='S'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM task_contract_amendments`).get().n, 0);
});
