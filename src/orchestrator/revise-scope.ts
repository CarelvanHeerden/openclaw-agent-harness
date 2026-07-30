/**
 * beta.91 (Fix 1): cycle-scoping for revise cycles.
 *
 * PROBLEM (Staging's beta.90 DR/BCP smoke, session baa8ba08): a revise cycle
 * (cycle > 1) re-ran ALL 12 sub-tasks even though 8 of them were
 * `subtask_revise_no_change` -- the worker re-checked an already-correct commit
 * and did nothing. That is ~5 min of pure "spin up a worker, confirm no change
 * needed, tear down" overhead per cycle, on top of a full adversary review that
 * scales with sub-task count.
 *
 * FIX: on a revise cycle, a sub-task whose file scope does NOT intersect ANY
 * finding's file is not something the current review is asking to change --
 * skip it (its prior-cycle commit is already correct and part of the branch).
 * Only re-run sub-tasks that a finding actually targets, PLUS anything the
 * skipped set depends on transitively is preserved (we never skip a sub-task a
 * KEPT sub-task depends on -- dependency safety first).
 *
 * SAFETY (why this can only reduce, never break, correctness):
 *   1. Scoped ONLY to cycle > 1 with review findings present. Cycle 1 is
 *      untouched.
 *   2. A finding with NO resolvable file (bare/absent `file`) makes the whole
 *      cycle UNSCOPABLE -> we skip the optimisation entirely and run every
 *      sub-task (matches beta.86 `strict_no_targets` conservatism -- we cannot
 *      prove a sub-task is irrelevant, so we run it).
 *   3. A sub-task with NO `filesLikelyTouched` is UNSCOPABLE for itself -> it is
 *      always KEPT (we cannot prove it is irrelevant).
 *   4. We NEVER skip a sub-task that a kept sub-task `dependsOn` (transitive) --
 *      the kept one may need its output committed/on-disk.
 *   5. This is purely which-sub-tasks-to-run; the adversary still reviews the
 *      WHOLE branch diff afterwards, so a wrongly-skipped file would still be
 *      caught by review, not silently shipped.
 *
 * All pure/deterministic. No fs, no git, no SDK.
 */

/** Minimal shape we read off a plan sub-task (structural, avoids a hard type import). */
export interface ScopeSubTask {
  seq: number;
  filesLikelyTouched?: string[];
  dependsOn?: number[];
  taskMode?: string;
}

/** Minimal shape we read off a review finding. */
export interface ScopeFinding {
  file?: string | null;
}

export interface ReviseScopeResult {
  /** true when the optimisation applied (some sub-tasks were skipped). */
  scoped: boolean;
  /** seq numbers to RUN this cycle. */
  runSeqs: number[];
  /** seq numbers to SKIP (mark completed_no_change without a worker turn). */
  skipSeqs: number[];
  /** why the optimisation did NOT apply, when scoped=false. */
  reason?:
    | "not_revise_cycle"
    | "no_findings"
    | "unscopable_findings" // >=1 finding has no resolvable file
    | "all_relevant"; // every sub-task intersects a finding (nothing to skip)
  /** the normalised set of finding file basenames/paths used for matching (debug/audit). */
  findingFiles: string[];
}

/** Normalise a path for loose intersection: lowercase, strip leading ./, collapse slashes. */
function norm(p: string): string {
  return p
    .trim()
    .replace(/^\.\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

/** basename of a normalised path. */
function base(p: string): string {
  const n = norm(p);
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

/**
 * Does a sub-task's file scope intersect the finding-file set?
 *
 * Matching is PATH-STRUCTURAL (suffix either direction) for findings that carry
 * a directory component -- so a finding `src/app/api/.../route.ts` matches a
 * sub-task listing the same fuller path (or a partial adversary path that is a
 * suffix of it), but does NOT match a DIFFERENT `.../[id]/route.ts` sibling that
 * merely shares the `route.ts` basename. This is the beta.74/87 strict-contract
 * lesson: a bare basename over-targets siblings (route.ts / index.ts / page.tsx
 * are everywhere), so a basename-only match is used ONLY when the finding itself
 * is a bare filename with no directory (the adversary gave just a name). We err
 * toward keeping a sub-task on genuine ambiguity, never toward wrongly skipping.
 */
export function subTaskIntersectsFindings(
  files: string[],
  findingFilesNorm: string[],
  bareFindingBasenames: Set<string>,
): boolean {
  for (const raw of files) {
    if (!raw) continue;
    const f = norm(raw);
    const b = base(raw);
    for (const ff of findingFilesNorm) {
      // suffix either direction (partial adversary path vs fuller plan path)
      if (f === ff || f.endsWith("/" + ff) || ff.endsWith("/" + f)) return true;
    }
    // basename match ONLY against findings that were themselves BARE filenames
    // (no directory) -- prevents `.../route.ts` from over-matching sibling
    // route files. Requires a specific basename (has an extension).
    if (b.includes(".") && bareFindingBasenames.has(b)) return true;
  }
  return false;
}

/**
 * Compute which sub-tasks to run vs skip on a revise cycle.
 *
 * @param subTasks the (revise-spec-refreshed or raw) plan sub-tasks
 * @param findings the previous review's findings
 * @param cycle current cycle (1-based)
 */
export function computeReviseScope(
  subTasks: ScopeSubTask[],
  findings: ScopeFinding[] | undefined,
  cycle: number,
): ReviseScopeResult {
  const allSeqs = subTasks.map((s) => s.seq);
  if (cycle <= 1) {
    return { scoped: false, runSeqs: allSeqs, skipSeqs: [], reason: "not_revise_cycle", findingFiles: [] };
  }
  const fs = (findings ?? []).map((f) => (f.file ?? "").trim()).filter(Boolean);
  if (!findings || findings.length === 0) {
    return { scoped: false, runSeqs: allSeqs, skipSeqs: [], reason: "no_findings", findingFiles: [] };
  }
  // If ANY finding lacks a resolvable file, we cannot prove which sub-tasks are
  // irrelevant -> run everything (beta.86 strict_no_targets conservatism).
  const anyFindingUnfiled = (findings ?? []).some((f) => !(f.file ?? "").trim());
  if (anyFindingUnfiled || fs.length === 0) {
    return {
      scoped: false,
      runSeqs: allSeqs,
      skipSeqs: [],
      reason: "unscopable_findings",
      findingFiles: fs,
    };
  }

  const findingFilesNorm = fs.map(norm);
  // Only findings that are BARE filenames (no directory) contribute a basename
  // match -- a full-path finding matches structurally (suffix) so it can't
  // over-target a same-basename sibling under a different directory.
  const bareFindingBasenames = new Set(
    fs.filter((p) => !norm(p).includes("/")).map(base),
  );

  const bySeq = new Map(subTasks.map((s) => [s.seq, s] as const));

  // 1) Directly-relevant: intersects a finding, OR unscopable-for-itself
  //    (no filesLikelyTouched -> cannot prove irrelevant -> keep).
  const keep = new Set<number>();
  for (const st of subTasks) {
    const files = (st.filesLikelyTouched ?? []).filter(Boolean);
    if (files.length === 0) {
      keep.add(st.seq); // unscopable-for-itself -> always keep
      continue;
    }
    if (subTaskIntersectsFindings(files, findingFilesNorm, bareFindingBasenames)) {
      keep.add(st.seq);
    }
  }

  // 2) Dependency closure: never skip something a KEPT sub-task depends on
  //    (transitively). Add deps of kept nodes until fixpoint.
  let changed = true;
  while (changed) {
    changed = false;
    for (const seq of [...keep]) {
      const st = bySeq.get(seq);
      for (const d of st?.dependsOn ?? []) {
        if (bySeq.has(d) && !keep.has(d)) {
          keep.add(d);
          changed = true;
        }
      }
    }
  }

  const runSeqs = allSeqs.filter((s) => keep.has(s));
  const skipSeqs = allSeqs.filter((s) => !keep.has(s));

  if (skipSeqs.length === 0) {
    return { scoped: false, runSeqs: allSeqs, skipSeqs: [], reason: "all_relevant", findingFiles: fs };
  }

  return { scoped: true, runSeqs, skipSeqs, findingFiles: fs };
}
