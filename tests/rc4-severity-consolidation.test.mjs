// rc.4 — finishing the severity consolidation, and testing the Node floor.
//
// The external reviewer verified rc.3 against the shipped tag and found the one
// thing the response document got wrong: rc.3 claimed "the six ad-hoc
// `(f.severity ?? "").toLowerCase()` call sites are gone" when three remained
// (revise-mapping x2, file-attribution), and a fourth (revise-scope) that the
// reviewer did not spot kept its own synonym list.
//
// Because `index.ts` normalises at the parse boundary, most values agreed
// anyway. Exactly one did not, and it disagreed in the direction that costs a
// whole run: `unknown`. An unreadable severity BLOCKED the ship (rc.3 working as
// designed) but was not adoptable into revise scope and not required to name a
// file -- so nothing could ever be scoped to a worker to fix it, the revise loop
// could not converge, and the run burned to `max_cycles`. Blocking and
// unfixable is the wrong pair of answers.
//
// These tests pin the property the reviewer asked for: every consumer agrees
// about what a severity means, for every severity, including the unreadable one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normaliseSeverity, isAtLeastMedium } from "../dist/orchestrator/finding-classify.js";
import { adoptOrphanFindings, ADOPTABLE_SEVERITIES } from "../dist/orchestrator/revise-mapping.js";
import { requiresFile, findingsMissingFile } from "../dist/orchestrator/adversary-file-attribution.js";
import { computeReviseScope } from "../dist/orchestrator/revise-scope.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

/* ------------------------------------------------------------------ *
 * The reviewer's finding: the gates must agree about `unknown`
 * ------------------------------------------------------------------ */

// Raw severities a model actually emits, including the ones it does not.
const RAW_SEVERITIES = [undefined, null, "", "   ", "Medium", "moderate", "major", "gibberish", "unknown"];

test("rc4: an unreadable severity blocks, and is therefore also adoptable and attributable", () => {
  // This is the reviewer's exact case. Before rc.4 the middle column was false
  // and the right column was false, while the left was true.
  const f = { dimension: "security", severity: normaliseSeverity(undefined), file: undefined };
  assert.equal(isAtLeastMedium(f.severity), true, "unknown blocks the ship");
  assert.equal(ADOPTABLE_SEVERITIES.has(f.severity), true, "so a worker must be allowed to receive it");
  assert.equal(requiresFile(f), true, "and it must be made to name a file, or it can never be scoped");
});

test("rc4: blocking implies fixable, for every severity a model can emit", () => {
  // The property, stated once: nothing may block the ship that the revise loop
  // is then forbidden from routing to a worker. Any severity that fails this
  // pair is a run that cannot converge.
  for (const raw of RAW_SEVERITIES) {
    const sev = normaliseSeverity(raw);
    const blocks = isAtLeastMedium(sev);
    if (!blocks) continue;
    const f = { dimension: "security", severity: sev, file: undefined };
    assert.equal(
      ADOPTABLE_SEVERITIES.has(sev),
      true,
      `${JSON.stringify(raw)} -> ${sev} blocks the ship but could not be adopted`,
    );
    assert.equal(
      requiresFile(f),
      true,
      `${JSON.stringify(raw)} -> ${sev} blocks the ship but was not required to name a file`,
    );
  }
});

test("rc4: an unfiled unknown-severity finding is caught by attribution, not ignored", () => {
  const unfiled = { dimension: "quality", severity: "unknown", file: undefined, title: "something unreadable" };
  const missing = findingsMissingFile([unfiled]);
  assert.equal(missing.length, 1, "the re-prompt must ask the adversary to name the file");
});

/* ------------------------------------------------------------------ *
 * Rank: `unknown` must survive the adoption cap it needs
 * ------------------------------------------------------------------ */

const SUBTASKS = [
  { seq: 1, filesLikelyTouched: ["src/lib/grc/continuity-client.ts"] },
  { seq: 2, filesLikelyTouched: ["src/lib/grc/continuity-helpers.ts"] },
];
const owned = (st) => st.filesLikelyTouched ?? [];

test("rc4: the adoption cap does not drop an unknown finding in favour of a low one", () => {
  // Adoption is severity-ordered and then capped, so rank decides who survives.
  // `indexOf` returned -1 for an unreadable severity, sorting it BELOW `info` --
  // first in line to be dropped by the very cap it had to survive, on the one
  // finding that was also blocking the ship.
  const unknownFinding = {
    id: 1,
    severity: "unknown",
    dimension: "quality",
    file: "src/lib/grc/continuity-notes.ts",
    title: "unreadable severity, real defect",
  };
  const lowFinding = {
    id: 2,
    severity: "low",
    dimension: "quality",
    file: "src/lib/grc/continuity-extras.ts",
    title: "a genuine low",
  };
  const adopted = adoptOrphanFindings(SUBTASKS, [lowFinding, unknownFinding], owned, { maxPerCycle: 1 });
  assert.equal(adopted.length, 1, "the cap admits exactly one");
  assert.equal(adopted[0].finding.id, 1, "and it must be the one that is blocking the ship");
});

test("rc4: unknown still ranks below high, so it does not crowd out real severity", () => {
  // Ranking `unknown` at the threshold it blocks at (medium) rather than at the
  // top: it must not outrank a finding the adversary could actually read.
  const unknownFinding = {
    id: 1,
    severity: "unknown",
    dimension: "quality",
    file: "src/lib/grc/continuity-notes.ts",
    title: "unreadable",
  };
  const highFinding = {
    id: 2,
    severity: "high",
    dimension: "quality",
    file: "src/lib/grc/continuity-extras.ts",
    title: "a read, high-severity defect",
  };
  const adopted = adoptOrphanFindings(SUBTASKS, [unknownFinding, highFinding], owned, { maxPerCycle: 1 });
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].finding.id, 2, "a legible high beats an illegible unknown");
});

/* ------------------------------------------------------------------ *
 * revise-scope: the synonym list the reviewer did not reach
 * ------------------------------------------------------------------ */

const SCOPE_SUBTASKS = [
  { seq: 1, filesLikelyTouched: ["src/a.ts"] },
  { seq: 2, filesLikelyTouched: ["src/b.ts"] },
];
// A real finding naming seq 1, so the cycle has something to scope TO. The
// severity under test rides alongside it with no file, which is the only place
// `isBelowActionable` changes the answer: an unfiled finding makes the whole
// cycle unscopable unless it is below actionable.
const scopeWith = (severity) =>
  computeReviseScope(
    SCOPE_SUBTASKS,
    [
      { severity: "medium", dimension: "quality", file: "src/a.ts", title: "the real one" },
      { severity, dimension: "quality", file: undefined, title: `unfiled ${severity}` },
    ],
    2,
  );

test("rc4: `trivial` and `minor` no longer force every sub-task to re-run", () => {
  // revise-scope kept its own below-actionable vocabulary, which was
  // `normaliseSeverity`'s list minus `trivial` and `minor`. Both normalise to
  // info/low everywhere else; here they fell through as ACTIONABLE, so an
  // info-in-all-but-name finding re-ran the whole cycle. That is the beta.114
  // cost this function exists to prevent, arriving through a synonym.
  for (const severity of ["trivial", "minor", "info", "low", "nit", "note"]) {
    const res = scopeWith(severity);
    assert.equal(res.scoped, true, `an unfiled ${severity} must not force a full re-run`);
    assert.deepEqual(res.skipSeqs, [2], `${severity} must leave seq 2 skippable`);
  }
});

test("rc4: an absent or unreadable severity still forces the full run", () => {
  // The direction that must NOT change: unknown is not a licence to skip work.
  // An unfiled finding we cannot read might name anything, so nothing is proven
  // irrelevant and everything runs.
  for (const severity of [undefined, "", "gibberish", "unknown", "medium"]) {
    const res = scopeWith(severity);
    assert.equal(res.scoped, false, `an unfiled ${severity} finding must not be scoped away`);
    assert.equal(res.reason, "unscopable_findings");
    assert.deepEqual(res.skipSeqs, [], "nothing may be skipped on an unreadable finding");
  }
});

/* ------------------------------------------------------------------ *
 * The guard: no site may hand-roll severity again
 * ------------------------------------------------------------------ */

test("rc4: severity is interpreted in exactly one module", () => {
  // rc.3's comment claimed this consolidation while four sites still had their
  // own. A claim in a comment is what let it drift; this is the version that
  // fails the build.
  const offenders = [];
  const files = [
    "src/orchestrator/revise-mapping.ts",
    "src/orchestrator/revise-scope.ts",
    "src/orchestrator/adversary-file-attribution.ts",
    "src/orchestrator/merge-recommendation.ts",
    "src/index.ts",
  ];
  for (const f of files) {
    for (const [i, line] of S(f).split("\n").entries()) {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
      if (/severity[^\n]*\.toLowerCase\(\)/.test(line)) offenders.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], "route severity through normaliseSeverity/isAtLeastMedium instead");
});

/* ------------------------------------------------------------------ *
 * §4a — the advertised Node floor must actually be tested
 * ------------------------------------------------------------------ */

test("rc4: CI runs the Node version that package.json advertises", () => {
  // `engines.node` said >=22.5.0 and CI ran 24 only, so the floor was claimed
  // and never executed. It was not academic: 22 subtests across the two
  // first-token watchdog files were `cancelledByParent` on 22.x and asserted
  // nothing -- on the suite that exists because of the beta.63 hung-stream
  // incident.
  const pkg = JSON.parse(S("package.json"));
  const floor = /(\d+)/.exec(pkg.engines.node)?.[1];
  assert.ok(floor, "engines.node must name a major version");

  const ci = S(".github/workflows/ci.yml");
  const matrix = /node-version:\s*\[([^\]]+)\]/.exec(ci);
  assert.ok(matrix, "CI must test a matrix of Node versions, not a single one");
  const versions = matrix[1].split(",").map((v) => v.trim().replace(/["']/g, ""));
  assert.ok(
    versions.some((v) => v.startsWith(floor)),
    `CI must run the advertised floor (Node ${floor}); matrix is ${versions.join(", ")}`,
  );
});

test("rc4: the first-token fakes hold the event loop open", () => {
  // The mechanism, so the cancellation cannot come back quietly. Both fakes wait
  // on an abort that only an unref'd watchdog timer will fire; an unref'd timer
  // does not hold the loop, so Node drains it and cancels the pending subtests
  // -- and cancellations are not failures, so the file stays green asserting
  // nothing. The fakes must wait through the helper that holds a ref'd handle.
  for (const f of ["tests/beta64-first-token-watchdog.test.mjs", "tests/beta65-first-token-arming.test.mjs"]) {
    const src = S(f);
    assert.match(src, /waitForAbort/, `${f} must wait through the keep-alive helper`);
    assert.doesNotMatch(
      src,
      /addEventListener\("abort"/,
      `${f} must not hand-roll the abort wait; that is what drained the loop`,
    );
  }
});
