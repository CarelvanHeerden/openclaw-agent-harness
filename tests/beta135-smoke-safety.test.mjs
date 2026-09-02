// beta.135 — regressions from the policy-Drive OpenCode smoke.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  runScenario,
  makeWorld,
  scenarioAvailable,
  git,
  IDENT,
  mutateSubTask,
} from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let rescue, focusedWorkerAcpGuard;
try {
  rescue = await import("../dist/orchestrator/basename-rescue.js");
  ({ focusedWorkerAcpGuard } = await import("../dist/safety/focused-worker-acp-guard.js"));
} catch {
  rescue = null;
  focusedWorkerAcpGuard = null;
}

test("beta135: trailing slash still matches a normalised directory rescue", { skip: !rescue }, () => {
  const r = rescue.proposeDirectoryRescue({
    expected: ["prisma/migrations/"],
    actual: ["prisma/schema.prisma", "prisma/migrations/20260902_drive/migration.sql"],
  });
  assert.ok(r);
  assert.equal(r.from, "prisma/migrations");
  assert.equal(rescue.rescueMatchesContractPath("prisma/migrations/", r), true);
});

test("beta135: the policy-Drive migration directory rescues and the run ships", { skip }, async () => {
  const world = await makeWorld({ files: { "README.md": "# seed\n" } });
  const task = mutateSubTask({
    title: "Add tenant-scoped Drive export persistence",
    path: "prisma/migrations/",
    extra: {
      verify: [
        { kind: "commit_made" },
        { kind: "file_written", path: "prisma/migrations/" },
        { kind: "file_committed", path: "prisma/migrations/" },
      ],
    },
  });
  const s = await runScenario({
    world,
    subTasks: [task],
    worker: async ({ worktreePath, plan }, { world: w }) => {
      const wt = worktreePath ?? plan.worktreePath;
      const rel = "prisma/migrations/20260902103000_policy_drive_export_persistence/migration.sql";
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), "ALTER TABLE Policy ADD COLUMN driveFileId TEXT;\n");
      const sha = await w.adapter.commit(wt, "feat: policy Drive persistence", IDENT);
      return {
        status: "completed",
        filesChanged: [rel],
        commitSha: sha,
        commitShas: [sha],
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: "migration committed",
      };
    },
  });
  assert.equal(s.out.status, "shipped", `${s.out.status}: ${s.out.reason ?? ""}`);
  const rescued = s.events("loop.contract_path_basename_rescued");
  assert.equal(rescued.length, 1);
  assert.equal(rescued[0].payload.verified, true);
  assert.equal(s.sawEvent("loop.contract_path_mismatch_escalated"), false);
});

test("beta135: a no-change revise with blocking findings never opens a PR", { skip }, async () => {
  let turn = 0;
  const s = await runScenario({
    worker: async ({ subTask, worktreePath, plan }, { world }) => {
      turn += 1;
      if (turn > 1) {
        return {
          status: "completed",
          filesChanged: [],
          costUsd: 0.01,
          tokensIn: 1,
          tokensOut: 1,
          reason: "end_turn",
          finalMessage: "No changes made.",
        };
      }
      const wt = worktreePath ?? plan.worktreePath;
      const rel = subTask.filesLikelyTouched[0];
      mkdirSync(dirname(join(wt, rel)), { recursive: true });
      writeFileSync(join(wt, rel), "export const persistenceOnly = true;\n");
      const sha = await world.adapter.commit(wt, "feat: partial implementation", IDENT);
      return {
        status: "completed",
        filesChanged: [rel],
        commitSha: sha,
        commitShas: [sha],
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: "partial implementation committed",
      };
    },
    runAdversary: async () => ({
      verdict: "revise",
      findings: [{
        severity: "high",
        dimension: "spec",
        title: "The export workflow is absent",
        detail: "Only persistence exists.",
        file: "src/thing.ts",
      }],
      summary: "blocking work remains",
      costUsd: 0.01,
      tokensIn: 1,
      tokensOut: 1,
    }),
  });
  assert.notEqual(s.out.status, "shipped");
  assert.equal(s.calls.push, 0);
  assert.ok(s.sawEvent("loop.cycle_no_change_blocked"));
});

test("beta135: accepting committed work continues the stored plan", () => {
  const registration = S("src/tools/registration.ts");
  const loop = S("src/orchestrator/loop.ts");
  assert.match(registration, /brief\.resumeExistingPlan = true/);
  assert.match(registration, /UPDATE sub_tasks[\s\S]{0,500}SET status = 'completed'/);
  assert.match(loop, /loadAcceptedContinuation\(sessionId\)/);
  assert.match(loop, /if \(done\.has\(st\.seq\)\) continue/);
  assert.match(loop, /loop\.plan_resumed_after_contract_accept/);
  assert.doesNotMatch(
    registration.slice(
      registration.indexOf("const acceptsCommittedWork"),
      registration.indexOf("} else if (/^skip", registration.indexOf("const acceptsCommittedWork")),
    ),
    /outOfScope/,
  );
});

test("beta135: accepted continuation skips completed tasks without calling the lead", { skip }, async () => {
  const world = await makeWorld({ files: { "README.md": "# seed\n" } });
  const branch = "harness/resume-existing-plan";
  git(["remote", "set-url", "origin", world.origin], world.bare);
  const wt = await world.adapter.allocate({
    repoFullName: "o/r",
    baseBranch: "main",
    sessionBranch: branch,
    sessionId: "S1",
    ghToken: "",
    commitIdentity: IDENT,
  });
  const tasks = [
    {
      seq: 1,
      title: "Inspect the repo",
      intent: "Report exact paths",
      filesLikelyTouched: [],
      successCriteria: ["report paths"],
      estimatedTokens: 10,
      taskMode: "observe",
    },
    mutateSubTask({ seq: 2, title: "Persistence", path: "prisma/schema.prisma", extra: { dependsOn: [1] } }),
    mutateSubTask({ seq: 3, title: "Export workflow", path: "src/export.ts", extra: { dependsOn: [1, 2] } }),
  ];
  const plan = {
    repo: "o/r",
    branch,
    worktreePath: wt,
    reviewChecklist: [],
    riskLevel: "high",
    approxCostUsd: 0,
    subTasks: tasks,
  };
  let dispatched;
  const brief = {
    title: "Drive export",
    motivation: "m",
    acceptanceCriteria: ["a"],
    outOfScope: [],
    riskLevel: "high",
    resumeExistingPlan: true,
  };
  const now = Date.now();
  const s = await runScenario({
    world,
    branch,
    brief,
    subTasks: tasks,
    seedSession: ({ db, state }) => {
      db.prepare(`UPDATE sessions SET lead_plan_json = ?, worktree_path = ? WHERE id = ?`)
        .run(JSON.stringify(plan), wt, "S1");
      for (const seq of [1, 2]) {
        db.prepare(
          `INSERT INTO sub_tasks
             (id, session_id, cycle, seq, description, worker_model, status, cost_usd, created_at, updated_at)
           VALUES (?, 'S1', 1, ?, ?, 'w', 'completed', 0, ?, ?)`,
        ).run(`S1-c1-s${seq}`, seq, tasks[seq - 1].title, now, now);
      }
      state.audit("loop.observe_report_recorded", {
        sessionId: "S1",
        seq: 1,
        title: "Inspect the repo",
        report: "The exact implementation path is src/export.ts",
      }, "S1");
    },
    worker: async ({ subTask, worktreePath }, { world: w }) => {
      dispatched = subTask;
      const rel = subTask.filesLikelyTouched[0];
      mkdirSync(dirname(join(worktreePath, rel)), { recursive: true });
      writeFileSync(join(worktreePath, rel), "export const driveExport = true;\n");
      const sha = await w.adapter.commit(worktreePath, "feat: export workflow", IDENT);
      return {
        status: "completed",
        filesChanged: [rel],
        commitSha: sha,
        commitShas: [sha],
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: "implemented",
      };
    },
  });
  assert.equal(s.out.status, "shipped", `${s.out.status}: ${s.out.reason ?? ""}`);
  assert.equal(s.calls.lead, 0, "accept must not buy or trust a replacement plan");
  assert.equal(s.calls.worker, 1, "only the still-pending third task runs");
  assert.equal(dispatched.seq, 3);
  assert.match(dispatched.priorObserveReports[0].report, /src\/export\.ts/);
  assert.ok(s.sawEvent("loop.plan_resumed_after_contract_accept"));
  assert.ok(s.sawEvent("loop.observe_reports_hydrated"));
});

test("beta135: observe reports are durable across the accepted continuation", () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /report: report\.slice\(0, OBSERVE_REPORT_MAX_CHARS\)/);
  assert.match(loop, /hydrateObserveReports\(sessionId, plan\)/);
  assert.match(loop, /loop\.observe_reports_hydrated/);
});

test("beta136: zero-change retry keeps evidence and confronts the false completion", () => {
  const loop = S("src/orchestrator/loop.ts");
  assert.match(loop, /subTask: dispatchSt/);
  assert.match(loop, /resumeSessionId: result\.sdkSessionId/);
  assert.match(loop, /worktreePath: workerWorktree/);
  assert.match(loop, /ZERO filesystem changes and ZERO commits/);
  assert.match(loop, /Git is authoritative/);
});

test("beta136: focused OpenCode workers cannot launch nested agents", () => {
  const guard = S("src/safety/focused-worker-acp-guard.ts");
  assert.match(guard, /call\.kind === "other" && call\.title === "todowrite"/);
  assert.match(guard, /focused worker may not launch nested agents/);
  assert.match(guard, /call\.kind === "think"/);
  assert.match(guard, /raw\["subagent_type"\]/);
});

test("beta136: the focused guard allows only the inert checklist and delegates everything else", {
  skip: !focusedWorkerAcpGuard,
}, async () => {
  const delegated = [];
  const guard = focusedWorkerAcpGuard(async (call) => {
    delegated.push(call);
    return { allow: false, reason: "base guard" };
  });

  assert.deepEqual(await guard({ kind: "other", title: "todowrite" }), { allow: true });
  assert.equal(delegated.length, 0);

  const nested = await guard({
    kind: "think",
    title: "task",
    rawInput: { subagent_type: "general" },
  });
  assert.equal(nested.allow, false);
  assert.match(nested.reason, /may not launch nested agents/);
  assert.equal(delegated.length, 0);

  assert.deepEqual(await guard({ kind: "execute", title: "git status" }), {
    allow: false,
    reason: "base guard",
  });
  assert.equal(delegated.length, 1);
});

test("beta136: every backend role schema can declare reasoning effort", () => {
  for (const file of ["src/config.schema.json", "openclaw.plugin.json"]) {
    const schema = JSON.parse(S(file));
    const root = file === "openclaw.plugin.json" ? schema.configSchema : schema;
    const roles = root.properties.backends.properties;
    for (const role of [
      "default", "worker", "scout", "lead", "adversary",
      "classifier", "crystalliser", "revise_spec", "worker_context",
    ]) {
      assert.deepEqual(
        roles[role].properties.effort.enum,
        ["none", "low", "medium", "high", "xhigh", "max"],
        `${file}: ${role}.effort missing`,
      );
    }
  }
});
