/**
 * beta.109 -- the merge gate stops treating "not pass" as "not mergeable".
 *
 * Anchored to ProjectThanos PR #932, which took three separate harness runs and
 * finished each time with `do_not_merge` while carrying nothing at medium
 * severity or above. The b108 revise (session `25274621`) ended 18 -> 15 -> 17
 * with ten low, six informational and one low convention finding.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { deriveMergeRecommendation } from "../dist/orchestrator/merge-recommendation.js";
import { OrchestratorLoop } from "../dist/orchestrator/loop.js";
import { parseHarnessConfig } from "../dist/config.js";
import { betaOrdinal } from "./helpers/version-floor.mjs";

const S = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const D = (p) => readFileSync(new URL(`../dist/${p}`, import.meta.url), "utf8");

/** PR #932's cycle-3 review, by severity: 10 low, 6 info, 1 low convention. */
const PR932_FINDINGS = [
  ...Array.from({ length: 10 }, (_, i) => ({
    severity: "low", dimension: "quality", title: `low finding ${i + 1}`,
  })),
  ...Array.from({ length: 6 }, (_, i) => ({
    severity: "info", dimension: "spec", title: `verified resolved ${i + 1} (no action)`,
  })),
  { severity: "low", dimension: "codebase-fit", title: "schema.prisma is not prisma format-clean" },
];

const REVIEW = (verdict, findings) => ({ verdict, findings });

/* ------------------------------------------------------------------ *
 * The recommendation
 * ------------------------------------------------------------------ */

test("beta109: a revise carrying only lows is RECOMMENDED FOR MERGE", () => {
  const r = deriveMergeRecommendation({
    review: REVIEW("revise", PR932_FINDINGS),
    blockingFindings: 0,
    reachedCleanPass: false,
    ciStatus: "success",
  });
  assert.equal(r.recommendation, "merge", "this is PR #932 after three runs and roughly $23 of revise spend");
  assert.match(r.reason, /nothing blocking remains/i);
  assert.match(r.reason, /17 finding/, "the residual must still be stated, not hidden");
  assert.match(r.reason, /harness_revise/, "and the option to close the nits must still be offered");
});

test("beta109: identical findings under a PASS verdict already merged -- now they agree", () => {
  const asPass = deriveMergeRecommendation({
    review: REVIEW("pass", PR932_FINDINGS),
    blockingFindings: 0,
    reachedCleanPass: true,
    ciStatus: "success",
  });
  const asRevise = deriveMergeRecommendation({
    review: REVIEW("revise", PR932_FINDINGS),
    blockingFindings: 0,
    reachedCleanPass: false,
    ciStatus: "success",
  });
  assert.equal(asPass.recommendation, "merge");
  assert.equal(
    asRevise.recommendation,
    asPass.recommendation,
    "the same set of findings must not produce opposite advice based on one word in the verdict",
  );
});

test("beta109: one medium keeps it blocked", () => {
  const r = deriveMergeRecommendation({
    review: REVIEW("revise", [
      ...PR932_FINDINGS,
      { severity: "medium", dimension: "security", title: "POST accepts ownersSignOff at create" },
    ]),
    blockingFindings: 1,
    reachedCleanPass: false,
    ciStatus: "success",
  });
  assert.equal(r.recommendation, "do_not_merge");
  assert.match(r.reason, /1 finding\(s\) at medium severity or above/);
  assert.match(r.reason, /ownersSignOff/, "the reason must name what is actually blocking");
});

test("beta109: a `block` verdict is never overridable, even with nothing counted", () => {
  const r = deriveMergeRecommendation({
    review: REVIEW("block", PR932_FINDINGS),
    blockingFindings: 0,
    reachedCleanPass: false,
    ciStatus: "success",
  });
  assert.equal(r.recommendation, "do_not_merge", "block is an explicit withhold, not a severity tally");
  assert.match(r.reason, /actively withheld/);
});

test("beta109: red CI still blocks a no-blocking-findings revise", () => {
  const r = deriveMergeRecommendation({
    review: REVIEW("revise", PR932_FINDINGS),
    blockingFindings: 0,
    reachedCleanPass: false,
    ciStatus: "failure",
  });
  assert.equal(r.recommendation, "do_not_merge");
  assert.match(r.reason, /CI checks are failing/);
});

test("beta109: an uncounted caller keeps the pre-b109 behaviour", () => {
  const r = deriveMergeRecommendation({
    review: REVIEW("revise", PR932_FINDINGS),
    reachedCleanPass: false,
    ciStatus: "success",
  });
  assert.equal(r.recommendation, "do_not_merge", "no count means no gate; nothing loosens by accident");
  assert.match(r.reason, /not "pass"/);
});

test("beta109: no review at all is still unmergeable", () => {
  const r = deriveMergeRecommendation({ review: undefined, blockingFindings: 0, reachedCleanPass: false });
  assert.equal(r.recommendation, "do_not_merge");
});

test("beta109: a clean pass carrying a HIGH is still blocked (step 4 intact)", () => {
  const r = deriveMergeRecommendation({
    review: REVIEW("pass", [{ severity: "high", dimension: "security", title: "cross-tenant read" }]),
    blockingFindings: 1,
    reachedCleanPass: true,
    ciStatus: "success",
  });
  assert.equal(r.recommendation, "do_not_merge");
  assert.match(r.reason, /blocking finding\(s\) at medium severity or above/);
});

/* ------------------------------------------------------------------ *
 * The cycling decision
 * ------------------------------------------------------------------ */

const ADV = (over = {}) => ({
  currentStatus: "reviewing",
  verdict: "revise",
  cyclesRan: 1,
  maxCycles: 3,
  findingCountsByCycle: [18],
  reactions: { shipIt: false, abort: false, pause: false },
  budgetExhausted: false,
  hardTimeout: false,
  ...over,
});

test("beta109: a revise with nothing blocking ends the loop instead of buying a cycle", () => {
  const d = OrchestratorLoop.advance(ADV({ blockingFindings: 0 }));
  assert.equal(d.nextStatus, "done");
  assert.equal(d.reason, "shipped_no_blocking_findings");
});

test("beta109: it fires on cycle 1, which is where the saving is", () => {
  // PR #932's cycles 2 and 3 cost roughly 14 and 8 minutes of execution plus a
  // 7-minute review each, to close low-severity nits and open others.
  const d = OrchestratorLoop.advance(ADV({ cyclesRan: 1, maxCycles: 3, blockingFindings: 0 }));
  assert.equal(d.nextStatus, "done");
});

test("beta109: one blocking finding still cycles", () => {
  const d = OrchestratorLoop.advance(ADV({ blockingFindings: 1 }));
  assert.equal(d.nextStatus, "executing", "medium and above must still get another cycle");
});

test("beta109: a block verdict still fails, gate or no gate", () => {
  const d = OrchestratorLoop.advance(ADV({ verdict: "block", blockingFindings: 0 }));
  assert.equal(d.nextStatus, "failed");
  assert.equal(d.reason, "adversary_block");
});

test("beta109: a pass still reports as a pass, not as the new reason", () => {
  const d = OrchestratorLoop.advance(ADV({ verdict: "pass", blockingFindings: 0 }));
  assert.equal(d.nextStatus, "done");
  assert.equal(d.reason, "adversary_pass");
});

test("beta109: the gate can be switched off", () => {
  const d = OrchestratorLoop.advance(ADV({ blockingFindings: 0, shipWhenNoBlockingFindings: false }));
  assert.equal(d.nextStatus, "executing");
});

test("beta109: an uncounted caller keeps cycling (pre-b109 behaviour)", () => {
  const d = OrchestratorLoop.advance(ADV({ blockingFindings: undefined }));
  assert.equal(d.nextStatus, "executing");
});

test("beta109: abort, budget and timeout still outrank the gate", () => {
  for (const [over, want] of [
    [{ reactions: { shipIt: false, abort: true, pause: false } }, "user_abort_reaction"],
    [{ budgetExhausted: true }, "budget_exhausted"],
    [{ hardTimeout: true }, "hard_timeout"],
  ]) {
    const d = OrchestratorLoop.advance(ADV({ blockingFindings: 0, ...over }));
    assert.equal(d.nextStatus, "aborted");
    assert.equal(d.reason, want);
  }
});

test("beta109: max cycles with blocking findings still ships as converging", () => {
  const d = OrchestratorLoop.advance(
    ADV({ cyclesRan: 3, maxCycles: 3, blockingFindings: 2, findingCountsByCycle: [18, 15, 12] }),
  );
  assert.equal(d.nextStatus, "done");
  assert.equal(d.reason, "shipped_max_cycles_revise_converging", "the b97 path must survive");
});

/* ------------------------------------------------------------------ *
 * Counting, and the wiring
 * ------------------------------------------------------------------ */

test("beta109: the loop counts blocking findings with isBlockingFinding", () => {
  // Not a second, looser notion of 'serious'. merge-recommendation's own
  // BLOCKING_SEVERITIES omits `medium`; the rest of the harness does not, and
  // shipping open mediums would be a loosening nobody asked for.
  const loop = S("src/orchestrator/loop.ts");
  const i = loop.indexOf("private countBlockingFindings(");
  assert.ok(i > 0);
  const body = loop.slice(i, i + 500);
  assert.match(body, /isBlockingFinding\(f, classifyFinding\(f/);
});

test("beta109: the built loop threads the count into BOTH decisions", () => {
  const loop = D("orchestrator/loop.js");
  assert.match(loop, /blockingFindings,\n\s+shipWhenNoBlockingFindings:/, "the cycling decision");
  assert.match(loop, /blockingFindings: this\.countBlockingFindings\(lastReview\.findings\)/, "the recommendation");
});

test("beta109: the built gate is present in advance()", () => {
  const loop = D("orchestrator/loop.js");
  assert.match(loop, /shipped_no_blocking_findings/);
  assert.match(loop, /input\.shipWhenNoBlockingFindings !== false/);
  assert.match(loop, /input\.blockingFindings === 0/);
});

test("beta109: the count is audited so a run can be explained afterwards", () => {
  assert.match(D("orchestrator/loop.js"), /"loop\.blocking_findings"/);
});

test("beta109: medium counts as blocking, behaviourally", async () => {
  // The predicate the gate actually consults. A high-and-above rule here would
  // ship PRs carrying open mediums -- a real loosening, not the intended one.
  const { isBlockingFinding, classifyFinding } = await import("../dist/orchestrator/finding-classify.js");
  const blocking = (severity, dimension = "quality") => {
    const f = { severity, dimension, title: "t", detail: "d", file: "src/a.ts" };
    return isBlockingFinding(f, classifyFinding(f, { repoHasTestScript: true }));
  };
  assert.equal(blocking("medium"), true, "medium MUST keep a run cycling");
  assert.equal(blocking("high"), true);
  assert.equal(blocking("critical"), true);
  assert.equal(blocking("low"), false);
  assert.equal(blocking("info"), false);
});

test("beta109: a medium is counted, so the run does NOT ship early", async () => {
  const { isBlockingFinding, classifyFinding } = await import("../dist/orchestrator/finding-classify.js");
  const count = (fs) =>
    fs.filter((f) => isBlockingFinding(f, classifyFinding(f, { repoHasTestScript: true }))).length;
  const withMedium = [
    ...PR932_FINDINGS.map((f) => ({ ...f, file: "src/a.ts", detail: "d" })),
    { severity: "medium", dimension: "security", title: "m", detail: "d", file: "src/b.ts" },
  ];
  const n = count(withMedium);
  assert.equal(n, 1, "exactly the medium is blocking; the ten lows and six infos are not");
  assert.equal(OrchestratorLoop.advance(ADV({ blockingFindings: n })).nextStatus, "executing");
});

// rc.3: this asserted that the local `AT_LEAST_MEDIUM` Set literal contained
// "medium". That Set is gone -- merge-recommendation now reads severity through
// `isAtLeastMedium`, so the ship gate and the merge gate cannot drift apart.
// The claim it was making is unchanged, so it is made against behaviour instead
// of against the source text that used to implement it.
test("beta109: merge-recommendation counts a medium as blocking", () => {
  const medium = { severity: "medium", dimension: "quality", title: "unchecked index write" };
  const r = deriveMergeRecommendation({
    review: REVIEW("revise", [...PR932_FINDINGS, medium]),
    blockingFindings: 1,
    reachedCleanPass: false,
    ciStatus: "success",
  });
  assert.equal(r.recommendation, "do_not_merge");
  assert.match(r.reason, /unchecked index write/);
});

test("beta109: the config key defaults on and is overridable", () => {
  const MIN = { slack: { authorised_users: ["U1"] }, repos: { allowed: ["a/*"], default_base_branch: "main" } };
  assert.equal(parseHarnessConfig(MIN).loop.ship_when_no_blocking_findings, true);
  assert.equal(
    parseHarnessConfig({ ...MIN, loop: { ship_when_no_blocking_findings: false } }).loop
      .ship_when_no_blocking_findings,
    false,
  );
});

test("beta109: the key is declared in both schemas", () => {
  for (const f of ["src/config.schema.json", "openclaw.plugin.json"]) {
    assert.match(S(f), /ship_when_no_blocking_findings/, `${f} missing the key`);
  }
});

test("beta109: pluginVersion and package.json agree at >= beta.109", () => {
  const betaNum = betaOrdinal;
  const pkg = JSON.parse(S("package.json")).version;
  assert.ok(betaNum(pkg) >= 109, `expected >= beta.109, got ${pkg}`);
  assert.ok(S("src/version.ts").includes(pkg));
});
