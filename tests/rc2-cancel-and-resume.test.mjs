// rc.2 — cancelling, resuming, and telling the truth about both.
//
// Six defects from the same production run, all of them about the harness
// mis-reporting or mis-handling its own state:
//
//   1. Cancel was logged and ignored. The session stayed `awaiting_clarification`
//      forever, because `harness_cancel` only set a flag the loop reads at its
//      "next checkpoint" -- and a paused session has no loop, so there was no
//      next checkpoint.
//   2. Answering a clarification re-planned the whole session instead of
//      resuming the sub-task that asked the question.
//   3. Which meant already-completed sub-tasks, with their commits already on
//      the branch, were dispatched a second time.
//   4. A research/observe sub-task counted as done on progress narration,
//      because an observe contract is legitimately empty and "the turn ended"
//      was the whole test. Its narration was then handed to dependent sub-tasks
//      as findings.
//   5. Startup logs warned about Claude model ids for roles running on
//      OpenCode/OpenRouter.
//   6. The retry prompt told the worker to delete its temp script, which the
//      bash guard denies.
//
// The integration tests here run the real orchestrator, the real
// `harness_cancel`/`harness_answer` tools and a real git repo, so a resumed run
// is answering questions about actual git history.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";

import { makeWorld, makeState, makeConfig, git, QUIET, IDENT, scenarioAvailable } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";

const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
const { BudgetEnforcer } = await import("../dist/budgets/enforcer.js");
const { PatRouter } = await import("../dist/auth/pat-router.js");
const { registerHarnessTools } = await import("../dist/tools/registration.js");
const { HARNESS_SCRATCH_DIR, HARNESS_EXCLUDE_PATTERNS, isHarnessScratch } =
  await import("../dist/adapters/git-worktree.js");
const { observeReportIsNarration, buildClarificationResumeHint } =
  await import("../dist/orchestrator/worker-outcome.js");

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// The narration from the incident, verbatim.
const NARRATION =
  "Now let me check the workbook headers quickly, the tenant extension mechanism, and package.json prisma scripts.";

const BRIEF = {
  title: "continuity module",
  motivation: "m",
  acceptanceCriteria: ["ship the continuity module"],
  filesLikelyTouched: [],
  outOfScope: [],
  riskLevel: "low",
};

/**
 * A three-sub-task run that pauses on seq 2, wired to the REAL tools.
 *
 * seq 1 commits and passes. seq 2's contract names a file the worker does not
 * write, so it fails verification and pauses. seq 3 never runs. That gives all
 * three resume questions one shape to ask them of: did seq 2 resume, did seq 1
 * stay done, did seq 3 eventually run.
 */
async function pausedRun(opts = {}) {
  const world = await makeWorld({ files: { "README.md": "# seed\n" } });
  const { db, state, audits } = await makeState();
  const cfg = makeConfig(opts.configOver ?? {});
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, crystallised_prompt)
     VALUES ('S1','T1','C1','U1','u1','o/r','harness/feat-x','', 'crystallising', ?, ?, 50, 0, 0, ?)`,
  ).run(now, now, JSON.stringify(BRIEF));

  const FICTIONAL = "src/app/(grc)/nav.tsx";
  let worktree = "";
  let leadCalls = 0;
  const dispatched = [];
  const commits = [];

  const subTasks = () => [
    { seq: 1, title: "zod schemas", intent: "add schemas", filesLikelyTouched: ["src/lib/schema.ts"],
      successCriteria: ["file written"], estimatedTokens: 100, taskMode: "mutate",
      verify: [{ kind: "file_written", path: "src/lib/schema.ts" }, { kind: "commit_made" }] },
    { seq: 2, title: "sidebar nav entry", intent: "add nav entry", filesLikelyTouched: [FICTIONAL],
      successCriteria: ["nav entry added"], estimatedTokens: 100, taskMode: "mutate",
      verify: [{ kind: "file_written", path: FICTIONAL }, { kind: "commit_made" }] },
    { seq: 3, title: "wire the route", intent: "wire it", filesLikelyTouched: ["src/lib/route.ts"],
      successCriteria: ["file written"], estimatedTokens: 100, taskMode: "mutate",
      verify: [{ kind: "file_written", path: "src/lib/route.ts" }, { kind: "commit_made" }] },
  ];

  const loop = new OrchestratorLoop({
    config: cfg,
    state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat: new PatRouter(cfg.pat_routing),
    logger: QUIET,
    runLead: async (brief) => {
      leadCalls++;
      git(["remote", "set-url", "origin", world.origin], world.bare);
      worktree = await world.adapter.allocate({
        repoFullName: "o/r", baseBranch: "main", sessionBranch: "harness/feat-x",
        sessionId: `pending-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        ghToken: "", commitIdentity: IDENT,
        preserveLocalBranch: !!brief.resumeFromClarification,
      });
      return { repo: "o/r", branch: "harness/feat-x", worktreePath: worktree,
        subTasks: subTasks(), reviewChecklist: [], riskLevel: "low", approxCostUsd: 0 };
    },
    runWorker: async ({ subTask, dispatchHint }) => {
      const hint = dispatchHint ?? "";
      dispatched.push({ seq: subTask.seq, hint });
      // seq 2 writes somewhere its contract does not name -- the pause. Once the
      // operator has ruled, it does what it was told, which is the whole point
      // of delivering the answer to this sub-task rather than to the planner.
      const resumed = hint.includes("RESUMING THIS SUB-TASK AFTER AN OPERATOR DECISION");
      const file = subTask.seq === 1 ? "src/lib/schema.ts"
        : subTask.seq === 2 ? (resumed ? FICTIONAL : "src/components/grc-nav.tsx")
        : "src/lib/route.ts";
      mkdirSync(dirname(join(worktree, file)), { recursive: true });
      writeFileSync(join(worktree, file), `// ${subTask.title} ${dispatched.length}\nexport const x = ${subTask.seq};\n`);
      const sha = await world.adapter.commit(worktree, `harness(${subTask.seq}): ${subTask.title}`, IDENT);
      if (sha) commits.push({ seq: subTask.seq, sha });
      return { status: "completed", filesChanged: [file], commitSha: sha, costUsd: 0.01,
        tokensIn: 1, tokensOut: 1, reason: "end_turn",
        finalMessage: subTask.seq === 2 ? `${FICTIONAL} does not exist; I put it in ${file}.` : "done" };
    },
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    buildVerifyProbes: () => ({
      remoteBranchExists: async () => ({ exists: false, detail: "" }),
      prUrlPresent: async () => ({ present: false, detail: "" }),
      fileWrittenSince: async (p) => ({ written: existsSync(join(worktree, p)), detail: "" }),
      fileExistsOnDisk: async (p) => {
        const ok = existsSync(join(worktree, p));
        return { exists: ok, nonEmpty: ok, detail: ok ? "present" : "no file matching contract path" };
      },
      commitMadeSince: async (base) => {
        const head = git(["rev-parse", "HEAD"], worktree);
        return { made: head !== base, detail: "" };
      },
      fileCommittedSince: async (p, base) => {
        const out = git(["log", `${base}..HEAD`, "--name-only", "--pretty=format:"], worktree);
        const hit = out.split("\n").map((s) => s.trim()).includes(p);
        return { committed: hit, detail: "", diffLines: hit ? 5 : 0 };
      },
    }),
    releaseWorktree: async () => ({ ok: true, path: worktree }),
    worktreeHeadSha: async (p) => git(["rev-parse", "HEAD"], p),
    worktreeMergeBase: async (p) => git(["merge-base", "HEAD", "origin/main"], p),
    unreachableCommits: async (p, from, shas) => world.adapter.unreachableCommits(p, from, shas),
    listRepoFiles: async (p) => world.adapter.listTrackedFiles(p),
    worktreeCommittedFiles: async (p, base) => world.adapter.listCommittedFiles(p, base),
  });

  const first = await loop.run("S1", BRIEF);

  let resumePromise = null;
  const tools = new Map();
  registerHarnessTools(
    { logger: QUIET, registerTool: (def) => { tools.set(def.name, { ...def, execute: (i) => def.execute("cid", i) }); return () => {}; } },
    { state, config: cfg, loop: { run: (...a) => (resumePromise = loop.run(...a)), cancelSession: (...a) => loop.cancelSession(...a) } },
  );

  return {
    world, state, db, audits, loop, first, tools, dispatched, commits,
    leadCalls: () => leadCalls,
    worktree: () => worktree,
    session: () => db.prepare(`SELECT * FROM sessions WHERE id='S1'`).get(),
    subTaskRows: () => db.prepare(`SELECT seq, cycle, status, summary, commit_sha FROM sub_tasks WHERE session_id='S1' ORDER BY cycle, seq`).all(),
    sawEvent: (name) => audits.some((a) => a.event === name),
    events: (name) => audits.filter((a) => a.event === name),
    answer: async (text) => {
      const res = await tools.get("harness_answer").execute({ sessionId: "S1", answer: text, invokedBy: "U1" });
      if (resumePromise) await resumePromise;
      return res;
    },
    cancel: async (reason) => tools.get("harness_cancel").execute({ sessionId: "S1", reason, invokedBy: "U1" }),
  };
}

// ---------------------------------------------------------------------------
// 1. Cancel, from any state
// ---------------------------------------------------------------------------

test("rc2: cancelling a session paused in clarification terminates it", { skip }, async () => {
  const s = await pausedRun();
  assert.equal(s.first.status, "awaiting_clarification", "precondition: the run paused");

  const res = await s.cancel("operator changed their mind");

  // THE DEFECT. The cancel was recorded, the tool said it worked, and the
  // session sat in awaiting_clarification until someone noticed.
  assert.equal(s.session().status, "aborted", "a cancelled session must be terminal");
  assert.equal(res.details.ok, true);
  assert.equal(res.details.terminatedNow, true, "no loop was running, so nothing had to be asked to stop");
  assert.ok(s.sawEvent("loop.cancel_requested"));
  assert.ok(s.sawEvent("loop.cancel_terminated"));
  assert.ok(s.sawEvent("loop.aborted"), "the canonical terminal event still fires");
});

test("rc2: a cancelled clarification is no longer waiting for an answer", { skip }, async () => {
  const s = await pausedRun();
  await s.cancel("stop");
  const row = s.session();
  assert.equal(row.clarification_question, null, "nothing is still being asked");
  assert.equal(row.clarification_seq, null);
});

test("rc2: cancelling twice is safe and still reports success", { skip }, async () => {
  const s = await pausedRun();
  const first = await s.cancel("stop");
  const second = await s.cancel("stop again");

  assert.equal(first.details.ok, true);
  // Previously this returned ok:false/alreadyTerminal, so "cancel it again to
  // be sure" read as a cancel that had not worked.
  assert.equal(second.details.ok, true, "cancelling a cancelled session is a no-op, not an error");
  assert.equal(second.details.alreadyTerminal, true);
  assert.equal(second.details.terminatedNow, false, "the second call must not re-run a finaliser");
  assert.equal(s.events("loop.aborted").length, 1, "exactly one termination");
  assert.equal(s.session().status, "aborted");
});

test("rc2: cancelling preserves committed work rather than deleting it", { skip }, async () => {
  const s = await pausedRun();
  const sha = s.commits.find((c) => c.seq === 1).sha;
  await s.cancel("stop");

  assert.equal(s.session().worktree_preserved, 1, "a cancel is 'stop spending', not 'throw it away'");
  git(["merge-base", "--is-ancestor", sha, "refs/heads/harness/feat-x"], s.world.bare);
});

test("rc2: an answer after a cancel cannot resurrect the session", { skip }, async () => {
  const s = await pausedRun();
  await s.cancel("stop");
  const res = await s.answer("go ahead and do it");
  assert.equal(res.details.ok, false, "the session is terminal; there is nothing to answer");
  assert.equal(s.session().status, "aborted");
});

test("rc2: cancelling an unknown session is a clean not-found, not a crash", { skip }, async () => {
  const s = await pausedRun();
  const res = await s.tools.get("harness_cancel").execute({ sessionId: "nope", reason: "x", invokedBy: "U1" });
  assert.equal(res.details.ok, false);
  assert.equal(res.details.notFound, true);
});

test("rc2: cancel still requires authorisation", { skip }, async () => {
  const s = await pausedRun();
  const res = await s.tools.get("harness_cancel").execute({ sessionId: "S1", reason: "x", invokedBy: "intruder" });
  assert.equal(res.details.unauthorised, true);
  assert.equal(s.session().status, "awaiting_clarification", "an unauthorised cancel changes nothing");
});

test("rc2: a running loop is asked to stop rather than reaped underneath itself", () => {
  const src = S("src/orchestrator/loop.ts");
  const body = src.slice(src.indexOf("async cancelSession("), src.indexOf("private finaliseAbort("));
  assert.match(body, /isSessionLoopRunning\(sessionId\)/);
  assert.match(body, /loopRunning: true/);
  // The flag must be written before the running/not-running branch, so a live
  // loop still stops even if the direct termination path is not taken.
  assert.ok(
    body.indexOf("reactions.abort = true") < body.indexOf("const loopRunning"),
    "the abort flag goes down first, unconditionally",
  );
});

test("rc2: the stall sweep also finishes a cancel left pending on a paused session", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /WHERE status IN \('executing', 'planning', 'reviewing', 'awaiting_clarification'\)/);
  assert.match(src, /row\.status === "awaiting_clarification"[\s\S]{0,300}cancelSession\(row\.id/);
});

// ---------------------------------------------------------------------------
// 2 + 3. Resuming the paused task, and not repeating finished ones
// ---------------------------------------------------------------------------

test("rc2: answering resumes the stored plan instead of re-planning", { skip }, async () => {
  const s = await pausedRun();
  assert.equal(s.leadCalls(), 1, "precondition: one plan so far");

  await s.answer("Put it in src/components/grc-nav.tsx; that is the right home for it.");

  assert.equal(s.leadCalls(), 1, "an answered clarification must not buy a second plan");
  assert.ok(s.sawEvent("tool.answer_resume_in_place"));
});

test("rc2: the answer reaches the sub-task that asked the question", { skip }, async () => {
  const s = await pausedRun();
  const before = s.dispatched.length;
  await s.answer("The planned path is correct; that is the right home for it.");

  const resumed = s.dispatched.slice(before).filter((d) => d.seq === 2);
  assert.equal(resumed.length >= 1, true, "the paused sub-task is the one that runs again");
  // Previously the decision went into the brief's acceptance criteria, which
  // only the LEAD reads -- and a resumed run does not call the lead. The worker
  // was re-dispatched with the identical prompt that had stopped it.
  assert.match(resumed[0].hint, /RESUMING THIS SUB-TASK AFTER AN OPERATOR DECISION/);
  assert.match(resumed[0].hint, /that is the right home for it/, "the operator's actual words");
  assert.ok(s.sawEvent("loop.subtask_resumed_with_answer"));
});

test("rc2: a completed sub-task is not run again after a resume", { skip }, async () => {
  const s = await pausedRun();
  const before = s.dispatched.length;
  await s.answer("The planned path is correct.");

  // Scoped to what the resume does FIRST. A later revise cycle legitimately
  // re-runs sub-tasks -- that is what a revise cycle is for -- so the claim
  // being made here is about the resume itself: it picks up where it stopped.
  const after = s.dispatched.slice(before);
  assert.equal(after[0].seq, 2, "the resume continues at the paused sub-task, not at the top");
  assert.equal(s.subTaskRows().filter((r) => r.cycle === 1 && r.seq === 1 && r.status === "completed").length, 1);
});

test("rc2: a resumed run carries on to the sub-tasks that never got their turn", { skip }, async () => {
  const s = await pausedRun();
  const before = s.dispatched.length;
  await s.answer("The planned path is correct.");

  const after = s.dispatched.slice(before);
  assert.deepEqual(after.slice(0, 2).map((d) => d.seq), [2, 3],
    "the paused sub-task finishes, then the one blocked behind it runs");
});

test("rc2: skipping retires the paused sub-task without re-planning or redoing the rest", { skip }, async () => {
  const s = await pausedRun();
  const before = s.dispatched.length;
  await s.answer("skip");

  assert.equal(s.leadCalls(), 1, "a skip is not a reason to rebuild the plan");
  const after = s.dispatched.slice(before);
  assert.equal(after[0].seq, 3, "the skipped sub-task is passed over and the run moves on");
  const seq2 = s.subTaskRows().filter((r) => r.seq === 2).pop();
  assert.equal(seq2.status, "completed_no_change");
  assert.match(seq2.summary ?? "", /skipped by operator/);
});

test("rc2: skip still records the durable prohibition for any later re-plan", { skip }, async () => {
  const s = await pausedRun();
  await s.answer("skip");
  const brief = JSON.parse(s.session().crystallised_prompt);
  assert.ok(
    (brief.outOfScope ?? []).some((line) => /operator explicitly skipped it/.test(line)),
    "b58's content-keyed prohibition survives the rc.2 in-place resume",
  );
});

test("rc2: a session with no plan yet still re-plans, because there is nothing to resume", () => {
  const src = S("src/tools/registration.ts");
  assert.match(src, /const canResumeInPlace = Boolean\(row\.lead_plan_json\) && seq >= 0/);
});

test("rc2: the resume hint tells the worker the decision is binding and the branch stands", () => {
  const hint = buildClarificationResumeHint({ question: "Where should it live?", answer: "In src/components." });
  assert.match(hint, /Where should it live\?/);
  assert.match(hint, /In src\/components\./);
  assert.match(hint, /do not ask\s*\n?\s*the same question again/);
  assert.match(hint, /already committed on\s*\n?\s*this branch stands/);
});

// ---------------------------------------------------------------------------
// 4. Narration is not research
// ---------------------------------------------------------------------------

test("rc2: the production narration does not count as an observe report", () => {
  assert.equal(observeReportIsNarration(NARRATION), true);
  assert.equal(observeReportIsNarration("First, let me look at the schema:"), true);
});

test("rc2: a real finding is a report, however brief", () => {
  assert.equal(observeReportIsNarration("The schema lives at prisma/schema.prisma and has no tenant column."), false);
  assert.equal(observeReportIsNarration("done"), false, "a terse sign-off is not narration");
});

test("rc2: emptiness is left alone -- it hands nothing downstream to be wrong about", () => {
  assert.equal(observeReportIsNarration(""), false);
  assert.equal(observeReportIsNarration(undefined), false);
});

/** A single observe sub-task whose worker returns whatever the test says. */
async function observeRun(messages, configOver = {}) {
  const world = await makeWorld({ files: { "README.md": "# seed\n" } });
  const { db, state, audits } = await makeState();
  const cfg = makeConfig(configOver);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, crystallised_prompt)
     VALUES ('S1','T1','C1','U1','u1','o/r','harness/feat-x','', 'crystallising', ?, ?, 50, 0, 0, ?)`,
  ).run(now, now, JSON.stringify(BRIEF));

  let worktree = "";
  const hints = [];
  let turn = 0;
  const loop = new OrchestratorLoop({
    config: cfg,
    state,
    budget: new BudgetEnforcer(cfg.budgets, state),
    pat: new PatRouter(cfg.pat_routing),
    logger: QUIET,
    runLead: async () => {
      git(["remote", "set-url", "origin", world.origin], world.bare);
      worktree = await world.adapter.allocate({
        repoFullName: "o/r", baseBranch: "main", sessionBranch: "harness/feat-x",
        sessionId: `pending-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        ghToken: "", commitIdentity: IDENT,
      });
      return { repo: "o/r", branch: "harness/feat-x", worktreePath: worktree, reviewChecklist: [], riskLevel: "low", approxCostUsd: 0,
        subTasks: [
          { seq: 1, title: "inspect the workbook", intent: "report the header row and the tenant mechanism",
            filesLikelyTouched: [], successCriteria: ["headers reported"], estimatedTokens: 100,
            taskMode: "observe", contractScope: "local", verify: [] },
          { seq: 2, title: "write the schema", intent: "add it", filesLikelyTouched: ["src/lib/schema.ts"],
            dependsOn: [1], successCriteria: ["file written"], estimatedTokens: 100, taskMode: "mutate",
            verify: [{ kind: "file_written", path: "src/lib/schema.ts" }, { kind: "commit_made" }] },
        ] };
    },
    runWorker: async ({ subTask, dispatchHint }) => {
      if (subTask.taskMode === "observe") {
        hints.push(dispatchHint ?? "");
        const finalMessage = messages[Math.min(turn++, messages.length - 1)];
        return { status: "completed", filesChanged: [], costUsd: 0.01, tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage };
      }
      mkdirSync(dirname(join(worktree, "src/lib/schema.ts")), { recursive: true });
      writeFileSync(join(worktree, "src/lib/schema.ts"), "export const x = 1;\n");
      const sha = await world.adapter.commit(worktree, "harness(2): schema", IDENT);
      return { status: "completed", filesChanged: ["src/lib/schema.ts"], commitSha: sha, costUsd: 0.01,
        tokensIn: 1, tokensOut: 1, reason: "end_turn", finalMessage: "done" };
    },
    runAdversary: async () => ({ verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 }),
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1",
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
    buildVerifyProbes: () => ({
      remoteBranchExists: async () => ({ exists: false, detail: "" }),
      prUrlPresent: async () => ({ present: false, detail: "" }),
      fileWrittenSince: async (p) => ({ written: existsSync(join(worktree, p)), detail: "" }),
      fileExistsOnDisk: async (p) => {
        const ok = existsSync(join(worktree, p));
        return { exists: ok, nonEmpty: ok, detail: "" };
      },
      commitMadeSince: async (base) => ({ made: git(["rev-parse", "HEAD"], worktree) !== base, detail: "" }),
      fileCommittedSince: async (p, base) => {
        const out = git(["log", `${base}..HEAD`, "--name-only", "--pretty=format:"], worktree);
        const hit = out.split("\n").map((x) => x.trim()).includes(p);
        return { committed: hit, detail: "", diffLines: hit ? 5 : 0 };
      },
    }),
    releaseWorktree: async () => ({ ok: true, path: worktree }),
    worktreeHeadSha: async (p) => git(["rev-parse", "HEAD"], p),
    worktreeMergeBase: async (p) => git(["merge-base", "HEAD", "origin/main"], p),
    unreachableCommits: async (p, from, shas) => world.adapter.unreachableCommits(p, from, shas),
    listRepoFiles: async (p) => world.adapter.listTrackedFiles(p),
    worktreeCommittedFiles: async (p, base) => world.adapter.listCommittedFiles(p, base),
  });

  const out = await loop.run("S1", BRIEF);
  return { out, audits, hints,
    session: () => db.prepare(`SELECT * FROM sessions WHERE id='S1'`).get(),
    subTaskRows: () => db.prepare(`SELECT seq, cycle, status, summary FROM sub_tasks WHERE session_id='S1' ORDER BY cycle, seq`).all(),
    sawEvent: (n) => audits.some((a) => a.event === n),
    events: (n) => audits.filter((a) => a.event === n) };
}

test("rc2: an observe sub-task that only narrates is retried, not completed", { skip }, async () => {
  // Narration first, findings second.
  const s = await observeRun([NARRATION, "The header row is row 3; tenancy is a per-row tenantId column."]);

  assert.ok(s.sawEvent("loop.worker_noop_end_turn"), "the narration is recognised for what it is");
  assert.ok(s.sawEvent("loop.worker_protocol_retry"));
  assert.equal(s.hints.length, 2, "the probe ran twice");
  assert.match(s.hints[1], /the REPORT is the deliverable/);
  assert.match(s.hints[1], /State what you FOUND/);
  // And the retry's real findings are what count.
  assert.ok(s.sawEvent("loop.subtask_observe_completed"));
  assert.equal(s.subTaskRows().find((r) => r.seq === 1).status, "completed");
});

test("rc2: narration never reaches a dependent sub-task as findings", { skip }, async () => {
  const s = await observeRun([NARRATION, "The header row is row 3."]);
  const recorded = s.events("loop.observe_report_recorded");
  for (const e of recorded) {
    assert.doesNotMatch(e.payload.report ?? "", /Now let me check/, "a stated intention is not a finding");
  }
});

test("rc2: an observe sub-task that will only ever narrate fails cleanly", { skip }, async () => {
  const s = await observeRun([NARRATION]);

  assert.ok(s.sawEvent("loop.worker_retry_exhausted"));
  assert.equal(s.session().status !== "awaiting_clarification", true, "there is no question for a human here");
  const row = s.subTaskRows().find((r) => r.seq === 1);
  assert.equal(row.status, "failed_verification");
  assert.match(row.summary, /rather than what it found/);
  // b100's rule holds here too: the narration itself is a record on the audit
  // event, never prose shown to a person.
  assert.doesNotMatch(row.summary, /Now let me check/);
  const ex = s.events("loop.worker_retry_exhausted")[0].payload;
  assert.equal(ex.taskMode, "observe");
  assert.ok(ex.retryCount >= 1, "the record says how hard it tried");
});

test("rc2: a substantive report on the first turn is not retried", { skip }, async () => {
  const s = await observeRun(["The header row is row 3; tenancy is a per-row tenantId column."]);
  assert.equal(s.sawEvent("loop.worker_protocol_retry"), false);
  assert.equal(s.hints.length, 1, "one turn, no correction");
  assert.equal(s.subTaskRows().find((r) => r.seq === 1).status, "completed");
});

test("rc2: the observe retry budget honours the configured limit", { skip }, async () => {
  const s = await observeRun([NARRATION], { loop: { worker_protocol_max_attempts: 2 } });
  assert.equal(s.hints.length, 2, "one initial turn plus one retry");
  assert.ok(s.sawEvent("loop.worker_retry_exhausted"));
});

// ---------------------------------------------------------------------------
// 5. Say which model actually ran
// ---------------------------------------------------------------------------

test("rc2: the Anthropic price check only asks about roles on Anthropic", () => {
  const src = S("src/index.ts");
  const block = src.slice(src.indexOf("// rc.2: only the roles that actually run on Anthropic"));
  assert.match(block, /runtime\.effectiveBackendRoutes \?\? \[\]/);
  assert.match(block, /filter\(\(r\) => r\.backend === "claude-code"\)/);
  // The offending line: four hardcoded Claude ids, warned about regardless of
  // where the roles actually ran.
  assert.doesNotMatch(
    block.slice(0, block.indexOf("const apiKey")),
    /config\.models\.lead, config\.models\.worker/,
  );
});

test("rc2: skipping the price check must not skip the rest of bootstrap", () => {
  const src = S("src/index.ts");
  const block = src.slice(
    src.indexOf("// rc.2: only the roles that actually run on Anthropic"),
    src.indexOf("model pricing health check failed (non-fatal)"),
  );
  assert.doesNotMatch(block, /^\s+return;$/m, "an early return here would skip ~1000 lines of boot");
});

test("rc2: the startup route table names the model for every role", () => {
  const src = S("src/index.ts");
  assert.match(src, /const routes = backendRouter\.describe\(legacyModelForRole\)/);
  assert.match(src, /state\.audit\("backend\.routes", \{ roles: routes \}/);
});

test("rc2: an unpriced-model audit names the roles it is talking about", () => {
  const src = S("src/index.ts");
  assert.match(src, /harness\.model_pricing_unpriced[\s\S]{0,200}anthropicRoles/);
});

// ---------------------------------------------------------------------------
// 6. Temp files without `rm`
// ---------------------------------------------------------------------------

test("rc2: the scratch directory is excluded from git, so it cannot be committed", () => {
  assert.ok(HARNESS_EXCLUDE_PATTERNS.includes(`${HARNESS_SCRATCH_DIR}/`));
  assert.equal(isHarnessScratch(`${HARNESS_SCRATCH_DIR}/inspect.mjs`), true);
  assert.equal(isHarnessScratch(`./${HARNESS_SCRATCH_DIR}/deep/one.py`), true);
  assert.equal(isHarnessScratch("src/harness-scratch.ts"), false, "a real source file is not scratch");
});

test("rc2: a scratch file left behind is swept, and never lands in a commit", { skip }, async () => {
  const world = await makeWorld({ files: { "README.md": "# seed\n" } });
  git(["remote", "set-url", "origin", world.origin], world.bare);
  const wt = await world.adapter.allocate({
    repoFullName: "o/r", baseBranch: "main", sessionBranch: "harness/scratch",
    sessionId: "S1", ghToken: "", commitIdentity: IDENT,
  });

  // Exactly what the retry prompt now tells a worker to do: write a script,
  // run it, and leave it.
  mkdirSync(join(wt, HARNESS_SCRATCH_DIR), { recursive: true });
  writeFileSync(join(wt, HARNESS_SCRATCH_DIR, "inspect.mjs"), "console.log('headers');\n");
  writeFileSync(join(wt, "src.txt"), "real work\n");

  const sha = await world.adapter.commit(wt, "harness: real work", IDENT);
  assert.ok(sha, "the real work commits");

  const committed = git(["show", "--name-only", "--pretty=format:", sha], wt).split("\n").map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(committed, ["src.txt"], "the scratch script is not in the commit");
  assert.equal(existsSync(join(wt, HARNESS_SCRATCH_DIR)), false, "and it is gone from the worktree");
  // b94 raises an undeclared committed file as a blocking out-of-scope finding,
  // which the worker could then never close: it is not allowed to `rm`.
  assert.equal(git(["status", "--porcelain"], wt).trim(), "", "nothing left for the loop to read as unfinished work");
});

test("rc2: the retry prompt sends the worker to scratch and never asks it to rm", () => {
  const src = S("src/orchestrator/worker-outcome.ts");
  const block = src.slice(src.indexOf("const RECOVERIES"), src.indexOf("const BLOCKERS"));
  assert.match(block, /HARNESS_SCRATCH_DIR/);
  // The prompt shipped with the previous fix said "then delete it" -- an
  // instruction the bash guard denies, so following it produced another denial.
  assert.doesNotMatch(block, /then delete it/);
  assert.match(block, /Leave it/);
});

test("rc2: the bash guard is untouched -- rm stays denied, running a script does not", async () => {
  const { guardCommand, defaultGuardConfig } = await import("../dist/safety/bash-guard.js");
  const cfg = defaultGuardConfig();

  const removal = guardCommand(`rm ${HARNESS_SCRATCH_DIR}/inspect.mjs`, cfg);
  assert.equal(removal.allowed, false, "recovery must not need rm, and rm must stay denied");
  // Rejected by the whitelist before the denylist even gets a turn; both gates
  // are in place, and the recovery path must clear neither of them.
  assert.match(removal.reason ?? "", /"rm"/);

  assert.equal(guardCommand(`node ${HARNESS_SCRATCH_DIR}/inspect.mjs`, cfg).allowed, true,
    "but running the script from scratch is ordinary and permitted");
  // And the denial that started all of this is still a denial.
  assert.equal(guardCommand(`python3 -c 'import openpyxl'`, cfg).allowed, false);
});

test("rc2: the worker prompt teaches scratch up front, not only on recovery", () => {
  const src = S("src/orchestrator/worker.ts");
  assert.match(src, /write a script to '\$\{HARNESS_SCRATCH_DIR\}\/' and run it from there/);
  assert.match(src, /'rm' is denied and you do not need it/);
});
