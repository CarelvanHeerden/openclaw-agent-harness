/**
 * rc.6 fix #1 — the approval gate stops guessing, and stops starting anyway.
 *
 * THE INCIDENT (StitchGuard PR #1184, compliance calendar). The pre-spend gate
 * invited the operator to name a cap in his reply. He replied:
 *
 *     Confirm, $60, 10 hours
 *
 * Neither clause carried a cue word, so `parseConfirmationReply` matched
 * neither, returned `approves: false`, and the caller did the one thing it knew
 * how to do with a non-approval: filed the WHOLE STRING as an authoritative
 * acceptance criterion of the feature -- "$60, 10 hours" became a stated
 * requirement of a compliance calendar -- and started the run at the $50 and
 * five hours nobody had asked for.
 *
 * Three hours and $53.81 later the run found four red CI jobs and declined the
 * repair cycle that would have fixed them, because $53.81 was over the $50 it
 * had never been told to raise. The operator had authorised $60. The money to
 * finish was approved, understood by the human, and invisible to the machine.
 *
 * So this file pins three things:
 *
 *   1. the shorthand parses (and the trap forms around it still do not),
 *   2. a control that CANNOT be read stops the run instead of becoming spec,
 *   3. what the operator is told afterwards comes from the persisted row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let confirm, registerHarnessTools, Database;
try {
  confirm = await import("../dist/tools/brief-confirmation.js");
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  confirm = null;
}
const skip = confirm === null ? "dist/ not built" : false;
const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. The reply that started it
// ---------------------------------------------------------------------------

test("rc6: the exact #1184 reply is read as an approval carrying both limits", { skip }, () => {
  const r = confirm.parseConfirmationReply("Confirm, $60, 10 hours");
  assert.equal(r.budgetUsd, 60, "the $60 the operator authorised must reach the session");
  assert.equal(r.timeoutSeconds, 10 * 3600);
  assert.equal(r.approves, true, "filing this as a spec correction is the #1184 defect");
  assert.deepEqual(r.ambiguities, [], "nothing here is ambiguous; both clauses were read");
  assert.doesNotMatch(r.remainder, /\$60|10 hours/, "no part of it may reach the acceptance criteria");
});

test("rc6: the shorthand is read in any order, case, or separator", { skip }, () => {
  for (const reply of [
    "Confirm, $60, 10 hours",
    "confirm $60 10h",
    "CONFIRM, 10 HOURS, $60",
    "yes — $60, 10 hrs, please",
    "Confirm, $60 budget, 10 hours",
  ]) {
    const r = confirm.parseConfirmationReply(reply);
    assert.equal(r.budgetUsd, 60, `budget in: ${reply}`);
    assert.equal(r.timeoutSeconds, 36000, `clock in: ${reply}`);
    assert.equal(r.approves, true, `approval in: ${reply}`);
    assert.deepEqual(r.ambiguities, [], `unambiguous: ${reply}`);
  }
});

test("rc6: the cue may follow the number as easily as precede it", { skip }, () => {
  // The report's "a 10 hour budget" case: b123 read cue-then-number only, so
  // the money landed and the hours were dropped from the same sentence.
  const r = confirm.parseConfirmationReply("Confirm, Budget $50 with a 10 hour budget");
  assert.equal(r.budgetUsd, 50);
  assert.equal(r.timeoutSeconds, 36000);
  assert.equal(r.approves, true);
});

test("rc6: 'budget of 10 hours' is a clock, never a $10 cap", { skip }, () => {
  // The b123 comment names this trap from the other direction: `\bbudget\b`
  // followed by a number is exactly the money shape, and the unit is the only
  // thing that says otherwise.
  const r = confirm.parseConfirmationReply("confirm, budget of 10 hours");
  assert.equal(r.timeoutSeconds, 36000);
  assert.equal(r.budgetUsd, undefined, "capping this run at $10 would be worse than reading nothing");
});

// ---------------------------------------------------------------------------
// 2. The gate that keeps shorthand from eating the feature
// ---------------------------------------------------------------------------

test("rc6: a bare amount inside a real correction stays part of the correction", { skip }, () => {
  // This is the whole licence for reading bare numbers: there must be no
  // feature text for them to belong to. Where there is, they belong to it.
  for (const reply of [
    "confirm, but the price threshold should be $60",
    "confirm, add a 5 minute cache TTL",
    "confirm, but the reminder window should be 24 hours before the due date",
    "confirm, retries should be 3 with a 10 second backoff",
    "no, the export must include the $ amount column",
  ]) {
    const r = confirm.parseConfirmationReply(reply);
    assert.equal(r.budgetUsd, undefined, `no cap in: ${reply}`);
    assert.equal(r.timeoutSeconds, undefined, `no clock in: ${reply}`);
    assert.deepEqual(r.ambiguities, [], `not a control at all: ${reply}`);
    assert.equal(r.approves, false, `still a correction: ${reply}`);
    assert.equal(r.remainder, reply, "the operator's words must reach the brief intact");
  }
});

test("rc6: the b123 corrections are untouched by the widened parser", { skip }, () => {
  for (const reply of [
    "confirm but set the retry limit to 3",
    "confirm, but the deadline field must be performedAt not scheduledAt",
    "no -- use performedAt, and only 3 statuses",
  ]) {
    const r = confirm.parseConfirmationReply(reply);
    assert.equal(r.budgetUsd, undefined);
    assert.equal(r.timeoutSeconds, undefined);
    assert.deepEqual(r.ambiguities, [], `a correction is not an ambiguous control: ${reply}`);
    assert.equal(r.remainder, reply);
  }
});

// ---------------------------------------------------------------------------
// 3. Fail closed: named a control, produced no number
// ---------------------------------------------------------------------------

test("rc6: an unusable limit is refused rather than silently defaulted", { skip }, () => {
  const cases = [
    ["confirm, time budget of 0 hours", "timeout"],
    ["confirm, time budget of 400 hours", "timeout"],
    ["confirm, budget $0", "budget"],
    ["confirm, budget -$50", "budget"],
    ["confirm, budget of 0", "budget"],
  ];
  for (const [reply, control] of cases) {
    const r = confirm.parseConfirmationReply(reply);
    assert.ok(r.ambiguities.length > 0, `must not be actionable: ${reply}`);
    assert.equal(r.ambiguities[0].control, control, `about the right control: ${reply}`);
    assert.equal(
      control === "budget" ? r.budgetUsd : r.timeoutSeconds,
      undefined,
      `and no value may be invented from it: ${reply}`,
    );
  }
});

test("rc6: two different values for one control is an ambiguity, not a race", { skip }, () => {
  const r = confirm.parseConfirmationReply("confirm, budget $40 and cap $60");
  assert.ok(r.ambiguities.length > 0, "picking one of them is guessing");
  assert.equal(r.ambiguities[0].control, "budget");
});

test("rc6: the re-ask quotes the operator's own words and asks for one thing", { skip }, () => {
  const text = confirm.describeControlAmbiguities(
    confirm.parseConfirmationReply("confirm, time budget of 400 hours").ambiguities,
  );
  assert.match(text, /have not started the run/i, "the headline fact is that nothing is spending");
  assert.match(text, /400 hours/, "their words, not a paraphrase");
  assert.match(text, /confirm/, "and a way out that does not require reading the source");
});

// ---------------------------------------------------------------------------
// 4. The caller: an unreadable control must not spend
// ---------------------------------------------------------------------------

function makeRuntime({ riskLevel = "high", sessionDefaultUsd = 50, hardCeilingUsd } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const loopCalls = [];
  return {
    state: {
      db,
      isOpen: () => true,
      audit(event, payload, sessionId) { audits.push({ event, payload, sessionId }); },
      close() {},
    },
    audits,
    loopCalls,
    loop: { run: async (sessionId, brief) => { loopCalls.push({ sessionId, brief }); return { status: "shipped" }; } },
    crystallise: async () => ({
      kind: "brief",
      costUsd: 0,
      brief: {
        title: "Compliance calendar",
        motivation: "m",
        acceptanceCriteria: ["recurrence identities are stable across edits"],
        filesLikelyTouched: [],
        outOfScope: [],
        riskLevel,
      },
    }),
    anthropicApiKey: async () => "sk-test",
    githubServiceFor: () => "github-o",
    githubToken: async () => "gh",
    gitResolutionFor: () => ({ credentialService: "github-o", provider: "github", apiBase: "https://api.github.com", apiKeyEnv: "GH_TOKEN" }),
    gitToken: async () => "gh",
    budget: { getDailySpend: () => 0 },
    config: {
      storage: { audit_retention_days: 90 },
      slack: { listener_enabled: false, channel: "C1", authorised_users: ["U1"] },
      repos: { allowed: ["o/*"] },
      models: { lead: "l", worker: "w", adversary: "a", classifier: "c", auth: { credential_service: "anthropic-x" } },
      pat_routing: { overrides: {}, commit_identity: {}, default_service_pattern: "github-{owner}", auth: { api_key_env: "GH_TOKEN" } },
      budgets: { session_default_usd: sessionDefaultUsd, ...(hardCeilingUsd ? { session_hard_ceiling_usd: hardCeilingUsd } : {}) },
      loop: { session_hard_timeout_seconds: 18000 },
    },
  };
}

function collectTools() {
  const tools = new Map();
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: (def) => {
      tools.set(def.name, { ...def, execute: (input) => def.execute("test-call-id", input) });
      return () => tools.delete(def.name);
    },
  };
  return { api, tools };
}

async function pausedSession(runtime) {
  const { api, tools } = collectTools();
  registerHarnessTools(api, runtime);
  const r = await tools.get("harness_run").execute({ requester: "U1", request: "build a tenant-safe compliance calendar" });
  assert.equal(r.details.awaitingConfirmation, true, "the gate must be the thing under test");
  return { tools, sessionId: r.details.sessionId };
}

test("rc6: an unreadable control spends nothing and leaves the gate open", { skip }, async () => {
  const runtime = makeRuntime();
  const { tools, sessionId } = await pausedSession(runtime);
  const a = await tools.get("harness_answer").execute({
    sessionId, answer: "confirm, time budget of 400 hours", invokedBy: "U1",
  });

  assert.equal(a.details.started, false);
  assert.equal(a.details.controlAmbiguous, true);
  assert.equal(runtime.loopCalls.length, 0, "not one dollar may be spent on a limit we could not read");

  const row = runtime.state.db.prepare(
    "SELECT status, clarification_subtask, clarification_question FROM sessions WHERE id = ?",
  ).get(sessionId);
  assert.equal(row.status, "awaiting_clarification", "the session must stay answerable");
  assert.ok(
    confirm.isBriefConfirmationPause(row.clarification_subtask),
    "and stay on THIS gate, so the corrected reply lands back in the same branch",
  );
  assert.match(row.clarification_question, /400 hours/);
  assert.ok(runtime.audits.some((x) => x.event === "tool.answer_brief_control_ambiguous"));
});

test("rc6: the unparsed control never becomes an acceptance criterion", { skip }, async () => {
  // The precise #1184 corruption: "$60, 10 hours" was written into the brief as
  // an authoritative product requirement, superseding anything contradicting it.
  const runtime = makeRuntime();
  const { tools, sessionId } = await pausedSession(runtime);
  await tools.get("harness_answer").execute({ sessionId, answer: "confirm, budget -$50", invokedBy: "U1" });

  const row = runtime.state.db.prepare("SELECT crystallised_prompt FROM sessions WHERE id = ?").get(sessionId);
  const brief = JSON.parse(row.crystallised_prompt);
  assert.equal(brief.acceptanceCriteria.length, 1, "the brief must be exactly as the crystalliser left it");
  assert.doesNotMatch(JSON.stringify(brief), /-\$50|OPERATOR CORRECTION/);
});

test("rc6: correcting the reply then starts the run under the stated limits", { skip }, async () => {
  const runtime = makeRuntime();
  const { tools, sessionId } = await pausedSession(runtime);
  const first = await tools.get("harness_answer").execute({ sessionId, answer: "confirm, budget of 0", invokedBy: "U1" });
  assert.equal(first.details.started, false);

  const second = await tools.get("harness_answer").execute({ sessionId, answer: "Confirm, $60, 10 hours", invokedBy: "U1" });
  assert.equal(second.details.ok, true);
  assert.equal(second.details.briefConfirmed, true);
  assert.equal(runtime.loopCalls.length, 1, "exactly one run, from the reply that could be read");

  const row = runtime.state.db.prepare(
    "SELECT budget_usd, hard_timeout_seconds, status FROM sessions WHERE id = ?",
  ).get(sessionId);
  assert.equal(row.budget_usd, 60, "the authorised $60 must be the number the loop enforces against");
  assert.equal(row.hard_timeout_seconds, 36000);
  assert.equal(row.status, "planning");
});

test("rc6: a retried confirmation cannot start a second run", { skip }, async () => {
  const runtime = makeRuntime();
  const { tools, sessionId } = await pausedSession(runtime);
  await tools.get("harness_answer").execute({ sessionId, answer: "Confirm, $60, 10 hours", invokedBy: "U1" });
  const again = await tools.get("harness_answer").execute({ sessionId, answer: "Confirm, $60, 10 hours", invokedBy: "U1" });

  assert.equal(again.details.ok, false);
  assert.equal(again.details.badStatus, "planning");
  assert.equal(runtime.loopCalls.length, 1, "a relayed duplicate must not buy a second session");
});

// ---------------------------------------------------------------------------
// 5. The receipt
// ---------------------------------------------------------------------------

test("rc6: the operator is told the limits the ROW holds, not the ones we meant", { skip }, async () => {
  const runtime = makeRuntime();
  const { tools, sessionId } = await pausedSession(runtime);
  const a = await tools.get("harness_answer").execute({ sessionId, answer: "Confirm, $60, 10 hours", invokedBy: "U1" });

  assert.equal(a.details.budgetUsd, 60);
  assert.equal(a.details.hardTimeoutSeconds, 36000);
  assert.match(a.content[0].text, /\$60\.00/);
  assert.match(a.content[0].text, /10h/);

  const row = runtime.state.db.prepare("SELECT budget_usd FROM sessions WHERE id = ?").get(sessionId);
  assert.equal(row.budget_usd, a.details.budgetUsd, "the receipt IS the row; that is the point of it");
});

test("rc6: a plain confirm still gets a receipt, because defaults bind too", { skip }, async () => {
  const runtime = makeRuntime({ sessionDefaultUsd: 50 });
  const { tools, sessionId } = await pausedSession(runtime);
  const a = await tools.get("harness_answer").execute({ sessionId, answer: "confirm", invokedBy: "U1" });

  assert.equal(a.details.briefConfirmed, true);
  // #1184's operator believed he was running at $60/10h. Someone who names no
  // limit at all has exactly the same right to know what will stop their run.
  assert.match(a.content[0].text, /\$50\.00/);
  assert.match(a.content[0].text, /5h/, "the inherited default clock, stated");
});

test("rc6: a clamped budget says so instead of quietly reporting the ask", { skip }, async () => {
  const runtime = makeRuntime({ hardCeilingUsd: 55 });
  const { tools, sessionId } = await pausedSession(runtime);
  const a = await tools.get("harness_answer").execute({ sessionId, answer: "Confirm, $60, 10 hours", invokedBy: "U1" });

  assert.equal(a.details.budgetUsd, 55, "the operator ceiling still binds");
  assert.match(a.content[0].text, /\$55\.00/);
  assert.match(a.content[0].text, /asked for \$60\.00/, "and the gap is stated, not hidden");
});

// ---------------------------------------------------------------------------
// 6. Source pins for the two structural properties
// ---------------------------------------------------------------------------

test("rc6: the ambiguity check precedes every write and the loop dispatch", { skip }, () => {
  const src = readFileSync(resolve(here, "..", "src", "tools", "registration.ts"), "utf8");
  const parse = src.indexOf("parseConfirmationReply(trimmed)");
  const guard = src.indexOf("parsed.ambiguities.length > 0", parse);
  const budgetWrite = src.indexOf("UPDATE sessions SET budget_usd", parse);
  const dispatch = src.indexOf("liveRuntime().loop.run(sessionId, brief)", parse);
  assert.ok(guard > parse, "the gate must exist");
  assert.ok(guard < budgetWrite, "an unreadable reply must not half-apply a limit");
  assert.ok(guard < dispatch, "and must not reach the loop at all");
});

test("rc6: the receipt is built from a re-read of the row", { skip }, () => {
  const src = readFileSync(resolve(here, "..", "src", "tools", "registration.ts"), "utf8");
  const i = src.indexOf("parseConfirmationReply(trimmed)");
  const readBack = src.indexOf("SELECT budget_usd, hard_timeout_seconds FROM sessions", i);
  const dispatch = src.indexOf("liveRuntime().loop.run(sessionId, brief)", i);
  assert.ok(readBack > i, "the limits must be read back, not assumed from what we wrote");
  assert.ok(readBack < dispatch, "and verified before anything is spent against them");
});
