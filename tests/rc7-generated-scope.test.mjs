/**
 * rc.7 -- a declared generated artifact is not scope creep.
 *
 * The final scope check builds its in-scope set from the plan alone: the
 * revision's approved files, each sub-task's `filesLikelyTouched`, and its
 * `verify[].path`. A generated artifact was therefore only ever in scope when
 * a sub-task happened to name it.
 *
 * That was harmless for as long as such trees also sat in
 * `repos.never_commit_paths`: the commit was reverted before this check ever
 * saw it. rc.6 made that pairing a configuration error -- correctly, because it
 * is a contract no worker can satisfy -- which means the CORRECT configuration
 * is now the one where generated artifacts are committed. And the first thing
 * that happens in a correct configuration is that a bundle regeneration puts
 * every file it rewrote in front of this check as out-of-scope.
 *
 * The StitchGuard OKF tree is 1,663 files against a 500-file
 * `scope_blowout_file_threshold`. That is not a `fit` finding; b110 throws
 * ScopeBlowoutError and abandons the cycle before review. Resolving the rc.6
 * contradiction, by itself, would have bought an abandoned run in place of an
 * unwinnable contract -- PR #961's shape at ten times the size.
 *
 * The exemption is the operator's own declaration of which script writes which
 * paths, so it is narrow, never inferred, and deliberately unavailable to any
 * mapping rc.6 rejected -- including one rejected for the never_commit overlap
 * itself. A contradictory config gets nothing: it has to be fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OrchestratorLoop, ScopeBlowoutError } from "../dist/orchestrator/loop.js";

const LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

const scopeLoop = ({ committed = [], generators, neverCommit, loop: loopCfg } = {}) => {
  const audits = [];
  const loop = new OrchestratorLoop({
    config: {
      loop: { deterministic_final_scope_check: true, ...loopCfg },
      ...(generators ? { verify: { generators } } : {}),
      ...(neverCommit ? { repos: { never_commit_paths: neverCommit } } : {}),
    },
    state: {
      audit: (event, payload) => audits.push({ event, payload }),
      db: { prepare: () => ({ get: () => ({ plan_base_sha: "b".repeat(40) }) }) },
    },
    interactionLog: { log() {} },
    logger: LOGGER,
    worktreeCommittedFiles: async () => committed,
    git: { baseSha: async () => "b".repeat(40) },
  });
  return { loop, audits };
};

const PLAN = {
  worktreePath: "/tmp/wt",
  baseSha: "b".repeat(40),
  subTasks: [{ seq: 1, filesLikelyTouched: ["src/feature.ts"], verify: [] }],
};

const OKF = [{ script: "okf", produces: ["okf/"] }];
const bundle = (n) => Array.from({ length: n }, (_, i) => `okf/modules/m${i}.md`);

// ---------------------------------------------------------------------------
// The StitchGuard shape
// ---------------------------------------------------------------------------

test("rc.7: a regenerated bundle does not abandon the cycle", async () => {
  // 1,663 generated files, the real number from the SAST worktree, against the
  // 500 default. Before this change every one of them was scope creep and the
  // 664th turned the run into a ScopeBlowoutError.
  const { loop, audits } = scopeLoop({
    committed: ["src/feature.ts", ...bundle(1663)],
    generators: OKF,
  });

  const findings = await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.deepEqual(findings, [], "a declared artifact is not a finding");
  assert.ok(!audits.some((a) => a.event === "loop.scope_blowout"), "and it is certainly not a blowout");

  const ran = audits.find((a) => a.event === "loop.final_scope_check_ran");
  assert.equal(ran.payload.outOfScopeCount, 0);
  assert.equal(ran.payload.generatedCount, 1663);
});

test("rc.7: the exemption names itself and its owner", async () => {
  // "The scope check stopped firing" and "the scope check excused 1,663 files
  // it can name the owner of" have to be different events in the log.
  const { loop, audits } = scopeLoop({ committed: bundle(3), generators: OKF });
  await loop.runFinalScopeCheck("s1", PLAN, 1);

  const ev = audits.find((a) => a.event === "loop.final_scope_check_generated");
  assert.ok(ev, "an exemption that leaves no trace is indistinguishable from a hole");
  assert.equal(ev.payload.count, 3);
  assert.deepEqual(ev.payload.owners, ["okf"], "which script is answerable for these files");
  assert.ok(ev.payload.sample.length <= 20, "a sample, not 1,663 paths in one audit row");
});

test("rc.7: nothing is exempted when nothing is generated", async () => {
  const { loop, audits } = scopeLoop({ committed: ["src/feature.ts"], generators: OKF });
  await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.ok(!audits.some((a) => a.event === "loop.final_scope_check_generated"));
  assert.equal(audits.find((a) => a.event === "loop.final_scope_check_ran").payload.generatedCount, 0);
});

// ---------------------------------------------------------------------------
// How narrow it is
// ---------------------------------------------------------------------------

test("rc.7: an undeclared file in the generated tree is still scope creep", async () => {
  // The exemption follows the DECLARATION, not the directory. `okf/notes/` is
  // hand-written prose that happens to live next door.
  const { loop } = scopeLoop({
    committed: ["src/feature.ts", "okf/modules/m1.md", "okf/notes/hand-written.md"],
    generators: [{ script: "okf", produces: ["okf/modules/"] }],
  });

  const findings = await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "okf/notes/hand-written.md");
  assert.equal(findings[0].severity, "medium");
});

test("rc.7: scope creep outside the tree is untouched", async () => {
  const { loop, audits } = scopeLoop({
    committed: ["src/feature.ts", "src/stray.ts", ...bundle(2)],
    generators: OKF,
  });
  const findings = await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.deepEqual(findings.map((f) => f.file), ["src/stray.ts"]);
  assert.ok(audits.some((a) => a.event === "loop.final_scope_check_out_of_scope"));
});

test("rc.7: a real blowout still aborts, and generated files do not pad the count", async () => {
  // The b110 tripwire has to survive this change: a cache sweep alongside a
  // legitimate regeneration is still unreviewable.
  const { loop, audits } = scopeLoop({
    committed: [
      "src/feature.ts",
      ...bundle(1000),
      ...Array.from({ length: 600 }, (_, i) => `.npm-cache-tmp/_cacache/b${i}`),
    ],
    generators: OKF,
  });

  await assert.rejects(
    () => loop.runFinalScopeCheck("s1", PLAN, 1),
    (err) => {
      assert.ok(err instanceof ScopeBlowoutError);
      assert.equal(err.outOfScopeCount, 600, "the 1,000 declared artifacts are not counted against the threshold");
      return true;
    },
  );
  assert.equal(audits.find((a) => a.event === "loop.scope_blowout").payload.outOfScopeCount, 600);
});

// ---------------------------------------------------------------------------
// Fail closed on a config rc.6 rejects
// ---------------------------------------------------------------------------

test("rc.7: the exclusion list does not withdraw the exemption", async () => {
  // The live StitchGuard config, exactly: okf mappings alongside `okf/**`.
  //
  // rc.6 refused those mappings, which made `ownerOf` null and left the scope
  // check treating a declared artifact as creep. rc.7 retired that refusal --
  // the exclusion spares the sub-task contracted to generate the path -- so the
  // overlap must now resolve and the artifact must be in scope. This is the
  // case the whole change exists for; if it regresses, StitchGuard is back to
  // an abandoned cycle.
  const { loop, audits } = scopeLoop({
    committed: ["src/feature.ts", "okf/modules/m1.md"],
    generators: OKF,
    neverCommit: ["okf/**"],
  });

  const findings = await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.deepEqual(findings, [], "a declared artifact is in scope whether or not it is also excluded");
  assert.equal(audits.find((a) => a.event === "loop.final_scope_check_generated").payload.count, 1);
});

test("rc.7: an ambiguously-owned path earns no exemption either", async () => {
  // Two scripts claiming one tree is refused by rc.5 for the same reason: the
  // harness cannot say who is answerable for the file.
  const { loop } = scopeLoop({
    committed: ["src/feature.ts", "okf/modules/m1.md"],
    generators: [
      { script: "okf", produces: ["okf/modules/"] },
      { script: "okf-alt", produces: ["okf/modules/"] },
    ],
  });

  const findings = await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.deepEqual(findings.map((f) => f.file), ["okf/modules/m1.md"]);
});

test("rc.7: with no generators declared the check is exactly what it was", async () => {
  const { loop, audits } = scopeLoop({ committed: ["src/feature.ts", "src/stray.ts"] });
  const findings = await loop.runFinalScopeCheck("s1", PLAN, 1);
  assert.deepEqual(findings.map((f) => f.file), ["src/stray.ts"]);
  assert.equal(audits.find((a) => a.event === "loop.final_scope_check_ran").payload.generatedCount, 0);
});

// ---------------------------------------------------------------------------
// rc.7 -- the wiring: the worker spends its authorization twice
// ---------------------------------------------------------------------------
//
// The exemption is only real if the set the worker was told it may GENERATE is
// the same set the commit is told it may KEEP. Computing it twice was the whole
// defect: the worker was authorized to run the script, instructed to commit
// what it wrote, and had the result reverted by a rule that never asked.

const { runWorker } = await import("../dist/orchestrator/worker.js");

async function workerTurn({ generators, neverCommit, filesLikelyTouched }) {
  const commits = [];
  await runWorker(
    "/tmp/wt",
    { title: "t", motivation: "m", acceptanceCriteria: [] },
    { seq: 1, title: "Regenerate the bundle", intent: "", filesLikelyTouched, successCriteria: [] },
    { name: "H", email: "h@t.local" },
    {
      config: {
        models: { worker: "w" },
        safety: { worker_permission_mode: "acceptEdits" },
        loop: { worker_timeout_seconds: 60 },
        ...(generators ? { verify: { generators } } : {}),
        ...(neverCommit ? { repos: { never_commit_paths: neverCommit } } : {}),
      },
      logger: LOGGER,
      buildCanUseTool: () => async () => ({ allow: true }),
      runWorkerModel: async () => ({
        sdkSessionId: "s", stopReason: "end_turn", costUsd: 0, tokensIn: 0, tokensOut: 0,
        logsExcerpt: "", finalMessage: "done", streamOpened: true,
      }),
      gitBaseSha: async () => "base0000",
      gitListChangedFiles: async () => ["okf/modules/m1.md"],
      gitCommit: async (_wt, _msg, _id, authorizedPaths) => {
        commits.push(authorizedPaths ?? null);
        return "c0ffee00";
      },
      gitListCommittedFiles: async () => [],
    },
  );
  return commits;
}

test("rc.7: the worker hands its authorized paths to the commit", async () => {
  const commits = await workerTurn({
    generators: OKF,
    neverCommit: ["okf/**"],
    filesLikelyTouched: ["okf/modules/m1.md"],
  });
  assert.ok(commits.length > 0, "the turn has to reach a commit at all");
  for (const authorized of commits) {
    assert.deepEqual(authorized, ["okf/"], "the declared tree the sub-task owes, as the map normalised it");
  }
});

test("rc.7: a sub-task that owes no generated path authorizes nothing", async () => {
  // The PR #961 turn. It must arrive at the commit with an empty hand, or the
  // exclusion stops being an exclusion.
  const commits = await workerTurn({
    generators: OKF,
    neverCommit: ["okf/**"],
    filesLikelyTouched: ["src/feature.ts"],
  });
  for (const authorized of commits) {
    assert.deepEqual(authorized, [], "no declared output, no exemption");
  }
});

test("rc.7: with no generators declared nothing is ever authorized", async () => {
  const commits = await workerTurn({ neverCommit: ["okf/**"], filesLikelyTouched: ["okf/modules/m1.md"] });
  for (const authorized of commits) {
    assert.deepEqual(authorized, []);
  }
});
