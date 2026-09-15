/**
 * rc.9 -- the reason a human is given must be the reason the work stopped.
 *
 * StitchGuard session f7c4e585 is the whole specification for this file. The
 * harness recorded the true cause at 19:35:17.838 (audit 5406):
 *
 *   loop.worker_tool_denied
 *   reason: edit path '.env.example, ...' is denylisted
 *
 * Twenty seconds later, three things had gone wrong with it:
 *
 *   1. The retry classifier logged `reason: ""`, `category: null` -- the
 *      structured denial never reached it, so a deterministic permission
 *      conflict was retried as a PROTOCOL problem and cost a second billed turn.
 *   2. The second attempt was denied identically and left NO audit row at all.
 *      The durable record showed one denial where there had been two.
 *   3. The clarification put to the operator was:
 *
 *        Sub-task 11 ("Document Safe Deployment And Review Artefacts") could not
 *        proceed. The worker's explanation: I'll inspect the named documentation
 *        sections, [...] evidence requirements, and. How should it proceed?
 *
 *      Planning prose, truncated mid-sentence, describing a denial it never
 *      mentions, attributed to a worker that had refused nothing.
 *
 * These tests pin the three fixes and their negative controls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyWorkerOutcome,
  policyDenialFrom,
  buildPolicyDenialClarification,
  correctFalseUserRejection,
} from "../dist/orchestrator/worker-outcome.js";
import { buildAcpGuard } from "../dist/safety/bash-guard.js";

/** The incident's own worker text: pure planning narration, cut mid-sentence. */
const INCIDENT_FINAL_MESSAGE =
  "I\u2019ll inspect the named documentation sections, help companion conventions, existing Slack " +
  "manifests, and OKF source metadata, then make only the scoped documentation changes and commit " +
  "them.The implementation is fail-closed around six dedicated settings: five Slack controls plus " +
  "explicit IT and Engineering Linear team IDs. I\u2019ll replace the obsolete slash-command/shared-token " +
  "guidance with the message-shortcut workflow, tenant-bound identity checks, durable retry model, " +
  "evidence requirements, and";

const denylistDenial = (path = ".env.example") => ({
  kind: "edit",
  title: "4 files",
  reason: `edit path '${path}' is denylisted`,
  denial: {
    code: "path_denylisted",
    rule: ".env.*",
    kind: "edit",
    paths: [path],
    message: `'${path}' is blocked by the safety path denylist rule '.env.*'. ...add its exact path to \`safety.path_denylist_exceptions\`...`,
  },
});

/* ------------------------------------------------------------------ *
 * 4. denial -> outcome -> clarification keeps the actionable reason
 * ------------------------------------------------------------------ */

test("rc.9: a denylist denial is a policy denial, not an 'incomplete' turn", () => {
  const outcome = classifyWorkerOutcome({
    finalMessage: INCIDENT_FINAL_MESSAGE,
    commitSha: undefined,
    deniedToolCalls: [denylistDenial()],
  });
  // rc.8 produced exactly this input and classified it `incomplete`, which is
  // what licensed the retry and the misleading question.
  assert.equal(outcome.kind, "policy_denial");
  assert.equal(outcome.policy.rule, ".env.*");
  assert.deepEqual(outcome.policy.paths, [".env.example"]);
  assert.equal(outcome.policy.tool, "edit");
});

test("rc.9: the classification is structural -- prose alone never invents one", () => {
  // Same reason STRING, no structured verdict: the pre-rc.9 behaviour stands,
  // rather than a policy denial being fabricated from English.
  const outcome = classifyWorkerOutcome({
    finalMessage: INCIDENT_FINAL_MESSAGE,
    deniedToolCalls: [{ kind: "edit", title: "4 files", reason: "edit path '.env.example' is denylisted" }],
  });
  assert.notEqual(outcome.kind, "policy_denial");
});

test("rc.9: the clarification names the rule, the path, the tool and the attempts", () => {
  const outcome = classifyWorkerOutcome({
    finalMessage: INCIDENT_FINAL_MESSAGE,
    deniedToolCalls: [denylistDenial(), denylistDenial()],
  });
  const q = buildPolicyDenialClarification({
    seq: 11,
    title: "Document Safe Deployment And Review Artefacts",
    policy: outcome.policy,
    workerNote: outcome.explanation?.slice(0, 300),
  });

  assert.match(q, /BLOCKED BY HARNESS SAFETY POLICY/);
  assert.match(q, /\.env\.example/);
  assert.match(q, /`\.env\.\*`/);
  assert.match(q, /Attempts: 2/);
  assert.match(q, /path_denylist_exceptions/);
  assert.match(q, /deterministic/);
  // And it must not be a question about the worker's state of mind.
  assert.doesNotMatch(q, /The worker's explanation/);
});

test("rc.9: the worker's narrative is context at most, never the question", () => {
  const outcome = classifyWorkerOutcome({
    finalMessage: INCIDENT_FINAL_MESSAGE,
    deniedToolCalls: [denylistDenial()],
  });
  const withNote = buildPolicyDenialClarification({
    seq: 11,
    title: "t",
    policy: outcome.policy,
    workerNote: "I\u2019ll inspect the named documentation sections",
  });
  const withoutNote = buildPolicyDenialClarification({ seq: 11, title: "t", policy: outcome.policy });

  // Present, but demoted and labelled as not being the reason.
  assert.match(withNote, /not the reason it stopped/);
  const noteIndex = withNote.indexOf("I\u2019ll inspect");
  assert.ok(noteIndex > withNote.indexOf("safety path denylist"), "the rule comes first, the prose last");
  // And the question stands on its own without it.
  assert.match(withoutNote, /\.env\.example/);
  assert.doesNotMatch(withoutNote, /I\u2019ll inspect/);
});

test("rc.9: a human is never told they rejected something the guard rejected", () => {
  const backendText =
    "The user rejected permission to use this specific tool call. I will try a smaller patch.";
  const corrected = correctFalseUserRejection(backendText);
  assert.doesNotMatch(corrected, /user rejected/i);
  assert.match(corrected, /harness safety guard denied/);
  assert.match(corrected, /no human was asked/);
  // Unrelated text is untouched.
  assert.equal(correctFalseUserRejection("The tests failed."), "The tests failed.");
});

/* ------------------------------------------------------------------ *
 * 5. Bounded retries, and both denials stay visible
 * ------------------------------------------------------------------ */

test("rc.9: a deterministic denial is not retryable; a self-correctable one still is", () => {
  const deterministic = classifyWorkerOutcome({
    finalMessage: "x",
    deniedToolCalls: [denylistDenial()],
  });
  assert.equal(deterministic.kind, "policy_denial", "-> humanDecidableNow, so no retry");

  // `secret_material` is deliberately NOT deterministic: the worker can write a
  // placeholder instead, so it keeps its retry.
  const fixable = classifyWorkerOutcome({
    finalMessage: "x",
    deniedToolCalls: [
      {
        kind: "edit",
        reason: "adds secret material",
        denial: { code: "secret_material", rule: ".env.*", kind: "edit", paths: [".env.example"], message: "..." },
      },
    ],
  });
  assert.notEqual(fixable.kind, "policy_denial");
});

test("rc.9: a guard denial that names a remedy still outranks the policy bucket", () => {
  // The harness can fix this one without interrupting anybody, and that
  // precedence must survive: it is the rc.2 behaviour, not a regression.
  const outcome = classifyWorkerOutcome({
    finalMessage: "Now let me check the headers",
    deniedToolCalls: [
      {
        kind: "execute",
        title: "python -c 'import x'",
        reason: "inline code via -c is not permitted; write a script file instead",
        denial: { code: "command_denied", kind: "execute", message: "..." },
      },
    ],
  });
  assert.equal(outcome.kind, "recoverable_tool_denial");
});

test("rc.9: repeated denials are counted, so the second attempt is not invisible", () => {
  const twice = policyDenialFrom([denylistDenial(), denylistDenial()]);
  assert.equal(twice.attempts, 2);

  // Two DIFFERENT denials do not inflate the count of the first.
  const mixed = policyDenialFrom([denylistDenial(".env.example"), denylistDenial(".env.production")]);
  assert.equal(mixed.attempts, 1);
  assert.deepEqual(mixed.paths, [".env.example"]);
});

test("rc.9: every attempt's denials are audited, not just the first", async () => {
  // The loop's auditor takes an explicit `attempt`, and is called after each
  // retry as well as after the first turn. At rc.8 it ran once, before the
  // retry loop, so attempt 2's denial left no row.
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("../src/orchestrator/loop.ts", import.meta.url), "utf8");
  const calls = [...text.matchAll(/this\.auditDeniedToolCalls\(\{/g)];
  assert.ok(calls.length >= 3, `expected the auditor at the first turn and both retry sites, saw ${calls.length}`);
  assert.match(text, /attempt: protocolRetries \+ 1/);
});

/* ------------------------------------------------------------------ *
 * The boundary the structure has to survive: guard -> adapter shape
 * ------------------------------------------------------------------ */

test("rc.9: the ACP adapter forwards the structured verdict, not just the sentence", async () => {
  const fs = await import("node:fs");
  const acp = fs.readFileSync(new URL("../src/adapters/acp.ts", import.meta.url), "utf8");
  assert.match(acp, /denied\.push\(\{[^}]*denial: verdict\.denial/s, "the denial must ride along with the push");

  // And the guard really does produce one for the incident's own case.
  const g = buildAcpGuard({
    bash_whitelist: [],
    bash_denylist_tokens: [],
    path_denylist: [".env", ".env.*"],
    allow_git_push: false,
    allow_network_commands: false,
  });
  const v = await g({ kind: "edit", title: "1 file", locations: [{ path: ".env.example" }], rawInput: {} });
  assert.equal(v.allow, false);
  assert.equal(v.denial.code, "path_denylisted");
  assert.equal(v.denial.rule, ".env.*");
});
