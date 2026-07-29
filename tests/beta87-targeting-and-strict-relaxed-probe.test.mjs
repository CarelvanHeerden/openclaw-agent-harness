/**
 * beta.87 — three issues from Staging's beta.85 DEEP-DIVE that survived beta.86,
 * closed before the smoke.
 *
 * [1] LLM `finding.file` over-targeting: beta.86's bidirectional bare-basename
 *     match meant an adversary `file:"route.ts"` (bare) force-strictened EVERY
 *     `route.ts` sibling -> re-created the 696226e4 false-fail on the file the
 *     worker correctly left alone. Fix: STRUCTURAL targeting only
 *     (resolveContractPath strictContract) -- a bare basename cannot target a
 *     more-specific sibling.
 * [2] Review-wide targeted set applied per sub-task: when reviseSpecApplied, use
 *     THIS sub-task's workerContext (filesLikelyTouched + codeExcerpts[].path)
 *     instead of the review-wide findings.
 * [3] fileCommittedInBranch used allowBasenameFallback (the fuzzy matcher
 *     beta.84 hardened away). Fix: strictContract on the relaxed probe too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const readSrc = (rel) => readFileSync(join(ROOT, rel), "utf8");

let resolveContractPath;
try {
  ({ resolveContractPath } = await import("../dist/orchestrator/path-match.js"));
} catch {
  resolveContractPath = null;
}
const skip = { skip: resolveContractPath === null };

const ROUTE = "src/app/api/grc/continuity-exercises/[id]/files/[fileId]/route.ts";
const DOWNLOAD = "src/app/api/grc/continuity-exercises/[id]/files/[fileId]/download/route.ts";

test("beta.87: version >= beta.87", () => {
  const betaNum = (v) => parseInt(/beta\.(\d+)/.exec(v)?.[1] ?? "0", 10);
  assert.ok(betaNum(JSON.parse(readSrc("package.json")).version) >= 87);
});

// [1] — the isTargeted semantics (structural via resolveContractPath). This is
// exactly the predicate the loop now uses: resolveContractPath(targeted, p, strict).
test("beta.87 [1]: a bare-basename finding does NOT target a more-specific sibling", skip, () => {
  // adversary wrote bare `route.ts` (meaning download/route.ts). It must NOT
  // force-target the base route.ts's sibling download/route.ts.
  const targeted = ["route.ts"];
  // download/route.ts is NOT structurally matched by a bare `route.ts`
  assert.equal(resolveContractPath(targeted, DOWNLOAD, { strictContract: true }), null,
    "bare basename must not structurally target the dir'd sibling -> it relaxes");
  // the base route.ts (bare-equal) DOES match exactly -> targeted (stays strict)
  assert.ok(resolveContractPath(targeted, "route.ts", { strictContract: true }),
    "an exact bare match still targets the bare contract path");
});

test("beta.87 [1]: a properly-pathed finding targets its file (and not the sibling)", skip, () => {
  const targeted = [DOWNLOAD]; // adversary named the full path
  assert.ok(resolveContractPath(targeted, DOWNLOAD, { strictContract: true }), "exact path targets itself");
  assert.equal(resolveContractPath(targeted, ROUTE, { strictContract: true }), null,
    "the sibling base route.ts is NOT targeted -> relaxes (worker may leave it alone)");
});

// ---- wiring source-asserts ----

test("beta.87 [1]: loop targets structurally via resolveContractPath strictContract (no bidirectional fuzzy)", () => {
  const src = readSrc("src/orchestrator/loop.ts");
  assert.ok(
    /const isTargeted = \(p: string\): boolean =>\s*\n?\s*!!resolveContractPath\(targetedFiles, p, \{ strictContract: true \}\)/.test(src),
    "isTargeted must use resolveContractPath strictContract",
  );
  // the old bidirectional bare-basename match must be gone
  assert.ok(!/pathMatches\(tf, p\) \|\| pathMatches\(p, tf\)/.test(src), "bidirectional bare-basename match removed");
});

test("beta.87 [2]: targeted set is per-sub-task when reviseSpecApplied (workerContext), review-wide fallback otherwise", () => {
  const src = readSrc("src/orchestrator/loop.ts");
  assert.ok(/reviseSpecApplied\s*\?\s*\[/.test(src), "per-sub-task branch gated on reviseSpecApplied");
  assert.ok(/st\.filesLikelyTouched/.test(src) && /st\.workerContext\?\.codeExcerpts/.test(src),
    "per-sub-task files derived from filesLikelyTouched + codeExcerpts");
  assert.ok(/perSubTaskFiles\.length > 0 \? perSubTaskFiles : reviewFindingFiles/.test(src),
    "falls back to review-wide findings when no per-sub-task signal");
});

test("beta.87 [3]: fileCommittedInBranch uses strictContract (no basename fuzzy on the relaxed probe)", () => {
  const src = readSrc("src/index.ts");
  const block = src.slice(src.indexOf("fileCommittedInBranch: async"), src.indexOf("fileCommittedInBranch: async") + 900);
  assert.ok(/resolveContractPath\(files, path, \{ strictContract: true \}\)/.test(block),
    "fileCommittedInBranch must resolve strictContract");
  assert.ok(!/allowBasenameFallback/.test(block), "no basename fallback on the relaxed probe");
});
