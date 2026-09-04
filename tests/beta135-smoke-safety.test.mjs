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

test("rc1: reviewer-authorized companion file is durable scope and ships after cycle-two pass", { skip }, async () => {
  const page = "src/app/(portal)/it/offboarding/[id]/page.tsx";
  const help = "src/lib/help/help-content.ts";
  let workerTurn = 0;
  let reviewTurn = 0;
  const s = await runScenario({
    seedFiles: { "README.md": "# seed\n" },
    subTasks: [mutateSubTask({ title: "Add checklist sorting", path: page })],
    worker: async ({ worktreePath }, { world }) => {
      workerTurn += 1;
      const rel = workerTurn === 1 ? page : help;
      mkdirSync(dirname(join(worktreePath, rel)), { recursive: true });
      writeFileSync(join(worktreePath, rel), `export const turn = ${workerTurn};\n`);
      const sha = await world.adapter.commit(worktreePath, `fix: cycle ${workerTurn}`, IDENT);
      return {
        status: "completed",
        filesChanged: [rel],
        commitSha: sha,
        commitShas: [sha],
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: `${rel} committed`,
      };
    },
    runAdversary: async () => {
      reviewTurn += 1;
      return reviewTurn === 1
        ? {
            verdict: "revise",
            findings: [{
              severity: "medium",
              dimension: "fit",
              title: "Update mandatory help content",
              detail: "The repository convention requires the companion help index.",
              file: page,
              relatedFiles: [help],
            }],
            summary: "one convention co-fix remains",
            costUsd: 0.01,
            tokensIn: 1,
            tokensOut: 1,
          }
        : {
            verdict: "pass",
            findings: [],
            summary: "the reviewer-required companion update is present",
            costUsd: 0.01,
            tokensIn: 1,
            tokensOut: 1,
          };
    },
  });

  assert.equal(s.out.status, "shipped", `${s.out.status}: ${s.out.reason ?? ""}`);
  assert.equal(s.calls.worker, 2);
  assert.equal(reviewTurn, 2, "a false scope finding must not start a third cycle");
  assert.equal(s.calls.push, 1);
  assert.equal(s.sawEvent("loop.final_scope_check_out_of_scope"), false);
  const storedPlan = JSON.parse(s.session().lead_plan_json);
  assert.ok(storedPlan.approvedRevisionScopeFiles.includes(help));
  const finalReview = s.db.prepare(`SELECT verdict, findings FROM reviews WHERE session_id = ? AND cycle = 2`).get("S1");
  assert.equal(finalReview.verdict, "pass");
  assert.deepEqual(JSON.parse(finalReview.findings), []);
});

test("rc1: a genuinely unrelated committed file remains a routable deterministic scope finding", { skip }, async () => {
  const page = "src/page.ts";
  const unrelated = "src/unrelated.ts";
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1, max_cycle_extensions: 0 } },
    subTasks: [mutateSubTask({ title: "Edit page", path: page })],
    worker: async ({ worktreePath }, { world }) => {
      for (const rel of [page, unrelated]) {
        mkdirSync(dirname(join(worktreePath, rel)), { recursive: true });
        writeFileSync(join(worktreePath, rel), `export const value = ${JSON.stringify(rel)};\n`);
      }
      const sha = await world.adapter.commit(worktreePath, "feat: page plus unrelated file", IDENT);
      return {
        status: "completed", filesChanged: [page, unrelated], commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "committed",
      };
    },
  });
  const review = s.db.prepare(`SELECT verdict, findings FROM reviews WHERE session_id = ? AND cycle = 1`).get("S1");
  const findings = JSON.parse(review.findings);
  const scope = findings.find((finding) => finding.source === "deterministic_scope");
  assert.equal(review.verdict, "revise");
  assert.equal(scope.file, unrelated);
  assert.equal(scope.dimension, "fit");
  assert.equal(s.events("loop.review_raw")[0].payload.verdict, "pass");
});

test("rc1: Vercel verification pushes only after static pass and reviews the exact preview SHA before PR open", { skip }, async () => {
  const order = [];
  let previewSha;
  let openCalls = 0;
  const s = await runScenario({
    runAdversary: async ({ runtime }) => {
      order.push(runtime?.provider === "vercel" ? "runtime-review" : "static-review");
      return {
        verdict: "pass", findings: [], summary: "pass",
        costUsd: 0.01, tokensIn: 1, tokensOut: 1,
      };
    },
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ plan, commitSha }) => {
        order.push("preview-push");
        previewSha = git(["rev-parse", "HEAD"], plan.worktreePath);
        assert.equal(commitSha, previewSha);
        return { remoteSha: previewSha };
      },
      fetchRuntime: async ({ waitForPreview, commitSha }) => {
        if (!waitForPreview) return undefined;
        order.push("preview-wait");
        assert.equal(commitSha, previewSha);
        return { provider: "vercel", status: "ok", deploymentUrl: "https://preview.example" };
      },
      openPullRequest: async () => {
        order.push("pr-open");
        openCalls += 1;
        return "https://github.com/o/r/pull/1";
      },
    },
  });
  assert.equal(s.out.status, "shipped");
  assert.deepEqual(order, ["static-review", "preview-push", "preview-wait", "runtime-review", "pr-open"]);
  assert.equal(openCalls, 1);
  assert.equal(s.calls.push, 0, "the combined push/open path must not repush after preview verification");
});

test("rc1: missing exact-SHA runtime evidence preserves the worktree and never opens a PR", { skip }, async () => {
  let reviews = 0;
  let openCalls = 0;
  const s = await runScenario({
    runAdversary: async () => {
      reviews += 1;
      return {
        verdict: "pass", findings: [], summary: "pass",
        costUsd: 0.01, tokensIn: 1, tokensOut: 1,
      };
    },
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ commitSha }) => ({ remoteSha: commitSha }),
      fetchRuntime: async () => ({
        provider: "vercel",
        status: "no_deploy_yet",
        logsExcerpt: "No deployment matched the candidate SHA.",
      }),
      openPullRequest: async () => {
        openCalls += 1;
        return "https://github.com/o/r/pull/should-not-open";
      },
    },
  });
  assert.equal(reviews, 1, "unavailable runtime evidence must not be presented as a reviewable deployment");
  assert.equal(openCalls, 0);
  assert.equal(s.out.status, "failed");
  assert.match(s.out.reason, /preview_runtime_unavailable/);
});

test("rc1: non-zero unparseable typecheck output becomes a harness_env finding", { skip }, async () => {
  const s = await runScenario({
    seedFiles: {
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
      "tsconfig.json": JSON.stringify({ compilerOptions: {} }),
    },
    deps: {
      runCheckScript: () => ({
        status: 1,
        stdout: "This is not the tsc command you are looking for",
        stderr: "",
      }),
      runTypecheckDirect: () => ({
        via: "node_modules_bin",
        status: 1,
        stdout: "compiler wrapper failed before diagnostics",
        stderr: "",
      }),
    },
  });
  const row = s.db.prepare(`SELECT findings FROM reviews WHERE session_id = ? AND cycle = 1`).get("S1");
  const finding = JSON.parse(row.findings).find((item) => item.source === "harness_env");
  assert.equal(finding.title, "Typecheck failed without parseable compiler diagnostics");
  assert.ok(s.sawEvent("loop.typecheck_gate_unparsed"));
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

test("beta137: accepted continuation remembers each sub-task's latest completion", () => {
  const loop = S("src/orchestrator/loop.ts");
  const start = loop.indexOf("private loadAcceptedContinuation");
  const body = loop.slice(start, start + 2500);
  assert.match(body, /latest\.seq = current\.seq/);
  assert.match(body, /MAX\(latest\.cycle\)/);
  assert.doesNotMatch(
    body,
    /MAX\(cycle\) FROM sub_tasks WHERE session_id = \?\)/,
    "a partial newer cycle must not hide completions from an earlier cycle",
  );
});

test("beta137: a resumed review replaces its same-cycle predecessor", () => {
  const loop = S("src/orchestrator/loop.ts");
  const start = loop.indexOf("private saveReview");
  const body = loop.slice(start, start + 1200);
  assert.match(body, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(body, /findings = excluded\.findings/);
  assert.match(body, /cost_usd = excluded\.cost_usd/);
});

test("beta137: resolved contracts are reported to the adversary as passing", () => {
  const loop = S("src/orchestrator/loop.ts");
  const start = loop.indexOf("private readLocalVerification");
  const body = loop.slice(start, start + 2500);
  assert.match(body, /current\.status IN \('completed', 'completed_no_change'\)/);
  assert.match(body, /ok: true/);
  assert.match(body, /MAX\(latest\.cycle\)/);
});

test("beta137: chunked reviews cannot infer missing tests from one chunk", () => {
  const adapter = S("src/adapters/claude-code.ts");
  const start = adapter.indexOf("const changedFiles =");
  const body = adapter.slice(start, start + 2500);
  assert.match(body, /Global changed-file manifest/);
  assert.match(body, /Prior chunk summaries/);
  assert.match(body, /Never report that required code or tests are absent merely because/);
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

test("beta136: the capability probe uses the selected role effort", () => {
  const router = S("src/adapters/backend-router.ts");
  const acp = S("src/adapters/acp.ts");
  assert.match(router, /effort: this\.roles\[role\]\.effort/);
  assert.match(acp, /effort: input\.effort/);
});
