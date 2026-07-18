/**
 * beta.33: push + PR are NOT sub-tasks. The harness endgame
 * (pushBranchAndOpenPr) pushes the branch and opens the PR automatically
 * after the adversary review passes, using an authenticated token + askpass.
 * A worker CANNOT push (git push is bash-guard-blocked, worker bash git has
 * no credentials).
 *
 * Root cause (session 534be94a, beta.32 smoke): the lead planned a final
 * "Push branch and open PR" sub-task; its remote verify contract failed
 * (remote 404, worker never pushed) and aborted the run BEFORE review and
 * before the harness's own working push.
 *
 * Two guards:
 *   1. Prompt regression: the lead system prompt forbids push/PR sub-tasks.
 *   2. Behaviour: runLeadPlanner sanitises any push/PR sub-task the lead
 *      emits anyway (strip remote verify kinds, force local scope, drop
 *      pure push/PR-only tasks when safe).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sdkSourcePath = resolve(here, "..", "src", "adapters", "claude-sdk.ts");
const sdkSrc = readFileSync(sdkSourcePath, "utf8");

test("beta.33 prompt: lead is told NOT to plan push/PR sub-tasks", () => {
  assert.match(sdkSrc, /DO NOT PLAN PUSH OR PR SUB-TASKS/);
  assert.match(sdkSrc, /harness (pushes|does that step)/i);
  // 'remote' scope must be marked reserved / do-not-use.
  assert.match(sdkSrc, /'remote' = RESERVED for the harness\. Do NOT use\./);
});

let runLeadPlanner;
try {
  ({ runLeadPlanner } = await import("../dist/orchestrator/fable5-lead.js"));
} catch {
  runLeadPlanner = null;
}

const baseConfig = {
  repos: { allowed: ["Stitch-Vercel/*"], default_base_branch: "main" },
};

function makeDeps(rawPlan, log) {
  return {
    config: baseConfig,
    logger: { info: (m, meta) => log.push({ m, meta }) },
    callLeadModel: async () => rawPlan,
    allocateWorktree: async () => "/tmp/wt-test",
    estimateCost: () => 0.1,
  };
}

test("beta.33 sanitiser: strips remote verify kinds + forces local scope",
  { skip: runLeadPlanner === null }, async () => {
    const log = [];
    const raw = {
      repo: "Stitch-Vercel/ProjectThanos",
      branch: "harness/chore-x",
      riskLevel: "low",
      reviewChecklist: ["a", "b"],
      subTasks: [
        {
          seq: 1, title: "Edit summary prompt", intent: "remove Gamorning lines and commit",
          filesLikelyTouched: ["src/lib/briefing/ai-summary.ts"], successCriteria: ["gamorning removed"],
          estimatedTokens: 500, contractScope: "local",
          verify: [{ kind: "file_committed", path: "src/lib/briefing/ai-summary.ts" }, { kind: "commit_made" }],
        },
        {
          seq: 2, title: "Push branch and open PR", intent: "push branch to origin and open a pull request",
          filesLikelyTouched: [], successCriteria: ["PR opened"], estimatedTokens: 300,
          contractScope: "remote",
          verify: [{ kind: "branch_pushed", branch: "harness/chore-x" }, { kind: "pr_opened", branch: "harness/chore-x" }],
        },
      ],
    };
    const plan = await runLeadPlanner({ title: "t" }, makeDeps(raw, log));
    // sub-task 2 is a pure push/PR-only task with (after stripping) empty
    // verify and nothing depends on it -> dropped.
    assert.equal(plan.subTasks.length, 1, "push/PR-only sub-task should be dropped");
    assert.equal(plan.subTasks[0].seq, 1);
    // sub-task 1 keeps its LOCAL verify kinds and local scope.
    assert.deepEqual(plan.subTasks[0].verify.map((v) => v.kind).sort(), ["commit_made", "file_committed"]);
    assert.equal(plan.subTasks[0].contractScope, "local");
  });

test("beta.33 sanitiser: coerces (not drops) a mixed local+push sub-task depended-on",
  { skip: runLeadPlanner === null }, async () => {
    const log = [];
    const raw = {
      repo: "Stitch-Vercel/ProjectThanos",
      branch: "harness/chore-y",
      riskLevel: "low",
      reviewChecklist: ["a"],
      subTasks: [
        {
          seq: 1, title: "Write and push", intent: "edit the file, commit, then push to origin",
          filesLikelyTouched: ["a.ts"], successCriteria: ["done"], estimatedTokens: 400,
          contractScope: "remote",
          verify: [{ kind: "file_committed", path: "a.ts" }, { kind: "branch_pushed", branch: "harness/chore-y" }],
        },
        {
          seq: 2, title: "Verify", intent: "confirm the change is correct", dependsOn: [1],
          filesLikelyTouched: [], successCriteria: ["ok"], estimatedTokens: 100,
          contractScope: "local", taskMode: "observe", verify: [],
        },
      ],
    };
    const plan = await runLeadPlanner({ title: "t" }, makeDeps(raw, log));
    // Nothing is a pure push/PR-only + no-verify + un-depended task, so both
    // survive; sub-task 1 is coerced local and its remote verify kind stripped.
    assert.equal(plan.subTasks.length, 2);
    const s1 = plan.subTasks.find((s) => s.seq === 1);
    assert.equal(s1.contractScope, "local");
    assert.deepEqual(s1.verify.map((v) => v.kind), ["file_committed"], "branch_pushed stripped, file_committed kept");
  });

test("beta.33 sanitiser: does NOT drop the only sub-task even if push/PR-only",
  { skip: runLeadPlanner === null }, async () => {
    const log = [];
    const raw = {
      repo: "Stitch-Vercel/ProjectThanos",
      branch: "harness/chore-z",
      riskLevel: "low",
      reviewChecklist: ["a"],
      subTasks: [
        {
          seq: 1, title: "Push branch and open PR", intent: "push and open a pull request",
          filesLikelyTouched: [], successCriteria: ["pr"], estimatedTokens: 200,
          contractScope: "remote", verify: [{ kind: "pr_opened" }],
        },
      ],
    };
    // must not throw "zero sub-tasks" — we neutralise, not delete the last one.
    const plan = await runLeadPlanner({ title: "t" }, makeDeps(raw, log));
    assert.equal(plan.subTasks.length, 1);
    assert.equal(plan.subTasks[0].contractScope, "local");
    assert.equal((plan.subTasks[0].verify ?? []).length, 0, "remote verify stripped to empty");
  });
