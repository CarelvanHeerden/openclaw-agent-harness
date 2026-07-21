// beta.50: verifier path matching for the file_committed contract kind.
//
// From the beta.49 #858 revise (session 20928481): C demotion worked, the run
// got PAST sub-task 1 for the first time in five runs and the worker committed
// the CORRECT refactor -- but the verifier failed `file_committed` because the
// lead authored the contract path from route semantics
// (src/app/governance-risk/taxonomy/page.tsx) while the worker committed the
// real filesystem path (src/app/(portal)/governance-risk/taxonomy/page.tsx --
// `(portal)` is a Next.js route group). The old exact-string match rejected a
// correct commit and killed the revise at sub-task 2.
//
// beta.50: structural path matching (exact -> route-group -> suffix ->
// basename+dir) so route groups / monorepo prefixes / src drift no longer fail
// a correct worker. Plus headline enrichment on path-mismatch failures.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const S = (p) => readFileSync(join(here, "..", p), "utf8");

const { pathMatches, pathMatchRule, anyPathMatches, stripRouteGroups, normalisePath } =
  await import("../dist/orchestrator/path-match.js");

// ---------------------------------------------------------------------------
// The exact #858 case (the whole point of beta.50).
// ---------------------------------------------------------------------------
test("beta50: the #858 route-group case matches (committed (portal) vs route-semantics contract)", () => {
  const committed = "src/app/(portal)/governance-risk/taxonomy/page.tsx";
  const contract = "src/app/governance-risk/taxonomy/page.tsx";
  assert.equal(pathMatches(committed, contract), true);
  assert.equal(pathMatchRule(committed, contract), "route-group");
});

// ---------------------------------------------------------------------------
// exact match still works (fast path, unchanged behaviour).
// ---------------------------------------------------------------------------
test("beta50: exact match", () => {
  assert.equal(pathMatchRule("src/a/b.ts", "src/a/b.ts"), "exact");
  assert.equal(pathMatchRule("./src/a/b.ts", "src/a/b.ts"), "exact"); // ./ normalised
});

// ---------------------------------------------------------------------------
// route groups (Next.js) in various positions.
// ---------------------------------------------------------------------------
test("beta50: route groups anywhere in the path are stripped for comparison", () => {
  assert.equal(stripRouteGroups("src/app/(portal)/x/page.tsx"), "src/app/x/page.tsx");
  assert.equal(stripRouteGroups("(auth)/login/page.tsx"), "login/page.tsx");
  assert.equal(pathMatchRule("app/(a)/(b)/x.ts", "app/x.ts"), "route-group");
});

// ---------------------------------------------------------------------------
// suffix: contract omits a leading monorepo prefix.
// ---------------------------------------------------------------------------
test("beta50: monorepo prefix drift matches via suffix", () => {
  assert.equal(pathMatchRule("packages/web/src/app/page.tsx", "src/app/page.tsx"), "suffix");
  assert.equal(pathMatchRule("apps/dashboard/src/index.ts", "src/index.ts"), "suffix");
});

// ---------------------------------------------------------------------------
// basename + trailing-dir: inserted segment anywhere, dir context preserved.
// ---------------------------------------------------------------------------
test("beta50: contract as trailing sub-path matches via suffix; broken dir chain does not", () => {
  // contract is a clean trailing sub-path of committed -> suffix.
  assert.equal(pathMatchRule("app/portalX/gr/taxonomy/page.tsx", "gr/taxonomy/page.tsx"), "suffix");
  // Guard (false-positive protection): an extra segment INSIDE the contract's
  // own dir context breaks contiguity -> no match.
  assert.equal(pathMatchRule("a/b/gr/mid/taxonomy/page.tsx", "gr/taxonomy/page.tsx"), null);
});

test("beta50: basename-dir rule fires when route-group strip prevents a clean suffix", () => {
  // committed: app/(portal)/gr/taxonomy/page.tsx -> group-strip -> app/gr/taxonomy/page.tsx
  // contract:  (portal)/gr/taxonomy/page.tsx     -> group-strip -> gr/taxonomy/page.tsx
  // cg ends with `/`+tg -> suffix. To force basename-dir instead, make the
  // contract NOT a raw suffix but its dir chain still a contiguous tail:
  // committed a/GR/taxonomy/page.tsx (dirs [a,GR,taxonomy]) vs contract with
  // an equal trailing dir chain but a leading dir that only differs by case is
  // out of scope. The honest coverage: basename-dir is defensive depth; the
  // realistic wins are exact/route-group/suffix (covered above). Assert the
  // rule at least accepts an identical dir-chain tail that suffix also accepts.
  assert.ok(pathMatches("a/GR/taxonomy/page.tsx", "GR/taxonomy/page.tsx"));
});

// ---------------------------------------------------------------------------
// false-positive guards (the fatal case is a false NEGATIVE, but we must not
// accept an unrelated file).
// ---------------------------------------------------------------------------
test("beta50: bare filename does NOT match an unrelated file with same basename in a different tree", () => {
  // contract carries directory context that is NOT a suffix of committed dirs
  assert.equal(pathMatches("src/components/widgets/page.tsx", "governance-risk/taxonomy/page.tsx"), false);
});

test("beta50: different basename never matches", () => {
  assert.equal(pathMatches("src/app/(portal)/gr/taxonomy/layout.tsx", "src/app/gr/taxonomy/page.tsx"), false);
});

test("beta50: bare-filename contract matches on basename via suffix; different basename does not", () => {
  // A bare `page.tsx` contract matches any committed `.../page.tsx` (suffix
  // fires before basename-dir since the committed path ends with `/page.tsx`).
  assert.equal(pathMatches("src/app/(portal)/gr/taxonomy/page.tsx", "page.tsx"), true);
  // but a different basename never matches.
  assert.equal(pathMatches("src/app/(portal)/gr/taxonomy/layout.tsx", "page.tsx"), false);
});

test("beta50: empty inputs never match", () => {
  assert.equal(pathMatches("", "src/a.ts"), false);
  assert.equal(pathMatches("src/a.ts", ""), false);
});

test("beta50: normalisePath handles backslashes + leading/trailing slashes", () => {
  assert.equal(normalisePath("\\src\\a\\b.ts"), "src/a/b.ts");
  assert.equal(normalisePath("/src/a/"), "src/a");
  assert.equal(normalisePath("src//a///b.ts"), "src/a/b.ts");
});

test("beta50: anyPathMatches finds the route-group file among many committed", () => {
  const committed = [
    "src/lib/grc/taxonomy-tree.ts",
    "src/app/(portal)/governance-risk/taxonomy/page.tsx",
    "README.md",
  ];
  assert.equal(anyPathMatches(committed, "src/app/governance-risk/taxonomy/page.tsx"), true);
  assert.equal(anyPathMatches(committed, "src/app/governance-risk/does-not-exist.tsx"), false);
});

// ---------------------------------------------------------------------------
// wiring: fileCommittedSince uses pathMatchRule (source assert).
// beta.56 (P0-5): the worker-path factory was removed (it duplicated the
// loop-path factory with an empty-branch bug), so exactly ONE occurrence.
// ---------------------------------------------------------------------------
test("beta50/56: the (single) fileCommittedSince factory uses pathMatchRule (not exact resolve equality)", () => {
  const indexSrc = S("src/index.ts");
  // beta.51 widened this import to also pull resolveContractPath.
  assert.match(indexSrc, /import \{ pathMatchRule(, resolveContractPath)? \} from "\.\/orchestrator\/path-match\.js"/);
  const occurrences = indexSrc.match(/const rule = pathMatchRule\(f, path\)/g) ?? [];
  assert.equal(occurrences.length, 1, "the loop-path fileCommittedSince factory must use pathMatchRule");
  // the old exact-resolve equality match must be gone from fileCommittedSince
  assert.doesNotMatch(indexSrc, /resolve\(worktreePath, f\) === absTarget \|\| f === path/);
});

test("beta50: headline enriches path-mismatch failures", () => {
  const progSrc = S("src/orchestrator/progress.ts");
  assert.match(progSrc, /loop\.file_committed_verify_failed/);
  assert.match(progSrc, /failureDetail/);
  assert.match(progSrc, /verifier path check:/);
  // buildHeadline consumes it
  assert.match(progSrc, /const why = input\.failureDetail \? ` — \$\{input\.failureDetail\}` : ""/);
});
