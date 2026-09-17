import test from "node:test";
import assert from "node:assert/strict";
import {
  makeWorld,
  mutateSubTask,
  runScenario,
  scenarioAvailable,
  defaultWorker,
} from "../helpers/scenario.mjs";

const {
  validateObserveResult,
  applyObserveBindings,
  loadBearingObserveContractErrors,
} = await import("../../dist/orchestrator/observe-contract.js");

const existingFiles = [
  "prisma/schema.prisma",
  "prisma/migrations/20260101000000_seed/migration.sql",
  "src/lib/config.ts",
];
const proposed = "prisma/migrations/20260917090000_governed/migration.sql";

const observeContract = {
  requiredFindings: ["migration_convention"],
  requireEvidence: true,
  bindings: [
    {
      name: "migrationPath",
      type: "proposed_output_path",
      applyTo: [{
        consumerSeq: 2,
        fields: ["filesLikelyTouched", "verify", "intent", "successCriteria", "workerContext.changeSpec"],
        placeholder: "{{migrationPath}}",
      }],
    },
  ],
};

const structuredResult = {
  status: "ok",
  findings: [{
    id: "migration_convention",
    summary: "Forward migrations use a timestamp directory and migration.sql.",
    evidence: [{ path: "prisma/migrations/20260101000000_seed/migration.sql", line: 1 }],
  }],
  bindings: [{
    name: "migrationPath",
    type: "proposed_output_path",
    value: proposed,
    evidence: [{ path: "prisma/migrations/20260101000000_seed/migration.sql" }],
  }],
  blockers: [],
};

function producer(extra = {}) {
  return {
    seq: 1,
    title: "Resolve exact migration path and contract bindings",
    intent: "Return structured findings and the exact path for the dependent task contract binding.",
    filesLikelyTouched: [],
    successCriteria: ["Return structured migration convention evidence and an exact proposed path."],
    estimatedTokens: 10,
    taskMode: "observe",
    verify: [],
    observeContract,
    ...extra,
  };
}

function consumer() {
  return mutateSubTask({
    seq: 2,
    title: "Create migration",
    path: "prisma/schema.prisma",
    intent: "Commit schema and {{migrationPath}}.",
    extra: {
      dependsOn: [1],
      successCriteria: ["Schema and {{migrationPath}} are committed."],
      workerContext: {
        rationale: "The observe prerequisite establishes the repository naming convention.",
        changeSpec: "Create the schema change and the bound file at {{migrationPath}} after the observe result.",
      },
    },
  });
}

test("rc.11: proposed output paths may be absent while existing evidence paths must exist", () => {
  const valid = validateObserveResult({
    finalMessage: JSON.stringify(structuredResult),
    contract: observeContract,
    repoFiles: existingFiles,
  });
  assert.equal(valid.ok, true, valid.reason);

  const wrongExisting = structuredClone(structuredResult);
  wrongExisting.bindings[0].type = "existing_repo_path";
  const invalid = validateObserveResult({
    finalMessage: JSON.stringify(wrongExisting),
    contract: { ...observeContract, bindings: [{ ...observeContract.bindings[0], type: "existing_repo_path" }] },
    repoFiles: existingFiles,
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /does not resolve/);
});

test("rc.11: a proposed output must have a real parent convention and evidence", () => {
  for (const value of ["invented/nowhere/file.sql", proposed]) {
    const result = structuredClone(structuredResult);
    result.bindings[0].value = value;
    if (value === proposed) result.bindings[0].evidence = [];
    const out = validateObserveResult({
      finalMessage: JSON.stringify(result),
      contract: observeContract,
      repoFiles: existingFiles,
    });
    assert.equal(out.ok, false);
  }
});

test("rc.11: one allowed tool does not satisfy missing findings or bindings", () => {
  const out = validateObserveResult({
    finalMessage: JSON.stringify({ status: "ok", findings: [], bindings: [] }),
    contract: observeContract,
    repoFiles: existingFiles,
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /required finding/);
});

test("rc.11: validated bindings amend every declared dependent contract field", () => {
  const p = {
    repo: "o/r",
    branch: "b",
    worktreePath: "/w",
    subTasks: [producer(), consumer()],
    reviewChecklist: [],
    riskLevel: "high",
    approxCostUsd: 1,
  };
  const bound = applyObserveBindings({ plan: p, producer: p.subTasks[0], result: structuredResult });
  assert.deepEqual(bound.changedConsumers, [2]);
  const task = bound.plan.subTasks[1];
  assert.ok(task.filesLikelyTouched.includes(proposed));
  assert.ok(task.verify.some((probe) => probe.kind === "file_committed" && probe.path === proposed));
  assert.match(task.intent, new RegExp(proposed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(task.successCriteria.join("\n"), /20260917090000_governed/);
  assert.match(task.workerContext.changeSpec, /20260917090000_governed/);
  assert.doesNotMatch(JSON.stringify(task), /\{\{migrationPath\}\}/);
});

test("rc.11: a load-bearing observe prerequisite without a contract is rejected at plan time", () => {
  const p = {
    subTasks: [producer({ observeContract: undefined }), consumer()],
  };
  assert.equal(loadBearingObserveContractErrors(p).length, 1);
  assert.equal(loadBearingObserveContractErrors({ subTasks: [producer(), consumer()] }).length, 0);
});

const available = await scenarioAvailable();

test("rc.11: validated observe bindings persist into the plan before dependent dispatch", { skip: !available }, async () => {
  const world = await makeWorld({
    files: Object.fromEntries(existingFiles.map((path) => [path, path.endsWith(".sql") ? "-- seed\n" : "// seed\n"])),
  });
  const seen = [];
  const fallback = defaultWorker({ adapter: world.adapter });
  const result = await runScenario({
    world,
    subTasks: [producer(), consumer()],
    worker: async (params) => {
      seen.push({ seq: params.subTask.seq, task: structuredClone(params.subTask) });
      if (params.subTask.seq === 1) {
        return {
          status: "completed",
          filesChanged: [],
          commitShas: [],
          costUsd: 0.01,
          tokensIn: 1,
          tokensOut: 1,
          reason: "end_turn",
          finalMessage: JSON.stringify(structuredResult),
          allowedToolCalls: 1,
          unguardedReads: 0,
        };
      }
      return fallback(params);
    },
  });
  const consumerDispatch = seen.find((entry) => entry.seq === 2);
  assert.ok(
    consumerDispatch,
    JSON.stringify({
      out: result.out,
      rows: result.subTaskRows(),
      observeEvents: result.audits.filter((entry) => entry.event.includes("observe_contract")),
    }),
  );
  const dispatched = consumerDispatch.task;
  assert.ok(dispatched.filesLikelyTouched.includes(proposed), "scope was revised before dispatch");
  assert.ok(dispatched.verify.some((probe) => probe.path === proposed), "verifier contract was revised before dispatch");
  assert.equal(result.db.prepare(`SELECT COUNT(*) AS n FROM observe_reports`).get().n, 1);
  const stored = JSON.parse(result.session().lead_plan_json).subTasks.find((task) => task.seq === 2);
  assert.ok(stored.filesLikelyTouched.includes(proposed), "binding survives restart in lead_plan_json");
  assert.equal(result.out.status, "shipped");
});

test("rc.11: invalid structured observe output never releases its dependent", { skip: !available }, async () => {
  const seen = [];
  const result = await runScenario({
    configOver: { loop: { worker_protocol_max_attempts: 2 } },
    seedFiles: Object.fromEntries(existingFiles.map((path) => [path, "seed\n"])),
    subTasks: [producer(), consumer()],
    worker: async ({ subTask }) => {
      seen.push(subTask.seq);
      return {
        status: "completed",
        filesChanged: [],
        commitShas: [],
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: JSON.stringify({ status: "ok", findings: [], bindings: [] }),
        allowedToolCalls: 1,
        unguardedReads: 0,
      };
    },
  });
  assert.ok(!seen.includes(2));
  assert.equal(result.subTaskRows().find((row) => row.seq === 1).status, "failed_verification");
});
