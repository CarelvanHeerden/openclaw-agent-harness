/**
 * rc.4 -- recovering the association between a failed session and the PR it
 * already produced.
 *
 * StitchGuard session `112673df` pushed nine commits and opened PR #1168, then
 * failed before `pr_number` was written. `harness_revise` refuses a row with no
 * PR, so the one workflow built to change that PR could not see it, and the
 * documented alternative was to build the feature again.
 *
 * The whole risk here is a false yes. The branch was even named
 * `harness/sast-sheet-source-code-dashboard-112673df` -- it contains the
 * session id -- and matching on that would have "worked" on the real case while
 * being wrong in every case that matters: a force-push, a fork, a different
 * repository's #1168. So most of what follows is about refusing, and the tests
 * that assert a refusal are the load-bearing ones.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let prLink, registerHarnessTools, Database;
try {
  prLink = await import("../dist/orchestrator/pr-link.js");
  ({ registerHarnessTools } = await import("../dist/tools/registration.js"));
  ({ DatabaseSync: Database } = await import("node:sqlite"));
} catch {
  prLink = null;
}
const skip = prLink === null;
const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The real shape of the production case, so the fixtures are not a convenient
// fiction. Every value below was read off Stitch-Vercel/StitchGuard#1168.
// ---------------------------------------------------------------------------
const REPO = "Stitch-Vercel/StitchGuard";
const SESSION = "112673df-68e0-4846-ae97-30121ea2c02d";
const BRANCH = "harness/sast-sheet-source-code-dashboard-112673df";
const PR_NUMBER = 1168;
const HEAD_SHA = "1410e98db1f00bbe850ab73a8f3784c6f6c023f3";
const BASE_SHA = "d6541d5bb69d6fc7bcee06db82f382a1bf6c0e06";
const PR_COMMITS = [
  "2cf51d638c9d0000000000000000000000000000",
  "33aa1855defc0000000000000000000000000000",
  "bf7e1ee636750000000000000000000000000000",
  "7d65a4a5e05c0000000000000000000000000000",
  "784c352a43a40000000000000000000000000000",
  "008324f3cae50000000000000000000000000000",
  "a91adfd9fb790000000000000000000000000000",
  "aa2caf9bc5d00000000000000000000000000000",
  HEAD_SHA,
];
const HTML_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
/** 2026-09-07, when the real session ran. Any time firmly before "now". */
const SEEDED_AT = 1757246694000;

function openDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8"));
  return db;
}

/** A session that failed AFTER pushing its work, exactly as 112673df did. */
function seedFailedSession(db, over = {}) {
  const o = {
    id: SESSION, repo: REPO, branch: BRANCH, planBaseSha: BASE_SHA,
    status: "failed", prNumber: null, linkState: null, cost: 37.42, cycles: 4,
    commitShas: [PR_COMMITS[6], PR_COMMITS[7]],
    ...over,
  };
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
       status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, crystallised_prompt, plan_base_sha,
       pr_number, final_pr_url, pr_link_state, merge_recommendation, merge_recommendation_reason)
     VALUES (?, ?, '', 'U1', 'gh-carel', ?, ?, '/w', ?, ?, ?, 60, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
  ).run(
    // Seeded in the past so `updated_at` moving is observable; a same-millisecond
    // seed makes the "nothing else changed" assertion pass for the wrong reason.
    o.id, `agent:${o.id}`, o.repo, o.branch, o.status, SEEDED_AT, SEEDED_AT, o.cost, o.cycles,
    JSON.stringify({ title: "SAST sheet sync", acceptanceCriteria: ["tenant-scoped credentials"], outOfScope: [], filesLikelyTouched: [] }),
    o.planBaseSha, o.prNumber, o.linkState,
  );
  o.commitShas.forEach((sha, i) => {
    db.prepare(
      `INSERT INTO sub_tasks (id, session_id, cycle, seq, description, worker_model, status, commit_sha, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'work', 'm', 'done', ?, ?, ?)`,
    ).run(`${o.id}-st${i}`, o.id, i, sha, Date.now(), Date.now());
  });
  return o.id;
}

function prFacts(over = {}) {
  return {
    headRepo: REPO, headRef: BRANCH, headSha: HEAD_SHA, baseRef: "main",
    state: "open", merged: false, draft: true, htmlUrl: HTML_URL,
    commitShas: PR_COMMITS, commitsTruncated: false, mergeBaseSha: BASE_SHA,
    ...over,
  };
}

function makeDeps(db, { pr = prFacts(), authorised = ["U1"], fail = null, audits = [] } = {}) {
  return {
    db,
    audits,
    audit: (event, payload, sessionId) => audits.push({ event, payload, sessionId }),
    authorisedUsers: authorised,
    defaultBaseBranch: "main",
    fetchPr: async () => {
      if (fail) throw fail;
      return pr;
    },
  };
}

const args = (over = {}) => ({ sessionId: SESSION, repo: REPO, prNumber: PR_NUMBER, invokedBy: "U1", ...over });

// ===========================================================================
// 1. The valid recovery
// ===========================================================================

test("rc4: the real PR #1168 case verifies, and says WHY it verified", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const audits = [];
  const out = await prLink.linkPullRequest(makeDeps(db, { audits }), args());

  assert.equal(out.ok, true, "the genuine association must verify");
  assert.equal(out.dryRun, true, "no `apply` means a dry run");
  assert.equal(out.headSha, HEAD_SHA);
  const ev = out.evidence.join(" | ");
  // The evidence must name the commit check specifically. A link justified only
  // by "the branch matches" is the thing this action exists not to do.
  assert.match(ev, /Commit lineage confirmed: 2 of 2/, `lineage must be stated, got: ${ev}`);
  assert.match(ev, /Repository matches/);
  assert.match(ev, /not a fork/);
  assert.match(ev, /Head branch matches/);
  assert.match(ev, /Base branch matches/);
  assert.match(ev, /Fork point matches/);
  assert.match(out.message, /draft, which a revision can still update/, "a draft is open, and must not read as a blocker");
  assert.equal(audits[0].event, "tool.pr_link_dry_run");
});

test("rc4: a dry run writes NOTHING", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const before = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(SESSION);
  const out = await prLink.linkPullRequest(makeDeps(db), args());
  assert.equal(out.ok, true);
  const after = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(SESSION);
  assert.deepEqual(after, before, "a dry run that changed a single column is not a dry run");
  assert.equal(after.pr_number, null);
  assert.equal(after.pr_link_state, null);
});

test("rc4: applying persists the association, the evidence and the operator", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const audits = [];
  const out = await prLink.linkPullRequest(makeDeps(db, { audits }), args({ apply: true, expectedHeadSha: HEAD_SHA }));

  assert.equal(out.ok, true);
  assert.equal(out.applied, true);
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(SESSION);
  assert.equal(row.pr_number, PR_NUMBER);
  assert.equal(row.final_pr_url, HTML_URL);
  assert.equal(row.pr_link_state, "recovered", "the link must be distinguishable from one the loop made");
  assert.equal(row.pr_linked_by, "U1");
  assert.equal(row.pr_link_head_sha, HEAD_SHA);
  assert.ok(row.pr_linked_at > 0);

  const evidence = JSON.parse(row.pr_link_evidence);
  assert.deepEqual(evidence.matchedCommitShas, [PR_COMMITS[6], PR_COMMITS[7]]);
  assert.equal(evidence.mergeBaseSha, BASE_SHA);
  assert.equal(evidence.headSha, HEAD_SHA);

  const applied = audits.find((a) => a.event === "tool.pr_link_applied");
  assert.ok(applied, "an applied link must be audited");
  assert.equal(applied.sessionId, SESSION);
  assert.equal(applied.payload.repo, REPO);
  assert.equal(applied.payload.prNumber, PR_NUMBER);
  assert.equal(applied.payload.headSha, HEAD_SHA);
  assert.equal(applied.payload.invokedBy, "U1");
  assert.equal(applied.payload.sessionStatus, "failed", "the audit records the status it did NOT change");
  assert.ok(Array.isArray(applied.payload.evidence) && applied.payload.evidence.length > 0);
});

// ===========================================================================
// 2. The refusals. A matching branch name is not evidence.
// ===========================================================================

test("rc4: the wrong repository is refused even when the PR number exists there", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(makeDeps(db), args({ repo: "Other-Org/OtherRepo" }));
  assert.equal(out.ok, false);
  assert.match(out.message, /ran against Stitch-Vercel\/StitchGuard, but the request names Other-Org\/OtherRepo/);
});

test("rc4: a fork head is refused -- the harness could not push a revision to it", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(
    makeDeps(db, { pr: prFacts({ headRepo: "a-fork/StitchGuard" }) }),
    args(),
  );
  assert.equal(out.ok, false);
  assert.ok(out.blockers.some((b) => b.kind === "head_repo_mismatch"), JSON.stringify(out.blockers));
});

test("rc4: a deleted head repository is refused rather than treated as same-repo", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(makeDeps(db, { pr: prFacts({ headRepo: null }) }), args());
  assert.equal(out.ok, false);
  assert.ok(out.blockers.some((b) => b.kind === "head_repo_mismatch"));
});

test("rc4: a head branch that is not the session's branch is refused", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(makeDeps(db, { pr: prFacts({ headRef: "harness/something-else" }) }), args());
  assert.equal(out.ok, false);
  assert.ok(out.blockers.some((b) => b.kind === "branch_mismatch"));
});

test("rc4: a PR targeting the wrong base is refused", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(makeDeps(db, { pr: prFacts({ baseRef: "develop" }) }), args());
  assert.equal(out.ok, false);
  const b = out.blockers.find((x) => x.kind === "base_mismatch");
  assert.ok(b);
  assert.match(b.message, /reviewed against the wrong base/);
});

test("rc4: THE test -- the right branch name with none of the session's commits is refused", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  // The branch is named after the session, the repo is right, the base is
  // right, it is open. Only the commits differ -- a force-push over the work.
  const out = await prLink.linkPullRequest(
    makeDeps(db, { pr: prFacts({ commitShas: ["ffffffffffff0000000000000000000000000000"] }) }),
    args(),
  );
  assert.equal(out.ok, false, "a branch name must never be sufficient evidence");
  const b = out.blockers.find((x) => x.kind === "lineage_mismatch");
  assert.ok(b, JSON.stringify(out.blockers));
  assert.match(b.message, /force-pushed|different PR/);
});

test("rc4: a session that recorded no commits at all cannot be linked to anything", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db, { commitShas: [] });
  const out = await prLink.linkPullRequest(makeDeps(db), args());
  assert.equal(out.ok, false);
  const b = out.blockers.find((x) => x.kind === "no_session_commits");
  assert.ok(b, JSON.stringify(out.blockers));
  assert.match(b.message, /matching branch name is not evidence/i);
});

test("rc4: a PR forked from a different base is refused even when a commit matches", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(
    makeDeps(db, { pr: prFacts({ mergeBaseSha: "0000000abcdef0000000000000000000000000a1" }) }),
    args(),
  );
  assert.equal(out.ok, false);
  assert.ok(out.blockers.some((b) => b.kind === "base_sha_mismatch"), JSON.stringify(out.blockers));
});

test("rc4: closed and merged PRs are refused, with different reasons", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);

  const closed = await prLink.linkPullRequest(makeDeps(db, { pr: prFacts({ state: "closed" }) }), args());
  assert.equal(closed.ok, false);
  const cb = closed.blockers.find((b) => b.kind === "not_open");
  assert.ok(cb);
  assert.match(cb.message, /will not reopen a PR on an operator's behalf/);

  const merged = await prLink.linkPullRequest(makeDeps(db, { pr: prFacts({ state: "closed", merged: true }) }), args());
  assert.equal(merged.ok, false);
  assert.ok(merged.blockers.some((b) => b.kind === "merged"), "a merged PR is its own reason, not just 'closed'");
});

test("rc4: a missing PR reads as absent evidence, NOT as a mismatch", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(
    makeDeps(db, { fail: new Error("GitHub get PR #1168 failed 404: Not Found") }),
    args(),
  );
  assert.equal(out.ok, false);
  assert.match(out.message, /no evidence to link on/, "a 404 must not be reported as a verification failure");
  assert.match(out.message, /404/);
});

test("rc4: a provider outage refuses without writing, on both dry run and apply", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const boom = new Error("GitHub get PR #1168 failed 503: upstream unavailable");
  for (const extra of [{}, { apply: true, expectedHeadSha: HEAD_SHA }]) {
    const out = await prLink.linkPullRequest(makeDeps(db, { fail: boom }), args(extra));
    assert.equal(out.ok, false);
    assert.match(out.message, /no evidence to link on/);
  }
  assert.equal(db.prepare(`SELECT pr_number FROM sessions WHERE id = ?`).get(SESSION).pr_number, null);
});

test("rc4: a truncated commit list says absence is not conclusive", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(
    makeDeps(db, { pr: prFacts({ commitShas: ["aaaaaaaaaaaa0000000000000000000000000000"], commitsTruncated: true }) }),
    args(),
  );
  assert.equal(out.ok, false);
  const b = out.blockers.find((x) => x.kind === "lineage_mismatch");
  assert.match(b.message, /not conclusive/);
});

// ===========================================================================
// 3. Authorisation
// ===========================================================================

test("rc4: an unauthorised operator cannot link, and is told so distinctly", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  for (const who of ["U-nobody", "", undefined]) {
    const out = await prLink.linkPullRequest(makeDeps(db), args({ invokedBy: who, apply: true, expectedHeadSha: HEAD_SHA }));
    assert.equal(out.ok, false);
    assert.equal(out.unauthorised, true, "an authorisation failure must be distinguishable from a verification failure");
    assert.match(out.message, /slack\.authorised_users/);
  }
  assert.equal(db.prepare(`SELECT pr_number FROM sessions WHERE id = ?`).get(SESSION).pr_number, null);
});

test("rc4: authorisation is checked before the provider is ever called", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  let called = false;
  const deps = { ...makeDeps(db), fetchPr: async () => { called = true; return prFacts(); } };
  await prLink.linkPullRequest(deps, args({ invokedBy: "U-nobody" }));
  assert.equal(called, false, "an unauthorised caller must not be able to make the harness fetch on its behalf");
});

// ===========================================================================
// 4. Two-phase confirmation and staleness
// ===========================================================================

test("rc4: apply without expectedHeadSha is refused", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(makeDeps(db), args({ apply: true }));
  assert.equal(out.ok, false);
  assert.match(out.message, /apply requires expectedHeadSha/);
  assert.equal(db.prepare(`SELECT pr_number FROM sessions WHERE id = ?`).get(SESSION).pr_number, null);
});

test("rc4: a head that moved between the dry run and the apply refuses the apply", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const dry = await prLink.linkPullRequest(makeDeps(db), args());
  assert.equal(dry.ok, true);

  // Someone pushes another commit before the operator confirms.
  const moved = "99999999999900000000000000000000000000ff";
  const audits = [];
  const out = await prLink.linkPullRequest(
    makeDeps(db, { audits, pr: prFacts({ headSha: moved, commitShas: [...PR_COMMITS, moved] }) }),
    args({ apply: true, expectedHeadSha: dry.headSha }),
  );
  assert.equal(out.ok, false);
  assert.ok(out.blockers.some((b) => b.kind === "head_moved"));
  assert.match(out.message, /has moved since the dry run/);
  assert.equal(db.prepare(`SELECT pr_number FROM sessions WHERE id = ?`).get(SESSION).pr_number, null);
  assert.ok(audits.some((a) => a.event === "tool.pr_link_refused"));
});

test("rc4: the apply re-verifies -- a PR that became invalid after the dry run is refused", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const dry = await prLink.linkPullRequest(makeDeps(db), args());
  assert.equal(dry.ok, true);
  // Merged in the meantime, head unchanged, so the sha guard alone would pass.
  const out = await prLink.linkPullRequest(
    makeDeps(db, { pr: prFacts({ state: "closed", merged: true }) }),
    args({ apply: true, expectedHeadSha: dry.headSha }),
  );
  assert.equal(out.ok, false);
  assert.ok(out.blockers.some((b) => b.kind === "merged"), "apply must re-run the whole verification, not just the sha check");
});

// ===========================================================================
// 5. Idempotency, conflict, concurrency
// ===========================================================================

test("rc4: applying the identical link twice is a no-op the second time", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const first = await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  assert.equal(first.applied, true);
  const linkedAt = db.prepare(`SELECT pr_linked_at FROM sessions WHERE id = ?`).get(SESSION).pr_linked_at;

  const second = await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  assert.equal(second.ok, true, "a repeat is success, not an error");
  assert.equal(second.applied, false);
  assert.equal(second.alreadyLinked, true);
  assert.equal(
    db.prepare(`SELECT pr_linked_at FROM sessions WHERE id = ?`).get(SESSION).pr_linked_at,
    linkedAt,
    "a repeat must not rewrite the original link's timestamp",
  );
});

test("rc4: a session that shipped its PR normally is not relabelled as recovered", { skip }, async () => {
  const db = openDb();
  // pr_number set, pr_link_state NULL: the loop opened this one itself.
  seedFailedSession(db, { status: "done", prNumber: PR_NUMBER, linkState: null });
  const out = await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));

  assert.equal(out.ok, true);
  assert.equal(out.applied, false, "there is nothing to recover");
  assert.equal(out.alreadyLinked, true);
  assert.match(out.message, /the loop recorded it/);
  assert.equal(
    db.prepare(`SELECT pr_link_state FROM sessions WHERE id = ?`).get(SESSION).pr_link_state,
    null,
    "a PR the loop opened must not acquire a 'recovered' provenance it did not have",
  );
});

test("rc4: linking a session that already points at a DIFFERENT PR is refused", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db, { prNumber: 1042, linkState: "recovered" });
  const out = await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  assert.equal(out.ok, false);
  const b = out.blockers.find((x) => x.kind === "conflicting_link");
  assert.ok(b, JSON.stringify(out.blockers));
  assert.match(b.message, /already associated with PR #1042/);
  assert.match(b.message, /Unlinking is deliberately not offered/);
  assert.equal(db.prepare(`SELECT pr_number FROM sessions WHERE id = ?`).get(SESSION).pr_number, 1042);
});

test("rc4: a PR already recovered onto another session cannot be linked to a second", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db, { id: "other-session", prNumber: PR_NUMBER, linkState: "recovered" });
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  assert.equal(out.ok, false);
  assert.ok(out.blockers.some((b) => b.kind === "conflicting_link"));
  assert.match(out.message, /already linked to session other-session/);
});

test("rc4: two concurrent applies produce ONE link, and the loser says so", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const audits = [];
  const results = await Promise.all([
    prLink.linkPullRequest(makeDeps(db, { audits }), args({ apply: true, expectedHeadSha: HEAD_SHA })),
    prLink.linkPullRequest(makeDeps(db, { audits }), args({ apply: true, expectedHeadSha: HEAD_SHA })),
  ]);
  assert.ok(results.every((r) => r.ok), `both must succeed: ${JSON.stringify(results.map((r) => r.message))}`);
  assert.equal(results.filter((r) => r.applied === true).length, 1, "exactly one call may write");
  assert.equal(results.filter((r) => r.alreadyLinked === true).length, 1, "the other must report the existing link");
  assert.equal(audits.filter((a) => a.event === "tool.pr_link_applied").length, 1, "only the write is audited as a write");
  assert.equal(db.prepare(`SELECT pr_link_state FROM sessions WHERE id = ?`).get(SESSION).pr_link_state, "recovered");
});

// ===========================================================================
// 6. The failure, the findings and the spend all survive
// ===========================================================================

test("rc4: linking changes the association and NOTHING else about the run", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  db.prepare(
    `INSERT INTO reviews (id, session_id, cycle, verdict, findings, summary, created_at)
     VALUES ('r1', ?, 3, 'block', ?, 'blocked', ?)`,
  ).run(SESSION, JSON.stringify([{ severity: "high", title: "stale request overwrites newer filter results" }]), Date.now());
  db.prepare(`INSERT INTO budgets_monthly (month, user, spent_usd, session_count) VALUES ('2026-09', 'U1', 37.42, 1)`).run();

  const before = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(SESSION);
  const beforeReviews = db.prepare(`SELECT * FROM reviews WHERE session_id = ?`).all(SESSION);
  const beforeBudget = db.prepare(`SELECT * FROM budgets_monthly`).all();
  const beforeSubTasks = db.prepare(`SELECT * FROM sub_tasks WHERE session_id = ?`).all(SESSION);

  const out = await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  assert.equal(out.applied, true);

  const after = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(SESSION);
  // Everything the failure recorded stands.
  assert.equal(after.status, "failed", "linking a PR must never mark the run successful");
  assert.equal(after.cost_usd, before.cost_usd);
  assert.equal(after.cycles_ran, before.cycles_ran);
  assert.equal(after.merge_recommendation, null, "linking must not invent a merge recommendation");
  assert.equal(after.merge_recommendation_reason, null);
  assert.equal(after.crystallised_prompt, before.crystallised_prompt);
  assert.equal(after.plan_base_sha, before.plan_base_sha);
  assert.equal(after.branch, before.branch);
  assert.equal(after.pr_merged, null);

  // Only the association columns moved.
  const changed = Object.keys(after).filter((k) => String(after[k]) !== String(before[k]));
  assert.deepEqual(
    changed.sort(),
    ["final_pr_url", "pr_link_evidence", "pr_link_head_sha", "pr_link_state", "pr_linked_at", "pr_linked_by", "pr_number", "updated_at"],
    `linking touched columns it had no business touching: ${changed.join(", ")}`,
  );
  assert.deepEqual(db.prepare(`SELECT * FROM reviews WHERE session_id = ?`).all(SESSION), beforeReviews);
  assert.deepEqual(db.prepare(`SELECT * FROM budgets_monthly`).all(), beforeBudget);
  assert.deepEqual(db.prepare(`SELECT * FROM sub_tasks WHERE session_id = ?`).all(SESSION), beforeSubTasks);
});

test("rc4: the applied message says out loud that this is not an approval", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const out = await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  assert.match(out.message, /not\s+an approval/i);
  assert.match(out.message, /status, review findings, spend and history are unchanged/);
});

// ===========================================================================
// 7. The linked session reaches the revision workflow -- and only that
// ===========================================================================

function makeTools(db, { linkResult } = {}) {
  const audits = [];
  const runtime = {
    config: {
      slack: { authorised_users: ["U1"] },
      budgets: {},
      repos: { allowed: [REPO], default_base_branch: "main" },
      brief: {},
      loop: {},
    },
    state: { db, isOpen: () => true, audit: (event, payload, sessionId) => audits.push({ event, payload, sessionId }) },
    loop: { run: async () => {} },
    budget: { getDailySpend: () => 0 },
    linkPr: async (a) => linkResult ?? { ok: true, dryRun: a.apply !== true, message: "stub" },
  };
  const tools = new Map();
  registerHarnessTools(
    { logger: { info() {}, warn() {}, error() {}, debug() {} }, registerTool(spec) { tools.set(spec.name, spec); return () => {}; } },
    runtime,
  );
  return { tools, audits };
}

test("rc4: harness_link_pr is registered, dry-run by default, and repo-qualified", { skip }, async () => {
  const db = openDb();
  const { tools } = makeTools(db);
  const spec = tools.get("harness_link_pr");
  assert.ok(spec, "the tool must be registered");
  const req = spec.parameters.required;
  assert.ok(req.includes("repo"), "repo must be REQUIRED -- a PR number alone is ambiguous across repositories");
  assert.ok(req.includes("sessionId") && req.includes("prNumber") && req.includes("invokedBy"));
  assert.equal(spec.parameters.properties.apply.type, "boolean");
  assert.match(spec.parameters.properties.apply.description, /Default false/);
  assert.match(spec.description, /DRY RUN BY DEFAULT/);
  // The description is what an agent reads before choosing to call this. It has
  // to say that linking is not approval, or an agent will offer it as one.
  assert.match(spec.description, /does not change the session's failed status/);
  assert.match(spec.description, /fresh adversary review/);
});

test("rc4: a recovered failed session becomes revisable, without becoming 'done'", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));

  const { tools } = makeTools(db);
  const listed = await tools.get("harness_list_revisable").execute("c", {});
  const item = listed.details.revisable.find((r) => r.sessionId === SESSION);
  assert.ok(item, "a linked failed session must be reachable by the revision workflow");
  assert.equal(item.prNumber, PR_NUMBER);
  assert.equal(item.repo, REPO);
  assert.equal(item.branch, BRANCH);
  assert.equal(item.status, "failed", "it is listed as revisable, and it is still a failure");
  assert.equal(item.linkState, "recovered");
  assert.equal(item.reviewed, false, "nothing has reviewed this PR");
  assert.equal(item.mergeRecommendation, "do_not_merge", "an unreviewed PR defaults closed");
});

test("rc4: an unlinked failed session is NOT revisable", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  const { tools } = makeTools(db);
  const listed = await tools.get("harness_list_revisable").execute("c", {});
  assert.equal(listed.details.revisable.find((r) => r.sessionId === SESSION), undefined);
});

test("rc4: revising the recovered session pins the EXISTING branch, so the same PR updates", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));

  const { tools } = makeTools(db);
  const res = await tools.get("harness_revise").execute("c", { requester: "U1", sessionId: SESSION });

  assert.equal(res.details.ok, true, `the recovered session must be revisable: ${res.content[0].text}`);
  assert.equal(res.details.reviseOfSessionId, SESSION);
  assert.equal(res.details.prNumber, PR_NUMBER);
  assert.equal(res.details.branch, BRANCH, "a revise must build on the existing branch, not a new one");
  assert.match(res.content[0].text, /same PR/);

  // `pinnedBranch` is what makes the worktree check out the existing remote
  // branch at its tip (index.ts: reuseExistingBranch), which is the whole point
  // of recovering the association -- the revision stacks on the PR's nine
  // commits instead of starting from the base branch.
  const child = db.prepare(`SELECT crystallised_prompt FROM sessions WHERE id = ?`).get(res.details.sessionId);
  const brief = JSON.parse(child.crystallised_prompt);
  assert.equal(brief.pinnedBranch, BRANCH, "without pinnedBranch the revise would open a second PR");
  assert.equal(brief.reviseOfSessionId, SESSION);
  assert.equal(brief.repoHint, REPO);

  // And the original session is still the failure it was.
  assert.equal(db.prepare(`SELECT status FROM sessions WHERE id = ?`).get(SESSION).status, "failed");
});

test("rc4: an unreviewed PR's revise brief says UNREVIEWED, never '0 findings'", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));

  const { tools } = makeTools(db);
  const res = await tools.get("harness_revise").execute("c", { requester: "U1", sessionId: SESSION });
  assert.equal(res.details.ok, true, res.content[0].text);

  const brief = JSON.parse(
    db.prepare(`SELECT crystallised_prompt FROM sessions WHERE id = ?`).get(res.details.sessionId).crystallised_prompt,
  );
  // The pre-rc.4 brief said "the adversary review returned revise with 0
  // finding(s)" -- a sentence describing a review that never happened, which
  // reads to a worker exactly like a PR that came back clean.
  assert.doesNotMatch(brief.motivation, /returned revise with 0 finding/, "no review ran; do not describe one that did");
  assert.match(brief.motivation, /UNREVIEWED, not approved/);
  assert.match(brief.motivation, /before any adversary review ran/);
  assert.match(
    brief.acceptanceCriteria[0],
    /NOT the same as a clean review/,
    "the absence of findings must be stated as absence of review",
  );
  assert.match(brief.acceptanceCriteria[0], /expect a full adversary review/);
  assert.equal(brief.pinnedBranch, BRANCH);
});

test("rc4: a session WITH review context still gets the findings brief, unchanged", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  db.prepare(
    `INSERT INTO reviews (id, session_id, cycle, verdict, findings, summary, created_at)
     VALUES ('r1', ?, 2, 'revise', ?, 's', ?)`,
  ).run(
    SESSION,
    JSON.stringify([{ severity: "high", title: "stale requests overwrite newer filter results", file: "src/app/page.tsx" }]),
    Date.now(),
  );
  await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));

  const { tools } = makeTools(db);
  const res = await tools.get("harness_revise").execute("c", { requester: "U1", sessionId: SESSION });
  assert.equal(res.details.ok, true);
  const brief = JSON.parse(
    db.prepare(`SELECT crystallised_prompt FROM sessions WHERE id = ?`).get(res.details.sessionId).crystallised_prompt,
  );
  assert.match(brief.motivation, /returned revise with 1 finding/, "the ordinary path must be untouched by the unreviewed wording");
  assert.doesNotMatch(brief.motivation, /UNREVIEWED/);
  assert.match(brief.acceptanceCriteria[0], /Address each adversary finding/);
  assert.match(JSON.stringify(brief.acceptanceCriteria), /stale requests overwrite newer filter results/);
});

test("rc4: a linked but unreviewed session still cannot be merged", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  const row = db.prepare(`SELECT merge_recommendation, status FROM sessions WHERE id = ?`).get(SESSION);
  // `mergePr` reads `merge_recommendation ?? 'do_not_merge'` and hard-refuses
  // anything that is not 'merge'. Linking leaves it NULL, which is that refusal.
  assert.equal(row.merge_recommendation, null);
  assert.notEqual(row.merge_recommendation, "merge");
  assert.equal(row.status, "failed");
});

test("rc4: linking starts nothing -- no run, no push, no PR, no other session touched", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  seedFailedSession(db, { id: "bystander", prNumber: null });
  const beforeBystander = db.prepare(`SELECT * FROM sessions WHERE id = 'bystander'`).get();
  const beforeSessionCount = db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n;

  const audits = [];
  await prLink.linkPullRequest(makeDeps(db, { audits }), args({ apply: true, expectedHeadSha: HEAD_SHA }));

  assert.deepEqual(db.prepare(`SELECT * FROM sessions WHERE id = 'bystander'`).get(), beforeBystander);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n, beforeSessionCount, "linking must not create a session");
  // The only events it may emit are its own.
  assert.deepEqual([...new Set(audits.map((a) => a.event))], ["tool.pr_link_applied"]);
});

// ===========================================================================
// 8. The recovery instruction names a route that works
// ===========================================================================

test("rc4: a preserved-worktree failure no longer sends the operator to a tool that refuses them", { skip }, () => {
  const src = readFileSync(resolve(here, "..", "src", "orchestrator", "loop.ts"), "utf8");
  const fn = src.slice(
    src.indexOf("private preservedWorktreeRecoveryAction"),
    src.indexOf("private async finaliseFailedPreserveWorktree"),
  );
  assert.ok(fn.length > 0, "the helper must exist");

  // The old text was "run harness_resume to continue" on a session this very
  // function marks `failed` -- which harness_resume refuses as terminal.
  assert.doesNotMatch(fn, /run harness_resume to continue/);
  assert.match(fn, /harness_resume will refuse this session/, "say so plainly rather than sending them there");
  assert.match(fn, /harness_link_pr/, "and name the route that does work");
  assert.match(fn, /harness_revise/);
  assert.match(fn, /dry run until you pass apply/, "an operator must not think linking is immediate");

  // A session that already recorded its PR does not need linking at all.
  assert.match(fn, /The PR is recorded, so harness_revise/);

  // And both the audit event and the durable interaction log carry it, rather
  // than a literal that drifts from the helper.
  const declAt = src.indexOf("private async finaliseFailedPreserveWorktree");
  const nextMethod = src.indexOf("\n  private ", declAt + 1);
  const preserve = src.slice(declAt, nextMethod > 0 ? nextMethod : undefined);
  const carried = preserve.match(/recoveryAction: this\.preservedWorktreeRecoveryAction\(sessionId, row\)/g) ?? [];
  assert.equal(carried.length, 2, `the audit event and the interaction log must both carry it, found ${carried.length}`);
  assert.doesNotMatch(preserve, /run harness_resume to continue/, "no stale literal left behind");
});

// ===========================================================================
// 9. The columns are additive -- an existing database opens unchanged
// ===========================================================================

test("rc4: the link columns are additive, so a pre-rc.4 database opens and keeps its rows", { skip }, async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openStateStoreSync } = await import("../dist/state/store.js");

  const dir = mkdtempSync(join(tmpdir(), "rc4-migrate-"));
  const file = join(dir, "state.db");
  try {
    // A database created WITHOUT the rc.4 columns, holding a real row.
    const old = new Database(file);
    const schema = readFileSync(resolve(here, "..", "dist", "state", "schema.sql"), "utf8");
    // Drop the rc.4 column definitions, then repair the comma the last
    // surviving column is now left holding before the closing paren.
    const stripped = schema
      .replace(/^\s*pr_link_\w+\s+\w+.*$\n?/gm, "")
      .replace(/^\s*pr_linked_\w+\s+\w+.*$\n?/gm, "")
      .replace(/,(\s*(?:--[^\n]*\n\s*)*)\)/g, "$1)");
    old.exec(stripped);
    old.prepare(
      `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
         status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
       VALUES ('legacy', 'agent:legacy', '', 'U1', 'gh', ?, 'b', '/w', 'done', ?, ?, 10, 3.5, 2)`,
    ).run(REPO, SEEDED_AT, SEEDED_AT);
    const hadColumn = old.prepare(`SELECT * FROM pragma_table_info('sessions') WHERE name = 'pr_link_state'`).get();
    assert.equal(hadColumn, undefined, "the fixture must genuinely predate the columns");
    old.close();

    // Reopening through the store must migrate, not fail, and not lose the row.
    const store = openStateStoreSync(file);
    const row = store.db.prepare(`SELECT * FROM sessions WHERE id = 'legacy'`).get();
    assert.equal(row.cost_usd, 3.5, "an existing row must survive the migration intact");
    assert.equal(row.cycles_ran, 2);
    assert.equal(row.pr_link_state, null, "the new column arrives empty, meaning 'the loop opened this, or nothing did'");
    assert.equal(row.pr_linked_by, null);
    for (const col of ["pr_link_state", "pr_linked_at", "pr_linked_by", "pr_link_head_sha", "pr_link_evidence"]) {
      assert.ok(
        store.db.prepare(`SELECT * FROM pragma_table_info('sessions') WHERE name = ?`).get(col),
        `${col} must exist after migration`,
      );
    }
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 10. PR numbers are not unique across repositories
// ===========================================================================

test("rc4: harness_revise refuses an ambiguous PR number and asks which repo", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  // A second repository with the same PR number, which is entirely ordinary.
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
       status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, pr_number, merge_recommendation)
     VALUES ('other', 'agent:other', '', 'U1', 'gh', 'Other-Org/Thing', 'harness/x', '/w', 'done', ?, ?, 10, 1, 1, ?, 'do_not_merge')`,
  ).run(Date.now(), Date.now(), PR_NUMBER);

  const { tools } = makeTools(db);
  const res = await tools.get("harness_revise").execute("c", { requester: "U1", prNumber: PR_NUMBER });
  assert.equal(res.details.ok, false);
  assert.equal(res.details.ambiguous, true, "a PR number matching two repos must not silently pick one");
  assert.equal(res.details.repos.length, 2);
  assert.match(res.content[0].text, /Pass `repo` to say which one/);
});

test("rc4: passing repo disambiguates, and a mismatched repo is refused", { skip }, async () => {
  const db = openDb();
  seedFailedSession(db);
  await prLink.linkPullRequest(makeDeps(db), args({ apply: true, expectedHeadSha: HEAD_SHA }));
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch, worktree_path,
       status, created_at, updated_at, budget_usd, cost_usd, cycles_ran, pr_number, merge_recommendation)
     VALUES ('other', 'agent:other', '', 'U1', 'gh', 'Other-Org/Thing', 'harness/x', '/w', 'done', ?, ?, 10, 1, 1, ?, 'do_not_merge')`,
  ).run(Date.now(), Date.now(), PR_NUMBER);

  const { tools } = makeTools(db);
  const ok = await tools.get("harness_revise").execute("c", { requester: "U1", prNumber: PR_NUMBER, repo: REPO });
  assert.notEqual(ok.details.ambiguous, true, "naming the repo must resolve the ambiguity");

  const wrong = await tools.get("harness_revise").execute("c", { requester: "U1", sessionId: SESSION, repo: "Other-Org/Thing" });
  assert.equal(wrong.details.ok, false);
  assert.equal(wrong.details.repoMismatch, true);
});
