// rc.5 fix #1: the impossible generated-artifact contract.
//
// THE DEFECT
// ----------
// The harness told the worker "do NOT run regenerators yourself; just place/
// edit source correctly and the harness regenerates derived artifacts for you"
// (repo-conventions.ts), told the adversary not to flag a stale bundle because
// "the harness regenerates derived artifacts in its own post-worker convention-
// check phase", and demoted stale-bundle findings to non-blocking on the same
// grounds (finding-classify.ts). Then verification demanded the generated file
// be committed.
//
// No such phase exists. `runFinalVerifyChecks` runs the repo's declared CHECK
// scripts (default allowlist `okf:check`, `lint`, `typecheck`, `test`), never a
// generator, and commits nothing -- and since beta.81 it is off by default, so
// on a stock deployment the promised phase does not run at all. Because nothing
// in the verify layer knew a path was derived, the file's absence surfaced
// through the contract path-resolution machinery as a PATH MISMATCH: "we could
// not find your file", when the truth was "nobody was ever going to write it".
//
// THE FIX
// -------
// Generation is assigned to the WORKER, scoped to paths an operator has
// explicitly mapped in `verify.generators`. Ownership is never inferred. An
// unmapped path is an ordinary file: no generation, and no exemption either.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");

const {
  resolveGenerators,
  normaliseRepoPath,
  authorizedGeneratorsForPaths,
  rescuableContractPaths,
  renderGeneratorInstruction,
  generatorScriptDeclared,
  describeGeneratedArtifactFailure,
  assessGeneratedFreshness,
  neverCommitCovers,
} = await import("../dist/orchestrator/generated-artifacts.js");
const { buildWorkerSystemPrompt } = await import("../dist/orchestrator/worker.js");
const { renderConventionsForPrompt } = await import("../dist/orchestrator/repo-conventions.js");
const { verifySubTaskOutput } = await import("../dist/orchestrator/verify.js");
const { classifyFinding } = await import("../dist/orchestrator/finding-classify.js");

// ---------------------------------------------------------------------------
// 1. The false promise is gone from every site that made it
// ---------------------------------------------------------------------------

test("rc5: no prompt promises a later harness phase regenerates derived artifacts", () => {
  const conv = S("src/orchestrator/repo-conventions.ts");
  // The exact claims that made the contract impossible.
  assert.doesNotMatch(conv, /the harness regenerates derived artifacts for you/i);
  assert.doesNotMatch(conv, /handled by the harness AFTER your turn/i);
  assert.doesNotMatch(conv, /harness regenerates derived artifacts in its own post-worker/i);
});

test("rc5: the worker guard no longer justifies itself with the phantom phase", () => {
  const w = S("src/orchestrator/worker.ts");
  assert.doesNotMatch(w, /The harness runs the repo's declared\s*\n?\s*\/\/ check scripts .*in\s*\n?\s*\/\/ a POST-WORKER convention-check phase/);
  // The cost rationale (the real one) survives.
  assert.match(w, /19 min/);
});

test("rc5: the adversary is no longer told to ignore an unregenerated bundle outright", () => {
  const adversaryGuidance = renderConventionsForPrompt(
    [{ source: "CONVENTIONS.md", text: "keep the bundle current" }],
    "adversary",
  );
  assert.doesNotMatch(adversaryGuidance, /do NOT raise a finding merely because a generated bundle/i);
  assert.doesNotMatch(adversaryGuidance, /post-worker convention-check phase/i);
});

// ---------------------------------------------------------------------------
// 2. Ownership comes from operator config and is never inferred
// ---------------------------------------------------------------------------

test("rc5: a declared mapping owns its exact file", () => {
  const m = resolveGenerators([{ script: "okf", produces: ["okf/bundle.json"] }]);
  assert.equal(m.errors.length, 0);
  assert.equal(m.empty, false);
  assert.equal(m.ownerOf("okf/bundle.json")?.script, "okf");
});

test("rc5: a trailing-slash entry owns a directory subtree; a bare entry does not", () => {
  const dir = resolveGenerators([{ script: "codegen", produces: ["src/generated/"] }]);
  assert.equal(dir.ownerOf("src/generated/client.ts")?.script, "codegen");
  assert.equal(dir.ownerOf("src/generated/deep/nested.ts")?.script, "codegen");
  // A sibling that merely shares the prefix string is NOT inside the directory.
  assert.equal(dir.ownerOf("src/generated-notes.md"), null);

  const file = resolveGenerators([{ script: "codegen", produces: ["src/generated"] }]);
  assert.equal(file.ownerOf("src/generated/client.ts"), null);
});

test("rc5: ownership is NEVER inferred -- a generated-LOOKING path is unowned without config", () => {
  const none = resolveGenerators([]);
  assert.equal(none.empty, true);
  for (const p of ["okf/bundle.json", "src/generated/client.ts", "schema.generated.ts", "dist/bundle.js"]) {
    assert.equal(none.ownerOf(p), null, `${p} must not be inferred as generated`);
  }
});

test("rc5: an unmapped path gets no generation AND no exemption when others ARE mapped", () => {
  const m = resolveGenerators([{ script: "okf", produces: ["okf/bundle.json"] }]);
  // Unmapped, even though it sits next to a mapped artifact and looks derived.
  assert.equal(m.ownerOf("okf/other.json"), null);
  // And it authorizes nothing, so the worker is told to run nothing for it.
  assert.deepEqual(authorizedGeneratorsForPaths(m, ["okf/other.json"]), []);
});

// ---------------------------------------------------------------------------
// 3. Validation: paths stay in the repo, ambiguity is refused
// ---------------------------------------------------------------------------

test("rc5: a produces path that escapes the repository is rejected", () => {
  for (const bad of ["../outside.json", "/etc/passwd", "C:/Windows/x.json", "..", ""]) {
    assert.equal(normaliseRepoPath(bad), null, `${bad} must not normalise to a repo path`);
  }
  const m = resolveGenerators([{ script: "okf", produces: ["../outside.json", "okf/bundle.json"] }]);
  assert.equal(m.ownerOf("../outside.json"), null);
  assert.equal(m.ownerOf("okf/bundle.json")?.script, "okf");
  assert.match(m.errors.map((e) => e.reason).join(" "), /escapes the repository/);
});

test("rc5: an interior .. is resolved rather than treated as an escape", () => {
  assert.equal(normaliseRepoPath("a/b/../c.json"), "a/c.json");
  assert.equal(normaliseRepoPath("./a/./b.json"), "a/b.json");
  assert.equal(normaliseRepoPath("a\\b.json"), "a/b.json");
});

test("rc5: a path claimed by two generators is ambiguous -- NEITHER is authorized", () => {
  const m = resolveGenerators([
    { script: "okf", produces: ["shared/bundle.json", "okf/own.json"] },
    { script: "codegen", produces: ["shared/bundle.json", "codegen/own.json"] },
  ]);
  assert.equal(m.ownerOf("shared/bundle.json"), null, "ambiguous path must fail closed");
  // The unambiguous paths on both entries survive.
  assert.equal(m.ownerOf("okf/own.json")?.script, "okf");
  assert.equal(m.ownerOf("codegen/own.json")?.script, "codegen");
  assert.match(m.errors.map((e) => e.reason).join(" "), /ambiguous/);
});

test("rc5: a script name that is not a plain script name is refused, not sanitised", () => {
  for (const bad of ["okf && rm -rf /", "okf; echo hi", "../bin/okf", "npm run okf", "", "-okf"]) {
    const m = resolveGenerators([{ script: bad, produces: ["a/b.json"] }]);
    assert.equal(m.empty, true, `${bad} must not resolve to an authorized generator`);
    assert.equal(m.errors.length >= 1, true);
  }
  // The legal shapes still work.
  for (const ok of ["okf", "okf:check", "gen-client", "gen_client", "gen.client", "a1"]) {
    assert.equal(resolveGenerators([{ script: ok, produces: ["a/b.json"] }]).empty, false, ok);
  }
});

test("rc5: a duplicate script entry and an empty produces are configuration errors", () => {
  const dup = resolveGenerators([
    { script: "okf", produces: ["a.json"] },
    { script: "okf", produces: ["b.json"] },
  ]);
  assert.match(dup.errors.map((e) => e.reason).join(" "), /declared more than once/);
  assert.equal(dup.ownerOf("b.json"), null);

  const empty = resolveGenerators([{ script: "okf", produces: [] }]);
  assert.equal(empty.empty, true);
  assert.match(empty.errors.map((e) => e.reason).join(" "), /no produces/);
});

// ---------------------------------------------------------------------------
// 4. THE EXACT SEQUENCE: worker told not to generate, then required to have
//    committed the generated file. It must now be satisfiable.
// ---------------------------------------------------------------------------

const brief = { title: "Add a field", motivation: "m", acceptanceCriteria: ["a"] };
const subTaskTouchingBundle = {
  seq: 2,
  title: "Add taxonomy field and commit",
  intent: "add the field to the source and commit okf/bundle.json",
  taskMode: "mutate",
  contractScope: "local",
  filesLikelyTouched: ["src/taxonomy.ts", "okf/bundle.json"],
  successCriteria: ["the field exists", "commit locally"],
};

test("rc5: with NO generators declared the blanket prohibition stands and nothing is authorized", () => {
  const p = buildWorkerSystemPrompt(brief, subTaskTouchingBundle, []);
  assert.match(p, /DO NOT run repo-wide generators/);
  assert.doesNotMatch(p, /GENERATED ARTIFACTS/);
});

test("rc5: THE IMPOSSIBLE CONTRACT -- a contracted generated file is now explicitly assigned to the worker", () => {
  const map = resolveGenerators([{ script: "okf", produces: ["okf/bundle.json"] }]);
  const authorized = authorizedGeneratorsForPaths(map, subTaskTouchingBundle.filesLikelyTouched);
  const p = buildWorkerSystemPrompt(brief, subTaskTouchingBundle, authorized);

  // The general guard is still present...
  assert.match(p, /DO NOT run repo-wide generators/);
  // ...and the specific authorization that makes the contract satisfiable is
  // present too, naming the script and the path.
  assert.match(p, /GENERATED ARTIFACTS \(authorized for this sub-task\)/);
  assert.match(p, /npm run okf/);
  assert.match(p, /okf\/bundle\.json/);
  assert.match(p, /MUST run the named script and COMMIT what it writes/);
  // The authorization is stated AFTER the prohibition, so the worker reads the
  // rule and then its exception rather than a rule it must remember to break.
  assert.ok(p.indexOf("DO NOT run repo-wide generators") < p.indexOf("GENERATED ARTIFACTS"));
});

test("rc5: authorization is scoped to THIS sub-task's paths, not the whole mapping", () => {
  const map = resolveGenerators([
    { script: "okf", produces: ["okf/bundle.json"] },
    { script: "codegen", produces: ["src/generated/"] },
  ]);
  // A sub-task touching only the okf bundle must not be handed `codegen`.
  const authorized = authorizedGeneratorsForPaths(map, ["okf/bundle.json"]);
  assert.deepEqual(authorized, [{ script: "okf", paths: ["okf/bundle.json"] }]);
  const p = buildWorkerSystemPrompt(brief, subTaskTouchingBundle, authorized);
  assert.doesNotMatch(p, /npm run codegen/);
});

test("rc5: a sub-task touching no mapped path is authorized for nothing (beta.70 cost guard intact)", () => {
  const map = resolveGenerators([{ script: "okf", produces: ["okf/bundle.json"] }]);
  const authorized = authorizedGeneratorsForPaths(map, ["src/taxonomy.ts", "README.md"]);
  assert.deepEqual(authorized, []);
  assert.equal(renderGeneratorInstruction(authorized), "");
});

test("rc5: the authorization is EXECUTABLE -- the bash guard permits the script it names", async () => {
  // The point of the fix is a contract the worker can satisfy. Telling it to
  // run `npm run okf` while the guard refuses `npm` would rebuild the same
  // impossibility one layer down.
  const { buildBashGuard } = await import("../dist/safety/bash-guard.js");
  const { parseHarnessConfig } = await import("../dist/config.js");
  const cfg = parseHarnessConfig({
    slack: { authorised_users: ["U1"] },
    repos: { allowed: ["acme/*"] },
  });
  const guard = buildBashGuard({
    bash_whitelist: cfg.safety.bash_whitelist,
    bash_denylist_tokens: cfg.safety.bash_denylist_tokens,
    path_denylist: cfg.safety.path_denylist,
    allow_git_push: false,
    allow_network_commands: false,
  });
  assert.equal((await guard("Bash", { command: "npm run okf" })).allow, true);
  // And the guard is still a guard.
  assert.equal((await guard("Bash", { command: "sudo rm -rf /" })).allow, false);
});

// ---------------------------------------------------------------------------
// 5. Failures are actionable, not misleading path mismatches
// ---------------------------------------------------------------------------

const okfMap = resolveGenerators([{ script: "okf", produces: ["okf/bundle.json"] }]);

/** Probes for a worktree where the contract file was never produced. */
const missingFileProbes = {
  remoteBranchExists: async () => ({ exists: false, detail: "no" }),
  prUrlPresent: async () => ({ present: false, detail: "no" }),
  fileWrittenSince: async () => ({ written: false, detail: "no diff for path" }),
  commitMadeSince: async () => ({ made: true, detail: "1 commit" }),
  fileCommittedSince: async () => ({
    committed: false,
    detail: "no structural match for okf/bundle.json among 3 committed files",
  }),
};

const baseCtx = { defaultBranch: "feat/x", subTaskStartMs: 1000, baseSha: "aaa" };

test("rc5: a missing GENERATED file reports a generation failure, not a path mismatch", async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json" }],
    { ...baseCtx, generators: okfMap, generatorScriptDeclared: () => true },
    missingFileProbes,
  );
  assert.equal(out.ok, false);
  const d = out.results[0].detail;
  assert.match(d, /is a GENERATED artifact/);
  assert.match(d, /npm run okf/);
  assert.match(d, /not a path-resolution mismatch/i);
});

test("rc5: MISSING TOOLING is named when the repo declares no such script", async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json" }],
    { ...baseCtx, generators: okfMap, generatorScriptDeclared: () => false },
    missingFileProbes,
  );
  assert.equal(out.ok, false);
  const d = out.results[0].detail;
  assert.match(d, /MISSING TOOLING/);
  assert.match(d, /package\.json declares no such script/);
  assert.match(d, /can never be produced/);
});

test("rc5: generatorScriptDeclared reads the repo manifest, and an absent script is detectable", () => {
  assert.equal(generatorScriptDeclared({ okf: "node gen.js" }, "okf"), true);
  assert.equal(generatorScriptDeclared({ lint: "eslint ." }, "okf"), false);
  assert.equal(generatorScriptDeclared(undefined, "okf"), false);
});

test("rc5: an UNMAPPED missing file keeps the ordinary probe detail (no false generation story)", async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "src/hand-written.ts" }],
    { ...baseCtx, generators: okfMap, generatorScriptDeclared: () => true },
    missingFileProbes,
  );
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.results[0].detail, /GENERATED artifact/);
  assert.match(out.results[0].detail, /no structural match/);
});

test("rc5: the failure messages name the script and stay distinguishable", () => {
  const owner = { script: "okf", files: ["okf/bundle.json"], dirs: [] };
  const notRun = describeGeneratedArtifactFailure({
    path: "okf/bundle.json", owner, scriptDeclared: true, baseDetail: "probe said no",
  });
  const missing = describeGeneratedArtifactFailure({
    path: "okf/bundle.json", owner, scriptDeclared: false, baseDetail: "probe said no",
  });
  assert.match(notRun, /did not run, or ran and produced nothing/);
  assert.doesNotMatch(notRun, /MISSING TOOLING/);
  assert.match(missing, /MISSING TOOLING/);
  // The underlying probe detail is preserved in both, not thrown away.
  assert.match(notRun, /probe said no/);
  assert.match(missing, /probe said no/);
});

// ---------------------------------------------------------------------------
// 6. STALE OUTPUT IS REJECTED
// ---------------------------------------------------------------------------

/**
 * A revise cycle where the artifact was committed by an EARLIER cycle and has
 * not been touched since. `fileCommittedInBranch` is what the beta.85 relaxation
 * consults, and it says "yes, it is in the branch" -- which is true, and which
 * is exactly why a derived file must not be judged on it.
 */
const staleArtifactProbes = {
  remoteBranchExists: async () => ({ exists: false, detail: "no" }),
  prUrlPresent: async () => ({ present: false, detail: "no" }),
  fileWrittenSince: async () => ({ written: false, detail: "mtime predates this sub-task" }),
  commitMadeSince: async () => ({ made: true, detail: "1 commit" }),
  fileCommittedInBranch: async () => ({ present: true, detail: "committed in branch (cycle 1)" }),
  fileCommittedSince: async () => ({ committed: false, detail: "not in this sub-task's window" }),
};

/**
 * rc.6 REPLACED THE RULE THESE THREE TESTS PINNED.
 *
 * rc.5 failed every generator-owned path that had not been rewritten in the
 * current window, and told the operator "its sources moved, so the committed
 * artifact is stale". Neither half was ever checked: the only fact in evidence
 * was that the file had not changed, which for a deterministic generator is the
 * expected result of a test-only sub-task. The compliance-calendar run
 * (StitchGuard #1184) hit it repeatedly with no way through -- the only action
 * that satisfies a diff requirement on a derived file is a falsified diff.
 *
 * rc.6 keeps every rejection it can evidence and drops the one it cannot. The
 * cases below are the four states, and which of them the harness can prove.
 */
test("rc6: an unchanged artifact with no input evidence is a no-op, not a stale failure", async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: okfMap },
    staleArtifactProbes,
  );
  assert.equal(out.ok, true, "rc.5 failed this, and nothing could ever have made it pass");
  assert.match(out.results[0].detail, /did not change in this sub-task/);
  assert.match(out.results[0].detail, /no inputs\[\] are declared/, "the reason it cannot be proven must be stated");
  assert.doesNotMatch(out.results[0].detail, /sources moved/, "and no claim may be made that was never checked");
});

test("rc6: the same acceptance applies to file_written", async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_written", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: okfMap },
    staleArtifactProbes,
  );
  assert.equal(out.ok, true);
  assert.match(out.results[0].detail, /valid no-op/);
});

test("rc6: an artifact that is NOT on the branch at all still fails", async () => {
  // The generator never ran. That is a fact, not an inference, and rc.6 keeps
  // every bit of rc.5's strictness about it.
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: okfMap },
    { ...staleArtifactProbes, fileCommittedInBranch: async () => ({ present: false, detail: "not in branch" }) },
  );
  assert.equal(out.ok, false);
  assert.match(out.results[0].detail, /not committed anywhere on this branch/);
  assert.match(out.results[0].detail, /npm run okf/);
});

test("rc6: a declared input that moved while the artifact did not IS stale", async () => {
  // With inputs declared the question becomes one git can answer, so the
  // rejection rc.5 wanted is available -- now with the evidence attached.
  const withInputs = resolveGenerators([
    { script: "okf", produces: ["okf/"], inputs: ["src/lib/grc/"] },
  ]);
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: withInputs },
    {
      ...staleArtifactProbes,
      changedFilesSince: async () => ["src/lib/grc/compliance-calendar.ts", "README.md"],
    },
  );
  assert.equal(out.ok, false);
  assert.match(out.results[0].detail, /STALE/);
  assert.match(out.results[0].detail, /compliance-calendar\.ts/, "the evidence must be named");
});

test("rc6: a test-only sub-task does not make a declared-input artifact stale", async () => {
  // The exact shape the incident kept failing on: the only change was a test,
  // which is not something the OpenAPI generator reads.
  const withInputs = resolveGenerators([
    { script: "okf", produces: ["okf/"], inputs: ["src/lib/grc/"] },
  ]);
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: withInputs },
    {
      ...staleArtifactProbes,
      changedFilesSince: async () => ["src/__tests__/lib/grc/compliance-calendar.test.ts"],
    },
  );
  assert.equal(out.ok, true);
  assert.match(out.results[0].detail, /none of its declared inputs changed/);
});

test("rc6: the revise-TARGETED plan-base window takes the same evidence-based route", async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json" }],
    { ...baseCtx, cycle: 2, branchBaseSha: "planbase", reviseTargetedPlanbaseWindow: true, generators: okfMap },
    { ...staleArtifactProbes, fileCommittedInBranch: async () => ({ present: false, detail: "not in branch" }) },
  );
  assert.equal(out.ok, false, "a targeted generated path that is absent still cannot pass");
});

test("rc5: a genuinely REGENERATED artifact passes on the same revise cycle", async () => {
  const freshProbes = {
    ...staleArtifactProbes,
    fileWrittenSince: async () => ({ written: true, detail: "written at 2000" }),
    fileCommittedSince: async () => ({ committed: true, detail: "12 lines changed" }),
  };
  const committed = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: okfMap },
    freshProbes,
  );
  assert.equal(committed.ok, true);
  assert.match(committed.results[0].detail, /regenerated this sub-task/);

  const written = await verifySubTaskOutput(
    [{ kind: "file_written", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: okfMap },
    freshProbes,
  );
  assert.equal(written.ok, true);
});

test("rc5: NO REGRESSION -- a hand-written file keeps the beta.85 revise-relaxed pass", async () => {
  const out = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "src/hand-written.ts", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2, generators: okfMap },
    staleArtifactProbes,
  );
  assert.equal(out.ok, true, "the stale rule must apply to derived files only");
  assert.match(out.results[0].detail, /revise-relaxed/);
});

test("rc5: NO REGRESSION -- with no generators configured, verification is byte-for-byte the old path", async () => {
  const withNone = await verifySubTaskOutput(
    [{ kind: "file_committed", path: "okf/bundle.json", reviseRelaxed: true }],
    { ...baseCtx, cycle: 2 },
    staleArtifactProbes,
  );
  assert.equal(withNone.ok, true);
  assert.match(withNone.results[0].detail, /revise-relaxed/);
});

test("rc6: every generated-artifact verdict says what was actually observed", () => {
  const owner = { script: "okf", files: [], dirs: [], inputs: ["src/x.ts"], inputDirs: [] };
  const base = { path: "okf/bundle.json", owner, baseDetail: "probe said no" };

  const missing = assessGeneratedFreshness({ ...base, writtenThisWindow: false, presentInBranch: false, changedFiles: null });
  assert.equal(missing.verdict, "missing");
  assert.equal(missing.passed, false);
  assert.match(missing.detail, /has not run/);

  const stale = assessGeneratedFreshness({ ...base, writtenThisWindow: false, presentInBranch: true, changedFiles: ["src/x.ts"] });
  assert.equal(stale.verdict, "stale");
  assert.equal(stale.passed, false);
  assert.match(stale.detail, /src\/x\.ts/, "a staleness claim must name the input it rests on");

  const unproven = assessGeneratedFreshness({ ...base, writtenThisWindow: false, presentInBranch: true, changedFiles: ["docs/readme.md"] });
  assert.equal(unproven.verdict, "unproven");
  assert.equal(unproven.passed, true);

  const fresh = assessGeneratedFreshness({ ...base, writtenThisWindow: true, presentInBranch: true, changedFiles: null });
  assert.equal(fresh.verdict, "regenerated");
  assert.equal(fresh.passed, true);
});

// ---------------------------------------------------------------------------
// rc.6: the ownership map and the never-commit list cannot contradict
// ---------------------------------------------------------------------------

test("rc6: a produced path that never_commit_paths would revert is refused", () => {
  // The observed StitchGuard configuration. `revertNeverCommitPaths` unstages
  // AND restores matching paths, so the worker's generated output is discarded
  // and the contract on it can never be met -- an unwinnable loop whose failure
  // text advises the one action that cannot work.
  const map = resolveGenerators(
    [{ script: "okf", produces: ["okf/data-model/", "okf/api/"] }, { script: "openapi", produces: ["src/lib/openapi.generated.json"] }],
    { neverCommitPaths: ["okf/**"] },
  );
  assert.equal(map.errors.length, 2, "both excluded paths must be reported, not just the first");
  for (const e of map.errors) {
    assert.equal(e.script, "okf");
    assert.match(e.reason, /never_commit_paths/);
    assert.match(e.reason, /unstages and RESTORES/, "the operator has to know why it is unsatisfiable");
  }
  assert.equal(map.ownerOf("okf/data-model/x.md"), null, "no generator may be authorized for it");
  // The unaffected mapping survives: one bad overlap must not disarm the rest.
  assert.equal(map.ownerOf("src/lib/openapi.generated.json")?.script, "openapi");
});

test("rc6: never_commit_paths patterns are matched, not string-compared", () => {
  const covered = (patterns, path) => neverCommitCovers(patterns, path);
  assert.equal(covered(["okf/**"], "okf/api/routes.md"), true);
  assert.equal(covered(["okf/**"], "okf/"), true, "a produced directory prefix is covered by its subtree pattern");
  assert.equal(covered(["okf"], "okf/api/routes.md"), true, "a bare pathspec owns its subtree, as git does");
  assert.equal(covered(["okf/**"], "src/lib/openapi.generated.json"), false);
  assert.equal(covered(["dist/*.js"], "dist/deep/nested.js"), false, "a single star must not cross a slash");
  assert.equal(covered([], "okf/api/routes.md"), false);
  assert.equal(covered(undefined, "okf/api/routes.md"), false);
});

test("rc6: an unresolvable inputs[] entry costs proof, not the whole mapping", () => {
  const map = resolveGenerators([{ script: "openapi", produces: ["src/lib/openapi.generated.json"], inputs: ["../outside/x.ts"] }]);
  assert.equal(map.ownerOf("src/lib/openapi.generated.json")?.script, "openapi", "ownership must survive a bad input");
  assert.equal(map.errors.length, 1);
  assert.match(map.errors[0].reason, /freshness cannot be proven/);
});

test("rc5: the basename rescue cannot launder a missing generated artifact onto a sibling", () => {
  const src = S("src/orchestrator/loop.ts");
  // The rescue exists for a lead that guessed a SOURCE file's location wrong.
  // A derived path is declared, not guessed, so rescuing it onto a
  // same-basename file the worker happened to touch would turn "the generator
  // never ran" into a pass.
  // Behaviour: a generated path is never offered to the rescue as an input.
  const map = resolveGenerators([{ script: "okf", produces: ["okf/bundle.json"] }]);
  assert.deepEqual(
    rescuableContractPaths(map, ["src/wrong-guess.ts", "okf/bundle.json"]),
    ["src/wrong-guess.ts"],
    "a declared generator's path has no topology ambiguity to rescue",
  );
  // With no mapping the rescue is unchanged -- every path stays eligible.
  assert.deepEqual(
    rescuableContractPaths(resolveGenerators([]), ["src/a.ts", "okf/bundle.json"]),
    ["src/a.ts", "okf/bundle.json"],
  );
  assert.deepEqual(rescuableContractPaths(undefined, ["okf/bundle.json"]), ["okf/bundle.json"]);

  // Wiring: both halves of the rescue consult it -- the inputs and the rewrite.
  assert.match(src, /const expected = rescuableContractPaths\(genMap, \[/);
  assert.match(src, /"path" in v && !isGenerated\(v\.path\) && rescueMatchesContractPath/);
});

test("rc5: the human escalation names the generator instead of asking to relocate the file", async () => {
  const { buildContractClarification } = await import("../dist/orchestrator/contract-clarify.js");
  const q = buildContractClarification({
    seq: 3,
    title: "Add the field",
    commitSha: "abc1234def",
    expected: ["okf/bundle.json"],
    actual: ["src/taxonomy.ts"],
    generated: [{ path: "okf/bundle.json", script: "okf", scriptDeclared: true }],
  });
  assert.match(q, /GENERATED artifact produced by `npm run okf`/);
  assert.match(q, /This is not a wrong path/);
  assert.match(q, /the generator did not run/);
});

test("rc5: the escalation says MISSING TOOLING when the script does not exist", async () => {
  const { buildContractClarification } = await import("../dist/orchestrator/contract-clarify.js");
  const q = buildContractClarification({
    seq: 3,
    title: "Add the field",
    commitSha: "abc1234def",
    expected: ["okf/bundle.json"],
    actual: ["src/taxonomy.ts"],
    generated: [{ path: "okf/bundle.json", script: "okf", scriptDeclared: false }],
  });
  assert.match(q, /MISSING TOOLING/);
  assert.match(q, /no answer here will change that/);
});

test("rc5: an ordinary path mismatch keeps the original question untouched", async () => {
  const { buildContractClarification } = await import("../dist/orchestrator/contract-clarify.js");
  const q = buildContractClarification({
    seq: 3,
    title: "Add the field",
    commitSha: "abc1234def",
    expected: ["src/wrong-guess.ts"],
    actual: ["src/taxonomy.ts"],
  });
  assert.doesNotMatch(q, /GENERATED artifact/);
  assert.match(q, /the contract path was wrong/);
});

// ---------------------------------------------------------------------------
// 7. The classification fail-open is closed
// ---------------------------------------------------------------------------

const staleBundleFinding = {
  dimension: "quality",
  severity: "medium",
  title: "The OKF bundle is stale",
  detail: "The okf bundle was not regenerated after the source change.",
};

test("rc5: with NO declared generator, a stale-bundle finding is NOT demoted to process", () => {
  // Nothing regenerates it, so the complaint is unanswered and must keep its
  // weight. Pre-rc.5 this returned "process" (non-blocking) unconditionally.
  assert.equal(classifyFinding(staleBundleFinding, { repoHasTestScript: true }), "diff_addressable");
});

test("rc5: with a declared generator, the beta.70 demotion still applies", () => {
  assert.equal(
    classifyFinding(staleBundleFinding, { repoHasTestScript: true, hasDeclaredGenerators: true }),
    "process",
  );
});

test("rc5: the demotion gate defaults to the SAFE reading when the flag is absent", () => {
  assert.equal(classifyFinding(staleBundleFinding, {}), "diff_addressable");
});

// ---------------------------------------------------------------------------
// 8. Config surface
// ---------------------------------------------------------------------------

test("rc5: verify.generators is declared in the schema AND the plugin manifest", () => {
  // The gateway validates operator config against the manifest with
  // additionalProperties:false, so a setting missing there rejects the whole
  // config rather than being ignored.
  for (const f of ["src/config.schema.json", "openclaw.plugin.json"]) {
    const j = JSON.parse(S(f));
    const verify = f === "openclaw.plugin.json"
      ? j.configSchema.properties.verify
      : j.properties.verify;
    const gen = verify.properties.generators;
    assert.ok(gen, `${f} must declare verify.generators`);
    assert.deepEqual(gen.default, [], `${f}: default must be empty -- no built-in toolchain defaults`);
    assert.equal(gen.items.required.includes("script"), true);
    assert.equal(gen.items.required.includes("produces"), true);
    assert.equal(gen.items.properties.produces.minItems, 1);
    // The script pattern is a security boundary: this value gets executed.
    assert.equal(gen.items.properties.script.pattern, "^[A-Za-z0-9][A-Za-z0-9._:-]*$");
  }
});

test("rc5: the default config declares no generators", async () => {
  const { parseHarnessConfig } = await import("../dist/config.js");
  const cfg = parseHarnessConfig({
    slack: { authorised_users: ["U1"] },
    repos: { allowed: ["acme/*"] },
  });
  assert.deepEqual(cfg.verify.generators, []);
  assert.equal(resolveGenerators(cfg.verify.generators).empty, true);
});

test("rc5: the run_repo_check_scripts doc comment no longer claims a default it does not have", () => {
  const c = S("src/config.ts");
  const block = c.slice(0, c.indexOf("run_repo_check_scripts: boolean;"));
  const doc = block.slice(block.lastIndexOf("/**"));
  assert.doesNotMatch(doc, /Default true\./);
  assert.match(doc, /Default FALSE since beta\.81/);
});

test("rc5: the harness never runs a mapped generator itself -- authorization is worker-side only", () => {
  const g = S("src/orchestrator/generated-artifacts.ts");
  // No spawn/exec surface in the ownership module at all.
  assert.doesNotMatch(g, /spawnSync|execSync|child_process|\bexec\(/);
  assert.match(g, /authorizes SCOPED WORKER-SIDE generation only/i);
});
