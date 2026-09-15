/**
 * beta.76 (Option 1 -- "the real cure"): contract-path RE-DERIVATION.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every path-match heuristic shipped since beta.50 (route-group, suffix,
 * basename-dir, basename-unique, test-file-unique) is a WORKAROUND for a single
 * root defect: the lead authors a sub-task's contract path (via `verify` or
 * `filesLikelyTouched`) as a GUESS, BEFORE the observe probe has discovered the
 * repo's real layout. When the guess drifts from the worker's real committed
 * path, the verifier false-fails a correct commit -- and we patch it with one
 * more tolerant match rule. That is whack-a-mole: there is always one more path
 * shape, and each new repo (Rust, Django, monorepo) re-opens the class.
 *
 * Carel's concern (2026-07-27): "all these edge cases are becoming specific to
 * the project. What happens when we dev against another repo?" The rules are
 * generic, but the reactive discover-one-at-a-time loop is not the cure.
 *
 * THE CURE
 * --------
 * Stop verifying against the lead's stale guess. As the run proceeds, the files
 * the workers ACTUALLY touch are GROUND TRUTH for the repo's real directory
 * conventions. Learn a small set of directory-prefix REMAPPINGS from those real
 * paths, then rewrite a downstream sub-task's stale contract path THROUGH those
 * remappings before it is verified. The verifier then compares against a
 * reality-corrected path instead of a pre-probe guess -- so drift is corrected
 * at the source, and the match rules become a rarely-needed backstop.
 *
 * MECHANISM (bounded + repo-agnostic + false-positive-safe)
 * ---------------------------------------------------------
 * A remapping is learned ONLY from empirical evidence: a real touched file
 * whose path shares a trailing directory chain (>=1 segment) with a stale
 * contract path, but under a DIFFERENT leading prefix. e.g.
 *
 *   stale contract dir : tests/api/grc
 *   real touched file  : src/__tests__/api/grc/evidence-fileurl-validation.test.ts
 *   shared tail        : api/grc
 *   learned remap      : tests/  ->  src/__tests__/   (for the api/grc subtree)
 *
 * We only ever remap the LEADING prefix up to the shared tail; the tail + the
 * basename the lead specified are preserved (or, for the test-file case, the
 * basename is left to the downstream test-file-unique rule). A remap requires a
 * NON-empty shared tail so we never collapse two unrelated trees. When no
 * remapping applies, the path is returned UNCHANGED -- re-derivation never
 * makes verification stricter, only more accurate.
 *
 * This module is PURE (no fs/git) so it is unit-testable and cannot itself
 * false-green anything: it only produces a corrected candidate path that the
 * real probes still have to satisfy.
 *
 * beta.93 (false-positive cure -- session de0cba9f)
 * -------------------------------------------------
 * beta.76's aggressive prefix-remapper mis-fired: it learned a
 * `src/components -> src/lib` remap from ONE sub-task's touched file
 * (`src/lib/grc/continuity-exercises.ts`) and applied it to a DIFFERENT,
 * already-correct contract (`src/components/grc/poi-attachment-upload.tsx`)
 * purely because both share the trailing dir `grc`. The worker had committed
 * that file at EXACTLY its declared path, yet re-derivation moved the goalpost
 * to a non-existent `src/lib/...` path and the strict file_committed check then
 * false-failed a correct commit as "confabulation". Two generic (repo-agnostic)
 * invariants close this whole class:
 *
 *   GUARD (a) -- exact-match short-circuit. If the contract path is ALREADY one
 *     of the real touched files, the worker put the file exactly where the plan
 *     said. A byte-exact-present path needs no correction; return it unchanged.
 *     This demotes re-derivation to what it was always meant to be: a LAST
 *     RESORT that only fires when the declared path is genuinely absent from
 *     what the run actually touched.
 *
 * GUARD (a) is the true, minimal cure for the de0cba9f class: the worker had
 * committed `src/components/grc/poi-attachment-upload.tsx` at EXACTLY its
 * declared path (so it was in the run's real-touched set at re-derive time),
 * yet beta.92 re-derived it anyway (learning `src/components -> src/lib` from
 * an UNRELATED sub-task's `src/lib/grc/continuity-exercises.ts` on the shared
 * `grc` tail) and moved the goalpost off a correct commit. Short-circuiting on
 * an exact touched-path match closes that class outright AND demotes
 * re-derivation to a last-resort. GUARD (a) is a universal truth (a file that
 * exists exactly where the plan said needs no correction, in ANY repo), so it
 * ends the false-positive class without adding a per-repo edge-case rule.
 *
 * NOTE we deliberately do NOT add a same-basename requirement: the beta.76 cure
 * legitimately relies on a DIFFERENT-basename sibling in the real target dir as
 * evidence of a prefix drift (e.g. real `src/components/grc/widget.tsx` proves
 * a stale `components/grc/other.tsx` should be `src/components/grc/other.tsx`).
 * Guard (a) alone is sufficient because the de0cba9f file was committed at its
 * exact declared path -- a genuinely-drifted path (absent from the touched set)
 * still gets the beta.76 correction.
 */

import { isTestFilePath, normalisePath, resolveContractPath } from "./path-match.js";

/** A learned leading-prefix remapping, scoped to a shared trailing subtree. */
export interface PrefixRemap {
  /** Leading prefix in the STALE (lead-guessed) path, e.g. `tests`. */
  from: string;
  /** Leading prefix in the REAL (worker-touched) path, e.g. `src/__tests__`. */
  to: string;
  /** The shared trailing directory chain that anchored the remap, e.g. `api/grc`. */
  tail: string;
}

function dirSegments(p: string): string[] {
  const n = normalisePath(p);
  const segs = n.split("/");
  return segs.slice(0, -1); // drop the basename
}

/**
 * Longest common SUFFIX of two segment arrays (the shared trailing dir chain).
 * Returns the shared segments in order (possibly empty).
 */
function commonDirSuffix(a: string[], b: string[]): string[] {
  const out: string[] = [];
  let i = a.length - 1;
  let j = b.length - 1;
  while (i >= 0 && j >= 0 && a[i] === b[j]) {
    out.unshift(a[i]!);
    i--;
    j--;
  }
  return out;
}

/**
 * Learn directory-prefix remappings from the set of real paths the run has
 * touched so far, relative to a stale contract directory. Returns at most one
 * remap per distinct (from,to) pair, preferring the LONGEST shared tail (most
 * specific / least ambiguous).
 *
 * `staleDir` is the directory portion of a stale contract path (no basename).
 * `realFiles` are actual touched/committed file paths (ground truth).
 */
export function learnRemapsForDir(staleDir: string, realFiles: string[]): PrefixRemap[] {
  const sd = normalisePath(staleDir);
  if (!sd) return [];
  const staleSegs = sd.split("/");
  const best = new Map<string, PrefixRemap>(); // key = `${from}=>${to}`
  for (const f of realFiles) {
    const realSegs = dirSegments(f);
    if (realSegs.length === 0) continue;
    const tail = commonDirSuffix(staleSegs, realSegs);
    if (tail.length === 0) continue; // no shared subtree -> unrelated, skip
    const fromPrefix = staleSegs.slice(0, staleSegs.length - tail.length).join("/");
    const toPrefix = realSegs.slice(0, realSegs.length - tail.length).join("/");
    if (fromPrefix === toPrefix) continue; // no drift on this path
    const key = `${fromPrefix}=>${toPrefix}`;
    const candidate: PrefixRemap = { from: fromPrefix, to: toPrefix, tail: tail.join("/") };
    const existing = best.get(key);
    // Prefer the longest tail (most specific evidence).
    if (!existing || candidate.tail.length > existing.tail.length) best.set(key, candidate);
  }
  return [...best.values()];
}

/**
 * Re-derive a single stale contract path against the run's real touched files.
 * Returns the corrected path (leading prefix remapped to the discovered
 * convention, tail + basename preserved) or the ORIGINAL path unchanged when no
 * evidence-backed remap applies.
 *
 * When multiple remaps apply, the one with the LONGEST shared tail wins (most
 * specific). Ties are broken deterministically by the corrected string.
 */
/**
 * rc.9: a correction the evidence supports but the rules decline to apply.
 *
 * Returned instead of silently rewriting, so the candidate and its provenance
 * survive into the audit and can be put to a human, rather than being either
 * acted on or thrown away.
 */
export interface RederiveSuggestion {
  path: string;
  via: PrefixRemap;
  /** Why it was not applied. Operator-facing. */
  reason: string;
  confidence: "low";
}

export interface RederiveResult {
  path: string;
  remapped: boolean;
  via?: PrefixRemap;
  suggestion?: RederiveSuggestion;
}

export interface RederiveOptions {
  /**
   * rc.10: the repository's own file list, as ground truth about what exists.
   *
   * Guard (a) below only knows what THIS RUN touched, which is a sliver of the
   * repository. A contract path that is absent from that sliver is not thereby
   * wrong -- it may be a file that has been in the repo for a year. Supplying
   * the tracked-file inventory lets a declared path that genuinely exists
   * short-circuit re-derivation the same way a touched path does.
   *
   * Optional, and the module stays pure: the caller reads the repository, this
   * function only compares strings.
   */
  repoFiles?: Iterable<string>;
}

export function rederiveContractPath(
  contract: string,
  realFiles: string[],
  opts: RederiveOptions = {},
): RederiveResult {
  const c = normalisePath(contract);
  if (!c || !c.includes("/")) return { path: contract, remapped: false };

  // beta.93 GUARD (a): exact-match short-circuit. If the worker actually touched
  // the contract path VERBATIM, the file is exactly where the plan declared --
  // there is nothing to correct, and re-deriving it can only MOVE the goalpost
  // off a correct commit (the session de0cba9f false-positive). This also
  // demotes re-derivation to a genuine last-resort: it now fires ONLY when the
  // declared path is absent from what the run touched.
  for (const f of realFiles) {
    if (normalisePath(f) === c) return { path: contract, remapped: false };
  }

  /*
   * rc.10 GUARD (a2): a path that EXISTS is authoritative, whether or not this
   * run happened to touch it.
   *
   * StitchGuard, audit 5591. The contract named
   * `src/__tests__/lib/it/client-offboarding-orchestrator.test.ts`, which was a
   * real file in the repository. Guard (a) did not fire because the run had not
   * touched it -- the sub-task that was supposed to write it had just been
   * denied -- and re-derivation went on to rewrite a path that existed into one
   * that did not. Existence settles the question that guard (a) was only ever
   * approximating: the plan is not stale if the plan is describing a real file.
   */
  if (opts.repoFiles) {
    for (const f of opts.repoFiles) {
      if (typeof f === "string" && normalisePath(f) === c) return { path: contract, remapped: false };
    }
  }

  const segs = c.split("/");
  const dir = segs.slice(0, -1);
  const base = segs[segs.length - 1]!;
  const staleDir = dir.join("/");

  /*
   * rc.10: EVIDENCE MUST BE THE SAME KIND OF ARTIFACT AS THE CONTRACT.
   *
   * StitchGuard, audit 5591. The contract was a test:
   *   src/__tests__/lib/it/client-offboarding-orchestrator.test.ts
   * The whole evidence was one PRODUCTION file an earlier sub-task committed:
   *   src/lib/it/client-offboarding-errors.ts
   * They share the two-segment tail `lib/it`, so `src/__tests__ -> src` was
   * learned and the test was rewritten to a path that does not exist and that
   * the repository's Jest config would never have discovered.
   *
   * rc.9 put its kind check on the CORRECTED PATH and only in one direction
   * (a non-test contract must not become a test path). Both halves of that were
   * too narrow. The rewritten name here still ended in `.test.ts`, so it read as
   * a test path and the check never fired -- and the direction that actually
   * fired was test -> production, the one rc.9 had deliberately left open.
   *
   * The durable rule is upstream of both: a file is only evidence about where
   * ITS OWN kind of artifact lives. Where the repository puts `errors.ts` says
   * nothing about where it puts `*.test.ts`, because test layout is decided by
   * a test runner's discovery config and source layout is not. Symmetrically, a
   * test file says nothing about where documentation lives, which is the rc.9
   * OKF case (audit 5408) arriving at the same refusal through a rule that no
   * longer depends on which direction the rewrite happens to run in.
   *
   * Same-kind corrections -- every case beta.76, beta.93 and beta.100 were
   * written for -- are untouched: they always had same-kind evidence.
   */
  const contractIsTest = isTestFilePath(c);
  const sameKind: string[] = [];
  const crossKind: string[] = [];
  for (const f of realFiles) {
    if (typeof f !== "string" || !f.trim()) continue;
    (isTestFilePath(f) === contractIsTest ? sameKind : crossKind).push(f);
  }

  const remaps = learnRemapsForDir(staleDir, sameKind);
  if (remaps.length === 0) {
    return declineOrPass(contract, c, staleDir, base, contractIsTest, crossKind);
  }

  // Apply the remap whose `from` prefix actually leads staleDir (defensive:
  // learnRemapsForDir already derived `from` from staleDir, but a path may have
  // an empty from-prefix meaning "prepend to"). Choose the longest-tail winner.
  const sorted = [...remaps].sort((a, b) => {
    if (b.tail.length !== a.tail.length) return b.tail.length - a.tail.length;
    return `${a.from}=>${a.to}`.localeCompare(`${b.from}=>${b.to}`);
  });

  for (const rm of sorted) {
    // rc1 follow-up (live smoke 6096e931): a remap anchored on a ONE-segment
    // tail is too weak to apply. `components`, `lib`, `grc` are generic
    // directory names; a single shared segment does not prove prefix drift.
    // Both observed false-positive classes rest on 1-segment tails:
    // de0cba9f (`src/components -> src/lib` via `grc`) and 6096e931
    // (`src -> src/__tests__` via `components`, which rewrote the SOURCE
    // contract `src/components/policy-editor.tsx` into a phantom TEST path
    // that then failed verification every cycle). Every documented legitimate
    // remap has a >= 2-segment tail (`api/grc`, `components/grc`). Guard (a)
    // only protects paths the worker touched verbatim; a genuinely-absent
    // over-declared path gets no protection, so weak evidence must not apply.
    if (rm.tail.split("/").filter(Boolean).length < 2) continue;
    // staleDir must equal `${from}/${tail}` (or `${tail}` when from is empty).
    const expectStale = rm.from ? `${rm.from}/${rm.tail}` : rm.tail;
    if (normalisePath(expectStale) !== staleDir) continue;
    const newDir = rm.to ? `${rm.to}/${rm.tail}` : rm.tail;
    const corrected = normalisePath(`${newDir}/${base}`);
    if (corrected === c) return { path: contract, remapped: false };
    /*
     * rc.9, retained as a BACKSTOP on the destination.
     *
     * The rc.10 evidence rule above now refuses the OKF case (audit 5408) and
     * the test case (audit 5591) before either reaches here, because both rest
     * on cross-kind evidence. One residual shape still needs this check: an
     * evidence file that is same-kind by `isTestFilePath` yet sits under a test
     * directory anyway -- an extensionless `src/__tests__/api/fixtures/README`
     * is not a test path by the basename rule, so it can license `to =
     * src/__tests__` for a non-test contract and land the correction in the
     * test tree regardless. Cheap to keep, and it fails closed.
     */
    if (!isTestFilePath(c) && isTestFilePath(corrected)) {
      return {
        path: contract,
        remapped: false,
        suggestion: {
          path: corrected,
          via: rm,
          confidence: "low",
          reason:
            `the only evidence is a shared '${rm.tail}' directory suffix, and applying it would move a ` +
            `non-test requirement into a test tree ('${rm.from || "<root>"}' -> '${rm.to}'). A shared suffix ` +
            `does not establish that a documentation artifact belongs under tests.`,
        },
      };
    }
    return { path: corrected, remapped: true, via: rm };
  }
  // Same-kind evidence existed but none of it survived the tail-width and
  // prefix-shape checks. Cross-kind evidence may still describe a candidate
  // worth putting to a human, so offer it as a suggestion rather than silence.
  return declineOrPass(contract, c, staleDir, base, contractIsTest, crossKind);
}

/**
 * rc.10: no same-kind remap applied. Report the best CROSS-KIND candidate as a
 * suggestion, so the operator sees what the evidence hinted at and why it was
 * refused, and return the declared path otherwise unchanged.
 *
 * This is the path both recorded incidents now take. It is deliberately a
 * suggestion and never a rewrite: the plan keeps the path the brief asked for,
 * the candidate reaches the audit, and a human decides.
 */
function declineOrPass(
  contract: string,
  c: string,
  staleDir: string,
  base: string,
  contractIsTest: boolean,
  crossKind: string[],
): RederiveResult {
  if (crossKind.length === 0) return { path: contract, remapped: false };

  const candidates = learnRemapsForDir(staleDir, crossKind)
    .filter((rm) => rm.tail.split("/").filter(Boolean).length >= 2)
    .filter((rm) => normalisePath(rm.from ? `${rm.from}/${rm.tail}` : rm.tail) === staleDir)
    .sort((a, b) => {
      if (b.tail.length !== a.tail.length) return b.tail.length - a.tail.length;
      return `${a.from}=>${a.to}`.localeCompare(`${b.from}=>${b.to}`);
    });

  for (const rm of candidates) {
    const newDir = rm.to ? `${rm.to}/${rm.tail}` : rm.tail;
    const corrected = normalisePath(`${newDir}/${base}`);
    if (corrected === c) continue;
    const reason = contractIsTest
      ? `the only evidence is a shared '${rm.tail}' directory suffix on PRODUCTION files ` +
        `('${rm.from || "<root>"}' -> '${rm.to}'). Where a repository keeps its source does not establish ` +
        `where its test runner discovers tests, so this cannot relocate a test contract.`
      : `the only evidence is a shared '${rm.tail}' directory suffix on TEST files ` +
        `('${rm.from || "<root>"}' -> '${rm.to}'), and applying it would move a non-test requirement into a ` +
        `test tree. A shared suffix does not establish that a documentation artifact belongs under tests.`;
    return { path: contract, remapped: false, suggestion: { path: corrected, via: rm, confidence: "low", reason } };
  }
  return { path: contract, remapped: false };
}

/** A 1:1 reconciliation of a stale TEST contract path onto the test file the sub-task really committed. */
export interface TestContractReconcile {
  /** The stale (lead-authored) contract path. */
  from: string;
  /** The real committed/written test file it resolves to. */
  to: string;
}

/**
 * beta.100: bounded TEST-CONTRACT reconciliation.
 *
 * ROOT CAUSE (b99 smoke, session 4420aa45, cycle 1 seq 3). The lead authored a
 * co-located contract path `src/app/api/grc/continuity-exercises/route.test.ts`.
 * The worker correctly committed the test at the repo's real Jest location,
 * `src/__tests__/api/grc/continuity-exercises-api.test.ts`, because the repo's
 * `jest.config.ts` `testMatch` is `**\/__tests__\/**\/*.test.ts` -- a co-located
 * file would never run in CI. The run then died at seq 3 holding a correct
 * commit, having spent $3.94 and opened no PR.
 *
 * THREE layers that each existed to catch exactly this all missed:
 *
 *   1. {@link rederiveContractPath} (b76/b93) learns a leading-prefix remap only
 *      from a SHARED TRAILING directory chain. Here the stale dir
 *      (`src/app/api/grc/continuity-exercises`) and the real dir
 *      (`src/__tests__/api/grc`) share NO common suffix -- `continuity-exercises`
 *      != `grc` -- so `commonDirSuffix` returned empty, no remap was learned,
 *      and the path came back unchanged.
 *   2. The `test-file-unique` rule in path-match.ts (b76) resolves this shape
 *      correctly -- it was BUILT for it -- but b84 set `strictContract: true` on
 *      `file_committed`, which early-returns before both `*-unique` fallbacks.
 *      b84's actual false positive (a `route.ts` contract matching a
 *      `download/route.ts` sibling) came only from `basename-unique`, on a
 *      NON-test file; `test-file-unique` was collateral damage and has been
 *      dead code on this path ever since.
 *   3. The b55 clarification escalation only fires when the worker made NO
 *      commit, so a reasoned deviation that DID commit had no recovery at all.
 *
 * THE RULE. We deliberately do NOT re-open the fuzzy fallbacks in path-match.ts
 * -- b84/b87/b95 depend on `file_committed` staying strict, and loosening the
 * matcher would re-open the sibling false-positive class. Instead we correct the
 * CONTRACT before verification (the layer b76 designated as "the real cure"),
 * under a 1:1 constraint that admits no ambiguity:
 *
 *   - EXACTLY ONE contract path is a test file that does not structurally
 *     resolve against what this sub-task actually touched, AND
 *   - EXACTLY ONE touched test file is not already claimed by some other
 *     contract path.
 *
 * Then those two are necessarily each other's counterpart, and we rewrite the
 * contract onto the real path. Two unmatched test contracts, or two unclaimed
 * test files, is genuine ambiguity -> we return nothing and the strict verifier
 * fails as before. This cannot re-open b84: a non-test contract path never
 * enters the rule, so `route.ts` can never reconcile onto a sibling.
 *
 * SAFETY depends on `subTaskTouched` being the PER-SUB-TASK-scoped file set
 * (this worker turn's own `filesChanged` + `uncommittedFiles`), NOT the
 * run-level set -- exactly the same scoping argument the b59/b76 fallbacks rest
 * on. A lone unclaimed test file in that tiny set is demonstrably the test THIS
 * sub-task just wrote. Callers must not pass the run-wide discovered-paths set.
 *
 * Like the rest of this module the function is PURE, so it cannot false-green
 * anything on its own: it only produces a corrected path that the strict
 * verifier still has to be satisfied by (including b84's non-zero-diff gate).
 */
export function reconcileTestContractPaths(
  contractPaths: string[],
  subTaskTouched: string[],
): TestContractReconcile[] {
  const touched = [...new Set(subTaskTouched.map((f) => (typeof f === "string" ? f.trim() : "")).filter(Boolean))];
  if (touched.length === 0 || contractPaths.length === 0) return [];

  // One pass: partition contract paths into those the worker satisfied
  // structurally (recording WHICH file each claimed) and unmatched test paths.
  const claimed = new Set<string>();
  const unmatchedTestContracts: string[] = [];
  for (const cp of contractPaths) {
    if (!cp) continue;
    const hit = resolveContractPath(touched, cp, { strictContract: true });
    if (hit) {
      claimed.add(normalisePath(hit.file));
      continue;
    }
    if (isTestFilePath(cp)) unmatchedTestContracts.push(cp);
  }
  if (unmatchedTestContracts.length !== 1) return [];

  const freeTests = touched.filter((f) => isTestFilePath(f) && !claimed.has(normalisePath(f)));
  if (freeTests.length !== 1) return [];

  const from = unmatchedTestContracts[0]!;
  const to = freeTests[0]!;
  if (normalisePath(from) === normalisePath(to)) return [];
  return [{ from, to }];
}
