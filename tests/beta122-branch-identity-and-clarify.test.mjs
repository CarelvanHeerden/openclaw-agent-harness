/**
 * beta.122: the six defects the b121 smoke earned.
 *
 * That run proved the b120/b121 brief-fidelity work: for the first time in ten
 * DR/BCP attempts the crystallised brief kept `performedAt`, the full
 * `exerciseType` enum, and the out-of-scope block, read verbatim from the
 * operator's file. Then it died at $2.39 with two correct commits orphaned,
 * and the chain that killed it was:
 *
 *   1. the lead named a DIRECTORY (`prisma/migrations`) as a contract path, so
 *      `file_written` could never pass and the run escalated to a human over a
 *      question with exactly one possible answer;
 *   2. the prompt offered `skip`, described as "accept that this sub-task is
 *      done" and implemented as "never do this work", so answering it dropped
 *      a migration that was already committed and correct;
 *   3. the answer took the resume path, where a re-plan RENAMED the branch
 *      (`feat-grc-...` -> `feat/grc-...`) because b108 pinned only the suffix;
 *   4. b101's preservation looked up the new name, missed, and the allocator
 *      reset the worktree to origin/main over two commits it could have found
 *      in the ledger.
 *
 * Plus three reporting defects the same run surfaced: a budget named at the
 * confirmation gate was filed as a spec change and never applied, the relayed
 * session id was wrong, and the sub-task counter read "1/1" for a ten-part plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const S = (p) => readFileSync(resolve(ROOT, p), "utf8");

let rescue = null;
let confirm = null;
let clarify = null;
let progressMod = null;
let openStateStoreSync = null;
try {
  rescue = await import("../dist/orchestrator/basename-rescue.js");
  confirm = await import("../dist/tools/brief-confirmation.js");
  clarify = await import("../dist/orchestrator/contract-clarify.js");
  progressMod = await import("../dist/orchestrator/progress.js");
  ({ openStateStoreSync } = await import("../dist/state/store.js"));
} catch {
  /* dist not built: the structural tests below still run */
}
const skip = { skip: rescue === null ? "dist not built" : false };

// ---------------------------------------------------------------------------
// Fix 1: a re-plan may not rename the session's branch
// ---------------------------------------------------------------------------

test("the lead uses the session's existing branch verbatim, whatever it proposes", skip, async () => {
  const lead = await import("../dist/orchestrator/lead.js");
  const { sessionScopedBranch } = lead;
  // This is what b108 actually guarantees, and it is not enough on its own:
  // the SUFFIX is stable, so two different stems still produce two different
  // branches for one session. Exactly the b121 dash-vs-slash pair.
  const first = sessionScopedBranch("harness/feat-grc-continuity-resilience", "1ef99186-4e89-4292");
  const second = sessionScopedBranch("harness/feat/grc-continuity-resilience", "1ef99186-4e89-4292");
  assert.notEqual(first, second, "b108 alone cannot keep a renamed stem on one branch");
  assert.ok(first.endsWith("-1ef99186") && second.endsWith("-1ef99186"), "both carry the same session suffix");
});

test("pinnedSessionBranch overrides whatever the lead invented", () => {
  const src = S("src/orchestrator/lead.ts");
  const i = src.indexOf("deps.pinnedSessionBranch");
  assert.ok(i > 0, "the lead must consult the session's pinned branch");
  const window = src.slice(i, i + 600);
  assert.match(window, /raw\.branch = deps\.pinnedSessionBranch/, "it is used verbatim, not merged or re-slugified");
  // Order matters: a revise's pinnedBranch must still win, and the b108
  // suffixing must only run when the session has no branch yet.
  const pinned = src.indexOf("if (brief.pinnedBranch)");
  const scoped = src.indexOf("sessionScopedBranch(raw.branch");
  assert.ok(pinned > 0 && pinned < i, "a revise's pinned branch is still checked first");
  assert.ok(scoped > i, "b108 suffixing is the fallback for a session with no branch yet");
});

test("the loop passes the branch it already recorded, not the one being planned", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /pinnedSessionBranch: \(row\.branch \?\? ""\)\.trim\(\) \|\| undefined/);
  // The read has to come from the sessions row. Taking it from the new plan
  // would be circular -- the plan is the thing that renamed it.
  assert.match(
    src,
    /SELECT id, requester, cost_usd, budget_usd, cycles_ran, status, branch FROM sessions/,
    "the session row must actually select branch",
  );
});

// ---------------------------------------------------------------------------
// Fix 2: a missing branch is not the same as no work
// ---------------------------------------------------------------------------

test("allocation re-attaches a missing branch to the ledger tip instead of resetting", () => {
  const src = S("src/adapters/git-worktree.ts");
  const i = src.indexOf("const recoverSha");
  assert.ok(i > 0, "the recovery path must exist");
  const window = src.slice(i, i + 1800);
  assert.match(window, /preserveRequested && !localExists && recoverSha/, "only when preservation was asked for and missed");
  assert.match(window, /"branch", ctx\.sessionBranch, recoverSha/, "the branch is created ON the recorded commit");
  assert.match(window, /decide\("recovered_local", recoverSha\)/, "and the decision is auditable");

  // Load-bearing ordering: recovery must be attempted BEFORE any resetting
  // path, or it can never run. This is the whole defect.
  const reset = src.indexOf('decide("reset_to_base"');
  assert.ok(i < reset, "recovery is attempted before the resetting checkout");
});

test("recovery refuses a SHA this repo does not have, rather than dying", () => {
  const src = S("src/adapters/git-worktree.ts");
  const i = src.indexOf("const recoverSha");
  const window = src.slice(i, i + 1800);
  assert.match(window, /cat-file", "-t", recoverSha/, "the SHA is verified before a branch is built on it");
  assert.match(window, /if \(type === "commit"\)/);
  // A failed recovery must degrade to the old behaviour, not abort allocation:
  // the reachability guard still refuses to ship an incomplete diff.
  assert.match(window, /catch \(err\)/);
  assert.match(window, /falling through/i);
});

test("the ledger tip is read from the same source the reachability guard uses", () => {
  const src = S("src/orchestrator/loop.ts");
  assert.match(src, /lastLedgerCommitSha\(sessionId: string\)/);
  assert.match(src, /private readLedgerCommits\(sessionId: string\)/);
  // Two readers of "this session's commits" that could disagree would mean the
  // allocator preserving one thing and the guard checking another.
  const guard = src.indexOf("private async checkLedgerReachability");
  assert.match(src.slice(guard, guard + 900), /this\.readLedgerCommits\(sessionId\)/);
  assert.match(src, /recoverBranchFromSha: this\.lastLedgerCommitSha\(sessionId\)/);
});

// ---------------------------------------------------------------------------
// Fix 3: a directory contract path resolves itself
// ---------------------------------------------------------------------------

test("the b121 migration mismatch resolves without asking a human", skip, () => {
  const { proposeDirectoryRescue } = rescue;
  const r = proposeDirectoryRescue({
    expected: ["prisma/migrations"],
    actual: ["prisma/migrations/20260812120000_continuity_resilience/migration.sql"],
  });
  assert.ok(r, "a directory contract with one file inside it is a 1:1 mapping");
  assert.equal(r.to, "prisma/migrations/20260812120000_continuity_resilience/migration.sql");
  assert.equal(r.from, "prisma/migrations");
  assert.equal(r.kind, "directory");
});

test("other committed files do not block the rescue, but two candidates do", skip, () => {
  const { proposeDirectoryRescue } = rescue;
  // A migration sub-task legitimately touches the schema too.
  const ok = proposeDirectoryRescue({
    expected: ["prisma/migrations"],
    actual: ["prisma/schema.prisma", "prisma/migrations/2026_x/migration.sql"],
  });
  assert.ok(ok, "a file outside the named directory is irrelevant to the mapping");
  assert.equal(ok.to, "prisma/migrations/2026_x/migration.sql");

  const ambiguous = proposeDirectoryRescue({
    expected: ["prisma/migrations"],
    actual: ["prisma/migrations/2026_x/migration.sql", "prisma/migrations/2026_y/migration.sql"],
  });
  assert.equal(ambiguous, undefined, "two candidates inside the directory is a real question");
});

test("a sibling with a longer name is never mistaken for a file inside a directory", skip, () => {
  const { proposeDirectoryRescue } = rescue;
  assert.equal(
    proposeDirectoryRescue({ expected: ["src/app"], actual: ["src/app.tsx"] }),
    undefined,
    "src/app.tsx is not inside src/",
  );
  assert.equal(
    proposeDirectoryRescue({ expected: ["src/a.ts"], actual: ["src/a.ts"] }),
    undefined,
    "nothing to rescue when they already match",
  );
});

test("the loop tries the directory rescue and audits which kind fired", () => {
  const src = S("src/orchestrator/loop.ts");
  const chain = src.indexOf("proposeBasenameRescue({ expected, actual, repoDirs");
  assert.ok(chain > 0, "the basename rescue is still tried");
  assert.match(
    src.slice(chain, chain + 200),
    /\?\?\s*\n\s*proposeDirectoryRescue\(\{ expected, actual \}\)/,
    "the directory rescue is the fallback, tried only when basename declines",
  );
  assert.match(src, /kind: rescue\.kind \?\? "basename"/);
  // The rescue is still only accepted if the corrected contract actually
  // verifies -- b105's discipline, which b122 must not loosen.
  const i = src.indexOf("proposeDirectoryRescue({ expected, actual })");
  assert.match(src.slice(i, i + 2500), /verifySubTaskOutput/);
});

// ---------------------------------------------------------------------------
// Fix 4: "accept the commit" and "drop the sub-task" are different answers
// ---------------------------------------------------------------------------

test("the prompt no longer describes skip as accepting the work", skip, () => {
  const { buildContractClarification } = clarify;
  const q = buildContractClarification({
    seq: 3,
    title: "Generate the continuity_resilience migration SQL",
    commitSha: "145d2533a58dfcb7324c1d0f7b6cb3277c1c01a2",
    expected: ["prisma/migrations"],
    actual: ["prisma/migrations/2026_x/migration.sql"],
    statedReason: "prisma migrate diff --from-schema",
    changedOnBranch: [],
  });
  assert.match(q, /accept.*keep the work/i);
  assert.match(q, /skip.*drop this sub-task/i);
  assert.ok(
    !/skip.*accept that this sub-task is done/i.test(q),
    "the sentence that made an operator drop committed work must be gone",
  );
});

test("accept keeps the requirement in the brief; skip strips it", () => {
  const src = S("src/tools/registration.ts");
  const acc = src.indexOf('/^accept\\b/i.test(trimmed)');
  assert.ok(acc > 0, "accept must be handled");
  // Bound the window at the skip branch, or the assertions below read skip's
  // code and pass for the wrong reason.
  const skipAt = src.indexOf("} else if (/^skip\\b/i.test(trimmed))", acc);
  assert.ok(skipAt > acc, "skip must follow accept");
  const accWindow = src.slice(acc, skipAt);
  assert.match(accWindow, /ALREADY DONE \(operator-confirmed\)/);
  assert.match(accWindow, /remains in scope for review/i, "the adversary must still check the work is there");
  assert.ok(
    !/outOfScope/.test(accWindow),
    "accept must NOT write a prohibition -- that is the skip behaviour it exists to be distinct from",
  );
  // And skip keeps its teeth.
  const sk = src.indexOf('} else if (/^skip\\b/i.test(trimmed))');
  assert.ok(sk > acc, "skip is still handled, after accept");
  assert.match(src.slice(sk, sk + 2400), /Do NOT perform the following work under ANY circumstances/);
});

// ---------------------------------------------------------------------------
// Fix 5: a budget named at the gate is applied, not filed as a spec change
// ---------------------------------------------------------------------------

test("the exact b121 reply raises the cap and still counts as approval", skip, () => {
  const { parseConfirmationReply } = confirm;
  const r = parseConfirmationReply("Confirm, Budget $40");
  assert.equal(r.budgetUsd, 40);
  assert.equal(r.approves, true, "the budget was the only qualification, so this IS a confirmation");
  assert.equal(r.remainder.toLowerCase().replace(/[.,]/g, "").trim(), "confirm");
});

test("a budget plus a real correction is still a correction", skip, () => {
  const { parseConfirmationReply } = confirm;
  const r = parseConfirmationReply("budget $40, and use performedAt not scheduledAt");
  assert.equal(r.budgetUsd, 40);
  assert.equal(r.approves, false, "a substantive change must never be read as approval");
  assert.match(r.remainder, /performedAt/);
  assert.ok(!/budget/i.test(r.remainder), "the budget clause is not left in the spec correction");
});

test("replies with no budget behave exactly as before", skip, () => {
  const { parseConfirmationReply, isBriefConfirmation } = confirm;
  assert.equal(parseConfirmationReply("confirm").budgetUsd, undefined);
  assert.equal(parseConfirmationReply("confirm").approves, true);
  assert.equal(parseConfirmationReply("use performedAt").approves, false);
  // A price mentioned as part of the WORK is not a session budget.
  const spec = parseConfirmationReply("the invoice total field should default to $0");
  assert.equal(spec.approves, false);
  assert.equal(spec.budgetUsd, undefined, "a dollar sign alone is not a budget instruction");

  // The dangerous direction: a spec phrase misread as a budget would BOTH set
  // a wrong cap and delete those words from the correction the operator wrote.
  for (const phrase of [
    "set the retry limit to 3",
    "cap the upload list at 20 items",
    "increase the page size to 50",
  ]) {
    const r = parseConfirmationReply(phrase);
    assert.equal(r.budgetUsd, undefined, `"${phrase}" is spec text, not a budget`);
    assert.equal(r.remainder, phrase, "and it must reach the brief intact");
  }
  // While the forms that ARE money still land.
  assert.equal(parseConfirmationReply("confirm, cap $30").budgetUsd, 30);
  assert.equal(parseConfirmationReply("confirm, bump to $75").budgetUsd, 75);
  assert.equal(parseConfirmationReply("budget of 40 usd, confirm").budgetUsd, 40);
  assert.equal(isBriefConfirmation("confirm, budget $40"), false, "the raw affirmation check stays strict");
});

test("the applied budget is written to the session and clamped by the ceiling", () => {
  const src = S("src/tools/registration.ts");
  const i = src.indexOf("parseConfirmationReply(trimmed)");
  assert.ok(i > 0);
  // beta.123: widened from 1600. The window is a character count, so adding
  // the time-budget clause beside the money one pushed the last assertion out
  // of range and failed a test about behaviour that had not changed -- the
  // recurring cost of pinning source text by offset rather than by meaning.
  const window = src.slice(i, i + 2600);
  assert.match(window, /UPDATE sessions SET budget_usd = \?/, "it must reach the column the loop enforces against");
  assert.match(window, /session_hard_ceiling_usd/, "the advertised ceiling still binds");
  assert.match(window, /tool\.answer_brief_budget_set/);
  // The correction that gets filed is the REMAINDER, never the raw reply --
  // otherwise "Confirm, Budget $40" lands in the acceptance criteria again.
  assert.match(window, /\$\{parsed\.remainder \|\| trimmed\}/);
});

// ---------------------------------------------------------------------------
// Fix 6: the confirmation carries its own session id
// ---------------------------------------------------------------------------

test("the confirmation text names the session, so a verbatim relay carries it", skip, () => {
  const { renderBriefConfirmation } = confirm;
  const text = renderBriefConfirmation({
    brief: { title: "T", acceptanceCriteria: ["a"], riskLevel: "high" },
    estimatedUsd: 10,
    effectiveBudget: 10,
    sessionId: "1ef99186-4e89-4292-9e72-9eb97c86e49c",
  });
  assert.match(text, /1ef99186-4e89-4292-9e72-9eb97c86e49c/);
  assert.match(text, /budget \$30/i, "the operator is told how to change the cap in the same reply");
});

// ---------------------------------------------------------------------------
// Fix 7: the sub-task counter counts the plan
// ---------------------------------------------------------------------------

test("a ten-sub-task plan reads 1/10 on its first sub-task, not 1/1", async () => {
  if (!progressMod || !openStateStoreSync) return;
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "b122-"));
  const store = openStateStoreSync(join(dir, "h.db"));
  const now = Date.now();
  const id = "1ef99186-4e89-4292-9e72-9eb97c86e49c";
  const plan = { subTasks: Array.from({ length: 10 }, (_, i) => ({ seq: i + 1 })) };
  store.db
    .prepare(
      `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
         status, cost_usd, budget_usd, cycles_ran, lead_plan_json, created_at, updated_at)
       VALUES (?, '', '', 'U1', '', 'acme/repo', 'harness/feat-x', '', 'executing', 1, 40, 1, ?, ?, ?)`,
    )
    .run(id, JSON.stringify(plan), now, now);
  // Only the first sub-task has started, which is exactly when the old
  // denominator said "1/1" and told the operator the run was nearly done.
  store.db
    .prepare(
      `INSERT INTO sub_tasks (session_id, cycle, seq, description, status, cost_usd, worker_model, started_at, created_at, updated_at)
       VALUES (?, 1, 1, 'Probe GRC conventions', 'running', 0.64, 'sonnet-5', ?, ?, ?)`,
    )
    .run(id, now, now, now);

  const snap = progressMod.buildProgressSnapshot(store.db, id);
  assert.equal(snap.subTasks.total, 10, "the denominator comes from the plan");
  assert.match(snap.headline, /1\/10/, "and the operator sees the real size of the run");
});

test("a revise cycle still counts rows, and the plan can never shrink the count", () => {
  const src = S("src/orchestrator/progress.ts");
  const i = src.indexOf("let plannedTotal = 0;");
  assert.ok(i > 0);
  const window = src.slice(i, i + 700);
  assert.match(window, /latestCycle <= 1/, "only cycle 1 runs the whole plan");
  assert.match(window, /Math\.max\(all\.length, plannedTotal\)/, "a short or stale plan cannot hide started work");
  assert.match(window, /catch/, "an unparseable plan leaves the row count in charge");
});
