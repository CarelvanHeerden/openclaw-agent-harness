// beta.51: apply the beta.50 structural path matcher to ALL path-resolving
// verifiers, not just file_committed.
//
// From the beta.50 #858 revise (session 6b7106b9): beta.50's route-group
// matcher WORKED -- file_committed passed on sub-tasks 2+3 via structural
// match, and the run got through sub-tasks 1-3 with real commits. It died at
// seq 4 because `file_written` used a DIFFERENT probe (fileWrittenSince /
// fileExistsOnDisk) still on exact resolve() equality: it stat'd the literal
// brief path (app/governance-risk/taxonomy/page.tsx) which ENOENT'd against
// the real src/app/(portal)/governance-risk/taxonomy/page.tsx. Same route-group
// + src-prefix drift, different verifier kind. beta.50 fixed one of two
// path-resolving verifiers (same lesson as beta.10: loop-path + worker-path
// probe factories must move together -- here it's file_committed vs
// file_written moving together).
//
// beta.51: shared resolveContractPath() resolves a contract path to the REAL
// changed/committed file across file_written, file_exists, file_committed, and
// file_in_pr.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");

const { resolveContractPath, anyPathMatches } = await import("../dist/orchestrator/path-match.js");

// ---------------------------------------------------------------------------
// resolveContractPath: the seq-4 case + rule preference.
// ---------------------------------------------------------------------------
test("beta51: the #858 seq-4 case resolves to the real (portal) file", () => {
  const changed = [
    "src/lib/grc/taxonomy-tree.ts",
    "src/app/(portal)/governance-risk/taxonomy/page.tsx",
  ];
  const m = resolveContractPath(changed, "src/app/governance-risk/taxonomy/page.tsx");
  assert.ok(m);
  assert.equal(m.file, "src/app/(portal)/governance-risk/taxonomy/page.tsx");
  assert.equal(m.rule, "route-group");
});

test("beta51: also resolves a bare app/ contract path (src-prefix + route-group drift)", () => {
  const changed = ["src/app/(portal)/governance-risk/taxonomy/page.tsx"];
  const m = resolveContractPath(changed, "app/governance-risk/taxonomy/page.tsx");
  assert.ok(m, "should resolve app/... contract to src/app/(portal)/... real file");
  // src/ prefix omitted + route group -> suffix after group-strip
  assert.ok(["route-group", "suffix"].includes(m.rule), `unexpected rule ${m?.rule}`);
});

test("beta51: exact match is preferred and returned immediately", () => {
  const changed = ["a/b.ts", "src/app/(x)/b.ts", "src/app/b.ts"];
  const m = resolveContractPath(changed, "src/app/b.ts");
  assert.ok(m);
  assert.equal(m.rule, "exact");
  assert.equal(m.file, "src/app/b.ts");
});

test("beta51: prefers stricter rule when multiple match (route-group over basename)", () => {
  const changed = [
    "totally/unrelated/page.tsx", // basename-only would match
    "src/app/(portal)/gr/tax/page.tsx", // route-group match for the contract
  ];
  const m = resolveContractPath(changed, "src/app/gr/tax/page.tsx");
  assert.ok(m);
  assert.equal(m.file, "src/app/(portal)/gr/tax/page.tsx");
  assert.equal(m.rule, "route-group");
});

test("beta51: no match returns null", () => {
  assert.equal(resolveContractPath(["src/x/y.ts"], "src/a/b/c/other.tsx"), null);
  assert.equal(resolveContractPath([], "src/a.ts"), null);
});

// ---------------------------------------------------------------------------
// Wiring: every path-resolving verifier uses the shared matcher.
// ---------------------------------------------------------------------------
test("beta51/59: index.ts imports resolveContractPath (pathMatchRule no longer used directly)", () => {
  const src = S("src/index.ts");
  assert.match(src, /import \{ resolveContractPath \} from "\.\/orchestrator\/path-match\.js"/);
});

// beta.56 (P0-5): the worker-path probe factory was REMOVED (it duplicated
// the loop-path factory with an empty-branch context bug and bypassed the
// retry/clarification machinery by pre-failing results). The loop-path
// factory is now the single verification site, so exactly ONE occurrence of
// each structural-matching pattern is correct.
test("beta51/56/59: the (single) fileWrittenSince factory resolves via resolveContractPath with basename fallback", () => {
  const src = S("src/index.ts");
  const uses = src.match(/resolveContractPath\(changed, path, \{ allowBasenameFallback: true \}\)/g) ?? [];
  assert.equal(uses.length, 1, `exactly one fileWrittenSince factory must use resolveContractPath+fallback (found ${uses.length})`);
  // the old exact-equality diff match must be gone
  assert.doesNotMatch(src, /changed\.some\(\(f\) => resolve\(worktreePath, f\) === abs\)/);
});

test("beta51/56/59: the (single) fileExistsOnDisk factory has a structural committed-file fallback (with basename fallback)", () => {
  const src = S("src/index.ts");
  const fallbacks = src.match(/resolveContractPath\(committed, path, \{ allowBasenameFallback: true \}\)/g) ?? [];
  assert.equal(fallbacks.length, 1, `exactly one fileExistsOnDisk factory needs the committed-file fallback (found ${fallbacks.length})`);
});

test("beta51/56/59: fileCommittedSince resolves via resolveContractPath (no longer a hand-rolled pathMatchRule loop)", () => {
  const src = S("src/index.ts");
  assert.match(src, /resolveContractPath\(files, path, \{ allowBasenameFallback: true \}\)/);
  // the old hand-rolled loop must be gone
  assert.doesNotMatch(src, /const rule = pathMatchRule\(f, path\)/);
});

test("beta51: file_in_pr uses anyPathMatches (route-group tolerant PR file match)", () => {
  const src = S("src/orchestrator/verify.ts");
  assert.match(src, /import \{ anyPathMatches \} from "\.\/path-match\.js"/);
  const uses = src.match(/anyPathMatches\(r\.files\.map\(\(f\) => f\.filename\), v\.path\)/g) ?? [];
  assert.equal(uses.length, 2, "both file_in_pr branches must use anyPathMatches");
  // old exact/endsWith match gone
  assert.doesNotMatch(src, /f\.filename === v\.path \|\| f\.filename\.endsWith/);
});

// ---------------------------------------------------------------------------
// anyPathMatches sanity for the PR-file case.
// ---------------------------------------------------------------------------
test("beta51: anyPathMatches finds the route-group file in a PR file list", () => {
  const prFiles = ["src/app/(portal)/governance-risk/taxonomy/page.tsx", "README.md"];
  assert.equal(anyPathMatches(prFiles, "src/app/governance-risk/taxonomy/page.tsx"), true);
  assert.equal(anyPathMatches(prFiles, "src/app/governance-risk/nope.tsx"), false);
});
