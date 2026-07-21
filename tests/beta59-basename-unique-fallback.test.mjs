// beta.59 — basename-unique fallback for verifier contract paths.
//
// b55-drop10 #858 (session 1db243c1) reached seq 4/7 with real commits landed
// (ff8e059, 7ae6093, aba600d), then FAILED verification on seq 4 despite a
// correct, committed change. Root cause: the lead bakes contract paths from the
// crystallised brief's STALE filesLikelyTouched hints before the observe probe
// runs. seq 4's contract was `components/governance-risk/risks/taxonomy-filter-
// dropdown.tsx`, but the worker committed the real path
// `src/components/grc/taxonomy-filter-dropdown.tsx`. Different directory
// TOPOLOGY (grc vs governance-risk/risks) -> exact/route-group/suffix/basename-
// dir ALL miss (no common trailing path). A correct commit failed the check.
//
// Fix: resolveContractPath gains an opt-in BASENAME-UNIQUE last-resort rule.
// Safe ONLY because the callers that enable it (fileWrittenSince,
// fileCommittedSince, fileExistsOnDisk-committed-fallback) pass a PER-SUB-TASK-
// scoped file list (git log/diff since the sub-task's worker-session-start
// SHA) -- so a lone same-basename file in that tiny set is the file this
// sub-task just wrote. Ambiguous (>1) basename collision falls through to a
// real failure. Repo-wide callers (file_in_pr via anyPathMatches) never enable
// it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const S = (p) => readFileSync(join(root, p), "utf8");

const { resolveContractPath, pathMatchRule, anyPathMatches } = await import("../dist/orchestrator/path-match.js");

const CONTRACT = "components/governance-risk/risks/taxonomy-filter-dropdown.tsx";
const REAL = "src/components/grc/taxonomy-filter-dropdown.tsx";

test("beta.59: the exact seq-4 topology drift is NOT bridged by the structural rules", () => {
  // sanity: prove the old rules genuinely miss (this is why the fallback is needed)
  assert.equal(pathMatchRule(REAL, CONTRACT), null, "no exact/route-group/suffix/basename-dir relation");
  assert.equal(resolveContractPath([REAL], CONTRACT), null, "without the fallback flag, still no match");
});

test("beta.59: basename-unique fallback resolves the seq-4 case when enabled + candidate is unique", () => {
  const m = resolveContractPath([REAL], CONTRACT, { allowBasenameFallback: true });
  assert.ok(m, "resolved");
  assert.equal(m.file, REAL);
  assert.equal(m.rule, "basename-unique");
});

test("beta.59: basename-unique fallback resolves within a small per-sub-task diff", () => {
  // realistic per-sub-task diff: the sub-task committed exactly one file
  const diff = [REAL];
  const m = resolveContractPath(diff, CONTRACT, { allowBasenameFallback: true });
  assert.equal(m?.file, REAL);
  assert.equal(m?.rule, "basename-unique");
});

test("beta.59: AMBIGUOUS basename collision falls through to a real failure (no guessing)", () => {
  const files = [
    "src/components/grc/taxonomy-filter-dropdown.tsx",
    "src/components/legacy/taxonomy-filter-dropdown.tsx",
  ];
  const m = resolveContractPath(files, CONTRACT, { allowBasenameFallback: true });
  assert.equal(m, null, "two same-basename candidates -> null, not a guess");
});

test("beta.59: bare-filename contract resolves via the pre-existing SUFFIX rule, not the fallback", () => {
  // A bare filename always ends the committed path, so `suffix` handles it and
  // the basename-unique fallback (dir-context-gated) is never reached. This
  // documents that the fallback is strictly additive for the topology-drift
  // case where dir context EXISTS but doesn't line up.
  const m = resolveContractPath(["src/a/foo.tsx"], "foo.tsx", { allowBasenameFallback: true });
  assert.equal(m?.rule, "suffix", "bare filename handled by suffix, not basename-unique");
  // And the fallback's own dir-context guard: a dir-context contract that
  // structurally misses IS what the fallback exists for.
  const drift = resolveContractPath(["src/components/grc/x.tsx"], "components/foo/bar/x.tsx", { allowBasenameFallback: true });
  assert.equal(drift?.rule, "basename-unique");
});

test("beta.59: fallback is OFF by default (no behaviour change for callers that don't opt in)", () => {
  assert.equal(resolveContractPath([REAL], CONTRACT), null);
  assert.equal(resolveContractPath([REAL], CONTRACT, {}), null);
});

test("beta.59: structural rules still WIN over the fallback (prefers real relation)", () => {
  // seq 3 case: suffix match must still be chosen, not basename-unique.
  const contract = "app/governance-risk/taxonomy/page.tsx";
  const real = "src/app/(portal)/governance-risk/taxonomy/page.tsx";
  const m = resolveContractPath([real], contract, { allowBasenameFallback: true });
  assert.ok(m);
  assert.equal(m.rule, "suffix", "suffix wins; fallback only fires when structural rules all miss");
});

test("beta.59: exact match short-circuits, fallback never consulted", () => {
  const m = resolveContractPath([REAL], REAL, { allowBasenameFallback: true });
  assert.equal(m?.rule, "exact");
});

// ---- wiring / safety-boundary source assertions ----
test("beta.59 wiring: the three per-sub-task probes opt into the fallback", () => {
  const idx = S("src/index.ts");
  // count occurrences of allowBasenameFallback: true (fileWritten, fileExists-fallback, fileCommitted)
  const n = (idx.match(/allowBasenameFallback:\s*true/g) ?? []).length;
  assert.ok(n >= 3, `expected >=3 opt-in call sites, found ${n}`);
  // fileCommittedSince now routes through resolveContractPath (no hand-rolled loop)
  assert.match(idx, /resolveContractPath\(files, path, \{ allowBasenameFallback: true \}\)/);
});

test("beta.59 safety: file_in_pr uses repo-wide anyPathMatches, which NEVER enables the fallback", () => {
  const verify = S("src/orchestrator/verify.ts");
  assert.match(verify, /anyPathMatches\(r\.files/);
  // anyPathMatches must not thread the fallback flag (it's a repo-wide PR file list)
  assert.doesNotMatch(verify, /allowBasenameFallback/);
  // and anyPathMatches itself doesn't take/forward the option
  const pm = S("src/orchestrator/path-match.ts");
  assert.match(pm, /export function anyPathMatches\(committedFiles: string\[\], contract: string\)/);
});
