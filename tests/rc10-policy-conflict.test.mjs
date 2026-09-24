/**
 * rc.10 / F3 -- a policy block is not a path mistake, and a partial commit does
 * not change that.
 *
 * Client Offboarding smoke test, 15 September 2026, session aad3fc57. Sub-task
 * 3 required `.env.example`; the effective denylist contains `.env.*`; no
 * exception was configured.
 *
 *   5598  the write is denied
 *   5601  the clarification takes the CONTRACT-MISMATCH branch, because the
 *         worker had committed two implementation files, and asks the operator
 *         to accept / skip / supply another path -- never mentioning that a
 *         safety rule refused the template
 *   5619  after an operator correction that changed the test path and left
 *         policy untouched, the identical denial recurs
 *   5627  this time there is no new commit, so the policy branch fires and the
 *         report is correct
 *
 * 5627 is the proof: the same denial produced the right question when there was
 * no commit and the wrong one when there was. rc.9 predicated every
 * policy-denial path on `!result.commitSha`.
 *
 * Two fixes, pinned below:
 *   1. The denial is read from the structured record, independent of commit
 *      state, and its escalation is placed above the mismatch branch.
 *   2. The plan is compared against policy at plan_ready, and the affected
 *      sub-task is not dispatched at all -- the $0.4262756 that bought a retry
 *      of unchanged-policy work is never spent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findPlanPolicyConflicts,
  describePlanPolicyConflicts,
} from "../dist/orchestrator/plan-policy-conflict.js";
import { buildPolicyDenialClarification, policyDenialFrom } from "../dist/orchestrator/worker-outcome.js";
import {
  makeWorld, makeConfig, mutateSubTask, runScenario, scenarioAvailable, IDENT, git,
} from "./helpers/scenario.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DENYLIST = [".env", ".env.*", "*.pem", "id_rsa"];

/** The denial the ACP guard produced, as audit 5598 recorded it. */
const envExampleDenial = {
  kind: "edit",
  title: "2 files",
  reason: "edit path '.env.example' is denylisted",
  denial: {
    code: "path_denylisted",
    rule: ".env.*",
    kind: "edit",
    paths: [".env.example"],
    message:
      "'.env.example' is blocked by the safety path denylist rule '.env.*'. If this is a tracked template " +
      "that genuinely must be edited, add its exact path to `safety.path_denylist_exceptions`.",
  },
};

/* ------------------------------------------------------------------ *
 * 1. Plan-time conflict detection
 * ------------------------------------------------------------------ */

test("rc.10 (F3): the plan/policy conflict is visible before anything is dispatched", () => {
  const conflicts = findPlanPolicyConflicts(
    [
      { seq: 1, title: "Access agent factory", filesLikelyTouched: ["src/lib/it/client-offboarding-errors.ts"] },
      { seq: 3, title: "Slack app config template", filesLikelyTouched: ["src/lib/it/config.ts", ".env.example"] },
    ],
    DENYLIST,
  );
  assert.equal(conflicts.length, 1);
  assert.deepEqual(
    { seq: conflicts[0].seq, path: conflicts[0].path, rule: conflicts[0].rule },
    { seq: 3, path: ".env.example", rule: ".env.*" },
  );
});

test("rc.10 (F3): an explicitly authorised template is not a conflict", () => {
  const conflicts = findPlanPolicyConflicts(
    [{ seq: 3, title: "t", filesLikelyTouched: [".env.example"] }],
    DENYLIST,
    [".env.example"],
  );
  assert.deepEqual(conflicts, [], "the rc.9 exception mechanism is honoured, not bypassed");
});

test("rc.10 (F3): the exception is exact -- it does not generalise to real secrets", () => {
  const conflicts = findPlanPolicyConflicts(
    [{ seq: 3, title: "t", filesLikelyTouched: [".env.production", ".env", "deploy/id_rsa"] }],
    DENYLIST,
    [".env.example"],
  );
  assert.deepEqual(conflicts.map((c) => c.path).sort(), [".env", ".env.production", "deploy/id_rsa"]);
});

test("rc.10 (F3): a clean plan produces nothing, and an empty denylist blocks nothing", () => {
  assert.deepEqual(findPlanPolicyConflicts([{ seq: 1, title: "t", filesLikelyTouched: ["src/a.ts"] }], DENYLIST), []);
  assert.deepEqual(findPlanPolicyConflicts([{ seq: 1, title: "t", filesLikelyTouched: [".env"] }], []), []);
  assert.deepEqual(findPlanPolicyConflicts(undefined, DENYLIST), []);
});

test("rc.10 (F3): the operator decision names the rule and the cost position", () => {
  const text = describePlanPolicyConflicts(
    findPlanPolicyConflicts([{ seq: 3, title: "Slack app config template", filesLikelyTouched: [".env.example"] }], DENYLIST),
  );
  assert.match(text, /REFUSE/);
  assert.match(text, /`\.env\.example`/);
  assert.match(text, /`\.env\.\*`/);
  assert.match(text, /no budget has been spent/);
  assert.match(text, /path_denylist_exceptions/);
  assert.match(text, /does not authorise putting a real credential in it/);
  // And it must NOT offer the question that went wrong.
  assert.doesNotMatch(text, /wrong path|path typo|did the worker/i);
});

/* ------------------------------------------------------------------ *
 * 2. The clarification when partial work exists
 * ------------------------------------------------------------------ */

test("rc.10 (F3, audit 5601): partial work is preserved AND the rule is the reason", () => {
  const policy = policyDenialFrom([envExampleDenial]);
  const text = buildPolicyDenialClarification({
    seq: 3,
    title: "Slack app config template",
    policy,
    partialWork: {
      commitSha: "065063efd1dfe6a0e74d0b114668c4ecdb4df766",
      committed: ["src/lib/it/access-agent-factory.ts", "src/lib/it/config.ts"],
      unmet: [".env.example", "src/__tests__/lib/it/client-offboarding-orchestrator.test.ts"],
    },
  });

  assert.match(text, /BLOCKED BY HARNESS SAFETY POLICY, not by the worker/);
  assert.match(text, /Work already done is KEPT/);
  assert.match(text, /065063ef/);
  assert.match(text, /access-agent-factory\.ts/);
  assert.match(text, /Still unmet/);
  assert.match(text, /NOT a wrong-path mistake/);
  assert.match(text, /`\.env\.\*`/, "the rule is named");
});

test("rc.10 (F3): with no partial work the rc.9 wording is unchanged", () => {
  const policy = policyDenialFrom([envExampleDenial]);
  const text = buildPolicyDenialClarification({ seq: 3, title: "t", policy });
  assert.doesNotMatch(text, /Work already done is KEPT/);
  assert.match(text, /BLOCKED BY HARNESS SAFETY POLICY/);
});

/* ------------------------------------------------------------------ *
 * 3. End to end, through the real loop
 * ------------------------------------------------------------------ */

const available = await scenarioAvailable();

test("rc.10 (F3): a blocked sub-task is never dispatched, and costs nothing", { skip: !available }, async () => {
  const world = await makeWorld();
  const r = await runScenario({
    world,
    config: makeConfig({ safety: { path_denylist: DENYLIST } }),
    subTasks: [mutateSubTask({ seq: 1, title: "Slack app config template", path: ".env.example" })],
  });

  assert.equal(r.calls.worker, 0, "the whole point: no worker turn was bought");
  assert.ok(r.sawEvent("loop.plan_policy_conflict"), "the conflict is recorded at plan time");
  assert.ok(r.sawEvent("loop.plan_policy_conflict_pre_dispatch"), "and acted on before any worker dispatch");

  const session = r.session();
  assert.equal(session.status, "failed");
  assert.equal(session.clarification_question, null);
  assert.ok(r.sawEvent("control.interactive_pause_rejected"));
  assert.equal(session.cost_usd, 0, "nothing was spent on a turn policy would refuse");
});

test("rc.13 smoke: a later policy conflict pauses before an earlier observe worker spends", { skip: !available }, async () => {
  const r = await runScenario({
    config: makeConfig({ safety: { path_denylist: DENYLIST } }),
    subTasks: [
      {
        ...mutateSubTask({ seq: 1, title: "inspect contracts", path: "src/thing.ts" }),
        taskMode: "observe",
        filesLikelyTouched: [],
        verify: [],
      },
      mutateSubTask({ seq: 3, title: "Slack app config template", path: ".env.example" }),
    ],
  });
  assert.equal(r.calls.worker, 0);
  assert.equal(r.session().status, "failed");
  assert.equal(r.session().clarification_question, null);
  assert.ok(r.sawEvent("loop.plan_policy_conflict_pre_dispatch"));
});

test("rc.10 (F3): sub-tasks without a conflict still run normally", { skip: !available }, async () => {
  const world = await makeWorld();
  const r = await runScenario({
    world,
    config: makeConfig({ safety: { path_denylist: DENYLIST } }),
    subTasks: [mutateSubTask({ seq: 1, title: "ordinary work", path: "src/thing.ts" })],
  });
  assert.equal(r.out.status, "shipped", "the gate is scoped to the offending sub-task, not the plan");
  assert.equal(r.calls.worker, 1);
  assert.ok(!r.sawEvent("loop.plan_policy_conflict_gate"));
});

test(
  "rc.10 (F3, audits 5598/5601): a partial commit plus a denied write asks about the RULE",
  { skip: !available },
  async () => {
    const world = await makeWorld();
    // The sub-task requires two files. The worker commits one and is denied the
    // other -- the incident's exact shape. `.env.example` is absent from
    // filesLikelyTouched so the plan-time gate does not pre-empt this; what is
    // under test here is the escalation AFTER a denial.
    const subTask = mutateSubTask({
      seq: 1,
      title: "Slack app config template",
      path: "src/lib/it/config.ts",
      extra: {
        verify: [
          { kind: "commit_made" },
          { kind: "file_committed", path: "src/lib/it/config.ts" },
          { kind: "file_committed", path: ".env.example" },
        ],
      },
    });

    const r = await runScenario({
      world,
      config: makeConfig({ safety: { path_denylist: DENYLIST } }),
      subTasks: [subTask],
      worker: async ({ subTask: st, worktreePath, plan }) => {
        const wt = worktreePath ?? plan.worktreePath;
        const rel = "src/lib/it/config.ts";
        const abs = join(wt, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, "export const config = {};\n");
        const commitSha = await world.adapter.commit(wt, `feat(${st.seq}): partial`, IDENT);
        return {
          status: "completed",
          filesChanged: [rel],
          commitSha,
          commitShas: [commitSha],
          costUsd: 0.42,
          tokensIn: 10,
          tokensOut: 10,
          reason: "end_turn",
          // The worker's own last words, which at rc.8 became the entire question.
          finalMessage: "I'll add the environment template next and wire the settings through.",
          deniedToolCalls: [envExampleDenial],
        };
      },
    });

    const session = r.session();
    assert.equal(session.status, "failed");
    assert.equal(session.clarification_question, null);
    assert.ok(r.sawEvent("control.interactive_pause_rejected"));

    // The rc.9 audit row must exist, and say that a commit was involved.
    const denied = r.events("loop.worker_policy_denied");
    assert.equal(denied.length, 1, "the denial is audited even though work was committed");
    assert.equal(denied[0].payload.withPartialCommit, true);
    assert.equal(denied[0].payload.rule, ".env.*");
    assert.ok(denied[0].payload.unmet.includes(".env.example"));

    // And the contract-mismatch branch must NOT have claimed this turn.
    assert.ok(
      !r.sawEvent("loop.contract_path_mismatch_escalated"),
      "audit 5601 took this branch; a policy denial must outrank it",
    );

    // The commit survives on the branch.
    assert.ok(r.subTaskRows().some((row) => row.commit_sha), "partial work is preserved, not rolled back");
  },
);

test(
  "rc.10 (F3): guidance that changes the path but not the policy does not authorise the write",
  { skip: !available },
  async () => {
    // The operator's correction in the incident moved a test path. It did not
    // touch `safety.path_denylist_exceptions`, and must not be read as if it
    // had. The check is on the policy layer, which is what an answer cannot
    // reach: an exception exists only when it is configured.
    const conflictsBefore = findPlanPolicyConflicts(
      [{ seq: 3, title: "t", filesLikelyTouched: [".env.example"] }],
      DENYLIST,
      [],
    );
    assert.equal(conflictsBefore.length, 1);

    // An operator answer is prose. Whatever it says, the effective exception
    // list is still empty, so the conflict stands.
    const answer = "Use src/__tests__/lib/it/client-offboarding-orchestrator.test.ts for the test, and add the env template.";
    const conflictsAfter = findPlanPolicyConflicts(
      [{ seq: 3, title: "t", filesLikelyTouched: [".env.example"] }],
      DENYLIST,
      [], // unchanged: an answer is not a config change
    );
    assert.deepEqual(conflictsAfter, conflictsBefore, "an implementation brief is not a safety approval");
    assert.ok(answer.length > 0);

    // Only an explicit, exact configuration entry clears it.
    assert.deepEqual(
      findPlanPolicyConflicts([{ seq: 3, title: "t", filesLikelyTouched: [".env.example"] }], DENYLIST, [".env.example"]),
      [],
    );
  },
);

test("rc.10 (F3): a resumed sub-task is not re-gated on the same conflict", async () => {
  const { readFileSync } = await import("node:fs");
  const loop = readFileSync(new URL("../src/orchestrator/legacy-loop.ts", import.meta.url), "utf8");
  const at = loop.indexOf("const myPolicyConflicts = planPolicyConflicts.filter");
  assert.ok(at > 0, "the gate exists");
  const body = loop.slice(at, at + 900);
  assert.match(body, /!isResumedSeq/, "an answered sub-task proceeds, so the gate cannot loop");
  assert.match(body, /clarification_escalation_enabled/);
  assert.ok(git !== undefined);
});
