// beta.131 -- the repair cycle that could never have worked.
//
// Session 03a8a7b6 was the first run to get all the way through b127's CI
// repair path in anger. It built the feature in two cycles for $10.09, pushed
// PR #1068, watched CI go red, GRANTED itself a repair cycle, spent about $3
// re-running all seven sub-tasks -- and left CI red on the same assertion it
// started with.
//
// The audit said why, twice, and nobody was listening: `1 CI finding(s),
// unrouted`. The finding was `file: null, adoptedBySeq: null`. A red build was
// handed to everybody as background reading and owned by nobody.
//
// The cause is one filter, three hops upstream. `readFailingJobLogs` asked
// GitHub "which workflow runs for this sha concluded as FAILED?" -- but a run's
// conclusion stays null until every job in it finishes, while check-runs, which
// are what wake the harness, conclude per job. Measured on the live run: the
// Tests job concluded 10:29:05Z, the harness ruled 10:29:28Z, the run did not
// conclude until 10:30:34Z. Sixty-six seconds too early, every single time. So
// the fallback found nothing, the caller fell back to the check-runs text --
// the bare string "- Tests [failure]" -- and every downstream component did
// exactly its job on a diagnosis that named no file.
//
// b127's own tests passed throughout, because the fixture said the run had
// concluded "failure". That shape is real; it is just never the shape present
// at the moment this code runs.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

let gh, ciFindings;
try {
  gh = await import("../dist/adapters/github.js");
  ciFindings = await import("../dist/orchestrator/ci-findings.js");
} catch {
  gh = null;
  ciFindings = null;
}
const skipDist = gh === null ? "build not present (npm run build)" : false;

const loadScenario = async () => {
  const mod = await import("./helpers/scenario.mjs");
  return (await mod.scenarioAvailable()) ? mod : null;
};

// ---------------------------------------------------------------------------
// Fixtures, taken from the live run rather than imagined.
// ---------------------------------------------------------------------------

/** The real job log, timestamps and all, as the Actions API serves it. */
const JOB_LOG =
  "2026-08-18T10:25:32.1353795Z Summary of all failing tests\n" +
  "2026-08-18T10:25:32.1355079Z FAIL src/__tests__/components/sidebar-nav-placement.test.ts\n" +
  "2026-08-18T10:25:32.1356000Z   ● InfoSec GRC ordering › groups the AI system register with the other inventories\n" +
  "2026-08-18T10:25:32.1357000Z     expect(received).toBe(expected)\n" +
  "2026-08-18T10:25:32.1358000Z     Expected: 2\n" +
  "2026-08-18T10:25:32.1359000Z     Received: 3\n";

const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const textRes = (body) => ({
  ok: true, status: 200, headers: new Map([["content-length", String(body.length)]]),
  json: async () => ({}), text: async () => body, body: {},
});

function stubFetch(routes) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    for (const [pat, handler] of routes) if (String(url).includes(pat)) return handler(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { restore: () => { globalThis.fetch = orig; }, seen };
}

/** Actions check-runs with no output at all -- the live shape that starts this. */
const CHECKS_NO_DETAIL = ["/check-runs", () => json({ check_runs: [{ name: "Tests", conclusion: "failure" }] })];

// ---------------------------------------------------------------------------
// 1. The race. This is the whole defect.
// ---------------------------------------------------------------------------

test("a run STILL RUNNING is read (b131): its conclusion is null while the job is already red", { skip: skipDist }, async () => {
  // The exact live moment: Tests has failed, Build has not finished, so the
  // run carries no conclusion yet. Pre-b131 this returned "" and the caller
  // shipped "- Tests [failure]" to a human told not to merge.
  const { restore } = stubFetch([
    CHECKS_NO_DETAIL,
    ["/actions/runs?head_sha", () => json({
      workflow_runs: [{ id: 7, name: "CI", conclusion: null, status: "in_progress" }],
    })],
    ["/actions/runs/7/jobs", () => json({
      jobs: [
        { id: 98, name: "Build", conclusion: null },
        { id: 99, name: "Tests", conclusion: "failure" },
      ],
    })],
    ["/actions/jobs/99/logs", () => textRes(JOB_LOG)],
  ]);
  try {
    const out = await gh.getFailingCheckLogs({ repoFullName: "o/r", sha: "c7b50253", ghToken: "t" });
    assert.match(out, /sidebar-nav-placement/, "the failing test file must survive the trip");
    assert.match(out, /Expected: 2/);
    assert.doesNotMatch(out, /^- Tests \[failure\]$/, "the bare check-run name is not a diagnosis");
  } finally { restore(); }
});

test("a run that concluded GREEN is not read (b131): there is nothing in it to find", { skip: skipDist }, async () => {
  const { restore, seen } = stubFetch([
    CHECKS_NO_DETAIL,
    ["/actions/runs?head_sha", () => json({
      workflow_runs: [
        { id: 5, name: "Secret Scan", conclusion: "success" },
        { id: 6, name: "Code Quality", conclusion: "success" },
        { id: 7, name: "CI", conclusion: null, status: "in_progress" },
      ],
    })],
    ["/actions/runs/7/jobs", () => json({ jobs: [{ id: 99, name: "Tests", conclusion: "failure" }] })],
    ["/actions/jobs/99/logs", () => textRes(JOB_LOG)],
  ]);
  try {
    const out = await gh.getFailingCheckLogs({ repoFullName: "o/r", sha: "c7b50253", ghToken: "t" });
    assert.match(out, /sidebar-nav-placement/);
    // Only two runs are ever read. Scanning the green ones would spend that
    // budget on runs that cannot contain a failing job.
    assert.ok(!seen.some((u) => u.includes("/actions/runs/5/jobs")), "a green run must not be scanned");
    assert.ok(!seen.some((u) => u.includes("/actions/runs/6/jobs")), "a green run must not be scanned");
  } finally { restore(); }
});

test("a run KNOWN to have failed is read before one still in flight (b131)", { skip: skipDist }, async () => {
  // Only the first two candidates are read, so ordering decides whether the
  // failing job is reached at all when a sha has several runs.
  const { restore, seen } = stubFetch([
    CHECKS_NO_DETAIL,
    ["/actions/runs?head_sha", () => json({
      workflow_runs: [
        { id: 1, name: "A", conclusion: null, status: "in_progress" },
        { id: 2, name: "B", conclusion: null, status: "in_progress" },
        { id: 3, name: "CI", conclusion: "failure" },
      ],
    })],
    ["/actions/runs/3/jobs", () => json({ jobs: [{ id: 99, name: "Tests", conclusion: "failure" }] })],
    ["/actions/runs/1/jobs", () => json({ jobs: [] })],
    ["/actions/runs/2/jobs", () => json({ jobs: [] })],
    ["/actions/jobs/99/logs", () => textRes(JOB_LOG)],
  ]);
  try {
    const out = await gh.getFailingCheckLogs({ repoFullName: "o/r", sha: "c7b50253", ghToken: "t" });
    assert.match(out, /sidebar-nav-placement/, "the definite failure must be read even when listed last");
    assert.ok(seen.some((u) => u.includes("/actions/runs/3/jobs")));
  } finally { restore(); }
});

test("end to end (b131): the live log becomes a finding that names its file", { skip: skipDist }, async () => {
  // The point of the fix. Everything below this line already worked; none of
  // it had ever been called with anything but "- Tests [failure]".
  const { restore } = stubFetch([
    CHECKS_NO_DETAIL,
    ["/actions/runs?head_sha", () => json({ workflow_runs: [{ id: 7, name: "CI", conclusion: null }] })],
    ["/actions/runs/7/jobs", () => json({ jobs: [{ id: 99, name: "Tests", conclusion: "failure" }] })],
    ["/actions/jobs/99/logs", () => textRes(JOB_LOG)],
  ]);
  try {
    const logs = await gh.getFailingCheckLogs({ repoFullName: "o/r", sha: "c7b50253", ghToken: "t" });
    const findings = ciFindings.buildCiFailureFindings(logs, { sha: "c7b50253" });
    assert.equal(findings.length, 1);
    assert.equal(
      findings[0].file,
      "src/__tests__/components/sidebar-nav-placement.test.ts",
      "a finding with no file is a finding no sub-task can own",
    );
    const described = ciFindings.describeCiFindings(findings);
    assert.doesNotMatch(described, /unrouted/, "this is the string the live run printed twice");
    assert.match(described, /across 1 file/);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// 2. The sub-task that owns an unroutable failure.
// ---------------------------------------------------------------------------

/** A failure with no repo path anywhere in it -- the genuinely unroutable case. */
const NO_FILE_LOG = "##[error]Process completed with exit code 1.";

test("an unroutable CI failure produces a finding with no file (b131 premise)", { skip: skipDist }, async () => {
  const findings = ciFindings.buildCiFailureFindings(NO_FILE_LOG, { sha: "deadbeef" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, null, "nothing in that log names a file, and pretending otherwise is worse");
  assert.match(ciFindings.describeCiFindings(findings), /unrouted/);
});

test("the repair brief carries the log verbatim and forbids weakening the test (b131)", { skip: skipDist }, async () => {
  const intent = ciFindings.renderCiRepairIntent("Expected: 2\nReceived: 3");
  assert.match(intent, /Expected: 2/, "the evidence is the only thing this sub-task has");
  assert.match(intent, /Received: 3/);
  assert.match(intent, /not limited to any declared file scope/i);
  assert.match(intent, /do NOT delete, skip, rename or weaken a test/i);
});

function ciEdge(states, logs) {
  const seen = [];
  return {
    seen,
    ciSnapshot: async ({ sha }) => {
      const state = states[Math.min(seen.length, states.length - 1)];
      seen.push({ sha, state });
      return {
        state, checkTotal: 1, checksReadable: true, statusReadable: true,
        reason: `test says ${state}`, checksSource: "check_runs",
      };
    },
    ciFailingLogs: async () => logs,
  };
}

function countingWorker() {
  let n = 0;
  return async (params, { world }) => {
    n += 1;
    const { subTask, worktreePath, plan } = params;
    const wt = worktreePath ?? plan.worktreePath;
    const written = [];
    // A sub-task with no declared scope still has to change something, or the
    // cycle is a no-op and proves nothing about whether it ran.
    const targets = (subTask.filesLikelyTouched ?? []).length
      ? subTask.filesLikelyTouched
      : [`src/ci-repair-${subTask.seq}.ts`];
    for (const rel of targets) {
      const abs = join(wt, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `// ${subTask.title}\nexport const x${subTask.seq} = ${n};\n`);
      written.push(rel);
    }
    const commitSha = await world.adapter.commit(wt, `fix(${subTask.seq}): pass ${n}`, { name: "t", email: "t@e.c" });
    return {
      status: "completed", filesChanged: written, commitSha,
      commitShas: [commitSha], costUsd: 0.01, tokensIn: 10, tokensOut: 10,
      reason: "end_turn", finalMessage: "done",
    };
  };
}

const PASSES = async () => ({
  verdict: "pass", findings: [], summary: "looks right", costUsd: 0.02, tokensIn: 1, tokensOut: 1,
});

/** Roomy clock and budget: nothing but routing should decide anything here. */
const ROOMY = { max_cycles: 1, session_hard_timeout_seconds: 600, time_extension_wait_seconds: 0 };

test("an unroutable red build gets its OWN sub-task (b131), not everyone's peripheral vision", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const r = await scenario.runScenario({
    configOver: { loop: ROOMY, ci: { max_repair_cycles: 1, poll_interval_seconds: 1 } },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1068",
    deps: ciEdge(["failure", "success"], NO_FILE_LOG),
  });

  const added = r.events("loop.ci_repair_subtask_added");
  assert.equal(added.length, 1, "a red build nobody owns must be given an owner");
  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1);

  // b124's lesson, again: a sub-task that exists but never runs is decoration.
  const rows = r.db
    .prepare(`SELECT cycle, seq, description, status FROM sub_tasks WHERE session_id = 'S1' ORDER BY cycle, seq`)
    .all();
  const repair = rows.filter((x) => x.description === ciFindings.CI_REPAIR_SUBTASK_TITLE);
  assert.equal(repair.length, 1, "and it must actually be dispatched, not just appended to the plan");
  assert.equal(repair[0].cycle, 2, "on the repair cycle");
  assert.equal(repair[0].status, "completed");
});

test("a red build that DOES name a file is left to its owner (b131)", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const r = await scenario.runScenario({
    configOver: { loop: ROOMY, ci: { max_repair_cycles: 1, poll_interval_seconds: 1 } },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1068",
    deps: ciEdge(["failure", "success"], JOB_LOG.replace(/^\S+Z /gm, "")),
  });

  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1, "a routable failure still buys its cycle");
  assert.equal(
    r.events("loop.ci_repair_subtask_added").length,
    0,
    "the existing router reaches the owner with its context; a cold worker is worse",
  );
});

test("the repair sub-task can be switched off (b131)", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  const r = await scenario.runScenario({
    configOver: {
      loop: ROOMY,
      ci: { max_repair_cycles: 1, poll_interval_seconds: 1, repair_subtask_enabled: false },
    },
    worker: countingWorker(),
    runAdversary: PASSES,
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1068",
    deps: ciEdge(["failure", "success"], NO_FILE_LOG),
  });

  assert.equal(r.events("loop.ci_repair_cycle_granted").length, 1);
  assert.equal(r.events("loop.ci_repair_subtask_added").length, 0, "b127 broadcast behaviour must remain reachable");
});

// ---------------------------------------------------------------------------
// 3. The decline reason. It named the wrong constraint.
// ---------------------------------------------------------------------------

test("an exhausted ceiling is reported as the CEILING, even when the clock is short too (b131)", async (t) => {
  const scenario = await loadScenario();
  if (!scenario) return t.skip("git/scenario harness unavailable");

  // 03a8a7b6's exact shape: repair granted once, CI red again, ceiling spent
  // AND the clock short. Pre-b131 the ladder tested the clock first and called
  // it `wall_clock`, which b130's report then read as "shipped red without
  // asking" -- a regression report about a refusal that was correct.
  //
  // Staged rather than raced: review 1 is quick, so the first grant happens on
  // a healthy clock; review 2 eats the rest of the ceiling, so the second
  // refusal has BOTH constraints failing and has to choose which to name. Both
  // verdicts pass, so b129's "a verdict outranks the clock" rule carries the
  // run to the ship gate instead of aborting it.
  let reviews = 0;
  const r = await scenario.runScenario({
    configOver: {
      loop: { max_cycles: 1, session_hard_timeout_seconds: 6, time_extension_wait_seconds: 0 },
      ci: { max_repair_cycles: 1, poll_interval_seconds: 1 },
    },
    worker: countingWorker(),
    runAdversary: async () => {
      reviews += 1;
      await new Promise((res) => setTimeout(res, reviews === 1 ? 50 : 3200));
      return { verdict: "pass", findings: [], summary: "ok", costUsd: 0.02, tokensIn: 1, tokensOut: 1 };
    },
    pushBranchAndOpenPr: async () => "https://github.com/o/r/pull/1068",
    deps: ciEdge(["failure"], JOB_LOG.replace(/^\S+Z /gm, "")),
  });

  const declined = r.events("loop.ci_repair_declined");
  assert.ok(declined.length >= 1, "the second red build must be declined and say so");
  const last = declined.at(-1).payload;
  assert.equal(last.granted, 1, "the ceiling had already been spent");
  assert.equal(last.ceilingOk, false);
  assert.equal(last.reason, "ceiling", "naming the clock here is what made b130's report cry wolf");
  assert.ok(last.blockers.includes("ceiling"), "and every failing constraint must be listed");
});

// ---------------------------------------------------------------------------
// 4. The report that would have called all of the above a regression.
// ---------------------------------------------------------------------------

test("the report does not call a ceiling-blocked refusal a b130 regression (b131)", { skip: skipDist }, async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/smoke-report.mjs", import.meta.url), "utf8");

  // The predicate must be derived from the individual flags, not from `reason`
  // -- audit rows written before b131 carry the buggy label and still have to
  // be read correctly.
  assert.match(src, /clockWasTheOnlyBlocker/, "the report needs a notion of 'the clock was the ONLY blocker'");
  assert.match(src, /ceilingWasOk/);
  assert.doesNotMatch(
    src,
    /reason === "wall_clock"\)\s*\{\s*\n\s*console\.log\(`   operator asked for time/,
    "keying the ask-check off `reason` alone is the bug this test exists to stop coming back",
  );

  // And the "shipped RED WITHOUT ASKING" alarm must be gated on the same thing.
  const alarmAt = src.indexOf("shipped RED WITHOUT ASKING");
  assert.ok(alarmAt > 0, "the b130 alarm must still exist -- it is right, when it applies");
  const gate = src.slice(Math.max(0, alarmAt - 1200), alarmAt);
  assert.match(gate, /clockWasTheOnlyBlocker/, "the alarm must only fire when time would actually have helped");
});
