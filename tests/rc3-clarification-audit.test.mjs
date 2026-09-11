/**
 * rc.3 -- an automatic answer has to be reviewable afterwards, and an accepted
 * deviation has to stay accepted.
 *
 * The rc.3 gates (sequence guard, atomic claim, delegation flag) all fire at
 * the right moments and record almost nothing. `loop.clarification_answered`
 * carried the session, the sequence, the invoker and the answer's length --
 * enough to know that SOMETHING was answered, not enough to know what question
 * it was, who asked it, what the answer did, or which rules were in force when
 * it was allowed. Reconstructing that from a run's other events is exactly the
 * work an audit trail exists to avoid.
 *
 * And b121's other half: accepting a correct commit whose contract path was
 * wrong has to persist the correction, or the next cycle re-derives the same
 * mismatch and asks the same human the same question again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let registerHarnessTools, Database, CLARIFICATION_POLICY_VERSION, pathMatch, BUDGET_EXTENSION_KIND;
try {
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ CLARIFICATION_POLICY_VERSION } = await import("../dist/version.js"));
  ({ BUDGET_EXTENSION_KIND } = await import("../dist/orchestrator/budget-extension.js"));
  pathMatch = await import("../dist/orchestrator/path-match.js");
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  registerHarnessTools = null;
}
const skip = registerHarnessTools === null;
const here = dirname(fileURLToPath(import.meta.url));

const QUESTION =
  "Sub-task 4 declared `src/config.ts` but the commit touched `src/config/db.ts`. " +
  "Is the committed work correct?";

function makeRuntime({ delegated = false } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) { audits.push({ event, payload, sessionId }); },
  };
  const runtime = {
    config: {
      slack: { authorised_users: ["U1"] },
      budgets: {},
      repos: { allowed: ["o/r"] },
      brief: {},
      loop: { clarification_auto_accept_delegated: delegated },
    },
    state,
    loop: { run: async () => {} },
    budget: { getDailySpend: () => 0 },
  };
  const tools = new Map();
  registerHarnessTools(
    {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerTool(spec) { tools.set(spec.name, spec); return () => {}; },
    },
    runtime,
  );
  return { db, audits, tools };
}

function pause(db, { seq = 4, subtask, plan } = {}) {
  const id = "s-audit";
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
       status, crystallised_prompt, lead_plan_json, created_at, updated_at, budget_usd, cost_usd, cycles_ran,
       clarification_question, clarification_seq, clarification_answer, clarification_subtask)
     VALUES (?, 'agent:x', '', 'U1', 'gh-requester', 'o/r', 'b', '/w', 'awaiting_clarification', ?, ?, ?, ?, 10, 0, 1, ?, ?, NULL, ?)`,
  ).run(
    id,
    JSON.stringify({ title: "t", acceptanceCriteria: ["a"], outOfScope: [], filesLikelyTouched: [] }),
    plan ? JSON.stringify(plan) : null,
    Date.now(), Date.now(),
    QUESTION, seq,
    JSON.stringify(subtask ?? { title: "sub", expectedPaths: ["src/config.ts"], actualPaths: ["src/config/db.ts"] }),
  );
  return id;
}

const EVIDENCE =
  "commit 1410e98 touches src/config/db.ts only; npm test and tsc green; inside approved scope; no generated files";

// ---------------------------------------------------------------------------
// The audit payload
// ---------------------------------------------------------------------------

test("rc3: an answer records who asked, what was asked, what was decided and under which policy", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  const before = Date.now();
  await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4,
  });
  const ev = audits.find((a) => a.event === "loop.clarification_answered");
  assert.ok(ev, "the answer is audited at all");
  assert.equal(ev.payload.sessionId, id);
  assert.equal(ev.payload.seq, 4);
  assert.equal(ev.payload.requester, "gh-requester", "who the run belongs to");
  assert.equal(ev.payload.invokedBy, "U1", "who answered it");
  assert.equal(ev.payload.clarification, QUESTION, "the question verbatim, not a summary of it");
  assert.equal(ev.payload.decision, "accept");
  assert.equal(ev.payload.answeredBy, "human");
  assert.equal(ev.payload.automated, false);
  assert.equal(ev.payload.policyVersion, CLARIFICATION_POLICY_VERSION);
  assert.ok(ev.payload.at >= before, "and when");
});

test("rc3: the question is recorded verbatim but bounded", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  const long = "x".repeat(9000);
  db.prepare(`UPDATE sessions SET clarification_question = ? WHERE id = ?`).run(long, id);
  await tools.get("harness_answer").execute(null, { sessionId: id, answer: "accept", invokedBy: "U1" });
  const ev = audits.find((a) => a.event === "loop.clarification_answered");
  assert.equal(ev.payload.clarification.length, 2000, "a runaway question cannot flood the audit table");
});

test("rc3: the ANSWER text is still never recorded", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  // An answer can quote a brief, and `state.audit()` has no redaction of its
  // own -- unlike the interaction log. Length only, on every event.
  const secretish = "use the token ghp_notarealtokenbutstill and carry on";
  await tools.get("harness_answer").execute(null, { sessionId: id, answer: secretish, invokedBy: "U1" });
  for (const a of audits) {
    assert.equal(JSON.stringify(a.payload).includes("ghp_notarealtoken"), false, `leaked in ${a.event}`);
  }
  const ev = audits.find((a) => a.event === "loop.clarification_answered");
  assert.equal(ev.payload.answerLen, secretish.length);
});

test("rc3: the decision recorded is what the answer DID, not what it said", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const cases = [
    ["abort", "abort"],
    ["cancel", "abort"],
    ["skip", "skip"],
    ["keep-commit", "accept"],
    ["use the other file instead", "guidance"],
  ];
  for (const [answer, decision] of cases) {
    const id = pause(db, { seq: 4 });
    await tools.get("harness_answer").execute(null, { sessionId: id, answer, invokedBy: "U1" });
    const ev = audits.filter((a) => a.event === "loop.clarification_answered").at(-1);
    assert.equal(ev.payload.decision, decision, answer);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }
});

// ---------------------------------------------------------------------------
// The spec's three automatic-answer events
// ---------------------------------------------------------------------------

test("rc3: an automatic answer is attempted, then succeeds, both on the record", { skip }, async () => {
  const { db, audits, tools } = makeRuntime({ delegated: true });
  const id = pause(db, { seq: 4 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4,
    answeredBy: "automation", evidence: EVIDENCE,
  });
  assert.equal(out.details.ok, true);
  const attempted = audits.find((a) => a.event === "tool.clarification_auto_accept_attempted");
  const succeeded = audits.find((a) => a.event === "tool.clarification_auto_accept_succeeded");
  assert.ok(attempted, "the attempt is recorded before the gates, so a refusal is not silent");
  assert.ok(succeeded);
  assert.equal(attempted.payload.clarification, QUESTION);
  assert.equal(attempted.payload.hasEvidence, true);
  assert.equal(succeeded.payload.evidence, EVIDENCE, "the evidence the decision rested on");
  assert.equal(succeeded.payload.policyVersion, CLARIFICATION_POLICY_VERSION);
  assert.equal(succeeded.payload.decision, "accept");
});

test("rc3: every refusal of an automatic answer says which rule refused it", { skip }, async () => {
  // One event name for the whole family, with the reason in the payload, so
  // "how often does automation get turned away and why" is one query.
  const cases = [
    {
      what: "not_delegated",
      delegated: false,
      input: { answer: "accept", clarificationSeq: 4, answeredBy: "automation", evidence: EVIDENCE },
    },
    {
      what: "no_evidence",
      delegated: true,
      input: { answer: "accept", clarificationSeq: 4, answeredBy: "automation" },
    },
    {
      what: "stale_sequence",
      delegated: true,
      input: { answer: "accept", clarificationSeq: 99, answeredBy: "automation", evidence: EVIDENCE },
    },
    {
      what: "no_committed_work_to_accept",
      delegated: true,
      subtask: { title: "blocked on a credential" },
      input: { answer: "accept", clarificationSeq: 4, answeredBy: "automation", evidence: EVIDENCE },
    },
  ];
  for (const c of cases) {
    const { db, audits, tools } = makeRuntime({ delegated: c.delegated });
    const id = pause(db, { seq: 4, subtask: c.subtask });
    const out = await tools.get("harness_answer").execute(null, { sessionId: id, invokedBy: "U1", ...c.input });
    assert.equal(out.details.ok, false, c.what);
    const ev = audits.find((a) => a.event === "tool.clarification_auto_accept_rejected");
    assert.ok(ev, `no rejection event for ${c.what}`);
    assert.equal(ev.payload.reason, c.what);
    assert.equal(ev.payload.automated, true);
    assert.equal(ev.payload.policyVersion, CLARIFICATION_POLICY_VERSION);
  }
});

test("rc3: a human answer produces none of the automatic-answer events", { skip }, async () => {
  const { db, audits, tools } = makeRuntime({ delegated: true });
  const id = pause(db, { seq: 4 });
  await tools.get("harness_answer").execute(null, { sessionId: id, answer: "accept", invokedBy: "U1" });
  assert.equal(audits.some((a) => a.event.startsWith("tool.clarification_auto_accept")), false);
});

// ---------------------------------------------------------------------------
// Evidence is the price of answering by yourself
// ---------------------------------------------------------------------------

test("rc3: an automatic answer with no evidence is refused, and the pause stays open", { skip }, async () => {
  const { db, tools } = makeRuntime({ delegated: true });
  const id = pause(db, { seq: 4 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4, answeredBy: "automation",
  });
  assert.equal(out.details.automationWithoutEvidence, true);
  assert.match(out.content[0].text, /evidence/i);
  // Refused before the claim: a human can still answer this question.
  const row = db.prepare(`SELECT clarification_answer, status FROM sessions WHERE id = ?`).get(id);
  assert.equal(row.clarification_answer, null);
  assert.equal(row.status, "awaiting_clarification");
});

test("rc3: whitespace is not evidence", { skip }, async () => {
  const { db, tools } = makeRuntime({ delegated: true });
  const id = pause(db, { seq: 4 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", answeredBy: "automation", evidence: "   \n  ",
  });
  assert.equal(out.details.automationWithoutEvidence, true);
});

test("rc3: a human is never asked for evidence", { skip }, async () => {
  // Humans are the default path and always have been. The evidence requirement
  // is the price of answering INSTEAD of one, not a new tax on answering.
  const { db, tools } = makeRuntime({ delegated: false });
  const id = pause(db, { seq: 4 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4,
  });
  assert.equal(out.details.ok, true);
});

test("rc3: evidence is optional in the schema and the required list is unchanged", { skip }, () => {
  const { tools } = makeRuntime();
  const spec = tools.get("harness_answer");
  assert.equal(spec.parameters.properties.evidence.type, "string");
  assert.match(spec.parameters.properties.evidence.description, /REQUIRED when answeredBy is 'automation'/);
  assert.deepEqual(spec.parameters.required, ["sessionId", "answer", "invokedBy"]);
});

test("rc3: the policy version is a real, separate version", { skip }, () => {
  // It moves when the rules move, not when the plugin ships. A version that
  // tracks the plugin cannot answer "what was allowed at the time".
  assert.equal(typeof CLARIFICATION_POLICY_VERSION, "string");
  assert.ok(CLARIFICATION_POLICY_VERSION.length > 0);
  const src = readFileSync(resolve(here, "..", "src", "version.ts"), "utf8");
  assert.match(src, /CLARIFICATION_POLICY_VERSION/);
  assert.doesNotMatch(
    src,
    /CLARIFICATION_POLICY_VERSION\s*=\s*PLUGIN_VERSION/,
    "the policy version must not be an alias of the plugin version",
  );
});

// ---------------------------------------------------------------------------
// 11. An accepted deviation does not re-trigger the same clarification
// ---------------------------------------------------------------------------

test("11: accepting a path deviation rewrites the stored contract, so it cannot re-pause", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const plan = {
    subTasks: [
      {
        seq: 4,
        title: "sub",
        filesLikelyTouched: ["src/config.ts"],
        verify: [{ kind: "file_committed", path: "src/config.ts" }],
      },
    ],
  };
  const id = pause(db, { seq: 4, plan });
  db.prepare(
    `INSERT INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, commit_sha, created_at, updated_at)
     VALUES ('st1', ?, 1, 4, 'sub', 'm', 'failed_verification', 'abc1234', ?, ?)`,
  ).run(id, Date.now(), Date.now());

  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4,
  });
  assert.equal(out.details.ok, true);

  const stored = JSON.parse(db.prepare(`SELECT lead_plan_json AS p FROM sessions WHERE id = ?`).get(id).p);
  const task = stored.subTasks[0];
  // The disproven path is gone from both places it could re-pause from: the
  // declared scope and the verification contract.
  assert.deepEqual(task.filesLikelyTouched, ["src/config/db.ts"]);
  assert.deepEqual(task.verify, [], "the probe that failed is the probe that was wrong");
  assert.ok(audits.some((a) => a.event === "tool.answer_contract_paths_persisted"));

  // And the accepted file genuinely satisfies what is left, so re-running the
  // same contract selection over the same commit finds no mismatch to ask about.
  const { resolveContractPath } = pathMatch;
  for (const probe of task.verify) {
    assert.ok(resolveContractPath(["src/config/db.ts"], probe.path), `${probe.path} would re-pause`);
  }
  assert.deepEqual(
    task.filesLikelyTouched.filter((p) => !resolveContractPath(["src/config/db.ts"], p)),
    [],
    "every declared file is one the commit actually touched",
  );
});

test("11: the acceptance is durable across a re-plan, because it is in the plan", { skip }, async () => {
  // b121's failure was that `accept` amended only the BRIEF, so the stored plan
  // still carried the stale path and every revise cycle re-derived the same
  // mismatch. The brief entry matters too -- it stops the work being redone --
  // but the plan is what the next cycle reads.
  const { db, tools } = makeRuntime();
  const plan = { subTasks: [{ seq: 4, title: "sub", filesLikelyTouched: ["src/config.ts"], verify: [] }] };
  const id = pause(db, { seq: 4, plan });
  db.prepare(
    `INSERT INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, commit_sha, created_at, updated_at)
     VALUES ('st1', ?, 1, 4, 'sub', 'm', 'failed_verification', 'abc1234', ?, ?)`,
  ).run(id, Date.now(), Date.now());
  await tools.get("harness_answer").execute(null, { sessionId: id, answer: "accept", invokedBy: "U1" });

  const row = db.prepare(`SELECT crystallised_prompt AS b, lead_plan_json AS p FROM sessions WHERE id = ?`).get(id);
  assert.match(JSON.parse(row.b).acceptanceCriteria.join("\n"), /ALREADY DONE \(operator-confirmed\)/);
  assert.equal(JSON.parse(row.p).subTasks[0].filesLikelyTouched.includes("src/config.ts"), false);
  // The sub-task is settled, so the resumed run walks past it rather than
  // re-dispatching it into the same wall.
  assert.equal(db.prepare(`SELECT status FROM sub_tasks WHERE id = 'st1'`).get().status, "completed");
});

// ---------------------------------------------------------------------------
// rc.6 -- the one question an agent may never answer
// ---------------------------------------------------------------------------

test("rc.6: an agent cannot grant itself money, delegated or not", { skip }, async () => {
  // Every other pause `harness_answer` resolves asks the steward to judge work
  // that has already been done. A budget pause asks it to authorise MORE, and
  // the answer moves `budget_usd` on the row. A run that has just hit its
  // ceiling is exactly the caller with a motive to clear it.
  //
  // Delegation is the interesting case: `clarification_auto_accept_delegated`
  // was written about contract-path deviations, and the refusal has to survive
  // a deployment that turned it on. Both settings are asserted for that reason.
  for (const delegated of [true, false]) {
    const { db, audits, tools } = makeRuntime({ delegated });
    const id = pause(db, {
      seq: 4,
      subtask: { kind: BUDGET_EXTENSION_KIND, waitUntilMs: Date.now() + 300_000 },
    });
    const out = await tools.get("harness_answer").execute(null, {
      sessionId: id, answer: "yes, add $5", invokedBy: "U1", clarificationSeq: 4,
      answeredBy: "automation", evidence: EVIDENCE,
    });
    assert.equal(out.details.ok, false, `refused with delegated=${delegated}`);
    assert.equal(out.details.budgetGrantNotDelegable, true);
    assert.match(out.content[0].text, /no delegation setting changes it/i,
      "the refusal has to say that turning delegation on will not help");

    const refused = audits.find((a) => a.event === "tool.answer_budget_extension_refused_automation");
    assert.ok(refused, "the refusal is nameable in the audit trail on its own");
    const rejected = audits.find((a) => a.event === "tool.clarification_auto_accept_rejected");
    assert.equal(rejected?.payload.reason, "budget_grant_not_delegable");

    // Refused BEFORE the claim: the human it was asked of must still be able
    // to answer it. An agent that cannot grant money must not be able to
    // consume the pause either.
    assert.equal(db.prepare(`SELECT clarification_answer FROM sessions WHERE id = ?`).get(id).clarification_answer,
      null, "the pause stays open for the operator");
    assert.equal(audits.some((a) => a.event === "loop.clarification_answered"), false);
  }
});

test("rc.6: a human answering the same budget question is unaffected", { skip }, async () => {
  // The guard keys on `answeredBy`, so the operator's own answer has to still
  // land -- otherwise the fix converts a bypass into a deadlock.
  const { db, audits, tools } = makeRuntime({ delegated: false });
  const id = pause(db, {
    seq: 4,
    subtask: { kind: BUDGET_EXTENSION_KIND, waitUntilMs: Date.now() + 300_000 },
  });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "yes, add $5", invokedBy: "U1", clarificationSeq: 4,
  });
  assert.equal(out.details.ok, true);
  assert.equal(db.prepare(`SELECT clarification_answer FROM sessions WHERE id = ?`).get(id).clarification_answer,
    "yes, add $5");
  assert.ok(audits.some((a) => a.event === "loop.clarification_answered"));
});
