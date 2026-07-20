// beta.49: unblock the immortal-finding treadmill on harness_revise.
//
// From the beta.48 #858 revise (session 8e8d3b79): C1/C2 shipped and made the
// worker's reasoned refusal visible, but the run still died at sub-task 1
// because harness_revise REPLAYS the stored adversary findings from the
// original session (21da9f9c) verbatim -- including finding 10, whose premise
// ("if no existing grc dir exists") is factually false. C3 disciplines the
// adversary at EMISSION; the revise path never re-runs the adversary, so a
// stale pre-C3 finding is immortal.
//
// beta.49 (A): dropFindings param -- manual exclusion of stale/false findings.
// beta.49 (C): auto-demote conditional findings to verify-premise-first so the
//              lead emits an observe probe and a false premise is a visible
//              skip (via beta.48 C1/C2), not a hard refusal.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");
const regSrc = S("src/tools/registration.ts");

// ---------------------------------------------------------------------------
// C: conditional-finding detection (behavioral, via the pure helper).
// ---------------------------------------------------------------------------
const { isConditionalFinding, findingText, CONDITIONAL_FINDING_RE } = await import(
  "../dist/orchestrator/finding-hygiene.js"
);

test("beta49 C: finding-10 shape (the #858 killer) is detected as conditional", () => {
  const f10 = {
    severity: "low",
    message:
      "Routes and the API path use 'governance-risk', but the new directories are src/components/grc/ and src/lib/grc/. If no existing 'grc' directories exist, this introduces a second naming convention for the same domain.",
  };
  assert.equal(isConditionalFinding(f10), true);
});

test("beta49 C: various unresolved-premise phrasings are all detected", () => {
  const cases = [
    "If no other callers exist, remove the helper.",
    "Unless this is an established convention, rename it.",
    "Assuming the flag is unused elsewhere, delete it.",
    "Provided that no tests depend on it, drop the export.",
    "Only if the directory does not exist, create it.",
    "Rename X to Y if there are no existing Y modules.",
  ];
  for (const c of cases) {
    assert.equal(isConditionalFinding({ message: c }), true, `should be conditional: ${c}`);
  }
});

test("beta49 C: definite (non-conditional) findings are NOT demoted", () => {
  const cases = [
    "The dropdown renders 'L1'/'L2' placeholders instead of the real taxonomy labels.",
    "severePlausibleScenario is typed as string but assigned a number.",
    "Add error-state handling to the fetch call in use-taxonomy.ts.",
    "Remove the unused import on line 12.",
  ];
  for (const c of cases) {
    assert.equal(isConditionalFinding({ message: c }), false, `should NOT be conditional: ${c}`);
  }
});

test("beta49 C: findingText reads the loose finding schema variants", () => {
  assert.equal(findingText({ message: "m" }), "m");
  assert.equal(findingText({ finding: "f" }), "f");
  assert.equal(findingText({ detail: "d" }), "d");
  assert.equal(findingText({ description: "x" }), "x");
  assert.equal(findingText(null), "");
});

test("beta49 C: regex is exported and case-insensitive", () => {
  assert.ok(CONDITIONAL_FINDING_RE instanceof RegExp);
  assert.equal(CONDITIONAL_FINDING_RE.flags.includes("i"), true);
});

// ---------------------------------------------------------------------------
// A: dropFindings param wiring (source assertions -- the tool closure is not
// importable).
// ---------------------------------------------------------------------------
test("beta49 A: harness_revise declares a dropFindings array param", () => {
  assert.match(regSrc, /dropFindings:\s*\{\s*\n?\s*type:\s*"array"/);
  assert.match(regSrc, /items:\s*\{\s*type:\s*"number",\s*minimum:\s*1\s*\}/);
});

test("beta49 A: dropFindings is threaded into buildReviseBrief", () => {
  assert.match(regSrc, /buildReviseBrief\(row,\s*\{\s*dropFindings\s*\}\)/);
  assert.match(regSrc, /const drop = new Set\(\(opts\.dropFindings \?\? \[\]\)/);
});

test("beta49 A: dropped indices are excluded but display indices stay stable", () => {
  // 1-based display index preserved via `i + 1` even after dropping, so
  // "finding 10" always means the same finding.
  assert.match(regSrc, /const displayIdx = i \+ 1;/);
  assert.match(regSrc, /if \(drop\.has\(displayIdx\)\) \{[\s\S]*?droppedIdx\.push\(displayIdx\);[\s\S]*?return;/);
});

// ---------------------------------------------------------------------------
// C wiring: demotion rewrites the finding + adds the verify-first note.
// ---------------------------------------------------------------------------
test("beta49 C: conditional findings are rewritten to verify-premise-first, not dropped", () => {
  assert.match(regSrc, /if \(isConditionalFinding\(f\)\) \{/);
  assert.match(regSrc, /CONDITIONAL PREMISE/);
  assert.match(regSrc, /FIRST verify the premise by grepping/);
  assert.match(regSrc, /demotedIdx\.push\(displayIdx\)/);
});

test("beta49 C: acceptance criteria gains a premise-verify note only when demotions exist", () => {
  assert.match(regSrc, /demotedIdx\.length[\s\S]*?must be premise-verified against the current repo BEFORE any change/);
});

// ---------------------------------------------------------------------------
// Provenance: _reviseMeta is audited and stripped before reaching the loop.
// ---------------------------------------------------------------------------
test("beta49: _reviseMeta records total/dropped/demoted and is stripped before startSessionFromBrief", () => {
  assert.match(regSrc, /_reviseMeta:\s*\{\s*total: allFindings\.length, dropped: droppedIdx, demoted: demotedIdx \}/);
  // stripped via destructure so it never reaches crystallised_prompt
  assert.match(regSrc, /const \{ _reviseMeta, \.\.\.cleanBrief \} = built/);
  assert.match(regSrc, /brief:\s*cleanBrief,/);
});

test("beta49: tool.revise.started audit carries findingsDropped + findingsDemotedConditional", () => {
  assert.match(regSrc, /findingsDropped: _reviseMeta\?\.dropped \?\? \[\]/);
  assert.match(regSrc, /findingsDemotedConditional: _reviseMeta\?\.demoted \?\? \[\]/);
});

test("beta49: harness_list_revisable exposes per-finding index + conditional flag", () => {
  assert.match(regSrc, /index: i \+ 1,/);
  assert.match(regSrc, /conditional: isConditionalFinding\(f\)/);
});
