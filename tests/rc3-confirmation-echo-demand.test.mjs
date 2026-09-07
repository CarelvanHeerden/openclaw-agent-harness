/**
 * rc.3 item 1: the pre-spend confirmation must survive the relay.
 *
 * The bug, concretely. Session `112673df` on the v2.0.0-rc.2 smoke. The b120
 * gate fired and `renderBriefConfirmation` produced the whole brief -- title,
 * motivation, acceptance criteria, files, out-of-scope, cost, source, reply
 * instructions, session id. What reached the operator in Slack was four lines:
 *
 *   Harness v2.0.0-rc.2 is loaded. Before starting, it requires Carel's confirmation:
 *   Repository Stitch-Vercel/StitchGuard. Risk medium. Estimated ~$40.00, cap $40.00.
 *   Reply "confirm" to start, or specify changes. ... Default limit is 3 hours.
 *   Session 112673df-68e0-4846-ae97-30121ea2c02d.
 *
 * Exactly one line survived byte-for-byte: repository/risk/cost. A $40 run went
 * up for approval against a repository name and a risk level.
 *
 * Three earlier fixes for this class were instructions to relay faithfully, and
 * two of them lived in `details.feedback.instruction` -- metadata beside the
 * payload, which a caller drops without dropping anything it displays. This one
 * asks for something a model will actually do (write what it understood) and
 * puts the demand in the message body, between the two regions that survived.
 *
 * What these tests pin down is deliberately narrow: the demand exists, it is
 * additive rather than a substitute, it sits where compression spared the text,
 * and the operator is told what a missing echo means. None of that can force a
 * caller to comply -- that is what the delivery half of the spec is for. See
 * notes/SPEC-rc3-confirmation-relay-fidelity.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let briefConfirmation;
try {
  briefConfirmation = await import("../dist/tools/brief-confirmation.js");
} catch {
  briefConfirmation = null;
}
const skip = briefConfirmation === null;

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(resolve(here, "..", p), "utf8");

/** The brief from the b119 disaster, so the fixture is a real one. */
function render(over = {}) {
  const { renderBriefConfirmation } = briefConfirmation;
  return renderBriefConfirmation({
    brief: {
      title: "Continuity & Resilience artefact library",
      motivation: "BCP/DR artefacts have no home",
      acceptanceCriteria: ["performedAt is the date the exercise was RUN", "kind/title on every artefact"],
      filesLikelyTouched: ["prisma/schema.prisma"],
      outOfScope: ["Do not touch the policy register"],
      riskLevel: "medium",
      repoHint: "Stitch-Vercel/StitchGuard",
    },
    estimatedUsd: 40,
    effectiveBudget: 40,
    sessionId: "112673df-68e0-4846-ae97-30121ea2c02d",
    ...over,
  });
}

// ---------------------------------------------------------------------------
// The demand itself
// ---------------------------------------------------------------------------

test("rc3: the confirmation asks the relaying agent for its own understanding", { skip }, () => {
  const out = render();
  assert.match(out, /OpenClaw, before you relay this/, "the demand is addressed to the caller");
  assert.match(out, /What I understood/, "and names the heading it must write under");
  assert.match(out, /in your words/, "its own words, not a restatement of the brief");
});

test("rc3: the demand is additive -- it may never replace the brief", { skip }, () => {
  const out = render();
  // The b119 failure was a fluent, confident, WRONG paraphrase. An agent echo
  // that stands in for the harness's brief reproduces that hole exactly, and
  // hides it behind something that reads like diligence.
  assert.match(out, /ADD it/, "the caller is told to add, in the imperative");
  assert.match(out, /replaces no part of the brief above/);
  assert.match(
    out,
    /summarising that brief is not the same thing/i,
    "a summary of the harness's brief is the obvious wrong way to satisfy this",
  );
});

test("rc3: the operator is told what a missing echo means", { skip }, () => {
  const out = render();
  assert.match(out, /If you are the operator/, "the fallback is addressed to the human, not the agent");
  assert.match(out, /abridged in transit/);
  assert.match(
    out,
    /rather than confirming/,
    "and the instruction is to NOT confirm -- an abridged brief is not something to approve",
  );
  // Naming the sections tells the operator what absence looks like. "The brief
  // seemed short" is not actionable; "there were no acceptance criteria" is.
  assert.match(out, /acceptance criteria, files and out-of-scope list/);
});

// ---------------------------------------------------------------------------
// Placement -- the whole point of putting it in the body
// ---------------------------------------------------------------------------

test("rc3: the demand sits between the two regions that survived compression", { skip }, () => {
  const out = render();
  const cost = out.indexOf("Estimated ~$40.00");
  const demand = out.indexOf("OpenClaw, before you relay this");
  const reply = out.indexOf('Reply "confirm" to start');
  assert.ok(cost >= 0 && demand >= 0 && reply >= 0, "all three landmarks are present");
  // On 112673df the cost line and the reply instructions both came through; the
  // brief between them did not. Anything wedged between the survivors travels
  // with them.
  assert.ok(cost < demand, "the demand follows the budget line Carel asked it to sit with");
  assert.ok(demand < reply, "and precedes the reply instructions");
});

test("rc3: the demand is in the operator-facing body, not only in tool metadata", { skip }, () => {
  // details.feedback.instruction is where the previous two fixes lived, and it
  // is droppable without dropping anything the caller is showing anyone. The
  // body is not: relaying the message at all carries this text.
  const out = render();
  assert.ok(
    out.includes("What I understood"),
    "renderBriefConfirmation output is the message itself -- if the demand is only in `details`, this fails",
  );
});

// ---------------------------------------------------------------------------
// The brief still has to be there
// ---------------------------------------------------------------------------

test("rc3: adding the demand did not cost the brief any of its sections", { skip }, () => {
  const out = render();
  assert.match(out, /Continuity & Resilience artefact library/, "title");
  assert.match(out, /performedAt is the date the exercise was RUN/, "acceptance criteria");
  assert.match(out, /prisma\/schema\.prisma/, "files");
  assert.match(out, /Do not touch the policy register/, "out of scope");
  assert.match(out, /Repository Stitch-Vercel\/StitchGuard/, "the one line that survived last time");
  assert.match(out, /112673df-68e0-4846-ae97-30121ea2c02d/, "session id");
});

test("rc3: an empty brief still prints its headings, so a short message is diagnostic", { skip }, () => {
  // This is what makes the paraphrase provable rather than merely suspected: a
  // genuinely empty brief is still LONG, because the headings are unconditional.
  // If the headings are ever made conditional, the b120 forensics break.
  const out = render({
    brief: { title: "t", motivation: "", acceptanceCriteria: [], filesLikelyTouched: [], outOfScope: [], riskLevel: "low" },
  });
  assert.match(out, /Acceptance criteria \(0\):/);
  assert.match(out, /Files it expects to touch:/);
  assert.match(out, /Explicitly out of scope:/);
  assert.match(out, /\(none specified\)/);
});

// ---------------------------------------------------------------------------
// The other two channels that carry this
// ---------------------------------------------------------------------------

test("rc3: both confirmation tool responses demand the full text and the echo", { skip }, () => {
  const reg = S("src/tools/registration.ts");
  // harness_run and harness_start_session each return their own feedback block;
  // b120 notes that a caller-built brief is MORE exposed to drift, not less, so
  // neither may be left behind.
  const blocks = reg.split("if (res.awaitingConfirmation === true) {").slice(1);
  assert.equal(blocks.length, 2, "both confirmation paths still return a feedback block");
  for (const [i, block] of blocks.slice(0, 2).entries()) {
    const head = block.slice(0, 2000);
    assert.match(head, /IN FULL/, `path ${i}: the caller is told the whole text, not a digest`);
    assert.match(head, /What I understood/, `path ${i}: and asked for its own echo`);
  }
});

test("rc3: the intake skill agrees with the message", { skip }, () => {
  const skill = S("skills/harness-brief-intake/SKILL.md");
  assert.match(skill, /What I understood/, "the skill names the same heading");
  assert.match(skill, /112673df/, "and cites the incident, so the rule has a reason attached");
  assert.match(skill, /Alongside — \*never\* instead of\./, "additive, stated as plainly as in the message");
  assert.match(
    skill,
    /- \[ \] Did I add my own "What I understood" paragraph next to it\?/,
    "the checklist is what gets read under time pressure",
  );
});

test("rc3: the heading is defined once and reused", { skip }, () => {
  const { UNDERSTANDING_HEADING } = briefConfirmation;
  assert.equal(UNDERSTANDING_HEADING, "What I understood");
  // Three copies of a magic string drift; the message would then ask for one
  // heading while the skill taught another, and neither would be wrong enough
  // to notice.
  const src = S("src/tools/brief-confirmation.ts");
  const literals = src.match(/"What I understood"/g) ?? [];
  assert.equal(literals.length, 1, "only the constant's own definition may spell it out");
});
