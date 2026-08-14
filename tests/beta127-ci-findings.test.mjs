// beta.127 — turning a job log into findings a worker can act on.
//
// Two things had to be true before a red build could buy a repair cycle, and
// neither was true in b126:
//
//   1. The excerpt has to contain the failing assertion. b126 wrote
//      "(no log excerpt available)" onto the PR. Verified against
//      Stitch-Vercel/ProjectThanos@1dd2fcb1 with a token that CAN read
//      check-runs: the whole excerpt was the 17 characters "- Tests [failure]".
//   2. The finding has to survive classification. Every bucket in
//      classifyFinding matches on keywords in the finding text, and a CI
//      finding's text is a raw job log -- so a jest failure that happens to
//      say "Cannot find module" would be filed as `env` and stop blocking.
import test from "node:test";
import assert from "node:assert/strict";
import { buildCiFailureFindings, describeCiFindings } from "../dist/orchestrator/ci-findings.js";
import { extractFailureExcerpt } from "../dist/adapters/github.js";
import { classifyFinding, isBlockingFinding } from "../dist/orchestrator/finding-classify.js";

// Verbatim from the b126 smoke, via the Actions jobs API.
const REAL = `Summary of all failing tests
FAIL src/__tests__/components/sidebar-nav-placement.test.ts
  ● InfoSec GRC ordering › groups the AI system register with the other inventories
    expect(received).toBe(expected) // Object.is equality
    Expected: 2
    Received: 3
      at Object.<anonymous> (src/__tests__/components/sidebar-nav-placement.test.ts:87:61)
FAIL src/__tests__/api/grc/continuity-exercises.test.ts
  ● POST /api/grc/continuity-exercises › creates a metadata-only exercise and returns 201 { data }
    expect(received).toEqual(expected) // deep equality
    -   "performedAt": 2026-08-01T00:00:00.000Z,
    +   "performedAt": "2026-08-01T00:00:00.000Z",
      at Object.<anonymous> (src/__tests__/api/grc/continuity-exercises.test.ts:152:23)
Test Suites: 2 failed, 1 skipped, 623 passed, 625 of 626 total
Tests:       2 failed, 1 skipped, 8833 passed, 8836 total`;

test("the two real b126 failures become two routable findings", () => {
  const fs = buildCiFailureFindings(REAL, { sha: "1dd2fcb11780f025e9b02466b38c60af19a71535" });
  assert.equal(fs.length, 2);
  assert.deepEqual(
    fs.map((f) => f.file),
    ["src/__tests__/components/sidebar-nav-placement.test.ts", "src/__tests__/api/grc/continuity-exercises.test.ts"],
  );
  // The test NAME is what makes two findings on one file distinguishable, and
  // what makes a finding recognisable as the same one next cycle.
  assert.match(fs[0].title, /groups the AI system register/);
  // The assertion itself, not a summary of it: the worker has to see that the
  // expectation was 2 and the reality was 3.
  assert.match(fs[0].detail, /Expected: 2/);
  assert.match(fs[1].detail, /performedAt/);
});

test("jest's epilogue is not mistaken for a failure", () => {
  const fs = buildCiFailureFindings(REAL);
  assert.ok(fs.every((f) => !/Test Suites:|8836/.test(f.title)));
});

test("every CI finding is blocking, whatever words are in the log", () => {
  // The trap this guards. Each of these logs contains a phrase that routes to a
  // NON-blocking bucket -- `env` for a missing module, `process` for anything
  // mentioning regeneration. Without the source short-circuit the run would
  // ship over a red build, and only on the failures unlucky enough to be
  // worded this way, which is the worst possible way for it to be wrong.
  for (const log of [
    "FAIL src/a.test.ts\n  ● boom\n    Cannot find module './missing'",
    "FAIL src/b.test.ts\n  ● boom\n    the okf bundle is stale, run npm run okf to regenerate",
    "FAIL src/c.test.ts\n  ● boom\n    Error: exited 127: eslint: not found",
  ]) {
    const [f] = buildCiFailureFindings(log);
    const cls = classifyFinding(f, { repoHasTestScript: true });
    assert.equal(cls, "diff_addressable", `should not be downgraded: ${log.slice(0, 40)}`);
    assert.equal(isBlockingFinding(f, cls), true);
  }
});

test("a finding the adversary raised is still classified on its merits", () => {
  // The short-circuit is keyed on `source`, so it must not leak to normal
  // findings -- an adversary complaint about a stale bundle is still `process`.
  const f = {
    dimension: "quality", severity: "high",
    title: "the okf bundle is stale", detail: "run npm run okf to regenerate", file: "a.ts",
  };
  assert.equal(classifyFinding(f, { repoHasTestScript: true }), "process");
});

test("an unrecognised runner still produces one blocking, unrouted finding", () => {
  // Broadcast is the right failure mode here: a red build is a property of the
  // whole branch, and showing it to everyone beats routing it confidently to
  // the wrong owner.
  const fs = buildCiFailureFindings("error: build failed with exit code 1\nsomething went wrong");
  assert.equal(fs.length, 1);
  assert.equal(fs[0].file, null);
  assert.equal(isBlockingFinding(fs[0], classifyFinding(fs[0])), true);
});

test("an empty log produces nothing, so no cycle can be bought on no evidence", () => {
  assert.deepEqual(buildCiFailureFindings(""), []);
  assert.deepEqual(buildCiFailureFindings("   \n  "), []);
});

test("a catastrophic red build is capped and summarised rather than flooding a cycle", () => {
  const many = Array.from({ length: 20 }, (_, i) => `FAIL src/t${i}.test.ts\n  ● case ${i}\n    boom`).join("\n");
  const fs = buildCiFailureFindings(many, { maxFindings: 6 });
  assert.equal(fs.length, 7, "6 itemised + 1 summary");
  assert.match(fs.at(-1).title, /20 failing test files/);
  assert.match(fs.at(-1).detail, /one shared cause/);
});

test("the worker is told not to make the test pass by deleting it", () => {
  const [f] = buildCiFailureFindings(REAL);
  assert.match(f.detail, /do not\s+delete, skip or weaken/i);
});

test("source files named in a failure are offered for co-fix routing", () => {
  const [f] = buildCiFailureFindings(
    "FAIL src/__tests__/nav.test.ts\n  ● order\n    at src/components/ui/sidebar.tsx:42:1\n    expected 2",
  );
  assert.equal(f.file, "src/__tests__/nav.test.ts");
  assert.deepEqual(f.relatedFiles, ["src/components/ui/sidebar.tsx"]);
});

test("describeCiFindings says what was found without dumping the log", () => {
  assert.match(describeCiFindings(buildCiFailureFindings(REAL)), /2 CI finding\(s\) across 2 file\(s\)/);
  assert.equal(describeCiFindings([]), "no CI findings");
});

// ---------------------------------------------------------------- log excerpt

test("GitHub's timestamps and ANSI colour are stripped", () => {
  // Both matter: the timestamp prefix pushes the real text off any width-based
  // truncation, and the colour codes sit between a path and its extension,
  // which is enough to hide the path from a path matcher.
  const raw =
    "2026-08-13T17:47:16.4189037Z \u001b[1mSummary of all failing tests\u001b[22m\n" +
    "2026-08-13T17:47:16.4190000Z \u001b[31mFAIL\u001b[0m src/a.test.ts\n" +
    "2026-08-13T17:47:16.4191000Z   \u001b[31m●\u001b[0m boom";
  const out = extractFailureExcerpt(raw);
  assert.doesNotMatch(out, /2026-08-13T17/);
  assert.doesNotMatch(out, /\u001b\[/);
  assert.match(out, /^Summary of all failing tests/);
  // And the cleaned text has to survive the round trip into a routable finding.
  assert.equal(buildCiFailureFindings(out)[0].file, "src/a.test.ts");
});

test("the failure summary wins over the tail of the log", () => {
  const raw = ["noise", "Summary of all failing tests", "FAIL src/a.test.ts", "  ● boom", ...Array(200).fill("trailing noise")].join("\n");
  const out = extractFailureExcerpt(raw);
  assert.match(out, /^Summary of all failing tests/);
});

test("a log with no summary falls back to the lines marked as errors", () => {
  const raw = ["setup ok", "##[error]Process completed with exit code 1", "more noise"].join("\n");
  assert.match(extractFailureExcerpt(raw), /##\[error\]Process completed/);
});

test("a log with neither falls back to the tail rather than to nothing", () => {
  const raw = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const out = extractFailureExcerpt(raw);
  assert.match(out, /line 99/);
  assert.doesNotMatch(out, /line 0\b/);
});

test("an empty log stays empty rather than becoming a fake excerpt", () => {
  assert.equal(extractFailureExcerpt(""), "");
});
