// beta.58 — fold the 3 conditional-finding defects on top of beta.57.
//
// From the live b55 #858 run: the human-in-loop PAUSE worked, but the SKIP was
// not durable across the re-plan it triggers:
//   D1  skip keyed by seq number -> a full re-plan renumbers seqs -> binds to nothing.
//   D2  skip only appended to outOfScope, didn't remove the owning finding line
//       -> the lead re-derived the same rename from the still-present finding.
//   D3  worse: the re-plan PROMOTED the CONDITIONAL premise to unconditional
//       ("planner decision: unconditionally align") -> a wrong-but-passing rename.
//   Bug B  loop.worker_refusal conflated bad-faith refusal with good-faith
//          premise-contradicted skip.
//
// Fixes:
//   D1+D2  content-keyed outOfScope prohibition + removeOwningFindingLines strips
//          the finding line from acceptanceCriteria. (+ paused sub-task title/intent
//          captured at pause so the skip is content-keyed.)
//   D3     lead-prompt "CONDITIONAL PREMISE FINDINGS STAY CONDITIONAL" + "OPERATOR
//          SKIP IS ABSOLUTE" constraints.
//   Bug B  matchesInvalidPremiseSkip -> distinct loop.worker_skipped_invalid_premise.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const hygiene = await import("../dist/orchestrator/finding-hygiene.js");
const loop = await import("../dist/orchestrator/loop.js");

// ---- D1/D2: removeOwningFindingLines ----
test("beta.58 D2: strips the finding line the skipped sub-task owned (the #858 rename case)", () => {
  const { removeOwningFindingLines } = hygiene;
  const lines = [
    "Address each adversary finding listed below without regressing the original acceptance criteria.",
    "NOTE: findings marked CONDITIONAL PREMISE must be premise-verified before any change.",
    "6. [medium] TaxonomyRef appears to be dead code; remove it",
    "10. [low] Rename the grc directories to governance-risk naming to match the app route convention -- CONDITIONAL PREMISE",
    "--- original acceptance criteria (must still hold) ---",
    "The taxonomy dropdown shows real values",
  ];
  const title = "Consolidate module dirs to governance-risk naming (finding 10 rename)";
  const intent = "Rename src/lib/grc/taxonomy-tree.ts to src/lib/governance-risk/taxonomy-tree.ts";
  const { kept, dropped } = removeOwningFindingLines(lines, title, intent);
  assert.equal(dropped.length, 1, "exactly the finding-10 rename line dropped");
  assert.match(dropped[0], /^10\./);
  // structural + unrelated finding + original criteria all preserved:
  assert.ok(kept.some((l) => l.startsWith("Address each adversary")));
  assert.ok(kept.some((l) => l.startsWith("6.")), "unrelated finding 6 preserved");
  assert.ok(kept.some((l) => l.includes("original acceptance criteria")));
  assert.ok(kept.some((l) => l.includes("real values")));
});

test("beta.58 D2: false-negative safe -- drops nothing when overlap is weak (never nukes an unrelated finding)", () => {
  const { removeOwningFindingLines } = hygiene;
  const lines = [
    "3. [high] Add response validation to the shared taxonomy module",
    "7. [medium] Wire an ErrorState component into the risks page",
  ];
  // skipped sub-task is about a totally different thing:
  const { kept, dropped } = removeOwningFindingLines(lines, "aria-label on dropdown select", "add accessible label");
  assert.equal(dropped.length, 0, "no incidental drop");
  assert.equal(kept.length, 2);
});

test("beta.58 D2: never touches non-numbered / structural lines", () => {
  const { removeOwningFindingLines } = hygiene;
  const lines = ["Address each adversary finding listed below", "some prose about renaming grc governance-risk module"];
  // Even with strong token overlap on line 2, it's not a numbered finding line.
  const { dropped } = removeOwningFindingLines(lines, "rename grc governance-risk module", "rename grc governance-risk module dirs");
  assert.equal(dropped.length, 0, "only numbered finding lines are eligible");
});

test("beta.58 D2: empty paused content -> no-op (returns input unchanged)", () => {
  const { removeOwningFindingLines } = hygiene;
  const lines = ["10. [low] rename grc"];
  const { kept, dropped } = removeOwningFindingLines(lines, "", "");
  assert.equal(dropped.length, 0);
  assert.deepEqual(kept, lines);
});

// ---- Bug B: matchesInvalidPremiseSkip ----
test("beta.58 Bug B: matchesInvalidPremiseSkip flags a good-faith premise-contradicted skip", () => {
  const { matchesInvalidPremiseSkip } = loop;
  assert.equal(typeof matchesInvalidPremiseSkip, "function");
  assert.equal(
    matchesInvalidPremiseSkip("Per the CONDITIONAL PREMISE rules, the premise is contradicted (grc/ is the established convention). Finding 10 is invalid; no change made."),
    true,
  );
  assert.equal(matchesInvalidPremiseSkip("The premise does not hold, so I made no change."), true);
  assert.equal(matchesInvalidPremiseSkip("Finding is invalid — premise not satisfied."), true);
});

test("beta.58 Bug B: matchesInvalidPremiseSkip does NOT flag the beta.53 hallucination refusal", () => {
  const { matchesInvalidPremiseSkip } = loop;
  assert.equal(matchesInvalidPremiseSkip("I'll wait for the completion notification from the background watcher before running the test suite."), false);
  assert.equal(matchesInvalidPremiseSkip("The Monitor will notify me when eslint is installed. Waiting for that event."), false);
  assert.equal(matchesInvalidPremiseSkip(""), false);
});

// ---- source-assertion wiring ----
test("beta.58 D1/D2 wiring: harness_answer skip is content-keyed + strips finding lines", () => {
  const reg = S("src/tools/registration.ts");
  assert.match(reg, /removeOwningFindingLines/, "imports + calls the stripper");
  assert.match(reg, /clarification_subtask/, "reads the paused sub-task content");
  assert.match(reg, /the operator explicitly skipped it/, "content-keyed outOfScope prohibition");
  // the old seq-only skip note must no longer be the primary path (only a fallback):
  assert.match(reg, /pausedTitle \|\| pausedIntent/, "keys the prohibition by content, not seq");
});

test("beta.58 D1/D2 wiring: loop captures paused sub-task title+intent at pause", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /clarify\.subtask = \{ title: st\.title, intent: st\.intent \}/);
  assert.match(src, /clarification_subtask = \?/, "persists it in finaliseAwaitingClarification");
});

test("beta.58 D3 wiring: lead prompt forbids promoting a conditional premise to unconditional", () => {
  const sdk = S("src/adapters/claude-sdk.ts");
  assert.match(sdk, /CONDITIONAL PREMISE FINDINGS STAY CONDITIONAL/);
  assert.match(sdk, /the premise gate WINS/);
  assert.match(sdk, /OPERATOR SKIP IS ABSOLUTE/);
});

test("beta.58 Bug B wiring: loop emits loop.worker_skipped_invalid_premise distinct from worker_refusal", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /"loop\.worker_skipped_invalid_premise"/);
  assert.match(src, /matchesInvalidPremiseSkip\(refusalText\)/);
  // gated on commit_made among failed kinds (Staging's discriminator):
  assert.match(src, /failedResults\.some\(\(x\) => x\.kind === "commit_made"\)/);
});

test("beta.58: schema + migration carry clarification_subtask", () => {
  assert.match(S("src/state/schema.sql"), /clarification_subtask/);
  assert.match(S("src/state/store.ts"), /clarification_subtask/);
});
