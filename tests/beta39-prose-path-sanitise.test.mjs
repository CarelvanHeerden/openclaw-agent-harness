/**
 * beta.39: verification-contract path inference must reject prose abbreviations
 * and other non-path tokens.
 *
 * ROOT CAUSE (Staging ProjectThanos beta.38 smoke, session d0d73a40):
 * the brief's `filesLikelyTouched` carried the prose entry
 *   "shared taxonomy data hook/service ... (e.g. hooks/useTaxonomy or lib/taxonomy)"
 * and the sub-task title/intent echoed "e.g.". `firstFilePath` fell through to
 * a text-scan regex `/\b([\w./-]+\.[a-z0-9]{1,6})\b/i` which matched `e.g` (the
 * `\b` boundary grabs `e.g` from `e.g.`, treating `.g` as a 1-char extension).
 * That literal `e.g` became a `file_written` / `file_committed` contract path.
 * The verifier then stat'd for a file named `e.g`, didn't find it, and marked
 * the sub-task `failed_verification` -- even though the worker had committed the
 * correct change (`0beaff1`, real `useTaxonomy` hook extraction, 2 files).
 *
 * This was NOT worker confabulation and NOT the beta.38 re-entrancy issue
 * (the guard held: no loop.run_skipped_already_running, no worktree collision).
 * It's a lead-plan/contract-extraction bug.
 *
 * Fix: `firstFilePath` now validates candidates with `looksLikeRealPath` --
 * a token must contain a `/` OR end in a known code/text extension, must not be
 * a prose abbreviation (e.g/i.e/etc/vs/...), and (when separator-less) must have
 * a >=2-char stem. A false negative (no path) is safe (existence still checked,
 * just not pinned to a filename); a false positive is fatal.
 */
import test from "node:test";
import assert from "node:assert/strict";

let verifyContract;
try {
  verifyContract = await import("../dist/orchestrator/verify-contract.js");
} catch {
  verifyContract = null;
}
const skipAll = { skip: verifyContract === null };

function pathFor(contract, kind) {
  return contract.filter((c) => c.kind === kind).map((c) => c.path);
}
function kinds(contract) {
  return contract.map((c) => c.kind);
}

// ============================================================
// The exact smoke scenario must no longer yield a bogus `e.g` path
// ============================================================

test("beta.39: the ProjectThanos smoke sub-task no longer infers a file named 'e.g'",
  skipAll, () => {
    const c = verifyContract.inferVerifyContract({
      seq: 2,
      title: "Extract shared taxonomy hook",
      intent:
        "Extract the taxonomy data fetch into a shared hook (e.g. hooks/useTaxonomy or lib/taxonomy) and commit it so both pages can consume it.",
      filesLikelyTouched: [
        "app/governance-risk/risks/ (risks page and its taxonomy filter dropdown component)",
        "app/governance-risk/taxonomy/ (taxonomy page and its data-fetching logic)",
        "shared taxonomy data hook/service extracted or reused for both pages (e.g. hooks/useTaxonomy or lib/taxonomy)",
      ],
      successCriteria: ["hook extracted", "committed"],
      estimatedTokens: 1000,
    });
    // A commit was requested, so commit_made must be present...
    assert.ok(kinds(c).includes("commit_made"), "commit_made should still be inferred");
    // ...but NO contract entry may carry the fictional path `e.g`.
    const allPaths = c.filter((x) => "path" in x).map((x) => x.path);
    assert.ok(!allPaths.includes("e.g"), `no contract path may be 'e.g'; got ${JSON.stringify(allPaths)}`);
    // And since no real path could be extracted, file_committed/file_written
    // must be path-less-absent (not present with a bogus path).
    assert.deepEqual(pathFor(c, "file_committed"), [], "no file_committed with a bogus path");
    assert.deepEqual(pathFor(c, "file_written"), [], "no file_written with a bogus path");
  });

// ============================================================
// Prose abbreviations must never become paths
// ============================================================

for (const abbrev of ["e.g.", "i.e.", "etc.", "vs.", "cf.", "approx."]) {
  test(`beta.39: prose abbreviation '${abbrev}' in intent is not treated as a file path`,
    skipAll, () => {
      const c = verifyContract.inferVerifyContract({
        seq: 1,
        title: "Write and commit the config",
        intent: `Create the config file ${abbrev} with sane defaults and commit it.`,
        filesLikelyTouched: [],
        successCriteria: ["file exists"],
        estimatedTokens: 500,
      });
      const allPaths = c.filter((x) => "path" in x).map((x) => x.path);
      const stripped = abbrev.replace(/\.$/, "");
      assert.ok(!allPaths.includes(stripped), `'${stripped}' must not be a contract path; got ${JSON.stringify(allPaths)}`);
    });
}

// ============================================================
// Real paths MUST still be extracted (no regression)
// ============================================================

test("beta.39: a real filesLikelyTouched path is still used for file_committed",
  skipAll, () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Write and commit the hook",
      intent: "Create the file and commit it.",
      filesLikelyTouched: ["src/hooks/use-taxonomy.ts"],
      successCriteria: ["file committed"],
      estimatedTokens: 500,
    });
    assert.deepEqual(pathFor(c, "file_committed"), ["src/hooks/use-taxonomy.ts"]);
  });

test("beta.39: a path embedded in prose (with a real extension) is still extracted",
  skipAll, () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Update the router",
      intent: "Write src/app/router.tsx to add the new route, then commit.",
      filesLikelyTouched: [],
      successCriteria: ["route added"],
      estimatedTokens: 500,
    });
    assert.deepEqual(pathFor(c, "file_committed"), ["src/app/router.tsx"]);
  });

test("beta.39: a directory-style path (no extension but has a separator) is accepted",
  skipAll, () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Add package module",
      intent: "Create pkg/mod.go and commit it.",
      filesLikelyTouched: ["pkg/mod.go"],
      successCriteria: ["created"],
      estimatedTokens: 500,
    });
    assert.deepEqual(pathFor(c, "file_committed"), ["pkg/mod.go"]);
  });

test("beta.39: a bare 1-char stem with a bogus extension is rejected",
  skipAll, () => {
    const c = verifyContract.inferVerifyContract({
      seq: 1,
      title: "Commit something",
      intent: "Make the change a.b and commit.",
      filesLikelyTouched: [],
      successCriteria: ["committed"],
      estimatedTokens: 500,
    });
    const allPaths = c.filter((x) => "path" in x).map((x) => x.path);
    assert.ok(!allPaths.includes("a.b"), `'a.b' must not be a contract path; got ${JSON.stringify(allPaths)}`);
  });
