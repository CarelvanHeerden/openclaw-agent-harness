// rc.7 phase 3: declared generated output is summarised for review, not sent
// verbatim.
//
// A regenerated bundle is 1,663 files on the StitchGuard OKF tree. Sent whole
// it pushes the adversary past DIFF_SINGLE_CHUNK_BYTES and splits the review
// into chunks read in sequence, so the hand-written change that actually needs
// review is scattered across calls that each see a fraction of it, while most
// of the money goes on reading machine output line by line.
//
// The line these tests hold is the difference between SUMMARISING and HIDING.
// Every folded file stays named, with its line counts and the script that owns
// it; the adversary is told the omission is deliberate and invited to demand
// any of it back. Only paths an operator declared are eligible, nothing is
// inferred from a directory name, and the whole thing is off unless a
// deployment turns it on. A test that let any of those slip would be testing a
// blind spot rather than a saving.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { foldGeneratedFiles, splitDiffOnFileBoundaries, DIFF_SINGLE_CHUNK_BYTES } = await import(
  "../dist/adapters/shared/diff.js"
);

/** One file's section of a unified diff. */
function section(path, { added = 1, removed = 1 } = {}) {
  const lines = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " context",
  ];
  for (let i = 0; i < removed; i++) lines.push(`-old ${i}`);
  for (let i = 0; i < added; i++) lines.push(`+new ${i}`);
  return lines.join("\n") + "\n";
}

/** Owner lookup standing in for a resolved `verify.generators`. */
const okfOwns = (f) => (f.startsWith("okf/") ? "okf" : null);
const ownsNothing = () => null;

// ---------------------------------------------------------------------------
// What it removes, and what it must not
// ---------------------------------------------------------------------------

test("rc.7 fold: generated content goes, generated FACTS stay", () => {
  const diff =
    section("src/feature.ts", { added: 4, removed: 2 }) +
    section("okf/index.md", { added: 12, removed: 3 }) +
    section("okf/modules/m1.md", { added: 7, removed: 0 });

  const { diff: out, folded } = foldGeneratedFiles(diff, okfOwns);

  assert.equal(folded.length, 2);
  // The hand-written file is untouched, in full.
  assert.ok(out.includes("diff --git a/src/feature.ts b/src/feature.ts"));
  assert.ok(out.includes("+new 3"), "the reviewable change must survive verbatim");
  // The generated CONTENT is gone.
  assert.ok(!out.includes("@@ -1,3 +1,3 @@\n context\n-old 0\n+new 0\n+new 1\n+new 2"), "generated hunks must not remain");
  // The generated FACTS are not.
  assert.match(out, /okf\/index\.md\s+\+12 -3\s+\(npm run okf\)/);
  assert.match(out, /okf\/modules\/m1\.md\s+\+7 -0\s+\(npm run okf\)/);
  assert.match(out, /2 file\(s\) SUMMARISED, NOT SHOWN VERBATIM/);
  assert.match(out, /\+19 -3 line\(s\)/, "the totals have to be stated, not left to be inferred");
});

test("rc.7 fold: the reviewer is told the omission is deliberate and may ask for it back", () => {
  // Without this the adversary's correct response to a missing file is a
  // finding that it is missing -- which is noise, and trains an operator to
  // ignore exactly the finding that would matter if a file really vanished.
  const { diff: out } = foldGeneratedFiles(section("okf/index.md"), okfOwns);
  assert.match(out, /file a finding saying so and naming/i);
  assert.match(out, /Do NOT report these files as missing or unreviewed/);
  assert.match(out, /not a claim that the files are correct/i);
  assert.match(out, /Review the SOURCES and the GENERATOR/);
});

test("rc.7 fold: nothing undeclared is ever folded", () => {
  // The whole safety property in one line. `ownerOf` is the operator's
  // declaration; a directory that merely looks generated is not.
  const diff = section("okf/index.md") + section("src/generated/api.ts") + section("vendor/lib.js");
  const { diff: out, folded } = foldGeneratedFiles(diff, ownsNothing);
  assert.deepEqual(folded, []);
  assert.equal(out, diff, "with nothing declared this must be byte-for-byte identity");
});

test("rc.7 fold: a hand-written file inside a generated tree is NOT folded", () => {
  // Ownership is per declared path, so a tree can be partly owned. The
  // unowned file keeps its content.
  const ownsModulesOnly = (f) => (f.startsWith("okf/modules/") ? "okf" : null);
  const diff = section("okf/README.md", { added: 3 }) + section("okf/modules/m1.md", { added: 5 });
  const { diff: out, folded } = foldGeneratedFiles(diff, ownsModulesOnly);
  assert.deepEqual(folded.map((f) => f.path), ["okf/modules/m1.md"]);
  assert.ok(out.includes("diff --git a/okf/README.md"));
  assert.ok(out.includes("+new 2"), "the unowned file keeps its hunks");
});

// ---------------------------------------------------------------------------
// The saving it exists for
// ---------------------------------------------------------------------------

test("rc.7 fold: the StitchGuard bundle stops forcing a chunked review", () => {
  // The actual point. 1,663 generated files plus a small feature change is
  // well past the single-chunk ceiling, so the feature gets reviewed in
  // fragments. Folded, it fits in one call and the reviewer sees all of it at
  // once.
  let diff = section("src/feature.ts", { added: 20, removed: 5 });
  for (let i = 0; i < 1663; i++) diff += section(`okf/modules/m${i}.md`, { added: 6, removed: 4 });

  assert.ok(diff.length > DIFF_SINGLE_CHUNK_BYTES, "the fixture has to reproduce the condition");
  assert.ok(splitDiffOnFileBoundaries(diff).length > 1, "and it really would be chunked");

  const { diff: out, folded } = foldGeneratedFiles(diff, okfOwns);
  assert.equal(folded.length, 1663);
  assert.ok(out.length < DIFF_SINGLE_CHUNK_BYTES, "folded, it is a single-pass review");
  assert.equal(splitDiffOnFileBoundaries(out).length, 1, "one chunk, full context for the code that matters");
  assert.ok(out.includes("+new 19"), "and the feature change is still there in full");
});

test("rc.7 fold: a long manifest is capped, and says how many it capped", () => {
  // The manifest cannot itself become the thing that blows the budget, but a
  // silent cut would be the same defect as a silent truncation.
  let diff = "";
  for (let i = 0; i < 500; i++) diff += section(`okf/m${i}.md`);
  const { diff: out, folded } = foldGeneratedFiles(diff, okfOwns);
  assert.equal(folded.length, 500, "all 500 are still REPORTED to the caller for the audit");
  assert.match(out, /500 file\(s\) SUMMARISED/);
  assert.match(out, /\.\.\. and 300 more/);
});

// ---------------------------------------------------------------------------
// Shapes that must not break it
// ---------------------------------------------------------------------------

test("rc.7 fold: a rename is judged on its destination", () => {
  const diff = [
    "diff --git a/okf/old.md b/okf/new.md",
    "similarity index 90%",
    "rename from okf/old.md",
    "rename to okf/new.md",
    "",
  ].join("\n");
  const { folded } = foldGeneratedFiles(diff, (f) => (f === "okf/new.md" ? "okf" : null));
  assert.deepEqual(folded.map((f) => f.path), ["okf/new.md"], "the path that now exists is the one that is owned");
});

test("rc.7 fold: an empty or non-diff input is returned untouched", () => {
  for (const input of ["", "not a diff at all\n", "Binary files differ\n"]) {
    const { diff: out, folded } = foldGeneratedFiles(input, okfOwns);
    assert.equal(out, input);
    assert.deepEqual(folded, []);
  }
});

test("rc.7 fold: two generators are both named", () => {
  const diff = section("okf/index.md") + section("src/generated/api.ts");
  const owner = (f) => (f.startsWith("okf/") ? "okf" : f.startsWith("src/generated/") ? "codegen" : null);
  const { diff: out, folded } = foldGeneratedFiles(diff, owner);
  assert.equal(folded.length, 2);
  assert.match(out, /`npm run okf`, `npm run codegen`/);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("rc.7 fold: it is OFF unless the deployment asks", () => {
  // Default-false is the substance of "this does not weaken the adversary".
  // Pinned in the source because the flag's whole purpose is its default.
  const cfg = readFileSync(join(root, "src", "config.ts"), "utf8");
  assert.match(cfg, /summarise_generated_for_review: false,/, "the shipped default must be false");

  const idx = readFileSync(join(root, "src", "index.ts"), "utf8");
  assert.match(
    idx,
    /if \(config\.verify\?\.summarise_generated_for_review === true\)/,
    "strict === true: an unset or truthy-ish value must not enable it",
  );
});

test("rc.7 fold: the adversary's diff is what gets folded, and the saving is audited", () => {
  const idx = readFileSync(join(root, "src", "index.ts"), "utf8");
  const i = idx.indexOf("runAdversary: async (");
  const j = idx.indexOf("runAdversaryCore", i);
  assert.ok(i >= 0 && j > i);
  const body = idx.slice(i, j);
  assert.ok(body.includes("foldGeneratedFiles"), "folding must happen on the review diff");
  assert.ok(
    body.indexOf("git.diff(") < body.indexOf("foldGeneratedFiles"),
    "fold the real diff; never build the review from a reconstruction",
  );
  assert.ok(body.includes("adversary.generated_output_folded"), "an operator must be able to see the reviewer read less");
  assert.ok(body.includes("bytesBefore") && body.includes("bytesAfter"), "and by how much");
});
