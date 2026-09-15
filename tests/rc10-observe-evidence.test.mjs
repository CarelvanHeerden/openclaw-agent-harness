// rc.10 (F4) — an observe prerequisite that inspected nothing is not complete.
//
// The incident (session aad3fc57, 15 September Client Offboarding smoke test):
// sub-task 1 was a read-only probe. Its four attempts to delegate the reading
// to nested agents were all denied by the guard (audits 5572-5575). It then
// ended the turn having read no file, written no file and made no commit, and
// its final message was a 280-character promise about what it was *going* to
// read:
//
//   "I'll split the read-only probe across repository conventions/
//    specification, identity/audit contracts, SDK capabilities, and test
//    fixtures, then consolidate exact paths, line ranges, excerpts, and
//    blockers. No files, dependencies, external systems, or git history will
//    be modified."
//
// That was recorded as the sub-task's findings (5577, 5578), the sub-task was
// marked complete, and the report was handed verbatim to two dependent workers
// (5579, 5587) whose prompts tell them not to re-explore the repository. They
// planned against a prerequisite that had produced nothing.
//
// Two independent defects, and the distinction is the point of this file:
//
//   1. The narration detector missed the message. Partly a missing shape (the
//      bare "I'll ..." with no leading adverb) and -- the part worth dwelling
//      on -- a right single quotation mark. The worker wrote "I’ll"; every
//      pattern in worker-outcome.ts spells the apostrophe "'". One character
//      defeated the whole table, including the refusal rules.
//
//   2. Even with both of those fixed the full message still is not narration,
//      because its last sentence ("No files ... will be modified") is a
//      truthful scope disclaimer, not an announcement. Which is the real
//      lesson: a detector that reads English will always have an edge, and
//      adding a "scope disclaimer" rule would be fitting to this one sample.
//
// So the load-bearing fix is not linguistic. unguardedReads was 0 in the same
// audit row that stored the report. A turn that read nothing, changed nothing
// and committed nothing has no findings, whatever its prose says, in whatever
// language, with whatever punctuation. The tests below assert the prose fix
// where it genuinely applies and assert the evidence rule for the incident.
import test from "node:test";
import assert from "node:assert/strict";
import { scenarioAvailable, runScenario, makeWorld, mutateSubTask, defaultWorker } from "./helpers/scenario.mjs";

let observeReportIsNarration, isProgressFragment, observeEvidenceVerdict, buildObserveEvidenceHint;
try {
  ({ observeReportIsNarration, isProgressFragment, observeEvidenceVerdict, buildObserveEvidenceHint } = await import(
    "../dist/orchestrator/worker-outcome.js"
  ));
} catch {
  observeEvidenceVerdict = undefined;
}
const skip = !observeEvidenceVerdict;
const skipScenario = (await scenarioAvailable()) ? false : "build missing";

/** The report as the worker actually wrote it, U+2019 and all. */
const INCIDENT_REPORT =
  "I\u2019ll split the read-only probe across repository conventions/specification, identity/audit contracts, " +
  "SDK capabilities, and test fixtures, then consolidate exact paths, line ranges, excerpts, and blockers. " +
  "No files, dependencies, external systems, or git history will be modified.";

/** The four denials the guard issued, in the shape acp.ts reports them. */
const NESTED_AGENT_DENIALS = Array.from({ length: 4 }, (_, i) => ({
  kind: "other",
  title: `task (probe ${i + 1})`,
  reason: "focused worker may not launch nested agents; use the direct read/edit/bash tools",
}));

// ---------------------------------------------------------------------------
// 1. The typographic apostrophe
// ---------------------------------------------------------------------------

test("rc.10 (F4): a curly apostrophe does not hide narration", { skip }, () => {
  // Same sentence, two apostrophes. Before the fix the first was caught and
  // the second was not, which is the entire difference between the detector
  // working and the incident.
  for (const apos of ["'", "\u2019"]) {
    assert.equal(isProgressFragment(`I${apos}ll now read the config`), true, `"I${apos}ll now" should be narration`);
    assert.equal(isProgressFragment(`Let${apos}s check the headers`), true, `"Let${apos}s" should be narration`);
  }
});

test("rc.10 (F4): the bare \"I'll ...\" form is narration", { skip }, () => {
  // The table required a leading adverb ("Next, I'll ...") or an explicit
  // "now". The incident had neither.
  assert.equal(isProgressFragment("I'll split the read-only probe across four areas"), true);
  assert.equal(isProgressFragment("I\u2019ll split the read-only probe across four areas"), true);
});

test("rc.10 (F4): widening the rule does not swallow a refusal", { skip }, () => {
  // "I will not" is the clearest thing a worker can say. A prefix rule on
  // "I will" that ate it would invert the bug rather than fix it -- and the
  // curly-apostrophe form has to survive too, since that fix touches the
  // refusal patterns as well.
  for (const apos of ["'", "\u2019"]) {
    assert.equal(isProgressFragment(`I will not modify the audit contract`), false);
    assert.equal(isProgressFragment(`I won${apos}t touch the offboarding SDK without approval`), false);
  }
  assert.equal(observeReportIsNarration("I will not proceed: the spec contradicts the acceptance criteria"), false);
});

test("rc.10 (F4): real findings are still findings", { skip }, () => {
  // The cost of a false positive here is a retry burnt on a worker that did
  // its job, so the ordinary shapes have to keep passing.
  const real =
    "Offboarding contracts live in src/contracts/offboarding.ts:40-118. The SDK exposes no revoke() " +
    "call; tests/fixtures/tenant.json is the only fixture with an audit id.";
  assert.equal(observeReportIsNarration(real), false);
  // Narration FOLLOWED by findings is findings -- the announcement is stripped.
  assert.equal(observeReportIsNarration(`I\u2019ll check the contracts. ${real}`), false);
});

test("rc.10 (F4): the incident message needs more than a prose rule", { skip }, () => {
  // Documenting the limit rather than papering over it. The trailing sentence
  // is a true statement about scope, so stripping narration leaves something
  // behind and the message is not classified as pure narration. Fitting a rule
  // to it would fit it to this one sample; the evidence check below is what
  // actually catches it.
  assert.equal(observeReportIsNarration(INCIDENT_REPORT), false);
  assert.equal(isProgressFragment(INCIDENT_REPORT.split(". ")[0]), true);
});

// ---------------------------------------------------------------------------
// 2. The evidence rule
// ---------------------------------------------------------------------------

test("rc.10 (F4, audits 5572-5578): zero reads and four denials is empty", { skip }, () => {
  const v = observeEvidenceVerdict({
    unguardedReads: 0,
    filesChanged: [],
    commitSha: null,
    deniedToolCalls: NESTED_AGENT_DENIALS,
  });
  assert.equal(v.empty, true);
  assert.equal(v.code, "denied_only");
  // The operator-facing reason has to name the cause, because "produced no
  // findings" alone sends someone looking at the model's diligence when the
  // actual event was the guard refusing a route four times.
  assert.match(v.reason, /denied \(4\)/);
  assert.match(v.deniedReason, /nested agents/);
});

test("rc.10 (F4): a turn that read nothing is empty even with no denials", { skip }, () => {
  const v = observeEvidenceVerdict({ unguardedReads: 0, filesChanged: [], commitSha: null, deniedToolCalls: [] });
  assert.equal(v.empty, true);
  assert.equal(v.code, "no_reads");
});

test("rc.10 (F4): one real read is enough -- this is not a quality bar", { skip }, () => {
  // The check answers "did it look?", not "did it look hard enough". The
  // second is a judgement and does not belong in a gate.
  assert.equal(observeEvidenceVerdict({ unguardedReads: 1, filesChanged: [], commitSha: null }).empty, false);
  // Denials alongside real reads are a partial probe, not an empty one: the
  // worker got some of what it needed and its report may be worth having.
  assert.equal(
    observeEvidenceVerdict({ unguardedReads: 12, filesChanged: [], commitSha: null, deniedToolCalls: NESTED_AGENT_DENIALS })
      .empty,
    false,
  );
});

test("rc.10 (F4): an observe turn that wrote or committed is not empty", { skip }, () => {
  // A probe should not be writing, but if it did, the turn plainly did
  // something and this is not the check that should object to it.
  assert.equal(observeEvidenceVerdict({ unguardedReads: 0, filesChanged: ["NOTES.md"], commitSha: null }).empty, false);
  assert.equal(observeEvidenceVerdict({ unguardedReads: 0, filesChanged: [], commitSha: "abc1234" }).empty, false);
});

test("rc.10 (F4): a backend that reports read PATHS is not accused of reading nothing", { skip }, () => {
  // The trap this fix nearly fell into. `unguardedReads` counts only the reads
  // the path denylist could NOT be applied to, so on a backend that supplies a
  // path with every read -- Codex does -- a turn that read forty files reports
  // unguardedReads: 0. A gate keyed on that field would fail every observe
  // sub-task there, and would get stricter as enforcement got better, which is
  // the wrong direction for a counter to move.
  assert.equal(
    observeEvidenceVerdict({ allowedToolCalls: 40, unguardedReads: 0, filesChanged: [], commitSha: null }).empty,
    false,
  );
  // A probe that only ran `rg` never "read" a file either, and still looked.
  assert.equal(observeEvidenceVerdict({ allowedToolCalls: 3, unguardedReads: 0 }).empty, false);
  // And the unenforceable-read backend the incident ran on still works: a
  // non-zero unguardedReads is positive evidence on its own, since it cannot
  // be non-zero unless a read happened.
  assert.equal(observeEvidenceVerdict({ unguardedReads: 7 }).empty, false);
});

test("rc.10 (F4): zero allowed tool calls is the actual incident shape", { skip }, () => {
  const v = observeEvidenceVerdict({
    allowedToolCalls: 0,
    unguardedReads: 0,
    filesChanged: [],
    commitSha: null,
    deniedToolCalls: NESTED_AGENT_DENIALS,
  });
  assert.equal(v.empty, true);
  assert.equal(v.code, "denied_only");
});

test("rc.10 (F4): a backend that does not count reads is not accused", { skip }, () => {
  // unguardedReads is reported by the ACP adapter. Absent the counter there is
  // no evidence either way, and inventing a verdict from its absence would
  // fail every turn on any other backend.
  assert.equal(observeEvidenceVerdict({ filesChanged: [], commitSha: null }).empty, false);
  assert.equal(observeEvidenceVerdict({ unguardedReads: undefined, deniedToolCalls: NESTED_AGENT_DENIALS }).empty, false);
});

test("rc.10 (F4): the retry hint names the route that is actually open", { skip }, () => {
  const args = { intent: "Report the offboarding contract paths", attempt: 2, maxAttempts: 3 };
  const hint = buildObserveEvidenceHint({
    ...args,
    verdict: observeEvidenceVerdict({
      unguardedReads: 0,
      filesChanged: [],
      commitSha: null,
      deniedToolCalls: NESTED_AGENT_DENIALS,
    }),
  });
  // Retrying with "please produce findings" against a worker whose tool route
  // was denied four times just buys four more denials. The hint has to carry
  // the denial reason so the next attempt takes the permitted route.
  assert.match(hint, /nested agents/);
  assert.match(hint, /read/i);
  // The probe's own question goes back in, so the retry has the target
  // rather than only a complaint about the last turn.
  assert.match(hint, /Report the offboarding contract paths/);

  const plain = buildObserveEvidenceHint({
    ...args,
    verdict: observeEvidenceVerdict({ unguardedReads: 0, filesChanged: [], commitSha: null }),
  });
  assert.match(plain, /read no files/i);
  // No denial happened, so the hint must not invent one.
  assert.doesNotMatch(plain, /DENIED/);
});

// ---------------------------------------------------------------------------
// 3. End to end: the prerequisite fails instead of releasing its dependents
// ---------------------------------------------------------------------------

const observeSubTask = (extra = {}) => ({
  seq: 1,
  title: "Probe the offboarding contracts",
  intent: "Report the exact paths and line ranges for the offboarding contracts",
  filesLikelyTouched: [],
  successCriteria: ["a written report naming real paths"],
  verify: [],
  estimatedTokens: 10,
  taskMode: "observe",
  ...extra,
});

test(
  "rc.10 (F4, audits 5577/5579): an empty probe fails and its dependents never run",
  { skip: skip || skipScenario },
  async () => {
    const workerSeqs = [];
    const res = await runScenario({
      configOver: { loop: { worker_protocol_max_attempts: 2 } },
      subTasks: [
        observeSubTask(),
        mutateSubTask({ seq: 2, title: "Apply the reported paths", path: "src/offboard.ts", extra: { dependsOn: [1] } }),
      ],
      worker: async ({ subTask }) => {
        workerSeqs.push(subTask.seq);
        return {
          status: "completed",
          filesChanged: [],
          commitShas: [],
          costUsd: 0.01,
          tokensIn: 10,
          tokensOut: 10,
          reason: "end_turn",
          finalMessage: INCIDENT_REPORT,
          unguardedReads: 0,
          deniedToolCalls: NESTED_AGENT_DENIALS,
        };
      },
    });

    // The probe is retried inside its protocol budget and then fails. What
    // must NOT happen is sub-task 2 running: in the incident it did, with a
    // prompt telling it not to re-explore and a "report" containing nothing.
    assert.ok(!workerSeqs.includes(2), `sub-task 2 must not be dispatched, saw ${JSON.stringify(workerSeqs)}`);
    assert.equal(workerSeqs.filter((s) => s === 1).length, 2, "the probe gets its retry before being failed");

    const rows = res.subTaskRows();
    const st1 = rows.find((r) => r.seq === 1);
    assert.equal(st1.status, "failed_verification");
    // The summary is what a human reads first. It must say the turn was
    // blocked, not that the model would not stop talking.
    assert.match(st1.summary, /denied/i);
    assert.notEqual(rows.find((r) => r.seq === 2)?.status, "completed");

    const exhausted = res.events("loop.worker_retry_exhausted");
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0].payload.evidenceCode, "denied_only");
    assert.equal(exhausted[0].payload.unguardedReads, 0);
    assert.equal(exhausted[0].payload.deniedToolCalls, 4);
  },
);

test(
  "rc.10 (F4): with the check off, the incident reproduces exactly",
  { skip: skip || skipScenario },
  async () => {
    // The before-picture, kept executable. Turning the flag off restores the
    // rc.9 behaviour, and what it produces is the incident: the empty probe is
    // marked complete and the dependent sub-task runs on nothing. If this ever
    // starts passing the fix has stopped being the thing that matters.
    const workerSeqs = [];
    const res = await runScenario({
      configOver: { loop: { observe_evidence_check_enabled: false, worker_protocol_max_attempts: 2 } },
      subTasks: [
        observeSubTask(),
        mutateSubTask({ seq: 2, title: "Apply the reported paths", path: "src/offboard.ts", extra: { dependsOn: [1] } }),
      ],
      worker: async (params) => {
        workerSeqs.push(params.subTask.seq);
        if (params.subTask.seq !== 1) return defaultWorker({ adapter: res.world.adapter })(params);
        return {
          status: "completed",
          filesChanged: [],
          commitShas: [],
          costUsd: 0.01,
          tokensIn: 10,
          tokensOut: 10,
          reason: "end_turn",
          finalMessage: INCIDENT_REPORT,
          unguardedReads: 0,
          deniedToolCalls: NESTED_AGENT_DENIALS,
        };
      },
    });

    assert.equal(res.subTaskRows().find((r) => r.seq === 1).status, "completed", "rc.9 accepted the empty probe");
    assert.ok(workerSeqs.includes(2), "rc.9 released the dependent sub-task");
  },
);

test(
  "rc.10 (F4): a probe that reads on its retry passes, and its report is handed down",
  { skip: skip || skipScenario },
  async () => {
    // The gate has to be an actual gate, not a wall: the retry exists to give
    // a blocked worker a second route, and taking it must work.
    const FINDINGS =
      "Offboarding contracts live in src/contracts/offboarding.ts:40-118. The SDK exposes no revoke() call.";
    const world = await makeWorld({
      files: { "README.md": "# seed\n", "src/contracts/offboarding.ts": "export const x = 1;\n" },
    });
    let attempt = 0;
    const promptsSeenBySeq2 = [];

    const res = await runScenario({
      world,
      configOver: { loop: { worker_protocol_max_attempts: 3 } },
      subTasks: [
        observeSubTask(),
        mutateSubTask({ seq: 2, title: "Apply the reported paths", path: "src/offboard.ts", extra: { dependsOn: [1] } }),
      ],
      worker: async (params) => {
        const { subTask } = params;
        if (subTask.seq !== 1) {
          // Record everything the dependent was given, so the assertion is
          // about what actually reached it rather than about an internal call.
          promptsSeenBySeq2.push(JSON.stringify(params));
          return defaultWorker({ adapter: world.adapter })(params);
        }
        attempt += 1;
        const blocked = attempt === 1;
        return {
          status: "completed",
          filesChanged: [],
          commitShas: [],
          costUsd: 0.01,
          tokensIn: 10,
          tokensOut: 10,
          reason: "end_turn",
          finalMessage: blocked ? INCIDENT_REPORT : FINDINGS,
          unguardedReads: blocked ? 0 : 9,
          deniedToolCalls: blocked ? NESTED_AGENT_DENIALS : [],
        };
      },
    });

    assert.equal(attempt, 2, "the probe is retried exactly once and then succeeds");
    const rows = res.subTaskRows();
    assert.equal(rows.find((r) => r.seq === 1).status, "completed");

    // And what the dependent receives is the real findings, not the promise
    // that preceded them.
    assert.ok(promptsSeenBySeq2.length > 0, "sub-task 2 ran");
    const handed = promptsSeenBySeq2.join("\n");
    assert.ok(handed.includes("offboarding.ts:40-118"), "the dependent sees the real findings");
    assert.ok(!handed.includes("split the read-only probe"), "the dependent never sees the promise");
  },
);

// ---------------------------------------------------------------------------
// 4. The flag
// ---------------------------------------------------------------------------

test("rc.10 (F4): the check is on by default", { skip }, async () => {
  // A defect this quiet -- an empty report accepted and passed downstream --
  // is only fixed if the fix is on without anyone opting in.
  const { parseHarnessConfig } = await import("../dist/config.js");
  const cfg = parseHarnessConfig({
    slack: { channel: "C1", authorised_users: ["U1"] },
    repos: { allowed: ["example-org/*"], default_base_branch: "main" },
  });
  assert.equal(cfg.loop.observe_evidence_check_enabled, true);
});
