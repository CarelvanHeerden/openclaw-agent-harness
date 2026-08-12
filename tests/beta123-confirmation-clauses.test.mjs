// beta.123 — the confirmation reply is a sentence, not a field.
//
// Three releases running, an operator answered the pre-spend gate with an
// approval plus an instruction, and the harness got it wrong a different way
// each time:
//
//   b121  "Confirm, Budget $40" -> filed verbatim as acceptance criterion #16,
//         run started at the $10 default.
//   b122  budget parsing shipped. Next reply was "confirm, set the Budget to
//         $40 with a time budget of 3 hours". The money landed; the leftover
//         "with a time budget of 3 hours" meant the remainder was not empty, so
//         a plain approval was filed as a spec correction AGAIN. And had the
//         operator put the clauses the other way round, `\bbudget\b` followed
//         by a number would have matched "time budget of 3" and capped the run
//         at $3.
//
// So the parser is tested on the sentences people actually typed.
import test from "node:test";
import assert from "node:assert/strict";

let parseConfirmationReply;
try {
  ({ parseConfirmationReply } = await import("../dist/tools/brief-confirmation.js"));
} catch {
  parseConfirmationReply = undefined;
}
const skip = parseConfirmationReply === undefined ? "dist/ not built" : false;

test("beta123: the exact b122 reply approves, and sets both ceilings", { skip }, () => {
  const r = parseConfirmationReply("confirm, set the Budget to $40 with a time budget of 3 hours");
  assert.equal(r.budgetUsd, 40);
  assert.equal(r.timeoutSeconds, 3 * 3600);
  assert.equal(r.approves, true, "this is an approval; filing it as a spec correction is the b121/b122 defect");
  assert.equal(r.remainder, "confirm", "nothing of the instruction may survive into the brief");
});

test("beta123: clause order does not decide the cap", { skip }, () => {
  const a = parseConfirmationReply("confirm, budget $40 with a time budget of 3 hours");
  const b = parseConfirmationReply("confirm, a time budget of 3 hours and budget $40");
  assert.equal(a.budgetUsd, 40);
  assert.equal(b.budgetUsd, 40, "'time budget of 3 hours' must never be read as a $3 cap");
  assert.equal(a.timeoutSeconds, b.timeoutSeconds);
});

test("beta123: a time budget alone still approves", { skip }, () => {
  const r = parseConfirmationReply("yes, give it a time budget of 90 minutes");
  assert.equal(r.timeoutSeconds, 5400);
  assert.equal(r.budgetUsd, undefined);
  assert.equal(r.approves, true);
});

test("beta123: the b122 money behaviour is unchanged", { skip }, () => {
  const r = parseConfirmationReply("Confirm, Budget $40");
  assert.equal(r.budgetUsd, 40);
  assert.equal(r.approves, true);
  assert.equal(r.timeoutSeconds, undefined);
});

// ---------------------------------------------------------------------------
// The lopsided precision the b122 comment describes still has to hold: reading
// a cap that is not there is worse than missing one, because it BOTH sets the
// wrong ceiling AND deletes the matched words from the operator's correction.
// ---------------------------------------------------------------------------

test("beta123: a real correction is never mistaken for a ceiling", { skip }, () => {
  for (const reply of [
    "confirm but set the retry limit to 3",
    "confirm, but the deadline field must be performedAt not scheduledAt",
    "no -- use performedAt, and only 3 statuses",
  ]) {
    const r = parseConfirmationReply(reply);
    assert.equal(r.budgetUsd, undefined, `no cap in: ${reply}`);
    assert.equal(r.timeoutSeconds, undefined, `no clock in: ${reply}`);
    assert.equal(r.approves, false, `must stay a correction: ${reply}`);
    assert.equal(r.remainder, reply, "the operator's words must reach the brief intact");
  }
});

test("beta123: a correction that also raises the cap stays a correction", { skip }, () => {
  const r = parseConfirmationReply("budget $25, and use performedAt");
  assert.equal(r.budgetUsd, 25);
  assert.equal(r.approves, false, "there is a spec change in here; approving it would build the wrong thing");
  assert.match(r.remainder, /performedAt/);
  assert.doesNotMatch(r.remainder, /\$25/, "the cap must not also land in the brief");
});

test("beta123: an absurd or empty duration is left as prose", { skip }, () => {
  for (const reply of ["confirm, time budget of 0 hours", "confirm, time budget of 400 hours"]) {
    const r = parseConfirmationReply(reply);
    assert.equal(r.timeoutSeconds, undefined, `must not act on: ${reply}`);
  }
});
