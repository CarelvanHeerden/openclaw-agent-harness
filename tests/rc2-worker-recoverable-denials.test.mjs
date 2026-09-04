// rc.2 — a denied command is not a question for a human.
//
// Production, session 40f71a12-a3e5-4874-8e16-4f1cc8a0f037, sub-task "Add
// tenant-scoped SAST persistence". The Kimi/OpenCode worker tried to read an
// XLSX with an inline Python command. The bash guard denied it and said what to
// do instead: write a script file. The worker then ended its turn with
//
//   "Now let me check the workbook headers quickly, the tenant extension
//    mechanism, and package.json prisma scripts."
//
// and stopped. Nothing written, nothing committed. Verification failed, quite
// correctly -- and the harness then asked the operator:
//
//   "Sub-task N could not proceed. The worker's explanation: Now let me check
//    the workbook headers quickly... How should it proceed?"
//
// There is no answer to that. The recovery was already written in the denial
// the worker had just been handed, and the operator was being asked to
// adjudicate a command-syntax mistake.
//
// The classifier responsible was:
//
//   const looksLikeRefusal = NO_CHANGE_ONLY && !result.commitSha && text.length > 0;
//
// -- "the worker said something and did not commit". Meanwhile `WorkerResult`
// already carried `deniedToolCalls`, and nothing read it.
//
// These tests run the real orchestrator over a real git repo. The scripted
// workers really do get denied, really do narrate, and on recovery really do
// write and commit, so verification is answering questions about genuine git
// history rather than about a stub's return value.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";

import { runScenario, scenarioAvailable, mutateSubTask, IDENT } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

const outcome = await import("../dist/orchestrator/worker-outcome.js");
const {
  classifyWorkerOutcome,
  stripProgressNarration,
  isProgressFragment,
  recoverableDenialFrom,
  buildProtocolRetryHint,
  describeContractForRetry,
} = outcome;

// The exact strings from the incident. Every test below that claims to
// reproduce it uses these, not a paraphrase.
const NARRATION =
  "Now let me check the workbook headers quickly, the tenant extension mechanism, and package.json prisma scripts.";
const DENIAL_REASON = 'inline code via "python3 -c" is not permitted (write a script file instead)';
const DENIED_COMMAND = "python3 -c 'import openpyxl; print(openpyxl.load_workbook(\"sast.xlsx\").sheetnames)'";
const DENIAL = [{ kind: "execute", title: DENIED_COMMAND, reason: DENIAL_REASON }];

// ---------------------------------------------------------------------------
// The classifier, in isolation
// ---------------------------------------------------------------------------

test("rc2: the production narration is progress-only, not a refusal", () => {
  const o = classifyWorkerOutcome({ finalMessage: NARRATION, deniedToolCalls: DENIAL });
  assert.equal(o.kind, "recoverable_tool_denial");
  assert.equal(o.recoverable.category, "inline_code");
  assert.equal(o.recoverable.reason, DENIAL_REASON);
  // Nothing in that sentence is worth showing a human.
  assert.equal(o.explanation, undefined);
});

test("rc2: the same narration WITHOUT a denial record is still not a refusal", () => {
  // The Claude SDK backend does not populate deniedToolCalls. The sentence has
  // to stand on its own.
  const o = classifyWorkerOutcome({ finalMessage: NARRATION });
  assert.equal(o.kind, "progress_only");
  assert.equal(o.explanation, undefined);
});

test("rc2: progress narration is recognised in the forms the brief lists", () => {
  for (const s of [
    "Now let me check the workbook headers.",
    "Next I will inspect the schema.",
    "I'm going to check the tenant extension mechanism.",
    "First, let me read package.json.",
    "Let me look at the migration directory.",
    "Now I'll start on the Prisma schema.",
    "Here is what I plan to do:",
  ]) {
    assert.equal(isProgressFragment(s), true, `should be progress: ${s}`);
  }
});

test("rc2: reported results are NOT progress, however they open", () => {
  for (const s of [
    "I checked the workbook headers and they use camelCase.",
    "The Prisma schema and migration are created and committed.",
    "I could not find a tenant column in the existing schema.",
    "Committed 4f21a0c with the new model.",
  ]) {
    assert.equal(isProgressFragment(s), false, `should NOT be progress: ${s}`);
  }
});

test("rc2: a real finding survives the narration it is buried in", () => {
  const msg = "First, let me check the schema. The tenant column already exists on Finding. Now let me wire the migration.";
  assert.equal(stripProgressNarration(msg), "The tenant column already exists on Finding.");
});

test("rc2: an explicit refusal stays a refusal even after a recoverable denial", () => {
  const o = classifyWorkerOutcome({
    finalMessage: "I will not add tenant scoping this way: it would silently drop rows for existing tenants.",
    deniedToolCalls: DENIAL,
  });
  assert.equal(o.kind, "refusal");
  assert.match(o.explanation, /silently drop rows/);
});

test("rc2: a genuine blocker outranks a denial that happened on the way to it", () => {
  const o = classifyWorkerOutcome({
    finalMessage: "Now let me check the schema. The DATABASE_URL credential is not set in this worktree, so I cannot run the migration.",
    deniedToolCalls: DENIAL,
  });
  assert.equal(o.kind, "genuine_blocker");
  assert.equal(o.blockerKind, "missing_credential");
  // The narration is gone from what a human would be shown.
  assert.doesNotMatch(o.explanation, /Now let me/);
});

test("rc2: each human-decidable category the brief names is detected", () => {
  const cases = [
    ["The GITHUB_TOKEN credential is missing, so I cannot query the API.", "missing_credential"],
    ["I need you to decide whether existing rows get the default tenant.", "needs_human_input"],
    ["Dropping the findings table is destructive; please confirm before I proceed.", "needs_human_input"],
    ["This requires your approval because it rewrites published migrations.", "needs_approval"],
    ["The acceptance criteria conflict: one requires a nullable column, the other requires NOT NULL.", "incompatible_criteria"],
    ["The upstream registry is unreachable, so the dependency cannot be installed.", "external_resource_unavailable"],
  ];
  for (const [msg, kind] of cases) {
    const o = classifyWorkerOutcome({ finalMessage: msg });
    assert.equal(o.kind, "genuine_blocker", `expected a blocker for: ${msg}`);
    assert.equal(o.blockerKind, kind, `wrong blocker kind for: ${msg}`);
  }
});

test("rc2: a denial that names no alternative is NOT called recoverable", () => {
  // "command X not in whitelist" tells the worker what it may not do and
  // nothing about what it may. Inventing the remedy would be the same guessing
  // this module exists to stop.
  assert.equal(recoverableDenialFrom([{ reason: 'command "curl" not in whitelist' }]), undefined);
  assert.equal(recoverableDenialFrom([{ reason: "read path '.env' is denylisted" }]), undefined);
  assert.equal(recoverableDenialFrom([]), undefined);
  assert.equal(recoverableDenialFrom(undefined), undefined);
});

test("rc2: heredocs and git push carry their own remedies", () => {
  const h = recoverableDenialFrom([{ title: "python3 <<'EOF'\nprint(1)\nEOF", reason: 'denylisted token "<<"' }]);
  assert.equal(h.category, "heredoc");
  assert.match(h.remedy, /file-writing tool/);
  const p = recoverableDenialFrom([{ reason: "git push is not permitted for workers" }]);
  assert.equal(p.category, "git_push");
  assert.match(p.remedy, /harness pushes/);
});

test("rc2: the retry prompt quotes the denial and restates the contract", () => {
  const hint = buildProtocolRetryHint({
    outcome: classifyWorkerOutcome({ finalMessage: NARRATION, deniedToolCalls: DENIAL }),
    contractSummary: describeContractForRetry([
      { kind: "commit_made" },
      { kind: "file_committed", path: "prisma/schema.prisma" },
    ]),
    attempt: 2,
    maxAttempts: 3,
  });
  assert.match(hint, /DENIED/);
  assert.ok(hint.includes(DENIAL_REASON), "the guard's exact words, not a paraphrase");
  assert.match(hint, /script file/);
  assert.match(hint, /prisma\/schema\.prisma/);
  assert.match(hint, /a new commit exists/);
  assert.match(hint, /Do NOT end your turn with a description of what you intend to do/);
  assert.match(hint, /attempt 2 of 3/);
  // The three exits the brief requires it to offer.
  assert.match(hint, /complete and committed/);
  assert.match(hint, /blocker/);
  assert.match(hint, /refusing/);
});

// ---------------------------------------------------------------------------
// The run. Real orchestrator, real git.
// ---------------------------------------------------------------------------

/**
 * A worker that reproduces the incident on its first turn and then behaves the
 * way the brief says it should on the retry: script file, run it, real work,
 * real commit.
 */
function deniedThenRecovers({ world, turns, recoverOnTurn = 2 }) {
  return async ({ subTask, worktreePath, plan, dispatchHint }) => {
    const n = ++turns.count;
    turns.hints.push(dispatchHint ?? "");
    const wt = worktreePath ?? plan.worktreePath;

    if (n < recoverOnTurn) {
      // Denied, then narrates, then stops. No files, no commit.
      return {
        status: "completed",
        filesChanged: [],
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: NARRATION,
        deniedToolCalls: DENIAL,
      };
    }

    // The permitted route, in full: write a script, run it, DELETE it, then do
    // the work. The delete matters -- a temp file left behind is an
    // out-of-scope write, and b94's final scope check is right to object.
    const script = join(wt, "tmp-inspect.mjs");
    writeFileSync(script, "console.log('headers');\n");
    rmSync(script);
    const written = [];
    for (const rel of subTask.filesLikelyTouched ?? []) {
      const abs = join(wt, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `// recovered\nexport const ok = true;\n`);
      written.push(rel);
    }
    const commitSha = await world.adapter.commit(wt, `feat: ${subTask.title}`, IDENT);
    return {
      status: "completed",
      filesChanged: written,
      commitSha,
      commitShas: [commitSha],
      costUsd: 0.01,
      tokensIn: 1,
      tokensOut: 1,
      reason: "end_turn",
      finalMessage: "Wrote the Prisma schema and migration, ran generation, and committed them.",
    };
  };
}

test("rc2: the production failure is corrected in-harness and never reaches the operator", { skip }, async () => {
  const turns = { count: 0, hints: [] };
  let world;
  const s = await runScenario({
    subTasks: [mutateSubTask({ seq: 1, title: "Add tenant-scoped SAST persistence", path: "prisma/schema.prisma" })],
    worker: async (params, ctx) => {
      world ??= ctx.world;
      return deniedThenRecovers({ world: ctx.world, turns })(params);
    },
  });

  // The whole point: no human was asked anything.
  assert.notEqual(s.out.status, "awaiting_clarification", "a denied command must not pause the run");
  assert.equal(s.session().clarification_question ?? null, null, "no question was persisted");
  assert.equal(s.sawEvent("loop.clarification_requested"), false, "no clarification was requested");
  assert.equal(s.sawEvent("loop.worker_refusal"), false, "narration is not a refusal");

  // It was recognised for what it was, and retried.
  assert.equal(s.sawEvent("loop.worker_recoverable_tool_denial"), true);
  assert.equal(s.sawEvent("loop.worker_protocol_retry"), true);
  assert.equal(turns.count, 2, `expected one retry, got ${turns.count} turns`);

  // The retry carried the denial and the way out of it.
  const hint = turns.hints[1];
  assert.ok(hint.includes(DENIAL_REASON), `retry prompt must quote the denial, got: ${hint}`);
  assert.match(hint, /script file/);
  assert.match(hint, /prisma\/schema\.prisma/);
  assert.match(hint, /Do NOT end your turn with a description/);

  // And the work actually landed.
  assert.equal(s.out.status, "shipped", `expected the run to finish, got ${s.out.status}: ${s.out.reason ?? ""}`);
  assert.ok(s.subTaskRows().some((r) => r.status === "completed"), "the sub-task completed");
});

test("rc2: the denial audit event carries what a post-mortem needs", { skip }, async () => {
  const turns = { count: 0, hints: [] };
  const s = await runScenario({
    subTasks: [mutateSubTask({ seq: 1, title: "Add tenant-scoped SAST persistence", path: "prisma/schema.prisma" })],
    worker: async (params, ctx) => deniedThenRecovers({ world: ctx.world, turns })(params),
  });

  const denial = s.events("loop.worker_recoverable_tool_denial")[0]?.payload;
  assert.ok(denial, "the denial event fired");
  assert.equal(denial.seq, 1);
  assert.ok(denial.subTaskId, "sub-task id present");
  assert.equal(denial.category, "inline_code");
  assert.equal(denial.reason, DENIAL_REASON);
  assert.match(denial.deniedCommand, /python3 -c/);
  assert.equal(denial.hasCommit, false);
  assert.equal(denial.hasFiles, false);
  assert.deepEqual(denial.failedKinds.sort(), ["commit_made", "file_committed"]);

  const retry = s.events("loop.worker_protocol_retry")[0]?.payload;
  assert.equal(retry.outcome, "recoverable_tool_denial");
  assert.equal(retry.retryCount, 1);
  assert.equal(retry.maxAttempts, 3);
});

test("rc2: a worker that only ever narrates fails cleanly, and asks nothing", { skip }, async () => {
  const turns = { count: 0, hints: [] };
  const s = await runScenario({
    // One cycle: this run cannot succeed and there is no point re-planning it.
    configOver: { loop: { max_cycles: 1 } },
    subTasks: [mutateSubTask({ seq: 1, title: "Add tenant-scoped SAST persistence", path: "prisma/schema.prisma" })],
    worker: async ({ dispatchHint }) => {
      turns.count++;
      turns.hints.push(dispatchHint ?? "");
      return {
        status: "completed",
        filesChanged: [],
        costUsd: 0.01,
        tokensIn: 1,
        tokensOut: 1,
        reason: "end_turn",
        finalMessage: NARRATION,
        deniedToolCalls: DENIAL,
      };
    },
  });

  // Bounded: three total attempts by default, so two retries.
  assert.equal(turns.count, 3, `expected 3 attempts, got ${turns.count}`);
  assert.equal(s.sawEvent("loop.worker_retry_exhausted"), true);
  assert.equal(s.sawEvent("loop.clarification_requested"), false, "exhaustion is not a question");
  assert.notEqual(s.out.status, "awaiting_clarification");
  assert.equal(s.session().clarification_question ?? null, null);

  // The record left behind has to be actionable on its own.
  const ex = s.events("loop.worker_retry_exhausted")[0].payload;
  assert.equal(ex.retryCount, 2);
  assert.equal(ex.maxAttempts, 3);
  assert.equal(ex.category, "inline_code");
  assert.equal(ex.reason, DENIAL_REASON);
  assert.match(ex.deniedCommand, /python3 -c/);
  assert.ok(Array.isArray(ex.failedChecks) && ex.failedChecks.length > 0, "the failed checks are named");
  assert.match(ex.contract, /a new commit exists/);
  assert.equal(ex.finalOutcome, "failed_verification");

  const row = s.subTaskRows().find((r) => r.seq === 1);
  assert.match(row.summary, /retries exhausted/);
  assert.match(row.summary, /inline code via/);
  // Never described as a refusal, because it was not one.
  assert.doesNotMatch(row.summary, /refused/);
});

test("rc2: the retry limit is configurable, and 1 means do not retry", { skip }, async () => {
  const turns = { count: 0 };
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1, worker_protocol_max_attempts: 1 } },
    subTasks: [mutateSubTask({ seq: 1, title: "narrate forever", path: "src/a.ts" })],
    worker: async () => {
      turns.count++;
      // No denial record this time: bare narration, the way the Claude SDK
      // backend would report it.
      return {
        status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1,
        reason: "end_turn", finalMessage: NARRATION,
      };
    },
  });
  assert.equal(turns.count, 1, "no retry when the budget is one total attempt");
  // Still not a question, and still not called a refusal.
  assert.equal(s.sawEvent("loop.clarification_requested"), false);
  assert.equal(s.sawEvent("loop.worker_refusal"), false);
  assert.equal(s.sawEvent("loop.worker_noop_end_turn"), true, "the no-op is recorded even when it is not retried");
});

test("rc2: a genuine blocker still pauses for the human it needs", { skip }, async () => {
  const turns = { count: 0 };
  const s = await runScenario({
    subTasks: [mutateSubTask({ seq: 1, title: "Add tenant-scoped SAST persistence", path: "prisma/schema.prisma" })],
    worker: async () => {
      turns.count++;
      return {
        status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1,
        reason: "end_turn",
        finalMessage:
          "The DATABASE_URL credential is not available in this worktree, so the migration cannot be generated.",
      };
    },
  });

  assert.equal(s.out.status, "awaiting_clarification", `a real blocker must pause, got ${s.out.status}`);
  assert.equal(s.sawEvent("loop.worker_genuine_blocker"), true);
  assert.equal(turns.count, 1, "a blocker is not retried -- another turn cannot supply a credential");
  const blocker = s.events("loop.worker_genuine_blocker")[0].payload;
  assert.equal(blocker.blockerKind, "missing_credential");
  assert.equal(blocker.finalOutcome, "awaiting_clarification");
  assert.match(s.session().clarification_question, /DATABASE_URL/);
});

test("rc2: an explicit refusal is still surfaced, and still called a refusal", { skip }, async () => {
  const s = await runScenario({
    subTasks: [mutateSubTask({ seq: 1, title: "drop the findings table", path: "src/a.ts" })],
    worker: async () => ({
      status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1,
      reason: "end_turn",
      finalMessage: "I will not do this: dropping the findings table destroys tenant data with no migration path.",
    }),
  });
  assert.equal(s.out.status, "awaiting_clarification");
  assert.equal(s.sawEvent("loop.worker_refusal"), true, "a refusal is still a refusal");
  assert.equal(s.sawEvent("loop.worker_recoverable_tool_denial"), false);
  assert.match(s.session().clarification_question, /destroys tenant data/);
});

test("rc2: the question shown to a human never stitches progress fragments together", { skip }, async () => {
  const s = await runScenario({
    subTasks: [mutateSubTask({ seq: 1, title: "Add tenant-scoped SAST persistence", path: "prisma/schema.prisma" })],
    worker: async () => ({
      status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1,
      reason: "end_turn",
      finalMessage:
        "First, let me check the workbook headers. Now let me look at the tenant extension mechanism. " +
        "I need you to decide whether existing findings are backfilled with the default tenant. " +
        "Next I will inspect package.json.",
    }),
  });

  assert.equal(s.out.status, "awaiting_clarification");
  const q = s.session().clarification_question;
  // The one sentence that is a question for a human, and none of the three
  // that are not.
  assert.match(q, /decide whether existing findings are backfilled/);
  assert.doesNotMatch(q, /let me check the workbook/);
  assert.doesNotMatch(q, /Now let me look/);
  assert.doesNotMatch(q, /Next I will inspect/);
});

test("rc2: work done before a denial survives into the retry", { skip }, async () => {
  const turns = { count: 0, hints: [] };
  let seenOnRetry = null;
  const s = await runScenario({
    subTasks: [mutateSubTask({ seq: 1, title: "Add tenant-scoped SAST persistence", path: "prisma/schema.prisma" })],
    worker: async ({ subTask, worktreePath, plan, dispatchHint }, ctx) => {
      const n = ++turns.count;
      turns.hints.push(dispatchHint ?? "");
      const wt = worktreePath ?? plan.worktreePath;

      const target = join(wt, "prisma/schema.prisma");

      if (n === 1) {
        // Partial work: half the schema really written to disk and left
        // uncommitted, then the denial, then a narrated stop.
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "// partial: model started\n");
        return {
          status: "completed", filesChanged: [], uncommittedFiles: ["prisma/schema.prisma"],
          costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn",
          finalMessage: NARRATION, deniedToolCalls: DENIAL,
        };
      }

      // The retry must land in the SAME worktree, with the partial file intact.
      seenOnRetry = existsSync(target) && readFileSync(target, "utf8").includes("partial: model started");
      writeFileSync(target, "// partial: model started\nmodel Finding { tenantId String }\n");
      const sha = await ctx.world.adapter.commit(wt, "feat: tenant scoping", IDENT);
      return {
        status: "completed", filesChanged: ["prisma/schema.prisma"],
        commitSha: sha, commitShas: [sha],
        costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn",
        finalMessage: "Created the schema and committed it.",
      };
    },
  });

  assert.equal(seenOnRetry, true, "the partial work is still on disk when the retry starts");
  // The retry prompt tells it what Git can see, so it does not redo the work.
  assert.match(turns.hints[1], /prisma\/schema\.prisma is written but uncommitted|written but uncommitted/);
  assert.equal(s.out.status, "shipped", `${s.out.status}: ${s.out.reason ?? ""}`);
});

test("rc2: an unexplained no-op still pauses the way b55 intended", { skip }, async () => {
  // Guard against over-reach. rc.2 diverts denials and unfinished sentences
  // away from the operator; it must not quietly convert every unverifiable
  // completion claim into a hard failure.
  const s = await runScenario({
    worker: async () => ({
      status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1,
      reason: "end_turn", finalMessage: "I have completed the work.",
    }),
  });
  assert.equal(s.out.status, "awaiting_clarification", `expected the b55 pause, got ${s.out.status}`);
});
