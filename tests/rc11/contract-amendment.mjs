import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  closeActiveDeadline,
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

test("rc.11 installation hold: an existing prohibition is preserved byte-for-byte", () => {
  const originalPlan = plan();
  const restriction = "Do not read, create or modify .env.example.";
  originalPlan.subTasks[0].successCriteria.push(restriction);
  const out = buildArtifactSubstitutionAmendment({
    plan: originalPlan,
    task: originalPlan.subTasks[0],
    answer:
      "Replace .env.example with README.md and CLIENT-OFFBOARDING-AGENT.md instead. " +
      "Preserve everything else. Do not read, create or modify .env.example.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, true, out.reason);
  const activated = activateTaskAmendment(originalPlan, out.amendment);
  assert.equal(activated.subTasks[0].successCriteria.at(-1), restriction);
  assert.ok(activated.subTasks[0].filesLikelyTouched.includes("README.md"));
});

test("rc.11 installation hold: a negated substitution is not authorization", () => {
  const p = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer: "Do not replace .env.example with README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /affirmatively authorize/);
});

test("rc.11: negative and historical path mentions cannot become replacement outputs", () => {
  const p = plan();
  const historical = "The previous plan said replace .env.example with README.md.";
  p.subTasks[0].successCriteria.push(historical);
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      "The previous proposal said replace .env.example with README.md. " +
      "Do not use README.md. Replace .env.example with CLIENT-OFFBOARDING-AGENT.md instead.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.amendment.substitution.newPaths, ["CLIENT-OFFBOARDING-AGENT.md"]);
  assert.equal(out.amendment.revisedTask.successCriteria.at(-1), historical);
});

test("rc.11: mixed positive and negative clauses preserve the restriction and apply only the affirmative relation", () => {
  const p = plan();
  p.subTasks[0].workerContext.changeSpec +=
    " Do not read .env.example; update .env.example with placeholders.";
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      "Do not replace .env.example with README.md; replace .env.example with CLIENT-OFFBOARDING-AGENT.md instead.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.amendment.substitution.newPaths, ["CLIENT-OFFBOARDING-AGENT.md"]);
  assert.match(out.amendment.revisedTask.workerContext.changeSpec, /Do not read \.env\.example/);
  assert.match(out.amendment.revisedTask.workerContext.changeSpec, /update CLIENT-OFFBOARDING-AGENT\.md/);
});

test("rc.11 corrected-candidate review: later withdrawal prevents automatic amendment", () => {
  const p = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      "Replace .env.example with README.md. Actually, do not replace .env.example. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /withdraws|prohibits/);
});

test("rc.11 corrected-candidate review: future approval is not current authorization", () => {
  const p = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer: "If I approve later, replace .env.example with README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /conditional|future approval/);
});

test("rc.11 corrected-candidate review: a prohibited replacement document cannot become required output", () => {
  const p = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      "Replace .env.example with README.md. Do not read or modify README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /prohibits required access/);
});

test("rc.11 corrected-candidate review: excluding one destination preserves a different affirmative destination", () => {
  const p = plan();
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      "Do not replace .env.example with README.md. " +
      "Replace .env.example with CLIENT-OFFBOARDING-AGENT.md instead. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(out.amendment.substitution.newPaths, ["CLIENT-OFFBOARDING-AGENT.md"]);
  assert.match(out.amendment.revisedTask.workerContext.gotchas.join("\n"), /Do not replace.*README\.md/);
});

test("rc.11 whole-answer review: global approval and proposal-only gates veto automatic activation", () => {
  for (const answer of [
    "Replace .env.example with README.md. Do not read credentials.json. Do not proceed until I approve. Preserve everything else.",
    "Replace .env.example with README.md. This is a proposal only; do not execute it. Preserve everything else.",
    "Replace .env.example with README.md. Keep the session paused. Preserve everything else.",
    "Replace .env.example with README.md, but keep the session paused. Preserve everything else.",
    "Replace .env.example with README.md; however keep the session paused. Preserve everything else.",
    "Replace .env.example with README.md.\nKeep the session paused.\nPreserve everything else.",
    "Replace .env.example with README.md;\nwait for my confirmation before applying it.\nPreserve everything else.",
  ]) {
    const p = plan();
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, answer);
    assert.ok(out.proposedDiff, "global gate must route to exact-diff confirmation");
    const proposal = JSON.parse(out.proposedDiff);
    assert.equal(
      proposal.proposalHash,
      createHash("sha256").update(JSON.stringify(proposal.completeAmendment)).digest("hex"),
      "confirmation integrity covers the complete amendment, not only the revised task",
    );
  }
});

test("rc.11 whole-answer review: unclassified instructions request restatement and offer no unusable confirmation", () => {
  for (const instruction of [
    "Ask the compliance committee what they think.",
    "Preserve the option to cancel later.",
    "Finish only after another review.",
  ]) {
    const p = plan();
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer: `Replace .env.example with README.md. ${instruction} Preserve everything else.`,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, instruction);
    assert.match(out.reason, /outside the bounded/, instruction);
    assert.equal(out.proposedDiff, undefined, instruction);
  }
  const p = plan();
  const compound = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      "Replace .env.example with README.md, but ask the compliance committee what they think. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(compound.ok, false);
  assert.match(compound.reason, /outside the bounded/);
  assert.equal(compound.proposedDiff, undefined);
});

test("rc.11 whole-clause review: affirmative syntax cannot consume an attached unsupported instruction", () => {
  const cases = [
    "Replace .env.example with README.md. Finish only after another review. Preserve everything else.",
    "Replace .env.example with README.md, and finish only after another review. Preserve everything else.",
    "Replace .env.example with README.md. Ask the compliance committee what they think. Preserve everything else.",
    "Replace .env.example with README.md, and ask the compliance committee what they think. Preserve everything else.",
    "Replace .env.example with README.md, and delete all tests. Preserve everything else.",
    "Replace .env.example after another review with README.md. Preserve everything else.",
  ];
  for (const answer of cases) {
    const p = plan();
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, answer);
    assert.match(out.reason, /outside the bounded/, answer);
  }

  const p = plan();
  const positive = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer: "Replace .env.example with README.md and CLIENT-OFFBOARDING-AGENT.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(positive.ok, true, positive.reason);
  assert.deepEqual(positive.amendment.substitution.newPaths, ["README.md", "CLIENT-OFFBOARDING-AGENT.md"]);
});

test("rc.11 whole-clause review: attached approval holds require complete-proposal confirmation", () => {
  for (const answer of [
    "Replace .env.example with README.md. Await my approval. Preserve everything else.",
    "Replace .env.example with README.md, and await my approval. Preserve everything else.",
  ]) {
    const p = plan();
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, answer);
    assert.match(out.reason, /withholds execution|approval/);
    assert.ok(out.proposedDiff, answer);
  }
});

test("rc.11 documentation review: only parsed destination operands become replacement outputs", () => {
  const p = plan();
  const valid = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      "Replace .env.example with README.md. Document placeholders in README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(valid.ok, true, valid.reason);
  assert.deepEqual(valid.amendment.substitution.newPaths, ["README.md"]);

  for (const answer of [
    "Replace .env.example with README.md. Document why private-notes.md is out of scope in README.md. Preserve everything else.",
    "Replace .env.example with README.md. Document placeholders in README.md, and finish only after another review in REVIEW.md. Preserve everything else.",
  ]) {
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, answer);
    assert.match(out.reason, /outside the bounded/, answer);
  }

  const builtSource = readFileSync(
    new URL("../../dist/orchestrator/contract-amendment.js", import.meta.url),
    "utf8",
  );
  assert.match(builtSource, /const candidates = parsedAnswer\.destinationPaths;/);
  assert.doesNotMatch(builtSource, /pathTokens\(affirmative\.join/);
});

test("rc.12 pre-smoke: contradictory substitutions and unrelated documentation fail closed", () => {
  const p = plan();
  for (const answer of [
    "Replace .env.example with README.md. Actually, replace .env.example with NOTES.md. Preserve everything else.",
    "Replace .env.example with README.md. Document placeholders in NOTES.md. Preserve everything else.",
    "Replace .env.example with README.md and .environment.md. Preserve everything else.",
    "Replace .env.example with README.md and .env-notes.md. Preserve everything else.",
  ]) {
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, answer);
  }

  const inherited = plan();
  inherited.subTasks[0].successCriteria.push("Do not read or modify README.md.");
  const prohibited = buildArtifactSubstitutionAmendment({
    plan: inherited,
    task: inherited.subTasks[0],
    answer: "Replace .env.example with README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(prohibited.ok, false);
  assert.match(prohibited.reason, /stored task already prohibits/);

  const labelOnly = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer: "Replace the environment example with README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(labelOnly.ok, false);
  assert.match(labelOnly.reason, /does not name the blocked artifact/);
});

test("rc.12 pre-smoke: every worker-visible task field is rewritten or rejected", () => {
  const p = plan();
  p.subTasks[0].title = "Update .env.example safely";
  p.subTasks[0].workerContext.rationale = "We must modify .env.example without exposing secrets.";
  p.subTasks[0].workerContext.gotchas = [
    "Write .env.example last.",
    "Do not read .env.example.",
  ];
  p.subTasks[0].workerContext.relatedSymbols = ["Environment template: .env.example"];
  const out = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer: "Replace .env.example with README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(out.ok, true, out.reason);
  const revised = out.amendment.revisedTask;
  assert.match(revised.title, /README\.md/);
  assert.match(revised.workerContext.rationale, /README\.md/);
  assert.match(revised.workerContext.gotchas[0], /README\.md/);
  assert.match(revised.workerContext.gotchas[1], /Do not read \.env\.example/);
  assert.match(revised.workerContext.relatedSymbols[0], /README\.md/);

  const unsafeEvidence = plan();
  unsafeEvidence.subTasks[0].workerContext.codeExcerpts = [{
    path: ".env.example",
    startLine: 1,
    snippet: "SECRET_PLACEHOLDER=",
  }];
  const rejected = buildArtifactSubstitutionAmendment({
    plan: unsafeEvidence,
    task: unsafeEvidence.subTasks[0],
    answer: "Replace .env.example with README.md. Preserve everything else.",
    blockedPaths: [".env.example"],
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /obsolete artifact remains/);
});

test("rc.11 provenance review: quoted history ends before current instructions", () => {
  const p = plan();
  for (const answer of [
    'Replace .env.example with README.md. The previous plan said "update .env.example", but finish only after another review. Preserve everything else.',
    "Replace .env.example with README.md. The previous plan said update .env.example, but finish only after another review. Preserve everything else.",
    'Replace .env.example with README.md. The previous plan said "update .env.example, but finish only after another review. Preserve everything else.',
  ]) {
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, false, answer);
    assert.match(out.reason, /outside the bounded/, answer);
  }

  const restricted = buildArtifactSubstitutionAmendment({
    plan: p,
    task: p.subTasks[0],
    answer:
      'Replace .env.example with README.md. The previous plan said "update .env.example", but never read secrets.txt. Preserve everything else.',
    blockedPaths: [".env.example"],
  });
  assert.equal(restricted.ok, true, restricted.reason);
  assert.match(restricted.amendment.revisedTask.workerContext.gotchas.join("\n"), /never read secrets\.txt/i);

  for (const answer of [
    'Replace .env.example with README.md. The previous plan said "do not proceed until I approve". Preserve everything else.',
    'Replace .env.example with README.md. The previous plan said "if approved later, replace .env.example with README.md". Preserve everything else.',
    'Replace .env.example with README.md. The previous plan said "update .env.example. Then wait for review". Preserve everything else.',
    "Replace .env.example with README.md. The previous proposal said replace .env.example with README.md. Preserve everything else.",
  ]) {
    const out = buildArtifactSubstitutionAmendment({
      plan: p,
      task: p.subTasks[0],
      answer,
      blockedPaths: [".env.example"],
    });
    assert.equal(out.ok, true, answer);
  }
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

test("rc.11: CI packs, installs, compares and uploads one exact release artifact", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const verifier = readFileSync(new URL("../../scripts/verify-installed-artifact.mjs", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(workflow, /Pack the tested release artifact/);
  assert.match(workflow, /verify-installed-artifact\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(packageJson.scripts.smoke, /--import \.\/scripts\/register-smoke-loader\.mjs/);
  assert.equal(packageJson.openclaw.compat.minGatewayVersion, "2026.6.1");
  assert.equal(packageJson.openclaw.build.openclawVersion, "2026.6.1");
  assert.match(verifier, /filesUnder\(installedRoot, "\."\)/);
  assert.match(verifier, /resolveOpenCodeBinary/);
  assert.match(verifier, /spawnSync\(openCode\.command, \["--version"\]/);
  assert.match(readme, /test:no-build.*is \*\*not\*\*/s);
  assert.match(readme, /openclaw-agent-harness-verify-artifact/);
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

test("rc.11: terminal clock closure does not invent a human pause", () => {
  const db = deadlineDb();
  resumeActiveDeadline(db, "S", 18000, 10_000);
  const closed = closeActiveDeadline(db, "S", 20_000);
  assert.equal(closed.elapsedMs, 10_000);
  assert.equal(closed.pausedAt, null);
  const row = db.prepare(`SELECT human_pause_started_at,active_segment_started_at FROM sessions WHERE id='S'`).get();
  assert.equal(row.human_pause_started_at, null);
  assert.equal(row.active_segment_started_at, null);
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
            clarification_subtask=?, human_pause_started_at=1000, active_limit_ms=18000000, cycles_ran=4
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
  let answerFactory;
  registerHarnessTools(
    {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerTool(def) {
        if (def.name === "harness_answer") answerFactory = def;
        tools.set(def.name, { ...def, execute: (input) => def.execute("call", input) });
        return () => {};
      },
    },
    runtime,
  );

  assert.equal(typeof answerFactory, "function", "harness_answer is registered as a contextual tool factory");
  const spoofed = await answerFactory({ requesterSenderId: "U2", senderIsOwner: true }).execute("call", {
    sessionId: "S",
    answer: ANSWER,
    invokedBy: "U1",
    answeredBy: "human",
    clarificationSeq: 3,
    clarificationId: "Q1",
  });
  assert.equal(spoofed.details.trustedRequesterRequired, true);
  const missingProvenance = await answerFactory({ requesterSenderId: "U1", senderIsOwner: false }).execute("call", {
    sessionId: "S",
    answer: ANSWER,
    invokedBy: "U1",
    clarificationSeq: 3,
    clarificationId: "Q1",
  });
  assert.equal(missingProvenance.details.missingAnswerProvenance, true);

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
  const amendment = db.prepare(
    `SELECT status,authorised_by,cycle FROM task_contract_amendments WHERE session_id='S'`,
  ).get();
  assert.equal(amendment.status, "active");
  assert.equal(amendment.authorised_by, "U1");
  assert.equal(amendment.cycle, 4);
  assert.ok(audits.some((entry) => entry.event === "tool.answer_contract_amendment_activated"));

  const duplicate = await tools.get("harness_answer").execute({
    sessionId: "S",
    answer: ANSWER,
    invokedBy: "U1",
    clarificationSeq: 3,
    clarificationId: "Q1",
  });
  assert.equal(duplicate.details.idempotent, true);
  assert.equal(resumed, 1, "duplicate delivery must not start a second loop");

  const conflict = await tools.get("harness_answer").execute({
    sessionId: "S",
    answer: `${ANSWER} Also remove the tests.`,
    invokedBy: "U1",
    clarificationSeq: 3,
    clarificationId: "Q1",
  });
  assert.equal(conflict.details.amendmentAnswerConflict, true);
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

test("rc.11: withdrawn, conditional, or contradictory answers remain paused with no activation or dispatch", async () => {
  const answers = [
    "Replace .env.example with README.md. Actually, do not replace .env.example. Preserve everything else.",
    "If I approve later, replace .env.example with README.md. Preserve everything else.",
    "Replace .env.example with README.md. Do not read or modify README.md. Preserve everything else.",
    "Replace .env.example with README.md. Do not read credentials.json. Do not proceed until I approve. Preserve everything else.",
    "Replace .env.example with README.md. This is a proposal only; do not execute it. Preserve everything else.",
    "Replace .env.example with README.md. Keep the session paused. Preserve everything else.",
    "Replace .env.example with README.md, and await my approval. Preserve everything else.",
    "Replace .env.example with README.md, and finish only after another review. Preserve everything else.",
    "Replace .env.example with README.md, and ask the compliance committee what they think. Preserve everything else.",
    "Replace .env.example with README.md. Document why private-notes.md is out of scope in README.md. Preserve everything else.",
    "Replace .env.example with README.md. Document placeholders in README.md, and finish only after another review in REVIEW.md. Preserve everything else.",
    'Replace .env.example with README.md. The previous plan said "update .env.example", but finish only after another review. Preserve everything else.',
    "Replace the environment example with README.md. Preserve everything else.",
  ];
  for (const [index, candidateAnswer] of answers.entries()) {
    const db = deadlineDb();
    const p = plan();
    db.prepare(
      `UPDATE sessions
          SET status='awaiting_clarification', crystallised_prompt=?, lead_plan_json=?,
              clarification_question='blocked path', clarification_seq=3, clarification_id=?,
              clarification_subtask=?, human_pause_started_at=1000, active_limit_ms=18000000
        WHERE id='S'`,
    ).run(
      JSON.stringify({ title: "t", motivation: "m", acceptanceCriteria: [] }),
      JSON.stringify(p),
      `Q-${index}`,
      JSON.stringify({
        title: p.subTasks[0].title,
        intent: p.subTasks[0].intent,
        task: p.subTasks[0],
        policyConflicts: [{ path: ".env.example", rule: ".env.*" }],
      }),
    );
    const state = {
      db,
      isOpen: () => true,
      audit(event, payload, sessionId) {
        db.prepare(`INSERT INTO audit_log (session_id,event,payload,created_at) VALUES (?,?,?,?)`)
          .run(sessionId ?? null, event, JSON.stringify(payload ?? {}), Date.now());
      },
    };
    let dispatches = 0;
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
          storage: { worktree_root: "/tmp/unused" },
        },
        loop: { run: async () => { dispatches += 1; return { status: "failed" }; } },
      },
    );
    const result = await tools.get("harness_answer").execute({
      sessionId: "S",
      answer: candidateAnswer,
      invokedBy: "U1",
      clarificationSeq: 3,
      clarificationId: `Q-${index}`,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.details.ok, false, candidateAnswer);
    assert.equal(dispatches, 0, candidateAnswer);
    assert.equal(db.prepare(`SELECT status FROM sessions WHERE id='S'`).get().status, "awaiting_clarification");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM task_contract_amendments WHERE status='active'`).get().n, 0);
    const clock = db.prepare(
      `SELECT active_segment_started_at,human_pause_started_at FROM sessions WHERE id='S'`,
    ).get();
    assert.equal(clock.active_segment_started_at, null, "rejected amendment closes its active-time segment");
    assert.ok(clock.human_pause_started_at !== null, "rejected amendment re-enters an explicit human pause");
    if (candidateAnswer.includes("Do not proceed until I approve")) {
      const question = db.prepare(`SELECT clarification_question FROM sessions WHERE id='S'`).get().clarification_question;
      const jsonAt = question.indexOf("\n{");
      assert.ok(jsonAt > 0, "the complete proposal is displayed as JSON");
      const displayed = JSON.parse(question.slice(jsonAt + 1));
      assert.ok(displayed.completeAmendment, "the displayed proposal includes the complete stored amendment");
      assert.equal(
        displayed.proposalHash,
        createHash("sha256").update(JSON.stringify(displayed.completeAmendment)).digest("hex"),
      );
      const confirmation = await tools.get("harness_answer").execute({
        sessionId: "S",
        answer: "Confirm the proposed diff",
        invokedBy: "U1",
        clarificationSeq: 3,
        clarificationId: result.details.clarificationId,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(confirmation.details.ok, true);
      assert.equal(dispatches, 1, "explicit confirmation of the displayed diff activates exactly once");
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM task_contract_amendments WHERE status='active'`).get().n, 1);
      const revised = JSON.parse(db.prepare(`SELECT lead_plan_json FROM sessions WHERE id='S'`).get().lead_plan_json)
        .subTasks[0];
      assert.match(
        revised.workerContext.gotchas.join("\n"),
        /Do not read credentials\.json/,
        "confirmation must activate the complete stored task, including independent restrictions",
      );
    }
  }
});
