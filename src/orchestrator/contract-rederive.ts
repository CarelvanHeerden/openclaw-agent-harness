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
 */

import { normalisePath } from "./path-match.js";

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
export function rederiveContractPath(contract: string, realFiles: string[]): { path: string; remapped: boolean; via?: PrefixRemap } {
  const c = normalisePath(contract);
  if (!c || !c.includes("/")) return { path: contract, remapped: false };
  const segs = c.split("/");
  const dir = segs.slice(0, -1);
  const base = segs[segs.length - 1]!;
  const staleDir = dir.join("/");

  const remaps = learnRemapsForDir(staleDir, realFiles);
  if (remaps.length === 0) return { path: contract, remapped: false };

  // Apply the remap whose `from` prefix actually leads staleDir (defensive:
  // learnRemapsForDir already derived `from` from staleDir, but a path may have
  // an empty from-prefix meaning "prepend to"). Choose the longest-tail winner.
  const sorted = [...remaps].sort((a, b) => {
    if (b.tail.length !== a.tail.length) return b.tail.length - a.tail.length;
    return `${a.from}=>${a.to}`.localeCompare(`${b.from}=>${b.to}`);
  });

  for (const rm of sorted) {
    // staleDir must equal `${from}/${tail}` (or `${tail}` when from is empty).
    const expectStale = rm.from ? `${rm.from}/${rm.tail}` : rm.tail;
    if (normalisePath(expectStale) !== staleDir) continue;
    const newDir = rm.to ? `${rm.to}/${rm.tail}` : rm.tail;
    const corrected = normalisePath(`${newDir}/${base}`);
    if (corrected === c) return { path: contract, remapped: false };
    return { path: corrected, remapped: true, via: rm };
  }
  return { path: contract, remapped: false };
}
