// rc.5 (#2) — FALSE PUBLICATION OF UNPUSHED WORK.
//
// Stitch-Vercel/StitchGuard PR #1168, 2026-09-10. Two revision sessions built
// 24 and 11 local commits, ended with review verdict `revise`, and were
// recorded as SHIPPED. GitHub received neither history; both worktrees were
// then released, deleting the only copy of 35 commits.
//
// The chain, all inside the harness:
//   preview verification ENABLED -> the preview push runs only for `pass`, so
//   a `revise` pushed nothing -> finalisation nonetheless selected the PR-ONLY
//   callback purely because preview was enabled -> that callback found the
//   revision's existing PR and posted a comment -> finalisation read the
//   resolved callback as publication, polled CI on the LOCAL worktree HEAD,
//   found no checks on a SHA GitHub had never seen, and shipped.
//
// Every one of those steps succeeded. That is the point: a config flag, a
// resolved callback, an existing PR URL, a posted review comment and a local
// branch name were ALL true while nothing had been published. So the tests
// below assert on remote state and on control flow, never on "the callback was
// called".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { runScenario, makeWorld, makeConfig, scenarioAvailable, git, IDENT } from "./helpers/scenario.mjs";

const skip = (await scenarioAvailable()) ? false : "dist/ not built";
const root = join(dirname(new URL(import.meta.url).pathname), "..");
const S = (p) => readFileSync(join(root, p), "utf8");

let pub;
try {
  pub = await import("../dist/orchestrator/publication.js");
} catch {
  pub = null;
}

const PR = "https://github.com/o/r/pull/1168";
const passing = { verdict: "pass", findings: [], summary: "ok", costUsd: 0.01, tokensIn: 1, tokensOut: 1 };
const revising = {
  verdict: "revise",
  findings: [{ severity: "high", category: "correctness", summary: "the retry window is unbounded", file: "src/thing.ts" }],
  summary: "needs another pass",
  costUsd: 0.01,
  tokensIn: 1,
  tokensOut: 1,
};

/**
 * A remote that only moves when something actually pushes to it. `push()` is
 * what a real `git push` would do; nothing else changes the tip. This is the
 * whole test apparatus: RC4 passes every callback-shaped assertion and fails
 * every assertion about this object.
 */
function fakeRemote({ initialSha = "1410e98db1f00bbe850ab73a8f3784c6f6c023f3" } = {}) {
  const state = { tip: initialSha, pushes: 0, prOpens: 0, reads: 0, forced: [] };
  return {
    state,
    read: async () => {
      state.reads += 1;
      return state.tip;
    },
    /** Stands in for `pushBranchAndOpenPr`: moves the ref, then opens the PR. */
    pushAndOpen: (headOf) => async ({ plan }) => {
      state.pushes += 1;
      state.tip = await headOf(plan);
      state.prOpens += 1;
      return PR;
    },
    /** Stands in for `openPullRequest`: finds the PR, posts a comment, pushes NOTHING. */
    prOnly: async () => {
      state.prOpens += 1;
      return PR;
    },
  };
}

const headOfWorktree = async (plan) => git(["rev-parse", "HEAD"], plan.worktreePath);

/** CI timings scaled to test time; the production defaults poll for 15 minutes. */
const CI_FAST = { none_grace_seconds: 0, poll_interval_seconds: 0, wait_timeout_seconds: 2 };

// ---------------------------------------------------------------------------
// The evidence primitives. Pure, so these pin the rules themselves rather than
// a particular route through the loop.
// ---------------------------------------------------------------------------

test("rc5: two SHAs naming the same commit match across abbreviation and case", { skip }, () => {
  const full = "491fc32e49ff2e23d89df1b3f61947a4125a5cb0";
  assert.equal(pub.shaMatches(full, full), true);
  assert.equal(pub.shaMatches(full, full.slice(0, 12)), true);
  assert.equal(pub.shaMatches(full.toUpperCase(), full), true);
  assert.equal(pub.shaMatches(full, "aa691d65355b2f84b6a476e9c297d3d90c0f7dd3"), false);
  // A prefix too short to identify a commit is not a match, however tempting:
  // publication is decided by this comparison, so a coincidental leading digit
  // must not read as proof.
  assert.equal(pub.shaMatches(full, "491"), false);
  assert.equal(pub.shaMatches(full, "4"), false);
  assert.equal(pub.shaMatches(full, "491fc3"), false, "six characters is still a coincidence");
  assert.equal(pub.shaMatches(full, "491fc32"), true, "seven identifies a commit");
  assert.equal(pub.shaMatches(full, ""), false);
  assert.equal(pub.shaMatches(full, "not-a-sha-at-all"), false);
  assert.equal(pub.shaMatches(undefined, full), false);
});

test("rc5: a remote holding the candidate verifies on the first read", { skip }, async () => {
  let reads = 0;
  const r = await pub.verifyRemoteSha({
    expectedSha: "491fc32e49ff2e23d89df1b3f61947a4125a5cb0",
    branch: "harness/x", repo: "o/r",
    readRemoteSha: async () => { reads += 1; return "491fc32e49ff2e23d89df1b3f61947a4125a5cb0"; },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(reads, 1, "a remote that already agrees must not be re-read");
});

test("rc5: transient provider lag is ridden out by BOUNDED revalidation", { skip }, async () => {
  // Observed during the #1168 recovery: the immediate read disagreed with a ref
  // that had demonstrably just landed; subsequent reads agreed.
  const sha = "84a14eb7e358e67d54b68dd61ec9083a6537429b";
  let reads = 0;
  const r = await pub.verifyRemoteSha({
    expectedSha: sha, branch: "harness/x", repo: "o/r",
    readRemoteSha: async () => { reads += 1; return reads < 3 ? undefined : sha; },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

test("rc5: a PERMANENT mismatch is refused, not waited out", { skip }, async () => {
  let reads = 0;
  const r = await pub.verifyRemoteSha({
    expectedSha: "491fc32e49ff2e23d89df1b3f61947a4125a5cb0",
    branch: "harness/x", repo: "o/r",
    readRemoteSha: async () => { reads += 1; return "1410e98db1f00bbe850ab73a8f3784c6f6c023f3"; },
    attempts: 3, sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "remote_mismatch");
  assert.equal(r.observedSha, "1410e98db1f00bbe850ab73a8f3784c6f6c023f3");
  assert.equal(reads, 3, "the bound is the bound");
  assert.match(r.detail, /491fc32e/);
});

test("rc5: an absent branch is remote_missing; an unreadable remote is verification_unavailable", { skip }, async () => {
  const missing = await pub.verifyRemoteSha({
    expectedSha: "491fc32e49ff2e23d89df1b3f61947a4125a5cb0",
    branch: "harness/x", repo: "o/r",
    readRemoteSha: async () => undefined, attempts: 2, sleep: async () => {},
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, "remote_missing");

  const unreadable = await pub.verifyRemoteSha({
    expectedSha: "491fc32e49ff2e23d89df1b3f61947a4125a5cb0",
    branch: "harness/x", repo: "o/r",
    readRemoteSha: async () => { throw new Error("403 from the provider"); },
    attempts: 2, sleep: async () => {},
  });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.kind, "verification_unavailable");
  assert.match(unreadable.detail, /403/);
  // Neither is a green. An unknown remote is never an assumed-published one.
});

test("rc5: no candidate SHA means nothing to verify, and never an assumed pass", { skip }, async () => {
  const r = await pub.verifyRemoteSha({
    expectedSha: "", branch: "harness/x", repo: "o/r",
    readRemoteSha: async () => { throw new Error("must not be called"); },
    sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "candidate_unknown");
  assert.equal(r.attempts, 0);
});

test("rc5: revalidation is cancellable and stops early when aborted", { skip }, async () => {
  let reads = 0;
  const signal = { aborted: false };
  const r = await pub.verifyRemoteSha({
    expectedSha: "491fc32e49ff2e23d89df1b3f61947a4125a5cb0",
    branch: "harness/x", repo: "o/r",
    readRemoteSha: async () => { reads += 1; signal.aborted = true; return undefined; },
    attempts: 8, sleep: async () => {}, signal,
  });
  assert.equal(r.ok, false);
  assert.equal(reads, 1, "an aborted run must not keep re-reading a remote nobody will act on");
});

test("rc5: evidence covers ONE sha on ONE branch, and nothing else", { skip }, () => {
  const ev = {
    sha: "491fc32e49ff2e23d89df1b3f61947a4125a5cb0",
    branch: "harness/x", repo: "o/r", verifiedAt: 1, via: "pushed",
  };
  assert.equal(pub.evidenceCoversCandidate(ev, ev.sha, "harness/x"), true);
  // The #1168 shape: a later commit inheriting an earlier one's proof.
  assert.equal(pub.evidenceCoversCandidate(ev, "aa691d65355b2f84b6a476e9c297d3d90c0f7dd3", "harness/x"), false);
  assert.equal(pub.evidenceCoversCandidate(ev, ev.sha, "harness/other"), false);
  assert.equal(pub.evidenceCoversCandidate(null, ev.sha), false);
});

test("rc5: the unpublished report names the SHA, the branch and the surviving worktree", { skip }, () => {
  const msg = pub.describeUnpublished({
    kind: "remote_mismatch",
    expectedSha: "491fc32e49ff2e23d89df1b3f61947a4125a5cb0",
    observedSha: "1410e98db1f00bbe850ab73a8f3784c6f6c023f3",
    branch: "harness/x", repo: "o/r",
    worktreePath: "/wt/s1", prUrl: PR,
    detail: "tip disagrees",
  });
  assert.match(msg, /NOT PUBLISHED/);
  assert.match(msg, /491fc32e49ff2e23d89df1b3f61947a4125a5cb0/);
  assert.match(msg, /1410e98db1f00bbe850ab73a8f3784c6f6c023f3/);
  assert.match(msg, /\/wt\/s1/);
  assert.match(msg, /NEVER force-push/i);
  // The PR exists and describes none of this work -- say so, don't hide it.
  assert.match(msg, /does NOT contain the candidate/);
});

test("rc5: published, approved and unpublished are three different sentences", { skip }, () => {
  const unpublished = pub.describePublicationState({ published: false, verdict: "revise" });
  assert.match(unpublished, /UNPUBLISHED/);
  assert.match(unpublished, /not shipped/i);

  const nonPass = pub.describePublicationState({ published: true, verdict: "revise", sha: "abc1234" });
  assert.match(nonPass, /PUBLISHED/);
  assert.match(nonPass, /NOT approved/i);
  assert.match(nonPass, /do NOT merge/i);

  const passed = pub.describePublicationState({ published: true, verdict: "pass", sha: "abc1234" });
  assert.match(passed, /PUBLISHED/);
  assert.match(passed, /not merged/i, "a pass is still not a merge");
});

// ---------------------------------------------------------------------------
// 1. The incident itself: preview enabled + verdict revise + an existing PR.
// ---------------------------------------------------------------------------

test("rc5 #1: preview enabled + a REVISE verdict PUSHES, instead of only touching the PR", { skip }, async () => {
  const remote = fakeRemote();
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => revising,
    deps: {
      previewVerificationEnabled: true,
      // Wired, and deliberately never reached on a revise: the preview push is
      // pass-only, which is exactly why RC4 published nothing here.
      pushBranchForPreview: async ({ commitSha }) => ({ remoteSha: commitSha }),
      fetchRuntime: async () => undefined,
      openPullRequest: remote.prOnly,
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      sleep: async () => {},
    },
  });

  assert.equal(s.out.status, "shipped");
  assert.equal(remote.state.pushes, 1, "RC4 pushed ZERO times here and still reported shipped");
  const head = git(["rev-parse", "HEAD"], s.worktree());
  assert.equal(remote.state.tip, head, "the remote must hold this run's commits, not the old PR head");

  const shipped = s.events("loop.shipped")[0];
  assert.equal(shipped.payload.publicationVerified, true);
  assert.equal(shipped.payload.publishedSha, head);
  assert.equal(s.session().published_sha, head, "publication evidence has to survive the process");
});

test("rc5 #1b: a revise is published for review with its blocking findings and a do-not-merge", { skip }, async () => {
  const remote = fakeRemote();
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => revising,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ commitSha }) => ({ remoteSha: commitSha }),
      fetchRuntime: async () => undefined,
      openPullRequest: remote.prOnly,
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      sleep: async () => {},
    },
  });
  // Publishing a non-passing candidate is EXISTING policy (the non-preview
  // path always did it). The fix makes the preview path match, and must not
  // quietly upgrade the verdict to make the publication look better.
  const row = s.session();
  assert.notEqual(row.merge_recommendation, "merge");
  assert.match(row.merge_recommendation_reason, /PUBLISHED/);
  assert.match(row.merge_recommendation_reason, /NOT approved/i);
});

// ---------------------------------------------------------------------------
// 2. A verified preview push is reused, not repeated.
// ---------------------------------------------------------------------------

test("rc5 #2: a PASS whose exact SHA was preview-pushed opens the PR without a second push", { skip }, async () => {
  const remote = fakeRemote();
  let previewSha = "";
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ plan, commitSha }) => {
        previewSha = await headOfWorktree(plan);
        remote.state.pushes += 1;
        remote.state.tip = previewSha;
        return { remoteSha: commitSha };
      },
      fetchRuntime: async () => ({ provider: "vercel", status: "ok", deploymentUrl: "https://preview.example" }),
      openPullRequest: remote.prOnly,
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      sleep: async () => {},
    },
  });
  assert.equal(s.out.status, "shipped");
  assert.equal(remote.state.pushes, 1, "the candidate was already published; a second push is pure noise");
  assert.equal(remote.state.prOpens, 1);
  assert.equal(s.events("loop.publication_reused_push").length, 1);
  assert.equal(s.session().published_sha, previewSha);
});

// ---------------------------------------------------------------------------
// 3. HEAD moving after publication invalidates the evidence.
// ---------------------------------------------------------------------------

test("rc5 #3: a commit made AFTER the preview push cannot inherit its publication", { skip }, async () => {
  const remote = fakeRemote();
  let previewSha = "";
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ plan, commitSha }) => {
        previewSha = await headOfWorktree(plan);
        remote.state.pushes += 1;
        remote.state.tip = previewSha;
        return { remoteSha: commitSha };
      },
      fetchRuntime: async () => ({ provider: "vercel", status: "ok", deploymentUrl: "https://preview.example" }),
      // The real commit-producing finalisation step: authoring a CI workflow
      // moves HEAD after the preview push has already happened. The loop tries
      // this once before the preview push and again at finalisation; here the
      // first attempt finds nothing to author and the second one commits,
      // which is precisely the ordering that strands the preview's evidence.
      ciAuthorWorkflow: (() => {
        let calls = 0;
        return async ({ worktreePath }) => {
          if (++calls === 1) return null;
          const rel = ".github/workflows/ci.yml";
          mkdirSync(join(worktreePath, ".github", "workflows"), { recursive: true });
          writeFileSync(join(worktreePath, rel), "name: ci\non: [push]\n");
          git(["add", "-A"], worktreePath);
          git(["-c", `user.name=${IDENT.name}`, "-c", `user.email=${IDENT.email}`, "commit", "-m", "ci: author workflow"], worktreePath);
          return { path: rel, scripts: ["test"] };
        };
      })(),
      openPullRequest: remote.prOnly,
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      sleep: async () => {},
    },
  });

  const head = git(["rev-parse", "HEAD"], s.worktree());
  assert.notEqual(head, previewSha, "the fixture must actually move HEAD, or it proves nothing");
  assert.equal(remote.state.pushes, 2, "the workflow commit is a NEW candidate and has to be published");
  assert.equal(remote.state.tip, head);

  const invalidated = s.events("loop.publication_evidence_invalidated");
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].payload.publishedSha, previewSha);
  assert.equal(invalidated[0].payload.candidateSha, head);
  assert.equal(invalidated[0].payload.reason, "head_moved_after_publication");
  assert.equal(s.session().published_sha, head, "evidence must name the commit that actually shipped");
});

// ---------------------------------------------------------------------------
// 4. Preview disabled still works, and is now verified too.
// ---------------------------------------------------------------------------

test("rc5 #4: with preview OFF, push-and-PR still runs and is verified against the remote", { skip }, async () => {
  const remote = fakeRemote();
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      previewVerificationEnabled: false,
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      sleep: async () => {},
    },
  });
  assert.equal(s.out.status, "shipped");
  assert.equal(remote.state.pushes, 1);
  assert.equal(s.events("loop.publication_verified").length >= 1, true);
  assert.equal(s.session().published_sha, git(["rev-parse", "HEAD"], s.worktree()));
});

// ---------------------------------------------------------------------------
// 5. A policy that PROHIBITS publication reports unpublished, and keeps the work.
// ---------------------------------------------------------------------------

test("rc5 #5: the unreviewed-salvage policy refuses to publish, and says so instead of shipping", { skip }, async () => {
  // rc.3 policy: an abort that never got an adversary review has no sign-off to
  // ship behind, so it must not push. The rc.5 requirement is that this reads
  // as an explicit UNPUBLISHED outcome with the work preserved -- never as a
  // ship, and never as a silent new default that hides the #1168 bug.
  const remote = fakeRemote();
  let released = 0;
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 }, budgets: { session_default_usd: 0.0001 } },
    budgetUsd: 0.0001,
    runAdversary: async () => { throw new Error("no review should be reached"); },
    deps: {
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      releaseWorktree: async () => { released += 1; return { ok: true }; },
      sleep: async () => {},
    },
  });
  assert.notEqual(s.out.status, "shipped");
  assert.equal(remote.state.pushes, 0, "policy said do not publish; nothing may be pushed");
  assert.equal(remote.state.tip, "1410e98db1f00bbe850ab73a8f3784c6f6c023f3", "the remote must be untouched");
  assert.equal(released, 0, "the only copy of the commits must survive");
});

// ---------------------------------------------------------------------------
// 6. The exact RC4 failure: a PR-only callback can never produce a ship.
// ---------------------------------------------------------------------------

test("rc5 #6: finding the PR and posting a comment, with no push, cannot produce a shipped result", { skip }, async () => {
  // This is RC4's control flow, forced: the ONLY publication callback available
  // is the PR-only one. It resolves, the PR URL is real, the comment lands --
  // and the remote never moves. RC4 called this shipped.
  const remote = fakeRemote();
  let released = 0;
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => revising,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ commitSha }) => ({ remoteSha: commitSha }),
      fetchRuntime: async () => undefined,
      openPullRequest: remote.prOnly,
      // Resolves without moving the ref: a PR adapter masquerading as a push.
      pushBranchAndOpenPr: async () => { remote.state.prOpens += 1; return PR; },
      remoteBranchSha: remote.read,
      releaseWorktree: async () => { released += 1; return { ok: true }; },
      sleep: async () => {},
    },
  });

  assert.notEqual(s.out.status, "shipped");
  assert.equal(s.events("loop.shipped").length, 0, "nothing reached the remote; nothing shipped");
  const unpublished = s.events("loop.unpublished");
  assert.equal(unpublished.length, 1);
  assert.equal(unpublished[0].payload.failureKind, "remote_mismatch");
  assert.equal(unpublished[0].payload.observedSha, "1410e98db1f00bbe850ab73a8f3784c6f6c023f3");
  assert.equal(unpublished[0].payload.worktreePreserved, true);
  assert.equal(released, 0, "releasing here is what destroyed 35 commits");
  assert.match(s.out.reason, /NOT PUBLISHED/);
  assert.equal(s.session().published_sha, null, "no evidence means NULL, never a guess");
});

// ---------------------------------------------------------------------------
// 7. Push rejection, missing remote, mismatch.
// ---------------------------------------------------------------------------

test("rc5 #7a: a rejected push is a truthful failure with the work preserved", { skip }, async () => {
  let released = 0;
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      pushBranchAndOpenPr: async () => { throw new Error("! [rejected] harness/feat-x -> harness/feat-x (non-fast-forward)"); },
      remoteBranchSha: async () => "1410e98db1f00bbe850ab73a8f3784c6f6c023f3",
      releaseWorktree: async () => { released += 1; return { ok: true }; },
      sleep: async () => {},
    },
  });
  assert.notEqual(s.out.status, "shipped");
  assert.equal(released, 0);
  assert.equal(s.session().published_sha, null);
});

test("rc5 #7b: a branch missing from the remote is remote_missing, not an assumed publish", { skip }, async () => {
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      // Ambiguous push: resolves, but the ref never appears.
      pushBranchAndOpenPr: async () => PR,
      remoteBranchSha: async () => undefined,
      sleep: async () => {},
    },
  });
  assert.notEqual(s.out.status, "shipped");
  const ev = s.events("loop.unpublished")[0];
  assert.equal(ev.payload.failureKind, "remote_missing");
  assert.match(s.out.reason, /NOT PUBLISHED/);
});

test("rc5 #7c: an unreadable remote is UNKNOWN, and unknown is never shipped", { skip }, async () => {
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      pushBranchAndOpenPr: async () => PR,
      remoteBranchSha: async () => { throw new Error("fatal: could not read Username for 'https://github.com'"); },
      sleep: async () => {},
    },
  });
  assert.notEqual(s.out.status, "shipped");
  assert.equal(s.events("loop.unpublished")[0].payload.failureKind, "verification_unavailable");
});

// ---------------------------------------------------------------------------
// 8. Transient PR-metadata lag.
// ---------------------------------------------------------------------------

test("rc5 #8: a lagging remote read is revalidated, without a duplicate push or PR", { skip }, async () => {
  const remote = fakeRemote();
  let reads = 0;
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: async () => {
        reads += 1;
        // The ref landed; the provider's first answer is stale.
        return reads < 3 ? "1410e98db1f00bbe850ab73a8f3784c6f6c023f3" : remote.state.tip;
      },
      sleep: async () => {},
    },
  });
  assert.equal(s.out.status, "shipped");
  assert.equal(remote.state.pushes, 1, "lag must not be answered with another push");
  assert.equal(remote.state.prOpens, 1, "nor with another PR");
  assert.ok(reads >= 3);
  assert.equal(s.events("loop.publication_verified")[0].payload.attempts, 3);
});

// ---------------------------------------------------------------------------
// 9. Concurrent remote advancement.
// ---------------------------------------------------------------------------

test("rc5 #9: concurrent work on the branch is never overwritten and never claimed", { skip }, async () => {
  const remote = fakeRemote();
  const forced = [];
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      // A push that lands, and a colleague who pushes on top a moment later.
      pushBranchAndOpenPr: async ({ plan }) => {
        remote.state.pushes += 1;
        remote.state.tip = await headOfWorktree(plan);
        remote.state.tip = "cafebabecafebabecafebabecafebabecafebabe"; // somebody else
        remote.state.prOpens += 1;
        return PR;
      },
      remoteBranchSha: remote.read,
      sleep: async () => {},
    },
  });
  assert.notEqual(s.out.status, "shipped");
  const ev = s.events("loop.unpublished")[0];
  assert.equal(ev.payload.failureKind, "remote_mismatch");
  assert.equal(ev.payload.observedSha, "cafebabecafebabecafebabecafebabecafebabe");
  assert.equal(remote.state.pushes, 1, "no retry, and above all no force-push");
  assert.equal(forced.length, 0);
  assert.match(s.out.reason, /NEVER force-push/i);
});

// ---------------------------------------------------------------------------
// 10. CI evidence is attributed to the PUBLISHED sha.
// ---------------------------------------------------------------------------

test("rc5 #10a: CI is polled on the published SHA, not the local worktree HEAD", { skip }, async () => {
  const remote = fakeRemote();
  const polled = [];
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 }, ci: CI_FAST },
    runAdversary: async () => passing,
    deps: {
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      ciCombinedStatus: async ({ sha }) => { polled.push(sha); return "success"; },
      sleep: async () => {},
    },
  });
  assert.equal(s.out.status, "shipped");
  const head = git(["rev-parse", "HEAD"], s.worktree());
  assert.deepEqual([...new Set(polled)], [head]);
  assert.equal(s.events("loop.shipped")[0].payload.ciSha, head);
  assert.equal(s.events("loop.ci_polled_unverified_sha").length, 0);
});

test("rc5 #10b: CI is never polled at all when publication was refused", { skip }, async () => {
  // The #1168 green: no checks existed because GitHub had never seen the SHA.
  // Absent CI on an unpublished commit is not a reading, so it must not happen.
  const polled = [];
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 }, ci: CI_FAST },
    runAdversary: async () => passing,
    deps: {
      pushBranchAndOpenPr: async () => PR,
      remoteBranchSha: async () => undefined,
      ciCombinedStatus: async ({ sha }) => { polled.push(sha); return "success"; },
      sleep: async () => {},
    },
  });
  assert.notEqual(s.out.status, "shipped");
  assert.deepEqual(polled, [], "an unpublished commit has no CI to read");
});

test("rc5 #10c: a red CI on the published SHA still blocks the merge recommendation", { skip }, async () => {
  const remote = fakeRemote();
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 }, ci: { ...CI_FAST, max_repair_cycles: 0 } },
    runAdversary: async () => passing,
    deps: {
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      remoteBranchSha: remote.read,
      ciCombinedStatus: async () => "failure",
      sleep: async () => {},
    },
  });
  const head = git(["rev-parse", "HEAD"], s.worktree());
  assert.equal(s.session().merge_recommendation, "needs_human_review");
  assert.match(s.session().merge_recommendation_reason, new RegExp(head.slice(0, 12)));
  // Published, red, and honest about all three facts.
  assert.match(s.session().merge_recommendation_reason, /PUBLISHED/);
});

// ---------------------------------------------------------------------------
// 11. Evidence is revalidated rather than trusted from the past.
// ---------------------------------------------------------------------------

test("rc5 #11: stale preview evidence is re-read, and a vanished branch is republished", { skip }, async () => {
  const remote = fakeRemote();
  let previewSha = "";
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => passing,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ plan, commitSha }) => {
        previewSha = await headOfWorktree(plan);
        remote.state.pushes += 1;
        remote.state.tip = previewSha;
        return { remoteSha: commitSha };
      },
      fetchRuntime: async () => ({ provider: "vercel", status: "ok", deploymentUrl: "https://p.example" }),
      openPullRequest: remote.prOnly,
      pushBranchAndOpenPr: remote.pushAndOpen(headOfWorktree),
      // Somebody deletes the branch between the preview push and finalisation.
      remoteBranchSha: async () => {
        const tip = remote.state.tip;
        if (remote.state.reads === 0 && tip === previewSha) {
          remote.state.reads += 1;
          remote.state.tip = undefined;
          return undefined;
        }
        remote.state.reads += 1;
        return remote.state.tip;
      },
      sleep: async () => {},
    },
  });
  assert.equal(s.out.status, "shipped");
  assert.equal(remote.state.pushes, 2, "evidence that no longer holds must not be reused");
  assert.equal(s.events("loop.publication_reused_push").length, 0);
});

// ---------------------------------------------------------------------------
// 12. Cleanup never destroys the only copy.
// ---------------------------------------------------------------------------

test("rc5 #12: an unpublished run keeps its worktree and its PR association", { skip }, async () => {
  const released = [];
  const s = await runScenario({
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => revising,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ commitSha }) => ({ remoteSha: commitSha }),
      fetchRuntime: async () => undefined,
      openPullRequest: async () => PR,
      pushBranchAndOpenPr: async () => PR, // resolves, publishes nothing
      remoteBranchSha: async () => "1410e98db1f00bbe850ab73a8f3784c6f6c023f3",
      releaseWorktree: async (p) => { released.push(p); return { ok: true }; },
      sleep: async () => {},
    },
  });
  assert.deepEqual(released, [], "cleanup must not delete the only copy of unpublished commits");
  const row = s.session();
  assert.equal(row.status, "failed");
  assert.equal(row.published_sha, null);
  // The PR association survives so the session stays revisable (beta.129).
  assert.equal(row.final_pr_url, PR);
  assert.match(s.out.reason, /worktree/i);
  // The commits are genuinely still there.
  assert.ok(git(["log", "--oneline"], s.worktree()).length > 0);
});

// ---------------------------------------------------------------------------
// Integration: a REAL local bare remote. Nothing here is mocked, so a callback
// that merely resolves cannot fake a moved ref.
// ---------------------------------------------------------------------------

test("rc5 integration: a real bare remote distinguishes a true push from a resolved callback", { skip }, async () => {
  // The allocator points a worktree's `origin` at the real github.com URL for
  // the repo. Re-point it at the on-disk bare origin so both the push and the
  // ls-remote in this test talk to a remote that genuinely exists -- otherwise
  // "the branch is missing" would be indistinguishable from "the network is".
  const pointAtBare = (world) => (worktreePath) =>
    git(["remote", "set-url", "origin", world.origin], worktreePath);

  // (a) The RC4 shape against a real remote: the adapter resolves, returns a
  // real PR URL, and the ref never moves.
  const w1 = await makeWorld();
  const local1 = pointAtBare(w1);
  const noPush = await runScenario({
    world: w1,
    sessionId: "S-nopush",
    branch: "harness/nopush",
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => revising,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ commitSha }) => ({ remoteSha: commitSha }),
      fetchRuntime: async () => undefined,
      openPullRequest: async () => PR,
      pushBranchAndOpenPr: async () => PR,
      remoteBranchSha: async ({ plan, branch }) => {
        local1(plan.worktreePath);
        return w1.adapter.remoteBranchSha(plan.worktreePath, "origin", branch, "");
      },
      sleep: async () => {},
    },
  });
  assert.notEqual(noPush.out.status, "shipped");
  assert.equal(noPush.events("loop.unpublished")[0].payload.failureKind, "remote_missing");
  // The remote itself is the witness: that branch does not exist on it.
  assert.equal(git(["ls-remote", w1.origin, "refs/heads/harness/nopush"], w1.base), "");

  // (b) The fixed shape: a real push moves a real ref, and verification reads
  // that ref back before anything is called shipped.
  const w2 = await makeWorld();
  const local2 = pointAtBare(w2);
  const pushed = await runScenario({
    world: w2,
    sessionId: "S-push",
    branch: "harness/push",
    configOver: { loop: { max_cycles: 1 } },
    runAdversary: async () => revising,
    deps: {
      previewVerificationEnabled: true,
      pushBranchForPreview: async ({ commitSha }) => ({ remoteSha: commitSha }),
      fetchRuntime: async () => undefined,
      openPullRequest: async () => PR,
      pushBranchAndOpenPr: async ({ plan }) => {
        local2(plan.worktreePath);
        git(["push", "origin", `${plan.branch}:${plan.branch}`], plan.worktreePath);
        return PR;
      },
      remoteBranchSha: async ({ plan, branch }) => {
        local2(plan.worktreePath);
        return w2.adapter.remoteBranchSha(plan.worktreePath, "origin", branch, "");
      },
      sleep: async () => {},
    },
  });
  assert.equal(pushed.out.status, "shipped");
  const head = git(["rev-parse", "HEAD"], pushed.worktree());
  assert.equal(
    git(["rev-parse", "refs/heads/harness/push"], w2.origin),
    head,
    "the ref on the real remote must be this run's HEAD",
  );
  assert.equal(pushed.session().published_sha, head);
});

// ---------------------------------------------------------------------------
// The false promise itself must be gone from the source.
// ---------------------------------------------------------------------------

test("rc5: finalisation no longer chooses its callback from the preview CONFIG FLAG", { skip }, () => {
  const src = S("src/orchestrator/loop.ts");
  assert.ok(
    !/previewVerificationEnabled === true && this\.deps\.openPullRequest\s*\n?\s*\?\s*await this\.deps\.openPullRequest/.test(src),
    "this exact ternary is the #1168 defect: a config flag standing in for a fact about the remote",
  );
  // And the PR-only callback is only ever reached behind proven reuse.
  const i = src.indexOf("prUrl = await this.deps.openPullRequest({ plan, brief, reviewReport, requester });");
  assert.ok(i > 0);
  const before = src.slice(Math.max(0, i - 400), i);
  assert.match(before, /if \(reuse && this\.deps\.openPullRequest\)/);
});

test("rc5: production wires the remote-SHA probe through requester credential routing", { skip }, () => {
  const src = S("src/index.ts");
  const i = src.indexOf("remoteBranchSha: async ({ plan, branch, requester }) => {");
  assert.ok(i > 0, "the loop's only route to real remote state must be wired in production");
  const body = src.slice(i, i + 700);
  assert.match(body, /pat\.resolve\(/, "never borrow another user's credentials");
  assert.match(body, /resolveGitToken\(resolution\)/);
  assert.match(body, /git\.remoteBranchSha\(/);
  assert.ok(!/console\.log|logger\.info\([^)]*gitToken/.test(body), "no secret may be logged");
});
