// beta.55 (Feature B — human-in-the-loop): mid-run clarification.
//
// Driver: across b47/49/51/52/53 the worker made a REASONED REFUSAL /
// confabulation on #858's early sub-task and the loop HARD-FAILED, wasting the
// whole run. B2 converts that into a RESUMABLE pause: the loop persists the
// worker's own question + the paused seq, sets status `awaiting_clarification`
// (NOT terminal, worktree preserved), and surfaces it via harness_progress. A
// human answers with harness_answer and the loop re-drives with the decision
// folded into the brief.
//
//   B1  crystalliser clarify nudge (classifier prompt) -- source-asserted.
//   B2  awaiting_clarification state + finaliseAwaitingClarification (no
//       worktree release) + progress surfacing + harness_answer resume.
//   B3  loop.worker_deviation audit event on a passed-but-deviated turn.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const loop = await import("../dist/orchestrator/loop.js");
const progress = await import("../dist/orchestrator/progress.js");

// ---- B3: worker-deviation detector ----
test("beta.55 B3: matchesWorkerDeviation catches judgment-call phrasings", () => {
  const { matchesWorkerDeviation } = loop;
  assert.equal(typeof matchesWorkerDeviation, "function");
  // the #858 sub-task-2 grc case:
  assert.equal(
    matchesWorkerDeviation("I left the non-empty grc/ directories in place instead of deleting them, since removing them would destroy unrelated code."),
    true,
  );
  assert.equal(matchesWorkerDeviation("Rather than rename the file, I re-exported it to preserve both call sites."), true);
  assert.equal(matchesWorkerDeviation("I decided not to touch the shared module and only edited the page."), true);
  assert.equal(matchesWorkerDeviation("I took a different approach: wrapped the hook instead of forking it."), true);
});

test("beta.55 B3: matchesWorkerDeviation does NOT fire on a plain completion", () => {
  const { matchesWorkerDeviation } = loop;
  assert.equal(matchesWorkerDeviation("Refactored the page to consume the shared module and committed."), false);
  assert.equal(matchesWorkerDeviation("Added the aria-label and committed the change."), false);
  assert.equal(matchesWorkerDeviation(""), false);
});

// ---- B2: LoopStatus + progress surfacing (via an in-memory DB) ----
test("beta.55 B2: progress snapshot surfaces awaiting_clarification with the question", async () => {
  const { openStateStoreSync } = await import("../dist/state/store.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "b55-"));
  const store = openStateStoreSync(join(dir, "h.db"));
  const now = Date.now();
  store.db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path, status, cost_usd, budget_usd, cycles_ran, created_at, updated_at, clarification_question, clarification_seq)
     VALUES (?, '', '', ?, '', ?, ?, ?, 'awaiting_clarification', 0, 10, 1, ?, ?, ?, ?)`,
  ).run("SESS1", "U1", "acme/repo", "harness/x", join(dir, "wt"), now, now,
        "Sub-task 3 could not proceed. How should it proceed?", 3);

  const snap = progress.buildProgressSnapshot(store.db, "SESS1");
  assert.equal(snap.found, true);
  assert.equal(snap.status, "awaiting_clarification");
  assert.equal(snap.needsClarification, true);
  assert.match(snap.clarificationQuestion ?? "", /How should it proceed/);
  assert.equal(snap.clarificationSeq, 3);
  assert.match(snap.headline, /Awaiting clarification/);
  assert.match(snap.headline, /harness_answer/);
  // awaiting_clarification is NOT terminal (resumable):
  assert.equal(snap.terminal, false);
});

// ---- source-assertion wiring ----
test("beta.55 B2: loop.ts has awaiting_clarification state + finaliseAwaitingClarification that does NOT release the worktree", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /"awaiting_clarification"/, "LoopStatus includes awaiting_clarification");
  assert.match(src, /finaliseAwaitingClarification\(/, "finalise helper exists");
  assert.match(src, /loop\.clarification_requested/, "audits clarification_requested");
  // the escalation branch is gated by config and fires on a real refusal:
  assert.match(src, /clarification_escalation_enabled !== false/, "config-gated");
  assert.match(src, /clarify\.question =/, "sets a clarify question in the refusal path");
  // finaliseAwaitingClarification must NOT schedule a worktree release:
  const fnStart = src.indexOf("finaliseAwaitingClarification(");
  const fnBody = src.slice(fnStart, fnStart + 1400);
  assert.doesNotMatch(fnBody, /scheduleWorktreeReleaseForSession/, "must NOT release the worktree on a pause");
});

test("beta.55 B2: harness_answer tool registered + handles abort/skip/decision", () => {
  const reg = S("src/tools/registration.ts");
  assert.match(reg, /name: "harness_answer"/, "harness_answer registered");
  assert.match(reg, /awaiting_clarification/, "checks the paused status");
  assert.match(reg, /\^\(abort\|cancel\)/, "handles abort/cancel");
  assert.match(reg, /\^skip/, "handles skip");
  assert.match(reg, /loop\.clarification_answered/, "audits clarification_answered");
  assert.match(reg, /liveRuntime\(\)\.loop\.run\(sessionId, brief\)/, "re-drives the loop");
});

test("beta.55 B2: worktree-heal protects awaiting_clarification worktrees", () => {
  const idx = S("src/index.ts");
  assert.match(idx, /status = 'awaiting_clarification'/, "adds paused sessions to protectedWorktreePaths");
});

test("beta.55 B2: awaiting_clarification is NOT in recovery NON_TERMINAL (stays paused across restart)", () => {
  const rec = S("src/state/recovery.ts");
  assert.doesNotMatch(rec, /"awaiting_clarification"/, "recovery must not auto-resume a human-pause");
});

test("beta.55 B1: classifier prompt nudges clarify on action-changing ambiguity", () => {
  const sdk = S("src/adapters/claude-sdk.ts");
  assert.match(sdk, /genuinely ambiguous on a decision that would change WHICH files or WHAT behaviour/i);
});

test("beta.55: config + manifest carry clarification_escalation_enabled", () => {
  const cfg = S("src/config.ts");
  assert.match(cfg, /clarification_escalation_enabled\?: boolean/);
  assert.match(cfg, /clarification_escalation_enabled: true/);
  const man = S("openclaw.plugin.json");
  assert.match(man, /"clarification_escalation_enabled"/);
  assert.match(man, /"harness_answer"/, "manifest declares the tool");
});

test("beta.55: migrations add clarification columns", () => {
  const store = S("src/state/store.ts");
  assert.match(store, /clarification_question/);
  assert.match(store, /clarification_seq/);
  assert.match(store, /clarification_answer/);
});
