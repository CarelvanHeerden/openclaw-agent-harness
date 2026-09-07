/**
 * rc.3: two independent gaps that both end with a human being asked a question
 * they cannot usefully answer.
 *
 * ONE -- a contract naming a bare directory matched nothing.
 *
 * The lead authors a verification contract naming the files a sub-task should
 * touch. `<dir>/**` has been directory scope since b50, and a bare trailing
 * slash (`prisma/migrations/`) since rc.1. But the plain directory name --
 * `src/__tests__`, `src/app/api/security/sast-sheet` -- fell through every rule
 * and returned null, so a worker who correctly wrote
 * `src/__tests__/foo.test.ts` failed verification and the run paused to ask a
 * human whether that was acceptable. There is only one answer to that question.
 *
 * TWO -- `harness_answer` did not know which question it was answering.
 *
 * It took no sequence and compared none: whatever text arrived was written onto
 * whatever pause happened to be open. An answer composed against seq 4 and
 * delayed while a human read it would land on the seq 7 pause that opened
 * meanwhile. On the `accept` path that retires a sub-task nobody agreed to
 * retire. It was not idempotent either -- a retried call answered twice and
 * mutated the stored plan twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let pathMatch, registerHarnessTools, Database;
try {
  pathMatch = await import("../dist/orchestrator/path-match.js");
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  pathMatch = null;
}
const skip = pathMatch === null;
const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// One: directory contracts
// ---------------------------------------------------------------------------

test("rc3: a bare directory contract matches the files committed beneath it", { skip }, () => {
  const { pathMatchRule } = pathMatch;
  // Both examples are the ones the defect report named.
  assert.equal(pathMatchRule("src/__tests__/foo.test.ts", "src/__tests__"), "directory-implied");
  assert.equal(
    pathMatchRule("src/app/api/security/sast-sheet/route.ts", "src/app/api/security/sast-sheet"),
    "directory-implied",
  );
  // Depth is not limited: a directory scope means everything under it.
  assert.equal(
    pathMatchRule("src/app/api/security/sast-sheet/upload/route.ts", "src/app/api/security/sast-sheet"),
    "directory-implied",
  );
  // The same omitted-prefix tolerance the explicit forms already have.
  assert.equal(pathMatchRule("packages/web/src/__tests__/a.test.ts", "src/__tests__"), "directory-implied");
});

test("rc3: a directory contract does not match its siblings", { skip }, () => {
  const { pathMatchRule } = pathMatch;
  // Prefix-of-a-name is not containment. This is the false positive that would
  // make the rule worse than the bug.
  assert.equal(pathMatchRule("src/__tests__x/foo.ts", "src/__tests__"), null);
  // A FILE sitting next to the directory is not inside it.
  assert.equal(pathMatchRule("src/app/api/security/sast-sheet.ts", "src/app/api/security/sast-sheet"), null);
  // An unrelated directory that happens to hold a similar file.
  assert.equal(pathMatchRule("src/other/foo.test.ts", "src/__tests__"), null);
  // The directory itself is not a file committed beneath it -- this matches as
  // `exact` on the string, which is a different claim and a different rule.
  assert.equal(pathMatchRule("src/__tests__", "src/__tests__"), "exact");
});

test("rc3: a contract naming an actual file stays strict", { skip }, () => {
  const { pathMatchRule } = pathMatch;
  // An extension means a file was genuinely required, so the directory reading
  // must not apply and a descendant must not satisfy it.
  assert.equal(pathMatchRule("src/config/db.ts", "src/config.ts"), null);
  assert.equal(pathMatchRule("prisma/schema/models.prisma", "prisma/schema.prisma"), null);
  // And the ordinary file rules are untouched.
  assert.equal(pathMatchRule("prisma/schema.prisma", "prisma/schema.prisma"), "exact");
});

test("rc3: a single bare segment is too ambiguous to read as a directory", { skip }, () => {
  const { pathMatchRule } = pathMatch;
  // `tests` is a directory and `Dockerfile` is a file, and the string does not
  // say which. Reading one segment as a directory would also let a contract of
  // `src` match the whole repository, which is vacuous rather than lenient.
  assert.equal(pathMatchRule("src/anything.ts", "src"), null);
  assert.equal(pathMatchRule("tests/foo.test.ts", "tests"), null);
  // Crucially, an extensionless FILE still matches itself.
  assert.equal(pathMatchRule("Dockerfile", "Dockerfile"), "exact");
});

test("rc3: the implied directory rule is structural, so strict callers keep it", { skip }, () => {
  const { isStructuralRule, resolveContractPath } = pathMatch;
  // `strictContract` exists to block the two `*-unique` fallbacks, which match
  // on filename or file TYPE alone across unrelated directories. Proving the
  // contract path is a real parent of the committed file is not that.
  assert.equal(isStructuralRule("directory-implied"), true);
  const hit = resolveContractPath(["src/__tests__/a.test.ts"], "src/__tests__", { strictContract: true });
  assert.deepEqual(hit, { file: "src/__tests__/a.test.ts", rule: "directory-implied" });
});

test("rc3: a filename match still beats a directory match when both are available", { skip }, () => {
  const { resolveContractPath } = pathMatch;
  // Ranking matters when one contract could match several committed files.
  const hit = resolveContractPath(
    ["src/__tests__/unrelated.test.ts", "src/__tests__/wanted.test.ts"],
    "src/__tests__/wanted.test.ts",
  );
  assert.equal(hit.file, "src/__tests__/wanted.test.ts");
  assert.equal(hit.rule, "exact");
});

// ---------------------------------------------------------------------------
// Two: harness_answer
// ---------------------------------------------------------------------------

function makeRuntime() {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));
  const audits = [];
  const runs = [];
  const state = {
    db,
    isOpen: () => true,
    audit(event, payload, sessionId) {
      audits.push({ event, payload, sessionId });
    },
  };
  const config = {
    slack: { authorised_users: ["U1"] },
    budgets: {},
    repos: { allowed: ["o/r"] },
    brief: {},
    loop: {},
  };
  const runtime = {
    config,
    state,
    loop: { run: async (sessionId) => { runs.push(sessionId); } },
    budget: { getDailySpend: () => 0 },
  };
  const tools = new Map();
  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool(spec) { tools.set(spec.name, spec); return () => {}; },
  };
  registerHarnessTools(api, runtime);
  return { db, audits, runs, tools, state };
}

/** A session paused mid-run on an ordinary sub-task clarification. */
function pause(db, { seq = 4, answer = null } = {}) {
  const id = "s-rc3";
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
       status, crystallised_prompt, created_at, updated_at, budget_usd, cost_usd, cycles_ran,
       clarification_question, clarification_seq, clarification_answer, clarification_subtask)
     VALUES (?, 'agent:x', '', 'U1', 'gh-u1', 'o/r', 'b', '/w', 'awaiting_clarification', ?, ?, ?, 10, 0, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    JSON.stringify({ title: "t", acceptanceCriteria: ["a"], outOfScope: [], filesLikelyTouched: [] }),
    Date.now(), Date.now(),
    "Which path did you mean?", seq, answer,
    JSON.stringify({ title: "sub", expectedPaths: ["src/a.ts"], actualPaths: ["src/b.ts"] }),
  );
  return id;
}

test("rc3: an answer addressed to a question that has since moved on is refused", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const id = pause(db, { seq: 7 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4,
  });
  assert.equal(out.details.ok, false);
  assert.equal(out.details.staleSeq, true);
  assert.equal(out.details.openSeq, 7);
  assert.match(out.content[0].text, /harness_progress/, "the caller is told how to recover");
  // And nothing was written: a refused answer must not half-apply.
  const row = db.prepare(`SELECT clarification_answer, status FROM sessions WHERE id = ?`).get(id);
  assert.equal(row.clarification_answer, null);
  assert.equal(row.status, "awaiting_clarification");
  assert.ok(audits.some((a) => a.event === "tool.answer_stale_seq"));
});

test("rc3: supplying the sequence that IS open answers normally", { skip }, async () => {
  const { db, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "use src/b.ts", invokedBy: "U1", clarificationSeq: 4,
  });
  assert.equal(out.details.ok, true);
  assert.equal(db.prepare(`SELECT clarification_answer FROM sessions WHERE id = ?`).get(id).clarification_answer, "use src/b.ts");
});

test("rc3: omitting the sequence still works, so existing callers are unaffected", { skip }, async () => {
  const { db, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "use src/b.ts", invokedBy: "U1",
  });
  assert.equal(out.details.ok, true);
});

test("rc3: the same question cannot be answered twice", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  const first = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4,
  });
  assert.equal(first.details.ok, true);
  // Force the session back to awaiting so only the CLAIM can stop the second
  // call -- otherwise the status check would mask what is being tested.
  db.prepare(`UPDATE sessions SET status = 'awaiting_clarification' WHERE id = ?`).run(id);
  const second = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4,
  });
  assert.equal(second.details.ok, false);
  assert.equal(second.details.alreadyAnswered, true);
  assert.ok(audits.some((a) => a.event === "tool.answer_already_claimed"));
});

test("rc3: an automatic answer is recorded as automatic", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", clarificationSeq: 4, answeredBy: "automation",
  });
  const ev = audits.find((a) => a.event === "loop.clarification_answered");
  assert.equal(ev.payload.answeredBy, "automation");
  assert.equal(ev.payload.automated, true);
  assert.equal(ev.payload.seq, 4);
  // The answer TEXT is never logged -- only its length. An answer can quote a
  // brief, and the audit table has no redaction of its own.
  assert.equal(ev.payload.answerLen, "accept".length);
  assert.equal(ev.payload.answer, undefined);
});

test("rc3: an answer with no marker is recorded as human", { skip }, async () => {
  const { db, audits, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  await tools.get("harness_answer").execute(null, { sessionId: id, answer: "accept", invokedBy: "U1" });
  const ev = audits.find((a) => a.event === "loop.clarification_answered");
  assert.equal(ev.payload.answeredBy, "human");
  assert.equal(ev.payload.automated, false);
});

test("rc3: the marker is advisory -- it does not gate anything", { skip }, async () => {
  const { db, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  // Carel's call: the policy lives in the steward skill, not in a harness
  // config gate. The harness records what it is told and behaves identically.
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "U1", answeredBy: "automation",
  });
  assert.equal(out.details.ok, true);
});

test("rc3: an unauthorised invoker is still refused before anything is claimed", { skip }, async () => {
  const { db, tools } = makeRuntime();
  const id = pause(db, { seq: 4 });
  const out = await tools.get("harness_answer").execute(null, {
    sessionId: id, answer: "accept", invokedBy: "NOPE", clarificationSeq: 4, answeredBy: "automation",
  });
  assert.equal(out.details.unauthorised, true);
  assert.equal(db.prepare(`SELECT clarification_answer FROM sessions WHERE id = ?`).get(id).clarification_answer, null);
});

test("rc3: the tool advertises both new fields", { skip }, () => {
  const { tools } = makeRuntime();
  const props = tools.get("harness_answer").parameters.properties;
  assert.equal(props.clarificationSeq.type, "number");
  assert.deepEqual(props.answeredBy.enum, ["human", "automation"]);
  // Neither may become required: every existing caller passes neither.
  const required = tools.get("harness_answer").parameters.required;
  assert.deepEqual(required, ["sessionId", "answer", "invokedBy"]);
});
