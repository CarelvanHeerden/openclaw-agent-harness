// rc.7 phase 2: an unclaimed generated tree gets a standing owner.
//
// Phase 1 lets the sub-task contracted to produce an artifact commit it. That
// only helps when a sub-task IS contracted to produce it, and on the observed
// plans none was: the bundle was regenerated as a side effect of unrelated
// work, by whichever sub-task happened to run a script that rewrote it. That
// accident is where this entire class of defect started -- PR #961's 141 swept
// files were one sub-task's side effect being carried by another's commit.
//
// So when a generator's declared inputs move and nothing in the plan owns its
// output, one sub-task is appended to do exactly that job. Two properties are
// load-bearing and both come from something that already went wrong:
//
//   EVIDENCED. A generator with no declared `inputs` is never triggered.
//   beta.70 paid for "run it just in case" once already -- a 19-minute
//   `npm run okf` across 1,436 files for a zero diff.
//
//   UNCLAIMED. If a sub-task already declares one of the generator's paths, it
//   is the owner and phase 1 covers it. A second turn would regenerate the same
//   tree twice and race the first for the same files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { OrchestratorLoop } from "../dist/orchestrator/loop.js";
const { pendingGenerations, resolveGenerators } = await import("../dist/orchestrator/generated-artifacts.js");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

/** `okf` declares its sources; `codegen` does not. */
const OKF = [
  { script: "okf", produces: ["okf/"], inputs: ["src/domain/"] },
  { script: "codegen", produces: ["src/generated/"] },
];

function genLoop({ committed = [], generators = OKF, enabled = true, baseSha = "b".repeat(40) } = {}) {
  const audits = [];
  const loop = new OrchestratorLoop({
    config: {
      loop: {},
      verify: { generators, append_generation_subtask: enabled },
    },
    state: {
      audit: (event, payload) => audits.push({ event, payload }),
      db: { prepare: () => ({ get: () => ({ plan_base_sha: baseSha || null }) }) },
    },
    interactionLog: { log() {} },
    logger: LOGGER,
    worktreeCommittedFiles: async () => committed,
  });
  return { loop, audits };
}

const PLAN = { worktreePath: "/tmp/wt", repo: "o/r", branch: "harness/x", subTasks: [] };
const SUBTASK = (seq, files) => ({ seq, title: `t${seq}`, intent: "", filesLikelyTouched: files, successCriteria: [], verify: [] });

const append = (loop, ordered, plan = PLAN) =>
  loop.appendGenerationSubTask({ sessionId: "s1", plan, cycle: 1, ordered });

// ---------------------------------------------------------------------------
// The case it exists for
// ---------------------------------------------------------------------------

test("rc.7 gen: a moved input with no owner gets one", async () => {
  const { loop, audits } = genLoop({ committed: ["src/domain/model.ts", "src/feature.ts"] });
  const st = await append(loop, [SUBTASK(1, ["src/domain/model.ts"]), SUBTASK(2, ["src/feature.ts"])]);

  assert.ok(st, "a changed declared input with no claimant is exactly the trigger");
  assert.equal(st.seq, 3, "appended after the last planned sub-task");
  assert.deepEqual(st.filesLikelyTouched, ["okf/"], "it owns the generator's whole declared output");
  assert.match(st.intent, /npm run `?okf/);
  assert.match(st.intent, /src\/domain\/model\.ts/, "the evidence is in the prompt, not just the audit");
  assert.match(st.intent, /Do NOT hand-edit/);

  const a = audits.find((x) => x.event === "loop.generation_subtask_appended");
  assert.ok(a, "appending a turn spends money and must be visible");
  assert.deepEqual(a.payload.scripts, ["okf"]);
  assert.deepEqual(a.payload.changedInputs, ["src/domain/model.ts"]);
});

test("rc.7 gen: it depends on nothing, because position already orders it", async () => {
  // A dependency on a prior seq would read as unresolved when revise-scoping
  // skipped that sub-task, and fail the run. Running last is guaranteed by
  // being appended last.
  const { loop } = genLoop({ committed: ["src/domain/model.ts"] });
  const st = await append(loop, [SUBTASK(1, ["src/domain/model.ts"])]);
  assert.deepEqual(st.dependsOn, []);
});

test("rc.7 gen: only concrete files become a contract", async () => {
  // A directory produce has no single path to assert, and inventing one fails
  // a generator that correctly writes a different set of files this time.
  const { loop } = genLoop({
    committed: ["src/domain/m.ts"],
    generators: [{ script: "okf", produces: ["okf/", "okf/index.json"], inputs: ["src/domain/"] }],
  });
  const st = await append(loop, [SUBTASK(1, ["src/domain/m.ts"])]);
  assert.deepEqual(st.verify, [{ kind: "file_committed", path: "okf/index.json" }]);
  assert.ok(st.filesLikelyTouched.includes("okf/"), "the directory is still in scope, just not under contract");
});

// ---------------------------------------------------------------------------
// When it must stay out of the way
// ---------------------------------------------------------------------------

test("rc.7 gen: off unless the deployment asks", async () => {
  const { loop, audits } = genLoop({ committed: ["src/domain/model.ts"], enabled: false });
  assert.equal(await append(loop, [SUBTASK(1, ["src/domain/model.ts"])]), null);
  assert.equal(audits.length, 0, "and it does not even audit a decision it did not take");
});

test("rc.7 gen: a sub-task that already owns the output gets no rival", async () => {
  // Phase 1 covers this one. A second turn would regenerate the same tree
  // twice and race the first for the same files.
  const { loop } = genLoop({ committed: ["src/domain/model.ts"] });
  const st = await append(loop, [SUBTASK(1, ["src/domain/model.ts"]), SUBTASK(2, ["okf/index.json"])]);
  assert.equal(st, null);
});

test("rc.7 gen: a generator with no declared inputs is never triggered", async () => {
  // beta.70's lesson, as a hard rule rather than a hope. `codegen` declares no
  // inputs, so nothing it produces can justify a speculative 19-minute run.
  const { loop } = genLoop({ committed: ["src/lib/thing.ts", "src/generated/api.ts"] });
  const st = await append(loop, [SUBTASK(1, ["src/lib/thing.ts"])]);
  assert.equal(st, null, "no inputs, no evidence, no turn");
});

test("rc.7 gen: inputs that did not move do not trigger it", async () => {
  const { loop } = genLoop({ committed: ["src/feature.ts", "README.md"] });
  assert.equal(await append(loop, [SUBTASK(1, ["src/feature.ts"])]), null);
});

test("rc.7 gen: no generators, no branch changes, or no base sha -- all inert", async () => {
  const noGen = genLoop({ committed: ["src/domain/m.ts"], generators: [] });
  assert.equal(await append(noGen.loop, [SUBTASK(1, ["src/domain/m.ts"])]), null);

  const noChanges = genLoop({ committed: [] });
  assert.equal(await append(noChanges.loop, [SUBTASK(1, ["src/domain/m.ts"])]), null);

  // Without a fork point there is no window to judge "changed" against, and
  // guessing one would make the trigger depend on how much history is local.
  const noBase = genLoop({ committed: ["src/domain/m.ts"], baseSha: "" });
  assert.equal(await append(noBase.loop, [SUBTASK(1, ["src/domain/m.ts"])]), null);
});

// ---------------------------------------------------------------------------
// The trigger primitive
// ---------------------------------------------------------------------------

test("rc.7 gen: pendingGenerations reports the evidence it acted on", () => {
  const map = resolveGenerators(OKF);
  const pending = pendingGenerations({
    map,
    changedFiles: ["src/domain/a.ts", "src/domain/b.ts", "src/other.ts"],
    claimedPaths: [],
  });
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].changedInputs, ["src/domain/a.ts", "src/domain/b.ts"]);
  assert.deepEqual(pending[0].produces, ["okf/"]);
});

test("rc.7 gen: a claim anywhere in the generator's tree claims the generator", () => {
  // Ownership is per script, as it is at commit time. A sub-task owning one
  // file of the bundle is expected to run the generator that writes all of it.
  const map = resolveGenerators(OKF);
  const claimed = pendingGenerations({
    map,
    changedFiles: ["src/domain/a.ts"],
    claimedPaths: ["okf/modules/deep/nested.md"],
  });
  assert.deepEqual(claimed, []);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("rc.7 gen: the plan is appended to at most once, after every planned sub-task", () => {
  const src = readFileSync(join(root, "src", "orchestrator", "loop.ts"), "utf8");
  const i = src.indexOf("let generationChecked = false;");
  assert.ok(i > 0, "the once-only latch must exist");
  const body = src.slice(i, i + 900);

  assert.match(body, /for \(let i = 0; ; i\+\+\)/, "an index loop, because the array is appended to mid-iteration");
  assert.match(body, /if \(i >= ordered\.length\)/, "the check happens as the index passes the end...");
  assert.ok(
    body.indexOf("if (i >= ordered.length)") < body.indexOf("const st = ordered[i]"),
    "...before the body, so the `continue`s in it cannot skip the check",
  );
  assert.match(body, /if \(generationChecked \|\| failed\.err\) break;/, "once only, and never after a failure");

  // Appended, not spliced: running last is the whole ordering guarantee.
  assert.match(body, /ordered\.push\(appended\)/);
});

test("rc.7 gen: the harness never runs the generator itself", () => {
  // `verify.generators` authorizes worker-side execution only. Doing the work
  // here would reverse that decision rather than implement it.
  const src = readFileSync(join(root, "src", "orchestrator", "loop.ts"), "utf8");
  const i = src.indexOf("private async appendGenerationSubTask");
  const body = src.slice(i, src.indexOf("private generatorVerifyCtx"));
  assert.ok(i > 0 && body.length > 0);
  assert.ok(!/execFile|spawn|runCheckScript|npm run"/.test(body), "it builds a sub-task; it does not execute anything");
  assert.match(body, /append_generation_subtask !== true/, "and it is gated strictly");
});
