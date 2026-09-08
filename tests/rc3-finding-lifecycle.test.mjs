// rc.3 -- a finding has an identity, and it keeps it.
//
// Two failures on StitchGuard PR #1168 came from findings being bare objects in
// an array. A diff too large for one adversary call is reviewed in chunks, and
// the aggregator did `findings.push(...)` per chunk with no dedup at all -- so
// the same schema/migration complaint, the same request-race, the same
// validation gap and the same credential-scope concern each arrived two or
// three times, and each copy was counted as a blocker and routed to a worker.
//
// And each cycle re-derived its finding set from nothing. A defect fixed in
// cycle 2 could be re-raised in cycle 3, while later cycles kept finding new
// medium concerns in feature code nobody had touched. The count of things to
// fix never fell, which is what a whack-a-mole loop looks like from inside.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");
const skip = existsSync(join(root, "dist", "orchestrator", "finding-lifecycle.js")) ? false : "dist not built";
const skipDist = { skip };

const F = (over = {}) => ({
  dimension: "security",
  severity: "high",
  title: "Tenant-scoped credentials are described as org-wide",
  detail: "The help text claims org scope; the query filters by tenant.",
  file: "src/app/api/security/credentials/route.ts",
  ...over,
});

// ---------------------------------------------------------------------------
// 18, 19. EQUIVALENT FINDINGS COLLAPSE, AND ARE COUNTED ONCE
// ---------------------------------------------------------------------------

test("18: two chunks reporting the same defect collapse into one finding", skipDist, async () => {
  const { dedupeFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const { kept, duplicates } = dedupeFindings([
    F(),
    // Chunk 2 saw the same route and said it its own way.
    F({ title: "Credentials described as org-wide are actually tenant-scoped", detail: "Different wording, same defect." }),
    F({ file: "src/app/api/security/connections/route.ts", title: "Tenant-scoped credentials are described as org-wide" }),
  ]);

  assert.equal(kept.length, 2, "the reworded repeat collapses; the other route does not");
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].reason, "equivalent");
  assert.deepEqual(
    kept.map((k) => k.file),
    ["src/app/api/security/credentials/route.ts", "src/app/api/security/connections/route.ts"],
    "same complaint, different file, is two defects and two repairs",
  );
});

test("18: an identical repeat collapses on the fingerprint alone", skipDist, async () => {
  const { dedupeFindings, findingFingerprint } = await import("../dist/orchestrator/finding-lifecycle.js");
  const { kept, duplicates } = dedupeFindings([F(), F(), F()]);
  assert.equal(kept.length, 1);
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((d) => d.reason === "identical"));
  assert.equal(kept[0].fingerprint, findingFingerprint(F()), "and the survivor carries the identity");
});

test("the fingerprint survives rewrapping, requoting and a moved line number", skipDist, async () => {
  const { findingFingerprint } = await import("../dist/orchestrator/finding-lifecycle.js");
  const a = F({ detail: "`parseInt` accepts trailing junk at line 42." });
  const b = F({ detail: 'parseInt accepts trailing junk at line 118.' });
  assert.equal(findingFingerprint(a), findingFingerprint(b), "a fix that moves a line is not a new finding");

  // But the things that identify it do change it.
  assert.notEqual(findingFingerprint(a), findingFingerprint(F({ file: "src/other.ts" })));
  assert.notEqual(findingFingerprint(a), findingFingerprint(F({ dimension: "quality" })));
});

test("collapsing keeps the worst severity and every file the fix needs", skipDist, async () => {
  const { dedupeFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const { kept } = dedupeFindings([
    F({ severity: "medium", relatedFiles: ["prisma/schema.prisma"] }),
    F({ severity: "critical", title: "Credentials described as org-wide are tenant-scoped", relatedFiles: ["src/lib/help/help-content.ts"] }),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].severity, "critical", "merging must not launder a critical into a medium");
  assert.deepEqual(
    [...kept[0].relatedFiles].sort(),
    ["prisma/schema.prisma", "src/lib/help/help-content.ts"],
    "a duplicate that named one more file the fix needs is the reason to merge rather than discard",
  );
});

test("19: the chunked adversary path deduplicates before anything counts them", skipDist, async () => {
  const { runAdversarySdk } = await import("../dist/adapters/claude-code.js");

  // Two files, each large enough to force its own chunk.
  const bigFile = (name) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n` +
    Array.from({ length: 3000 }, (_, i) => `+line ${i} of ${name} ${"x".repeat(40)}`).join("\n") +
    "\n";
  const diffText = bigFile("src/a.ts") + bigFile("src/b.ts");

  let calls = 0;
  const logged = [];
  const out = await runAdversarySdk({
    model: "m",
    systemPrompt: "sys",
    diffText,
    timeoutSeconds: 30,
    logger: { info: (m, meta) => logged.push({ m, meta }), warn: () => {} },
    // Both chunks report the same defect, which is exactly what the "do not
    // repeat prior chunks' findings" instruction fails to prevent.
    execute: async () => {
      calls += 1;
      return {
        parsed: null,
        raw: JSON.stringify({
          verdict: "revise",
          findings: [F({ severity: "high" })],
          summary: `chunk ${calls}`,
        }),
        sdkSessionId: `s${calls}`,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        stopReason: "end_turn",
      };
    },
  });

  assert.ok(calls >= 2, "the diff has to actually chunk for this test to mean anything");
  assert.equal(out.parsed.findings.length, 1, "one defect, reported twice, is one blocker");
  assert.equal(out.parsed.verdict, "revise", "and deduplication must not soften the verdict");
  const event = logged.find((l) => l.meta?.event === "adversary.finding_deduplicated");
  assert.ok(event, "what was collapsed has to be visible; silent merging is indistinguishable from a lost finding");
  assert.equal(event.meta.after, 1);
});

// ---------------------------------------------------------------------------
// 24. RESOLVED STAYS RESOLVED UNLESS IT REGRESSES
// ---------------------------------------------------------------------------

const record = (over = {}) => ({
  fingerprint: "fp-1",
  state: "open",
  severity: "high",
  dimension: "security",
  source: null,
  file: "src/app/api/security/credentials/route.ts",
  relatedFiles: [],
  title: "Tenant-scoped credentials are described as org-wide",
  detail: "d",
  firstSeenCycle: 1,
  lastSeenCycle: 1,
  resolvedCycle: null,
  lateDiscoveryReason: null,
  ...over,
});

test("24: a finding the adversary stops raising becomes resolved", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const r = reconcileFindings({ cycle: 2, current: [], prior: [record()], changedThisCycle: ["src/app/api/security/credentials/route.ts"] });
  assert.equal(r.records[0].state, "resolved");
  assert.equal(r.records[0].resolvedCycle, 2);
  assert.equal(r.transitions[0].to, "resolved");
});

test("24: a resolved finding re-raised over an untouched file stays resolved", skipDist, async () => {
  const { reconcileFindings, findingFingerprint } = await import("../dist/orchestrator/finding-lifecycle.js");
  const fp = findingFingerprint(F());
  const r = reconcileFindings({
    cycle: 4,
    current: [{ ...F(), fingerprint: fp }],
    prior: [record({ fingerprint: fp, state: "resolved", resolvedCycle: 2 })],
    // Cycle 4 touched something else entirely.
    changedThisCycle: ["src/lib/workflow-manifest.ts"],
  });
  assert.equal(r.findings[0].lifecycleState, "stale", "the fix is still in the tree; re-reading the diff is not a regression");
  assert.equal(r.records[0].state, "stale");
  assert.match(r.transitions[0].reason, /nothing has touched/);
});

test("24: a resolved finding reopens when its file changes again", skipDist, async () => {
  const { reconcileFindings, findingFingerprint } = await import("../dist/orchestrator/finding-lifecycle.js");
  const fp = findingFingerprint(F());
  const r = reconcileFindings({
    cycle: 4,
    current: [{ ...F(), fingerprint: fp }],
    prior: [record({ fingerprint: fp, state: "resolved", resolvedCycle: 2 })],
    changedThisCycle: ["src/app/api/security/credentials/route.ts"],
  });
  assert.equal(r.findings[0].lifecycleState, "open", "a worker edited it again, so the defect can genuinely be back");
  assert.equal(r.records[0].resolvedCycle, null);
});

test("a decision a human already made outranks the adversary raising it again", skipDist, async () => {
  const { reconcileFindings, findingFingerprint } = await import("../dist/orchestrator/finding-lifecycle.js");
  const fp = findingFingerprint(F());
  for (const state of ["accepted", "dispositioned"]) {
    const r = reconcileFindings({
      cycle: 3,
      current: [{ ...F(), fingerprint: fp }],
      prior: [record({ fingerprint: fp, state })],
      changedThisCycle: ["src/app/api/security/credentials/route.ts"],
    });
    assert.equal(r.findings[0].lifecycleState, state, `${state} must survive a re-raise`);
  }
});

// ---------------------------------------------------------------------------
// 22, 23. THE LATE-DISCOVERY BAR
// ---------------------------------------------------------------------------

test("22: a new medium finding against unchanged code after cycle 1 stops driving cycles", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const late = F({ severity: "medium", dimension: "quality", title: "This helper could be simplified", file: "src/legacy/untouched.ts" });
  const r = reconcileFindings({ cycle: 3, current: [late], prior: [], changedThisCycle: ["src/lib/workflow-manifest.ts"] });

  assert.equal(r.findings[0].lifecycleState, "stale");
  assert.equal(r.lateDiscoveries[0].admitted, false);
  assert.match(r.lateDiscoveries[0].reason, /cycle 3 against code this run has not changed/);
  // Still recorded, and still on the PR -- suppressed from the loop, not from
  // the human. The failure this prevents is a target that grows as fast as it
  // is hit, not a reviewer having an opinion.
  assert.equal(r.records[0].state, "stale");
  assert.match(r.records[0].lateDiscoveryReason, /below the late-discovery bar/);
});

test("22: the same finding in cycle 1 is an ordinary open finding", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const r = reconcileFindings({
    cycle: 1,
    current: [F({ severity: "medium", dimension: "quality", file: "src/legacy/untouched.ts" })],
    prior: [],
    changedThisCycle: [],
  });
  assert.equal(r.findings[0].lifecycleState, "open", "cycle 1 IS the full baseline review");
  assert.equal(r.lateDiscoveries.length, 0);
});

test("22: a new medium finding against code THIS cycle changed is always open", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const r = reconcileFindings({
    cycle: 3,
    current: [F({ severity: "medium", dimension: "quality", file: "src/lib/workflow-manifest.ts" })],
    prior: [],
    changedThisCycle: ["src/lib/workflow-manifest.ts"],
  });
  assert.equal(r.findings[0].lifecycleState, "open", "reviewing what just changed is the job, not surface expansion");
});

test("23: high, critical and security late discoveries are admitted, with a reason", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const cases = [
    [F({ severity: "high", dimension: "quality", file: "src/legacy/a.ts" }), /severity high/],
    [F({ severity: "critical", dimension: "quality", file: "src/legacy/b.ts" }), /severity critical/],
    [F({ severity: "medium", dimension: "security", file: "src/legacy/c.ts" }), /security-significant/],
  ];
  for (const [finding, reasonRe] of cases) {
    const r = reconcileFindings({ cycle: 3, current: [finding], prior: [], changedThisCycle: ["src/other.ts"] });
    assert.equal(r.findings[0].lifecycleState, "late_discovery", `${finding.severity}/${finding.dimension} must still be admitted`);
    assert.match(r.findings[0].lateDiscoveryReason, reasonRe);
    assert.equal(r.lateDiscoveries[0].admitted, true);
    assert.match(r.records[0].lateDiscoveryReason, reasonRe);
  }
});

test("23: a defect a previous fix exposed is admitted whatever its severity", skipDist, async () => {
  const { reconcileFindings } = await import("../dist/orchestrator/finding-lifecycle.js");
  const r = reconcileFindings({
    cycle: 3,
    // The finding lives in an untouched file, but resolving it needs the file
    // the last cycle changed -- which is what "a previous fix exposed it" is.
    current: [F({ severity: "medium", dimension: "quality", file: "src/legacy/consumer.ts", relatedFiles: ["src/lib/workflow-manifest.ts"] })],
    prior: [],
    changedThisCycle: ["src/lib/workflow-manifest.ts"],
  });
  assert.equal(r.findings[0].lifecycleState, "late_discovery");
  assert.match(r.findings[0].lateDiscoveryReason, /exposed by a fix made in a previous cycle/);
});

// ---------------------------------------------------------------------------
// THE GATES READ THE STATE
// ---------------------------------------------------------------------------

test("a settled finding stops driving cycles and stops holding the merge", skipDist, async () => {
  const { isBlockingFinding, blocksMerge, classifyFinding } = await import("../dist/orchestrator/finding-classify.js");
  const ctx = { repoHasTestScript: true };
  const live = F({ severity: "high", dimension: "quality", detail: "the function returns before the write" });
  const cls = classifyFinding(live, ctx);
  assert.equal(isBlockingFinding(live, cls), true, "the baseline this is measured against");
  assert.equal(blocksMerge(live, cls), true);

  for (const state of ["resolved", "stale", "accepted", "dispositioned"]) {
    const f = { ...live, lifecycleState: state };
    assert.equal(isBlockingFinding(f, classifyFinding(f, ctx)), false, `${state} must not force another cycle`);
    assert.equal(blocksMerge(f, classifyFinding(f, ctx)), false, `${state} must not hold the merge`);
  }
  for (const state of ["open", "late_discovery"]) {
    const f = { ...live, lifecycleState: state };
    assert.equal(isBlockingFinding(f, classifyFinding(f, ctx)), true, `${state} is live`);
  }
});

test("a finding with no lifecycle state at all behaves exactly as before", skipDist, async () => {
  const { isBlockingFinding, blocksMerge, classifyFinding } = await import("../dist/orchestrator/finding-classify.js");
  // Every finding produced before rc.3, and every path that has not been
  // through reconciliation. Reading an unknown state as settled would drop
  // real findings silently, so absent has to mean live.
  const f = F({ severity: "high", dimension: "quality", detail: "the function returns before the write" });
  assert.equal(isBlockingFinding(f, classifyFinding(f, { repoHasTestScript: true })), true);
  assert.equal(blocksMerge(f, classifyFinding(f, { repoHasTestScript: true })), true);
});

test("isRecycledFinding no longer calls two different files the same defect", skipDist, async () => {
  const { isRecycledFinding } = await import("../dist/orchestrator/finding-classify.js");
  const prior = [F({ title: "Missing tenant scope on the credentials route", file: "src/app/api/credentials/route.ts" })];

  // The bug this fixes: dimension plus two shared title words matched, so a
  // live defect in another file counted as recycled -- and a recycled finding
  // cannot sustain a `revise`, so the verdict downgraded to pass and shipped.
  assert.equal(
    isRecycledFinding(F({ title: "Missing tenant scope on the connections route", file: "src/app/api/connections/route.ts" }), prior),
    false,
    "same words, different file, different defect",
  );
  assert.equal(
    isRecycledFinding(F({ title: "Missing tenant scope on the credentials route", file: "src/app/api/credentials/route.ts" }), prior),
    true,
    "and the case it exists for still works",
  );
  // A file-less META finding has no location to disagree about, so the old
  // title-only comparison still applies to it.
  assert.equal(isRecycledFinding(F({ title: "Missing tenant scope somewhere", file: null }), prior), true);
});

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------

test("the findings table survives a cycle and is keyed by fingerprint", skipDist, async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { db, state, audits } = await makeState();
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, slack_thread, slack_channel, requester, requester_gh, repo, branch,
       worktree_path, status, created_at, updated_at, budget_usd, cost_usd, cycles_ran)
     VALUES ('S1','T','C','U1','u1','o/r','b','/w','reviewing', ?, ?, 50, 0, 1)`,
  ).run(now, now);
  const loop = new OrchestratorLoop({
    state, logger: { info() {}, warn() {}, error() {}, debug() {} }, config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
  });

  const report = { verdict: "revise", findings: [F(), F()], summary: "s", costUsd: 0, tokensIn: 0, tokensOut: 0 };
  const cycle1 = loop.reconcileCycleFindings("S1", 1, report, []);
  assert.equal(cycle1.findings.length, 1, "the duplicate never reaches the reviews table either");
  assert.equal(cycle1.findings[0].lifecycleState, "open");
  assert.ok(audits.some((a) => a.event === "loop.finding_deduplicated"));
  assert.ok(audits.some((a) => a.event === "loop.finding_lifecycle_reconciled"));

  const rows = db.prepare(`SELECT fingerprint, state, first_seen_cycle FROM findings WHERE session_id='S1'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "open");

  // Cycle 2 stops raising it: it closes, and the row is updated rather than
  // duplicated.
  const cycle2 = loop.reconcileCycleFindings("S1", 2, { ...report, findings: [] }, []);
  assert.equal(cycle2.findings.length, 0);
  const after = db.prepare(`SELECT fingerprint, state, resolved_cycle FROM findings WHERE session_id='S1'`).all();
  assert.equal(after.length, 1, "one finding, one row, however many cycles see it");
  assert.equal(after[0].state, "resolved");
  assert.equal(after[0].resolved_cycle, 2);
  assert.equal(after[0].fingerprint, rows[0].fingerprint, "and the identity is the same identity");
});

test("reconciliation never fails a review that it cannot complete", skipDist, async () => {
  const { OrchestratorLoop } = await import("../dist/orchestrator/loop.js");
  const { makeState, makeConfig } = await import("./helpers/scenario.mjs");
  const { state } = await makeState();
  const loop = new OrchestratorLoop({
    state,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    config: makeConfig(),
    readReactions: async () => ({ shipIt: false, abort: false, pause: false, budgetBump: false }),
  });
  // No session row, so the write violates the foreign key. A review that cannot
  // be reconciled is still a review; the findings must come back untouched.
  const report = { verdict: "revise", findings: [F()], summary: "s", costUsd: 0, tokensIn: 0, tokensOut: 0 };
  const out = loop.reconcileCycleFindings("nope", 1, report, []);
  assert.equal(out.findings.length, 1);
  assert.equal(out.verdict, "revise");
});

test("the loop reconciles before it persists, and feeds the reconciler real changed files", () => {
  const src = S("src/orchestrator/loop.ts");
  const reconcileAt = src.indexOf("report = this.reconcileCycleFindings(sessionId, cycle, report, changedThisCycle)");
  const saveAt = src.indexOf("this.saveReview(sessionId, cycle, report)");
  assert.ok(reconcileAt > 0 && saveAt > reconcileAt, "the reviews table must record the reconciled findings, not the raw ones");
  // Reconciliation also has to precede the blocking count, or a resolved
  // finding still buys a cycle.
  assert.ok(src.indexOf("const blockingFindings = this.countBlockingFindings(report.findings)") > reconcileAt);
  assert.match(src, /worktreeCommittedFiles\(plan\.worktreePath, cycleBaseSha\)/);
});
