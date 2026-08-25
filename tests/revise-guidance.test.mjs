/**
 * harness_revise guidance: the caller can say what to DO, not only what to ignore.
 *
 * `buildReviseBrief` constructs its brief purely from the prior session's stored
 * adversary findings. `dropFindings` says which to EXCLUDE, so every steer a
 * human had was subtractive. Nothing could say what the fix should achieve.
 *
 * That holds up while a finding states the required behaviour, and fails when a
 * finding names a SYMPTOM and understates the remedy -- every cycle re-reads the
 * same stored text, and a worker satisfies it the cheapest way available.
 *
 * StitchGuard PR #1084: the finding read "external monitors cannot filter the
 * list API by status=DUE_FOR_RENEWAL server-side". Twice, a worker "addressed"
 * it by adding a code comment explaining the limitation -- responsive to those
 * words, useless as a fix. Nothing said "translate the value into a
 * `reviewDate < now()` predicate instead of rejecting it". A human wrote the six
 * lines by hand after three cycles and $25.48.
 *
 * The pattern is harness_answer's qualified confirmation, which folds a
 * free-text reply into the brief as a labelled authoritative correction that
 * supersedes anything contradicting it.
 *
 * The invariant guidance must NOT break: it adds intent and cannot weaken the
 * gate. Dropping a finding or lowering a severity stays the explicit, indexed
 * job of dropFindings.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");
const regSrc = S("src/tools/registration.ts");
const indexSrc = S("src/index.ts");

const {
  OPERATOR_GUIDANCE_LABEL,
  guidanceAcceptanceLine,
  guidanceCommentSection,
  normaliseGuidance,
} = await import("../dist/tools/revise-guidance.js");

/** The #1084 steer, as an operator would type it. */
const STEER =
  "translate status=DUE_FOR_RENEWAL into a reviewDate < now() predicate instead of rejecting the value";

/* ------------------------------------------------------------------ *
 * normalisation
 * ------------------------------------------------------------------ */

test("guidance is trimmed and flattened to a single line", () => {
  // It becomes ONE element of acceptanceCriteria and one blockquote on the PR.
  // Embedded newlines would be lost on join, or read as criteria nobody wrote.
  assert.equal(normaliseGuidance("  use a predicate  "), "use a predicate");
  assert.equal(normaliseGuidance("use a\npredicate"), "use a predicate");
  assert.equal(normaliseGuidance("use   a\t\tpredicate"), "use a predicate");
  assert.equal(normaliseGuidance("line one\n\nline two"), "line one line two");
});

test("empty guidance is the same as no guidance", () => {
  // Rather than injecting an empty authoritative instruction.
  for (const empty of ["", "   ", "\n", "\t \n ", undefined, null, 42, {}, []]) {
    assert.equal(normaliseGuidance(empty), undefined, `should be undefined: ${JSON.stringify(empty)}`);
  }
});

/* ------------------------------------------------------------------ *
 * the instruction the models read
 * ------------------------------------------------------------------ */

test("the operator's words survive verbatim", () => {
  const line = guidanceAcceptanceLine(STEER);
  assert.ok(line.includes(STEER), "the steer must not be paraphrased or truncated");
});

test("normalising flattens whitespace and changes nothing else", () => {
  // A normaliser that also trimmed length would silently rewrite the
  // instruction, and the operator would never see which half was dropped.
  assert.equal(normaliseGuidance(STEER), STEER, "a long steer must survive intact");
  assert.equal(normaliseGuidance(`  ${STEER}\n`), STEER);
  assert.equal(
    normaliseGuidance(STEER).length,
    STEER.length,
    "same length in, same length out -- no truncation",
  );
});

test("the instruction is labelled and authoritative", () => {
  const line = guidanceAcceptanceLine(STEER);
  assert.ok(line.startsWith(OPERATOR_GUIDANCE_LABEL), "must be identifiable at a glance in the criteria list");
  assert.match(line, /AUTHORITATIVE/);
  assert.match(line, /supersedes anything below that contradicts it/i);
});

test("#1084: the cheap remedies are explicitly ruled out", () => {
  // The failure was not that the worker ignored the finding. It satisfied the
  // finding's wording with a comment. The instruction has to say that a
  // responsive-but-inert change does not count.
  const line = guidanceAcceptanceLine(STEER);
  assert.match(line, /does NOT count as addressing that finding/);
  for (const cheap of ["documenting the limitation", "commenting on it", "renaming around it"]) {
    assert.ok(line.includes(cheap), `the instruction should name this dodge: ${cheap}`);
  }
});

test("a finding that names a symptom is told where the behaviour comes from", () => {
  const line = guidanceAcceptanceLine(STEER);
  assert.match(line, /names a symptom without stating the behaviour required/i);
});

/* ------------------------------------------------------------------ *
 * the invariant: guidance adds, it cannot subtract
 * ------------------------------------------------------------------ */

test("the instruction states that it cannot drop a finding or lower a severity", () => {
  const line = guidanceAcceptanceLine(STEER);
  assert.match(line, /does not drop any finding/i);
  assert.match(line, /does not lower any finding's severity/i);
  assert.match(line, /must still be addressed at the severity shown/i);
  assert.match(line, /dropFindings/, "and must name the switch that does have that authority");
});

test("guidance is not consulted when findings are dropped or rendered", () => {
  // The structural half of the same claim. Dropping is decided by `drop`, built
  // from opts.dropFindings alone, and severity is read straight off the stored
  // finding. If guidance ever leaked into that loop it could retire a finding
  // by wording, which is exactly the authority it must not have.
  const loopStart = regSrc.indexOf("allFindings.forEach((f, i) => {");
  // The forEach's own closing brace, not the next statement -- guidance is
  // declared immediately below it and would otherwise land inside the slice.
  const loopEnd = regSrc.indexOf("\n    });", loopStart);
  assert.ok(loopStart > 0 && loopEnd > loopStart, "could not locate the finding-rendering loop");
  const loopBody = regSrc.slice(loopStart, loopEnd);
  assert.doesNotMatch(loopBody, /guidance/i, "guidance must not influence which findings survive, or their severity");

  assert.match(
    regSrc,
    /const drop = new Set\(\(opts\.dropFindings \?\? \[\]\)/,
    "exclusion must be driven by dropFindings alone",
  );
});

test("guidance is an extra criterion, never a replacement for the findings", () => {
  // Spread into the array alongside the finding lines, not in place of them.
  // Line-anchored so a commented-out fold-in fails here rather than matching
  // its own corpse.
  assert.match(
    regSrc,
    /^\s*\.\.\.\(guidance \? \[guidanceAcceptanceLine\(guidance\)\] : \[\]\),$/m,
    "guidance must be additive to acceptanceCriteria",
  );
  assert.match(regSrc, /^\s*\.\.\.findingLines,$/m, "the finding lines must still be spread in unconditionally");
});

test("guidance sits above the findings it governs", () => {
  // It is the intent the findings are meant to serve, so a worker reads it
  // before reaching finding 3, not after.
  const guidanceAt = regSrc.indexOf("guidanceAcceptanceLine(guidance)");
  const findingsAt = regSrc.indexOf("...findingLines,");
  assert.ok(guidanceAt > 0 && findingsAt > 0, "both must be present");
  assert.ok(guidanceAt < findingsAt, "guidance must precede the finding lines in acceptanceCriteria");
});

/* ------------------------------------------------------------------ *
 * the tool surface
 * ------------------------------------------------------------------ */

test("the schema accepts guidance, bounded", () => {
  assert.match(regSrc, /guidance: \{\s*\n\s*type: "string",/, "guidance must be a declared string parameter");
  assert.match(regSrc, /maxLength: 2000,/, "bounded: it is copied into three prompts every cycle");
  assert.match(regSrc, /required: \["requester"\],/, "and must stay optional");
});

test("the tool description tells the caller what guidance cannot do", () => {
  // The caller is a model choosing between two parameters. If the description
  // does not separate them it will reach for guidance to dismiss a finding.
  const descAt = regSrc.indexOf('name: "harness_revise"');
  const desc = regSrc.slice(descAt, regSrc.indexOf("parameters:", descAt));
  assert.match(desc, /guidance/, "the description must mention the parameter");
  assert.match(desc, /cannot drop a finding or lower a severity/i);
  assert.match(desc, /dropFindings/);
});

test("guidance is threaded from the tool input into the brief", () => {
  assert.match(regSrc, /const \{ requester, prNumber, sessionId, budgetUsd, dropFindings, guidance \} = input as/);
  assert.match(regSrc, /buildReviseBrief\(row, \{ dropFindings, guidance \}\)/);
  assert.match(regSrc, /const guidance = normaliseGuidance\(opts\.guidance\);/, "and normalised on the way in");
});

test("the brief carries guidance structurally as well as in the prose", () => {
  // acceptanceCriteria is what the models read; the field is what the PR
  // renderer reads, so it does not have to find the line by prefix.
  assert.match(regSrc, /operatorGuidance: guidance,/);
  assert.match(S("src/crystallise/prompt-refiner.ts"), /operatorGuidance\?: string;/);
});

/* ------------------------------------------------------------------ *
 * audit
 * ------------------------------------------------------------------ */

test("the steer is recorded in the audit trail", () => {
  const auditAt = regSrc.indexOf('"tool.revise.started"');
  assert.ok(auditAt > 0, "the revise audit event must exist");
  // To the close of the audit() call. `newSessionId: started.sessionId` opens
  // the payload, so that string cannot be the terminator.
  const payload = regSrc.slice(auditAt, regSrc.indexOf("\n          );", auditAt));
  assert.match(
    payload,
    /^\s*guidance: _reviseMeta\?\.guidance \?\? null,$/m,
    "what they were told to build is half the provenance",
  );
});

test("the audited guidance is the normalised text, not the raw input", () => {
  // So the audit trail matches what the models were actually given.
  assert.match(regSrc, /_reviseMeta: \{ total: allFindings\.length, dropped: droppedIdx, demoted: demotedIdx, guidance \}/);
});

/* ------------------------------------------------------------------ *
 * the PR echo
 * ------------------------------------------------------------------ */

test("the PR section quotes the steer and repeats the constraint", () => {
  const section = guidanceCommentSection(STEER).join("\n");
  assert.match(section, /### Operator guidance for this revise/);
  assert.ok(section.includes(`> ${STEER}`), "the operator's words, blockquoted");
  assert.match(section, /does not drop findings or lower severities/i);
  assert.match(section, /dropFindings/);
});

test("the echo goes on the review comment, because a revise never rewrites the body", () => {
  // createPullRequest only writes a body on first open (beta.75). A revise
  // updates an existing PR, so the body -- which does render guidance, via
  // acceptanceCriteria -- is never rewritten for the case guidance exists for.
  assert.match(indexSrc, /opts: \{ updatedExisting: boolean; operatorGuidance\?: string \}/);
  assert.match(indexSrc, /const guidanceLines = opts\.operatorGuidance \? guidanceCommentSection\(opts\.operatorGuidance\) : \[\];/);
  assert.match(indexSrc, /operatorGuidance: brief\.operatorGuidance,/, "and the brief's copy must actually be passed in");
});

test("a review with no guidance renders exactly as before", () => {
  // The echo is additive: an ordinary run must not grow an empty section.
  assert.deepEqual(guidanceCommentSection("").length > 0, true, "the helper itself is unconditional...");
  assert.match(
    indexSrc,
    /opts\.operatorGuidance \? guidanceCommentSection\(opts\.operatorGuidance\) : \[\]/,
    "...so the CALLER must be the thing that gates it",
  );
});

/* ------------------------------------------------------------------ *
 * it reaches the models
 * ------------------------------------------------------------------ */

test("acceptanceCriteria is the carrier that reaches lead, worker and adversary", () => {
  // The whole reason guidance lands in acceptanceCriteria rather than a field of
  // its own: these three read that array. If any stopped, guidance would be
  // silently advisory again.
  assert.match(
    S("src/orchestrator/sonnet-worker.ts"),
    /brief\.acceptanceCriteria\.map/,
    "the worker system prompt renders the criteria",
  );
  assert.match(
    indexSrc,
    /\.\.\.brief\.acceptanceCriteria\.map\(\(c\) => `- \$\{c\}`\)/,
    "the adversary's crystallisedPrompt projection renders the criteria",
  );
  assert.match(
    S("src/orchestrator/loop.ts"),
    /acceptanceCriteria:\\n\$\{\(brief\.acceptanceCriteria \?\? \[\]\)\.join\("\\n"\)\}/,
    "the lead prompt snapshot renders the criteria",
  );
});
