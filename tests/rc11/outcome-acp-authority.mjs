import test from "node:test";
import assert from "node:assert/strict";

const {
  buildAcpGuard,
  acpTargetEvidenceFromToolCall,
} = await import("../../dist/safety/bash-guard.js");
const {
  classifyWorkerOutcome,
  recoverableDenialFrom,
} = await import("../../dist/orchestrator/worker-outcome.js");

const guard = () =>
  buildAcpGuard({
    bash_whitelist: ["git"],
    bash_denylist_tokens: [],
    path_denylist: [".env", ".env.*"],
    path_denylist_exceptions: [],
    allow_git_push: false,
    allow_network_commands: false,
  });

const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
const patch = (targets = paths) =>
  `*** Begin Patch\n${targets.map((path) => `*** Update File: ${path}`).join("\n")}\n*** End Patch`;

test("rc.11: complete apply_patch targets outrank their exact joined display summary", async () => {
  const call = {
    kind: "edit",
    title: "4 files",
    locations: [{ path: paths.join(", ") }],
    rawInput: { patchText: patch() },
  };
  const evidence = acpTargetEvidenceFromToolCall(call);
  assert.equal(evidence.schema, "apply_patch/v1");
  assert.equal(evidence.complete, true);
  assert.equal(evidence.joinedDisplaySummary, true);
  assert.deepEqual(evidence.authoritativePaths, paths);
  const verdict = await guard()(call);
  assert.equal(verdict.allow, true);
  assert.deepEqual(verdict.checkedPaths, paths);
});

test("rc.11: a concrete additional location fails closed", async () => {
  const verdict = await guard()({
    kind: "edit",
    locations: [{ path: "src/a.ts" }, { path: "src/omitted.ts" }],
    rawInput: { patchText: patch(["src/a.ts"]) },
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.denial.code, "target_metadata_conflict");
  assert.match(verdict.reason, /absent from authoritative/i);
});

test("rc.11: partial patch parsing and an omitted move destination fail closed", async () => {
  const incomplete = await guard()({
    kind: "edit",
    locations: [],
    rawInput: { patchText: "*** Begin Patch\n*** Update File: src/a.ts" },
  });
  assert.equal(incomplete.allow, false);
  assert.equal(incomplete.denial.code, "target_metadata_conflict");

  const orphanMove = await guard()({
    kind: "move",
    locations: [],
    rawInput: { patchText: "*** Begin Patch\n*** Move to: src/new.ts\n*** End Patch" },
  });
  assert.equal(orphanMove.allow, false);
  assert.match(orphanMove.reason, /move destination has no source/i);
});

test("rc.11: the recognized patch schema accepts its end-of-file marker", async () => {
  const verdict = await guard()({
    kind: "edit",
    locations: [],
    rawInput: {
      patchText:
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End of File\n*** End Patch",
    },
  });
  assert.equal(verdict.allow, true);
});

test("rc.11: move source and destination are both policy checked in every ordering", async () => {
  for (const body of [
    "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: .env.example\n*** End Patch",
    "*** Begin Patch\n*** Update File: .env.example\n*** Move to: src/a.ts\n*** End Patch",
  ]) {
    const verdict = await guard()({ kind: "move", locations: [], rawInput: { patchText: body } });
    assert.equal(verdict.allow, false);
    assert.equal(verdict.denial.code, "path_denylisted");
    assert.equal(verdict.denial.rule, ".env.*");
  }
});

test("rc.11: an unknown payload cannot become authoritative because a field is named patchText", async () => {
  const verdict = await guard()({
    kind: "edit",
    locations: [],
    rawInput: { patchText: "not an apply_patch envelope" },
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.denial.code, "target_metadata_conflict");
});

test("rc.11: legitimate comma-containing filenames remain one target", async () => {
  const verdict = await guard()({
    kind: "edit",
    locations: [{ path: "docs/Report, Final Version.md" }],
    rawInput: {},
  });
  assert.equal(verdict.allow, true);
});

test("rc.11: display-only multi-target ambiguity carries typed bounded recovery", async () => {
  const verdict = await guard()({
    kind: "edit",
    title: "4 files",
    locations: [{ path: paths.join(", ") }],
    rawInput: {},
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.denial.code, "path_unresolvable");
  assert.equal(verdict.denial.recovery.code, "one_target_per_call");
  const recovery = recoverableDenialFrom([{ kind: "edit", reason: verdict.reason, denial: verdict.denial }]);
  assert.equal(recovery.code, "one_target_per_call");
  assert.match(recovery.remedy, /one call per file/i);
});

const INCIDENT =
  "I’ll inspect the implementation, then make the credential-isolation changes and commit them. " +
  "I will not read or modify any `.env*` file. " +
  "The current implementation still inherits generic credentials.";

test("rc.11: the incident compliance statement plus typed denial is recoverable, not refusal", async () => {
  const verdict = await guard()({
    kind: "edit",
    locations: [{ path: paths.join(", ") }],
    rawInput: {},
  });
  for (const message of [INCIDENT, INCIDENT.replace("I will not read or modify any `.env*` file.", "")]) {
    const outcome = classifyWorkerOutcome({
      finalMessage: message,
      deniedToolCalls: [{ kind: "edit", reason: verdict.reason, denial: verdict.denial }],
      taskContext: { filesLikelyTouched: [...paths, "README.md"] },
    });
    assert.equal(outcome.kind, "recoverable_tool_denial");
    assert.equal(outcome.recoverable.code, "one_target_per_call");
  }
});

test("rc.11: real task refusal and refusal of a required path remain visible", () => {
  assert.equal(classifyWorkerOutcome({ finalMessage: "I refuse to implement this task." }).kind, "refusal");
  assert.equal(classifyWorkerOutcome({ finalMessage: "I will not complete this task." }).kind, "refusal");
  assert.equal(
    classifyWorkerOutcome({
      finalMessage: "I will not modify README.md.",
      taskContext: { filesLikelyTouched: ["README.md"] },
    }).kind,
    "refusal",
  );
});

test("rc.11: a genuinely blocked path is a deterministic policy denial, not retryable", async () => {
  const verdict = await guard()({
    kind: "edit",
    locations: [{ path: ".env.example" }],
    rawInput: {},
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.denial.code, "path_denylisted");
  assert.equal(verdict.denial.recovery, undefined);
  const outcome = classifyWorkerOutcome({
    finalMessage: "I will not modify .env.example because policy blocked it.",
    deniedToolCalls: [{ kind: "edit", reason: verdict.reason, denial: verdict.denial }],
    taskContext: { filesLikelyTouched: ["README.md"] },
  });
  assert.equal(outcome.kind, "policy_denial");
});
