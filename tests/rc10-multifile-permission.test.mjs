// rc.10 (audits 5583/5589) — multi-file edit permission metadata.
//
// Twice in the 15 September smoke test a permission request arrived whose path
// was one string naming two files:
//
//   5583  "prisma/schema.prisma, prisma/migrations/20260915170000_client_
//          offboarding_workflow_persistence/migration.sql"
//   5589  "src/lib/config/stitchguard-config.ts, src/lib/it/client-offboarding-
//          slack.ts"
//
// Both were refused as `path_unresolvable`, and that refusal is right: a string
// naming two files cannot be judged against a per-path policy, filenames may
// legitimately contain commas, and splitting on them would be guessing which
// file the operator's rules apply to. Nothing here relaxes that.
//
// What the report asked for was the cause, and the cause is embarrassing. The
// 5589 string is character-for-character `filesLikelyTouched[0] + ", " +
// filesLikelyTouched[1]` from that sub-task's stored plan, which is how
// worker.ts used to render the list into the prompt:
//
//   Files likely touched: src/lib/config/stitchguard-config.ts, src/lib/it/...
//
// The worker copied a prose list out of its own instructions and passed it as
// one argument. So the fix is upstream of the guard -- give the worker a list
// it cannot mistake for a path -- and the guard keeps failing closed for the
// batching a backend may still do on its own.
//
// These tests cover both halves, and the structured multi-file path the report
// asked to have exercised: several `locations[]` entries are several files, and
// each is judged on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let buildAcpGuard, acpPathsFromToolCall, resolvePathForPolicy, looksLikeMultiplePaths, parseHarnessConfig, buildWorkerSystemPrompt;
try {
  ({ buildAcpGuard, acpPathsFromToolCall } = await import("../dist/safety/bash-guard.js"));
  ({ resolvePathForPolicy, looksLikeMultiplePaths } = await import("../dist/safety/path-policy.js"));
  ({ parseHarnessConfig } = await import("../dist/config.js"));
  ({ buildWorkerSystemPrompt } = await import("../dist/orchestrator/worker.js"));
} catch {
  buildAcpGuard = null;
}
const skip = buildAcpGuard === null;

const DENY = skip
  ? []
  : parseHarnessConfig({
      slack: { channel: "C1", authorised_users: ["U1"] },
      repos: { allowed: ["example-org/*"], default_base_branch: "main" },
    }).safety.path_denylist;

const guard = (over = {}) =>
  buildAcpGuard({
    bash_whitelist: ["git"],
    bash_denylist_tokens: [],
    path_denylist: DENY,
    allow_git_push: false,
    allow_network_commands: false,
    ...over,
  });

/** The two strings exactly as the incident recorded them. */
const JOINED_5583 =
  "prisma/schema.prisma, prisma/migrations/20260915170000_client_offboarding_workflow_persistence/migration.sql";
const JOINED_5589 = "src/lib/config/stitchguard-config.ts, src/lib/it/client-offboarding-slack.ts";

// ---------------------------------------------------------------------------
// 1. The refusal stands, and now says what to do instead
// ---------------------------------------------------------------------------

test("rc.10 (audits 5583/5589): a joined path string is still refused", { skip }, async () => {
  const g = guard();
  for (const joined of [JOINED_5583, JOINED_5589]) {
    const v = await g({ kind: "edit", title: "2 files", locations: [{ path: joined }], rawInput: {} });
    assert.equal(v.allow, false);
    assert.equal(v.denial.code, "path_unresolvable");
    // Not path_denylisted: the harness does not know whether a rule applies,
    // which is a different and more honest thing to report.
    assert.match(v.reason, /2 files rather than one/);
  }
});

test("rc.10 (audits 5583/5589): the refusal names the shape that IS allowed", { skip }, async () => {
  // The worker was told "no" four times and never told what would work. The
  // guidance is not a relaxation -- one call per file is precisely the shape
  // that lets each path be judged against the policy.
  const v = await guard()({ kind: "edit", title: "2 files", locations: [{ path: JOINED_5589 }], rawInput: {} });
  assert.match(v.reason, /one call per file/i);
});

test("rc.10: a comma in a filename does not by itself make a list", { skip }, () => {
  // Splitting on commas is refused rather than attempted because commas are
  // legal in filenames. A comma with no following space is not even a
  // candidate, so these resolve normally.
  for (const p of ["src/data/a,b.csv", "notes/1,2,3.txt"]) {
    assert.equal(looksLikeMultiplePaths(p), false, `${p} has no ", " separator`);
    assert.equal(resolvePathForPolicy(p).refuse, undefined, `${p} is one file`);
  }
  // The separator the heuristic keys on is ", " where NO part contains
  // whitespace, which is what a machine-assembled list looks like and what a
  // human filename generally does not.
  assert.equal(looksLikeMultiplePaths("docs/Report, Final Version.pdf"), false, "a human filename has spaces in it");
  assert.equal(resolvePathForPolicy("docs/Report, Final Version.pdf").refuse, undefined);
  assert.equal(looksLikeMultiplePaths(JOINED_5583), true);
  assert.equal(looksLikeMultiplePaths(JOINED_5589), true);
});

test("rc.10: where the heuristic is wrong, it is wrong towards refusing", { skip }, () => {
  // Stating the cost out loud. "docs/report, final.md" is one legal file and
  // the guard refuses it, because every part is whitespace-free and so it is
  // indistinguishable from a two-item list. That is the deliberate direction:
  // the alternative reading of an ambiguous string is to apply the wrong
  // policy to a real file, and a refusal an operator can override beats a
  // silent misjudgement. It is asserted rather than left implicit so the
  // trade-off is visible if anyone revisits it.
  const r = resolvePathForPolicy("docs/report, final.md");
  assert.match(r.refuse ?? "", /2 files rather than one/);
  assert.match(r.refuse ?? "", /one call per file/i);
});

// ---------------------------------------------------------------------------
// 2. Structured multi-file metadata: several locations are several files
// ---------------------------------------------------------------------------

test("rc.10: several locations[] entries are authorised independently", { skip }, async () => {
  const call = {
    kind: "edit",
    title: "2 files",
    locations: [{ path: "src/lib/config/stitchguard-config.ts" }, { path: "src/lib/it/client-offboarding-slack.ts" }],
    rawInput: {},
  };
  // The extractor sees two paths, not one string.
  assert.deepEqual(acpPathsFromToolCall(call).sort(), [
    "src/lib/config/stitchguard-config.ts",
    "src/lib/it/client-offboarding-slack.ts",
  ]);
  const v = await guard()(call);
  assert.equal(v.allow, true, "two ordinary source files are a normal multi-file edit");
});

test("rc.10: one denylisted file in a structured batch denies the batch, by name", { skip }, async () => {
  // Fail-closed on the whole call, because the harness cannot allow half of a
  // tool call -- but the operator has to be told which file and which rule,
  // or the worker retries the batch forever.
  const v = await guard()({
    kind: "edit",
    title: "2 files",
    locations: [{ path: "src/lib/config/stitchguard-config.ts" }, { path: ".env.example" }],
    rawInput: {},
  });
  assert.equal(v.allow, false);
  assert.equal(v.denial.code, "path_denylisted");
  assert.equal(v.denial.rule, ".env.*");
  assert.ok(
    v.denial.paths.some((p) => p.endsWith(".env.example")),
    `the denial must name the offending file, got ${JSON.stringify(v.denial.paths)}`,
  );
  // And it must NOT name the innocent one as denylisted.
  assert.ok(!v.denial.paths.some((p) => p.includes("stitchguard-config")));
});

test("rc.10: a joined string inside a structured batch does not slip past", { skip }, async () => {
  // A backend could send one good location and one joined one. The ambiguous
  // entry decides the call.
  const v = await guard()({
    kind: "edit",
    title: "3 files",
    locations: [{ path: "src/ok.ts" }, { path: JOINED_5583 }],
    rawInput: {},
  });
  assert.equal(v.allow, false);
  assert.equal(v.denial.code, "path_unresolvable");
});

// ---------------------------------------------------------------------------
// 3. The cause: the prompt no longer hands the worker a joined list
// ---------------------------------------------------------------------------

test("rc.10 (audit 5589): the worker prompt lists files one per line", { skip }, () => {
  const subTask = {
    seq: 3,
    title: "Isolate Slack And Routing Configuration",
    intent: "Implement and commit dedicated fail-closed configuration",
    // The real plan row, which is where the 5589 string came from verbatim.
    filesLikelyTouched: [
      "src/lib/config/stitchguard-config.ts",
      "src/lib/it/client-offboarding-slack.ts",
      ".env.example",
      "src/__tests__/lib/it/client-offboarding-orchestrator.test.ts",
      "okf/",
    ],
    successCriteria: ["configuration fails closed"],
    estimatedTokens: 5000,
    taskMode: "mutate",
  };
  const prompt = buildWorkerSystemPrompt({ title: "t", motivation: "m", acceptanceCriteria: ["a"] }, subTask);

  // The exact string the worker passed as a path must not appear anywhere in
  // what we hand it.
  assert.ok(!prompt.includes(JOINED_5589), "the prompt must not contain the joined pair");
  // Each file is still there, individually.
  for (const f of subTask.filesLikelyTouched) {
    assert.ok(prompt.includes(f), `${f} is still named`);
  }
  // And they are on their own lines.
  const lines = prompt.split("\n");
  const i = lines.findIndex((l) => l.startsWith("Files likely touched:"));
  assert.ok(i >= 0, "the section still exists");
  assert.equal(lines[i].trim(), "Files likely touched:", "no paths on the header line");
  assert.equal(lines[i + 1].trim(), "- src/lib/config/stitchguard-config.ts");
  assert.equal(lines[i + 2].trim(), "- src/lib/it/client-offboarding-slack.ts");
});

test("rc.10: a sub-task with no declared files still reads sensibly", { skip }, () => {
  const prompt = buildWorkerSystemPrompt(
    { title: "t", motivation: "m", acceptanceCriteria: ["a"] },
    {
      seq: 1,
      title: "Probe",
      intent: "look",
      filesLikelyTouched: [],
      successCriteria: ["a report"],
      estimatedTokens: 10,
      taskMode: "observe",
    },
  );
  assert.match(prompt, /Files likely touched: \(unspecified\)/);
});

test("rc.10: the joined rendering is gone from the source, not just this path", { skip }, () => {
  // A grep, because the defect was a formatting habit and it would come back
  // the next time someone adds a file list to a prompt.
  const src = readFileSync(new URL("../src/orchestrator/worker.ts", import.meta.url), "utf8");
  assert.ok(
    !/Files likely touched: \$\{subTask\.filesLikelyTouched\.join/.test(src),
    "worker.ts must not join filesLikelyTouched into one prompt line",
  );
});
