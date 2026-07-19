// beta.41: auto-feedback directive. Every successful harness_run /
// harness_start_session return must carry a machine-readable `details.feedback`
// directive telling the caller to poll harness_progress and relay `headline`
// until terminal -- so progress is automatic without a human instructing the
// agent to monitor. The harness itself never posts to Slack (Carel's hard
// constraint; beta.34 invariant). These are source-assertion tests: the tool
// returns are function-local literals, not exported, matching the
// beta.19/33/40 pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const regSrc = readFileSync(join(here, "..", "src", "tools", "registration.ts"), "utf8");

test("beta41: both start tools return a details.feedback directive", () => {
  // Two success returns (harness_run + harness_start_session) each build a
  // `feedback` object and attach it to details.
  const feedbackBlocks = regSrc.match(/const feedback = \{/g) ?? [];
  assert.ok(feedbackBlocks.length >= 2, "expected a feedback directive in both harness_run and harness_start_session");
  const attaches = regSrc.match(/details: \{ ok: true[^}]*feedback/g) ?? regSrc.match(/feedback \}/g) ?? [];
  assert.ok(regSrc.includes("feedback }"), "feedback must be attached to the success details payload");
});

test("beta41: feedback directive names harness_progress, 45s interval, headline field, terminal stop", () => {
  assert.ok(regSrc.includes('poll: "harness_progress"'), "directive must target harness_progress");
  assert.ok(regSrc.includes("intervalSeconds: 45"), "directive must specify a 45s poll interval");
  assert.ok(regSrc.includes('relayField: "headline"'), "directive must relay the headline field");
  assert.ok(regSrc.includes('until: "terminal"'), "directive must stop at terminal");
  assert.ok(regSrc.includes("args: { sessionId: res.sessionId }"), "directive must carry the sessionId to poll");
});

test("beta41: tool descriptions carry the imperative post-call poll protocol", () => {
  const occurrences = regSrc.match(/AUTOMATIC PROGRESS \(REQUIRED\)/g) ?? [];
  assert.ok(occurrences.length >= 2, "both harness_run and harness_start_session descriptions must carry the protocol");
  assert.ok(regSrc.includes("harness NEVER posts to Slack itself"), "must state the harness does not post to Slack");
  assert.ok(regSrc.includes("Do NOT fire-and-forget"), "must forbid fire-and-forget");
});

test("beta41: the human-facing text also mentions automatic progress polling", () => {
  assert.ok(
    regSrc.includes("Surface progress automatically: poll harness_progress"),
    "the content text must tell an agent that only reads content (not details) to poll harness_progress",
  );
});
