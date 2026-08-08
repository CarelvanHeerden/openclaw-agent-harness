/**
 * beta.116: a finding that names a file must reach whoever owns that file.
 *
 * The adversary's prompt lists its review axes in prose ("2. Codebase fit:
 * ...") and its TypeScript interface declares `dimension: "spec" | "fit" | ...`.
 * A TS union constrains our code, not a model, and the model read the heading:
 * across the local runs it emitted `codebase-fit` 21 times and `fit` once.
 *
 * `codebase-fit` matched neither set the router consults -- not
 * DIFF_ADDRESSABLE (spec|quality|security), not META_DIMENSIONS (fit|runtime)
 * -- so it landed in a third state nobody designed: broadcast to every
 * sub-task as context, targeted at none, and excluded from b107's orphan
 * adoption because that gate also tested `isDiffAddressable`.
 *
 * The b115 DR/BCP run (session 1d5db24b) is the worked example. Five of its
 * eight mapping misses were `codebase-fit` findings naming concrete files, and
 * two of those files were API routes that sub-tasks in the same plan had just
 * written. The adversary said the file. The owner existed. Nobody was asked.
 * PR #965 shipped with two of them open, one carrying the adversary's own note:
 * "second consecutive cycle, no attempted fix in this diff".
 *
 * The fixtures below are those exact findings.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  normaliseDimension,
  isRoutable,
  isBroadcastOnly,
  isMetaDimension,
} from "../dist/orchestrator/finding-dimension.js";
import { mapFindingsToSubTasks, isMetaFinding, adoptOrphanFindings } from "../dist/orchestrator/revise-mapping.js";
import { computeReviseScope } from "../dist/orchestrator/revise-scope.js";
import { buildTypecheckFinding } from "../dist/orchestrator/typecheck-gate.js";

/** The b115 plan, reduced to the sub-tasks that own the files in question. */
const SUBTASKS = [
  { seq: 1, filesLikelyTouched: ["prisma/schema.prisma"] },
  { seq: 2, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/route.ts"] },
  { seq: 3, filesLikelyTouched: ["src/app/api/grc/continuity-exercises/[id]/route.ts"] },
  { seq: 4, filesLikelyTouched: ["src/app/(portal)/grc/continuity-exercises/page.tsx"] },
];

/** Suffix matcher standing in for the loop's injected resolveContractPath. */
const match = (owned, candidate) => owned.find((p) => p === candidate || p.endsWith(`/${candidate}`) || candidate.endsWith(`/${p}`));

/** The real cycle-2 mapping misses, verbatim from the b115 audit log. */
const POST_NO_ACTIVITYLOG = {
  dimension: "codebase-fit",
  severity: "medium",
  file: "src/app/api/grc/continuity-exercises/route.ts",
  title: "POST /api/grc/continuity-exercises creates a ContinuityExercise with no ActivityLog",
};
const PUT_NO_ACTIVITYLOG = {
  dimension: "codebase-fit",
  severity: "medium",
  file: "src/app/api/grc/continuity-exercises/[id]/route.ts",
  title: "PUT /api/grc/continuity-exercises/[id] updates with no ActivityLog",
};
const HELP_CONTENT = {
  dimension: "codebase-fit",
  severity: "medium",
  file: "src/lib/help/help-content.ts",
  title: "New page and sidebar entry added without updating src/lib/help/help-content.ts",
};

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

test("beta116: the label the model actually emits is understood", () => {
  assert.equal(normaliseDimension("codebase-fit"), "fit", "21 of 22 fit findings arrived under this name");
});

test("beta116: separators and casing do not create new dimensions", () => {
  for (const raw of ["codebase_fit", "Codebase Fit", "  CODEBASE-FIT  ", "codebase  fit"]) {
    assert.equal(normaliseDimension(raw), "fit", `${JSON.stringify(raw)} is the same dimension`);
  }
});

test("beta116: the five canonical tokens pass through untouched", () => {
  for (const d of ["spec", "fit", "quality", "security", "runtime"]) {
    assert.equal(normaliseDimension(d), d);
  }
});

test("beta116: aliases that share no substring with their target still resolve", () => {
  // These cannot fall out of the substring fallback -- "correctness" contains
  // none of the five canonical words -- so they prove the alias table is
  // consulted rather than merely present.
  assert.equal(normaliseDimension("correctness"), "spec");
  assert.equal(normaliseDimension("requirements"), "spec");
  assert.equal(normaliseDimension("conventions"), "fit");
  assert.equal(normaliseDimension("consistency"), "fit");
  assert.equal(normaliseDimension("maintainability"), "quality");
  assert.equal(normaliseDimension("readability"), "quality");
  assert.equal(normaliseDimension("vulnerability"), "security");
  assert.equal(normaliseDimension("sec"), "security");
});

test("beta116: a compound label resolves to its canonical root", () => {
  assert.equal(normaliseDimension("security-hardening"), "security");
  assert.equal(normaliseDimension("code-quality"), "quality");
  assert.equal(normaliseDimension("spec-compliance"), "spec");
});

test("beta116: something genuinely unrecognisable is not guessed at", () => {
  // "" means no opinion, which sends routing to the evidence (does it name a
  // file?) instead of inventing a dimension and acting on the invention.
  assert.equal(normaliseDimension("vibes"), "");
  assert.equal(normaliseDimension(""), "");
  assert.equal(normaliseDimension(null), "");
  assert.equal(normaliseDimension(undefined), "");
});

// ---------------------------------------------------------------------------
// Routing follows the evidence, not the label
// ---------------------------------------------------------------------------

test("beta116: a fit finding naming a file is routable", () => {
  assert.equal(isRoutable(HELP_CONTENT), true);
  assert.equal(isBroadcastOnly(HELP_CONTENT), false);
});

test("beta116: a file-less finding stays a broadcast, because there is nowhere to send it", () => {
  assert.equal(isRoutable({ dimension: "fit", severity: "medium" }), false);
  assert.equal(isRoutable({ dimension: "quality", severity: "high", file: "   " }), false);
});

test("beta116: runtime stays a broadcast even when it names a file", () => {
  // A runtime finding is evidence about a deployed system; the file is where
  // the behaviour was seen, not necessarily a defect to edit.
  assert.equal(isRoutable({ dimension: "runtime", severity: "high", file: "src/app/page.tsx" }), false);
});

test("beta116: an unknown dimension that names a file is still routable", () => {
  // The next vocabulary drift must cost nothing. Evidence beats labels.
  assert.equal(isRoutable({ dimension: "whatever-comes-next", severity: "medium", file: "src/a.ts" }), true);
});

test("beta116: fit remains meta for the unscopable gate, where the question is different", () => {
  // "Is a missing file surprising here?" -- for fit and runtime it is not, so a
  // file-less one must not drag every sub-task into the cycle.
  assert.equal(isMetaDimension({ dimension: "codebase-fit" }), true);
  assert.equal(isMetaDimension({ dimension: "quality" }), false);
});

// ---------------------------------------------------------------------------
// The b115 failure, end to end
// ---------------------------------------------------------------------------

test("beta116: the two API-route findings reach the sub-tasks that wrote those files", () => {
  const res = mapFindingsToSubTasks(SUBTASKS, [POST_NO_ACTIVITYLOG, PUT_NO_ACTIVITYLOG], match);
  const seq2 = res.assignments.find((a) => a.seq === 2);
  const seq3 = res.assignments.find((a) => a.seq === 3);
  assert.equal(seq2.targeted.length, 1, "the POST finding belongs to the sub-task that wrote route.ts");
  assert.equal(seq3.targeted.length, 1, "the PUT finding belongs to the sub-task that wrote [id]/route.ts");
  assert.equal(res.mappingMisses.length, 0, "neither is a mapping miss: both name files the plan owns");
});

test("beta116: a fit finding is no longer broadcast-only when it names an owned file", () => {
  assert.equal(isMetaFinding(POST_NO_ACTIVITYLOG), false, "it has an owner, so it is not cross-cutting context");
  assert.equal(isMetaFinding({ dimension: "codebase-fit", severity: "medium" }), true, "file-less, so still meta");
});

test("beta116: help-content.ts finally gets an owner -- b107's own worked example", () => {
  // No sub-task declares src/lib/help/help-content.ts, so this IS a genuine
  // orphan. b107 wrote adoption for exactly this finding and cited it by name,
  // then gated adoption on `isDiffAddressable` -- which a fit finding fails.
  const owned = (st) => st.filesLikelyTouched ?? [];
  const adoptions = adoptOrphanFindings(SUBTASKS, [HELP_CONTENT], owned);
  assert.equal(adoptions.length, 1, "somebody must be asked to update the help content");
  assert.equal(adoptions[0].file, "src/lib/help/help-content.ts");
});

test("beta116: adoption still refuses to invent an owner out of nothing", () => {
  const owned = (st) => st.filesLikelyTouched ?? [];
  const unrelated = { dimension: "codebase-fit", severity: "medium", file: "totally/elsewhere/thing.rb", title: "x" };
  assert.equal(adoptOrphanFindings(SUBTASKS, [unrelated], owned).length, 0, "an arbitrary owner is worse than an honest miss");
});

test("beta116: info-severity fit findings are still not adopted", () => {
  // b108's rule survives: `info` is the adversary's acknowledgement severity,
  // not a request, and putting a worker on one wastes a cycle.
  const owned = (st) => st.filesLikelyTouched ?? [];
  const info = { ...HELP_CONTENT, severity: "info" };
  assert.equal(adoptOrphanFindings(SUBTASKS, [info], owned).length, 0);
});

// ---------------------------------------------------------------------------
// The unfiled typecheck finding that cost b115 a whole cycle
// ---------------------------------------------------------------------------

test("beta116: the typecheck finding names the file it found errors in", () => {
  const f = buildTypecheckFinding(
    [
      { file: "src/app/api/grc/continuity-exercises/[id]/route.ts", line: 100, column: 10, code: "TS2551", message: "Property 'relatedControlId' does not exist" },
      { file: "src/app/api/grc/continuity-exercises/[id]/route.ts", line: 106, column: 10, code: "TS2551", message: "Property 'signedOffById' does not exist" },
    ],
    "typecheck",
  );
  assert.equal(f.file, "src/app/api/grc/continuity-exercises/[id]/route.ts", "it knows exactly where the errors are");
  assert.equal(f.line, 100);
  assert.match(f.detail, /signedOffById/, "every error is still listed, not just the first");
});

test("beta116: a filed typecheck finding no longer forces the cycle to re-run everything", () => {
  // b115 cycle 2: `quality`/`high`/no file tripped anyFindingUnfiled, scoping
  // switched itself off, and six sub-tasks re-ran to fix two lines.
  const errs = [{ file: "src/app/api/grc/continuity-exercises/[id]/route.ts", line: 100, column: 10, code: "TS2551", message: "x" }];
  const scope = computeReviseScope(SUBTASKS, [buildTypecheckFinding(errs, "typecheck")], 2);
  assert.equal(scope.scoped, true, "the cycle is scopable now that the finding says where");
  assert.deepEqual(scope.runSeqs, [3], "only the sub-task owning the broken file re-runs");
});

test("beta116: an unfiled quality finding still forces a full re-run", () => {
  // The safety property is unchanged: when the harness genuinely cannot tell
  // who owns a problem, it runs everyone rather than guessing.
  const scope = computeReviseScope(SUBTASKS, [{ dimension: "quality", severity: "high", title: "something broad", file: "" }], 2);
  assert.equal(scope.scoped, false);
  assert.equal(scope.reason, "unscopable_findings");
});

test("beta116: a file-less codebase-fit finding does not force a full re-run", () => {
  // Before normalisation this read as a non-meta unfiled finding and made the
  // cycle unscopable, which is the opposite of what the b92 exemption intended.
  const scope = computeReviseScope(
    SUBTASKS,
    [
      { dimension: "codebase-fit", severity: "medium", title: "structure drifts from the module convention" },
      { dimension: "quality", severity: "medium", file: "prisma/schema.prisma", title: "naming" },
    ],
    2,
  );
  assert.equal(scope.scoped, true, "a cross-cutting fit note is expected to be file-less");
  assert.deepEqual(scope.runSeqs, [1]);
});

// ---------------------------------------------------------------------------
// The prompt, so the drift stops at source
// ---------------------------------------------------------------------------

test("beta116: the adversary is told the exact tokens, not just prose headings", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/orchestrator/fable5-adversary.ts", import.meta.url), "utf8");
  assert.match(src, /EXACTLY one of these five tokens/, "the prompt must name the enum it expects");
  for (const tok of ["`spec`", "`fit`", "`quality`", "`security`", "`runtime`"]) {
    assert.ok(src.includes(tok), `the prompt must show ${tok} as a literal token`);
  }
});
