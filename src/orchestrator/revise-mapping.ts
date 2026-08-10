/**
 * beta.92: DETERMINISTIC finding -> sub-task mapping (replaces the LLM
 * revise-spec turn).
 *
 * ROOT CAUSE this closes (three consecutive smokes b89/b90/b91): the cycle-2
 * revise-spec LLM turn (beta.67) kept exceeding `revise_spec_timeout_seconds`
 * (the beta.73 cron-nested-lane signature). On timeout it fell back to a RAW
 * 10-finding dump handed to EVERY sub-task (`reviseSpecApplied:false`), so:
 *   - F1 revise-scoping could not target (no per-sub-task file signal),
 *   - every sub-task got findings that mostly don't concern it, and
 *   - overwhelmed workers confabulated "already correct, one narrow change"
 *     answers that don't match their contract (the b91 seq-6 confab).
 *
 * FIX (b92 charter, agreed with Staging 2026-07-30): DELETE the LLM turn.
 * Cycle 2 already knows which sub-task owns which files (`filesLikelyTouched`
 * from the lead plan + `codeExcerpts[].path` from workerContext). Map each
 * diff-addressable finding (dimensions spec|quality|security, where `.file` is
 * required per b91) to the sub-task(s) that own its file, DETERMINISTICALLY,
 * using the same strict `resolveContractPath` structural machinery b87/b88
 * hardened. No LLM turn => no timeout => no raw-dump => no confab-inducing
 * overload.
 *
 * RULES (the charter's explicit ruleset):
 *   - DIFF-ADDRESSABLE (spec|quality|security): map to the sub-task(s) whose
 *     files structurally match the finding's `.file`. A filed finding with NO
 *     structural match to ANY sub-task is a MAPPING MISS -> attach to EVERY
 *     sub-task as context (never dropped, never "run-all the whole cycle"),
 *     and surface `loop.finding_mapping_miss`. A finding lost is never
 *     acceptable; an extra bit of context is.
 *   - META (fit|runtime): cross-cutting guidance ("add ActivityLog to every
 *     state-changing route", "triage preview deploy errors") that fans out to
 *     ALL sub-tasks. Broadcast verbatim as shared context to every sub-task,
 *     and EXEMPT from the F1 unscopable gate (a meta finding without `.file`
 *     must NOT force the whole cycle unscopable).
 *
 * All pure/deterministic. No fs, no git, no SDK. The structural matcher is
 * injected (the loop passes resolveContractPath) so this module has no import
 * cycle with path-match and stays trivially unit-testable.
 */

/** ReviewFinding shape we read (structural, avoids a hard type import). */
export interface MapFinding {
  dimension: string;
  severity: string;
  title?: string;
  detail?: string;
  file?: string | null;
  line?: number;
}

/** Sub-task shape we read for mapping. */
export interface MapSubTask {
  seq: number;
  filesLikelyTouched?: string[];
  /** codeExcerpts[].path from workerContext, flattened by the caller. */
  contextPaths?: string[];
}

/**
 * A structural path matcher: returns a truthy matched path when `candidate`
 * (a finding file) structurally resolves against `owned` (a sub-task's files),
 * else falsy. The loop injects `resolveContractPath(owned, candidate,
 * {strictContract:true})` so the SAME strict rules b87/b88 use for contract
 * targeting drive the mapping (no bare-basename over-match).
 */
export type StructuralMatch = (owned: string[], candidate: string) => unknown;

import { isRoutable, normaliseDimension } from "./finding-dimension.js";

/** Diff-addressable dimensions (must carry a `.file` per beta.91). */
export const DIFF_ADDRESSABLE = new Set(["spec", "quality", "security"]);
/** Meta dimensions: cross-cutting, `.file` optional, broadcast to all. */
export const META_DIMENSIONS = new Set(["fit", "runtime"]);

function dim(f: MapFinding): string {
  return normaliseDimension(f.dimension);
}
function fileOf(f: MapFinding): string {
  return (f.file ?? "").trim();
}

/** Is this a diff-addressable finding (spec|quality|security)? */
export function isDiffAddressable(f: MapFinding): boolean {
  return DIFF_ADDRESSABLE.has(dim(f));
}
/**
 * Is this a meta finding -> broadcast, exempt from unscopable gate?
 *
 * beta.116: a `fit` finding that NAMES A FILE is no longer meta. "This route
 * writes no ActivityLog while every sibling does" is fixed by editing exactly
 * the named route, so it belongs to whoever owns that file -- and until b116 it
 * belonged to nobody, because being meta excluded it from targeting and being
 * non-diff-addressable excluded it from b107's orphan adoption. File-less
 * `fit`, and all `runtime`, remain meta: there is nowhere to route them.
 */
export function isMetaFinding(f: MapFinding): boolean {
  return META_DIMENSIONS.has(dim(f)) && !isRoutable(f);
}

/** Render one finding as a worker-facing hint line (mirrors buildReviseDispatchHint). */
export function renderFindingLine(f: MapFinding): string {
  const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
  return `- [${f.severity}/${f.dimension}] ${f.title ?? "(untitled)"}${loc}: ${f.detail ?? ""}`.slice(0, 600);
}

export interface SubTaskAssignment {
  seq: number;
  /** diff-addressable findings that structurally target THIS sub-task's files. */
  targeted: MapFinding[];
  /** meta + mapping-miss findings broadcast to THIS (and every) sub-task. */
  broadcast: MapFinding[];
  /** the union of file paths this sub-task should treat as its targeted set. */
  targetedFiles: string[];
}

export interface ReviseMappingResult {
  /** per-sub-task assignment, keyed by seq (in the sub-tasks' input order). */
  assignments: SubTaskAssignment[];
  /** diff-addressable findings that matched NO sub-task (attached to all). */
  mappingMisses: MapFinding[];
  /** meta findings broadcast to all. */
  metaBroadcast: MapFinding[];
  /** true when at least one diff-addressable finding mapped to a sub-task. */
  anyTargeted: boolean;
  /** beta.107: orphan findings given an owner. Empty unless `adoptOrphans`. */
  orphanAdoptions: OrphanAdoption[];
  /** beta.118: orphans that had candidates but no single strongest one. */
  orphanRefusals: OrphanAdoptionRefusal[];
}

/** beta.107: one orphan finding, and the sub-task made responsible for it. */
export interface OrphanAdoption {
  finding: MapFinding;
  /** the finding's file, which no sub-task's plan claimed. */
  file: string;
  /** the sub-task that adopted it. */
  seq: number;
  reason: "mentioned_in_finding" | "nearest_path";
  score: number;
}

/**
 * beta.118: why an orphan finding that HAD a candidate still went unadopted.
 * Distinct from "no candidate at all", which needs a different fix.
 */
export interface OrphanAdoptionRefusal {
  finding: MapFinding;
  file: string;
  reason: "prefix_too_shallow";
  /** the best claim on offer, and the sub-task that held it. */
  score: number;
  seqs: number[];
}

/**
 * beta.118: the weakest `nearest_path` claim worth acting on -- share at least
 * one directory BELOW the source root. Depth 1 means two paths agree only on
 * `src/`, which in a `src/`-rooted repo every candidate satisfies and so
 * distinguishes nobody. Depth 2+ is a real directory-level claim.
 */
const MIN_NEAREST_PATH_DEPTH = 2;

/**
 * beta.108: severities an orphan finding may be adopted at. Everything the
 * adversary emits below `low` is commentary -- `info` in particular is how it
 * records that a PRIOR finding was verified fixed.
 */
export const ADOPTABLE_SEVERITIES = new Set(["low", "medium", "high", "critical"]);

const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];
function severityRank(f: MapFinding): number {
  return SEVERITY_ORDER.indexOf((f.severity ?? "").toLowerCase());
}

/** Leading path segments `a` and `b` share. `src/lib/x` vs `src/lib/y` -> 2. */
function sharedPrefixDepth(a: string, b: string): number {
  const x = a.split("/").filter(Boolean);
  const y = b.split("/").filter(Boolean);
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n += 1;
  return n;
}

/**
 * Does the finding's prose actually name this owned path? Matches the full path
 * or its last two segments, which is specific enough that `page.tsx` alone will
 * not match every page in the repo.
 */
function findingMentions(text: string, owned: string): boolean {
  if (!text) return false;
  const segs = owned.split("/").filter(Boolean);
  const tail = segs.slice(-2).join("/");
  for (const frag of [owned, tail]) {
    if (frag.length >= 8 && text.includes(frag)) return true;
  }
  return false;
}

/**
 * beta.107: GIVE AN ORPHAN FINDING AN OWNER.
 *
 * A diff-addressable finding whose file no sub-task claims is a mapping miss.
 * b92 broadcasts it to every sub-task as CONTEXT, which never drops it but also
 * never asks anyone to fix it -- and b91 revise-scoping then skips the very
 * sub-tasks it was broadcast to, because their files intersect no finding. The
 * finding is preserved and unactionable, so it is re-raised every cycle.
 *
 * b106 is the worked example. `.cursor/rules/help-section-updates.mdc` requires
 * `src/lib/help/help-content.ts` to be updated alongside a new page. The rule was
 * ingested, the adversary enforced it every cycle, no sub-task's plan mentioned
 * the file, and the finding was still open when the run hit the cycle ceiling --
 * `finding_mapping_miss` fired on the same file in both revise cycles. The run
 * could not have closed it however many cycles it was given.
 *
 * Adoption picks the sub-task with the strongest claim -- one the finding's own
 * prose names, else the one nearest in the directory tree -- and makes the
 * finding TARGETED there, adding the orphan file to that sub-task's targeted
 * set so the worker is instructed to change it and the contract permits it.
 *
 * Deliberately conservative: a finding with no file, and one sharing no
 * directory with any sub-task and named by none, is left as a pure broadcast.
 * An arbitrary owner is worse than an honest miss.
 *
 * beta.118: AND SO IS A CLAIM TOO WEAK TO BE ONE. b117 (session d66dbaed)
 * shipped `do_not_merge` on this function's own worked example. The adversary
 * filed `src/lib/help/help-content.ts` with an EMPTY detail, so
 * `findingMentions` had no prose to match and scored 0 everywhere. That left
 * `sharedPrefixDepth`, which returned exactly 1 for all five sub-tasks under
 * `src/`: they share the source root and diverge at the very next segment.
 * Sharing `src/` in a `src/`-rooted repo distinguishes nobody -- every
 * candidate emits it -- yet 1 cleared the `score <= 0` guard, and the
 * lowest-seq tie-break handed a help-content finding about a UI page to
 * sub-task 2, "Create continuity-exercises CRUD API routes", purely because
 * 2 < 5. The API worker touched the same two route files in both cycles and,
 * quite reasonably, ignored a finding outside its remit; the adversary
 * re-raised it as "prior fix not applied" and the run ended unmergeable.
 *
 * So a `nearest_path` claim must reach MIN_NEAREST_PATH_DEPTH -- at least one
 * shared directory BELOW the source root. Ties are still broken by lowest seq,
 * because two sub-tasks that both own files in `src/lib/help/` really are both
 * plausible owners of `src/lib/help/help-content.ts`; that was never the bug.
 * The other half of b118 makes the adversary name the triggering surface in
 * `detail`, which restores a `mentioned_in_finding` winner for this exact case.
 */
export function adoptOrphanFindings(
  subTasks: MapSubTask[],
  misses: MapFinding[],
  ownedOf: (st: MapSubTask) => string[],
  limits: { maxPerCycle?: number } = {},
  refusals?: OrphanAdoptionRefusal[],
): OrphanAdoption[] {
  const adoptions: OrphanAdoption[] = [];
  // beta.108: adopt in severity order, so a cap spends itself on the findings
  // that matter. `misses` arrives in the adversary's emission order, which is
  // not a priority order.
  const ordered = [...misses].sort((a, b) => severityRank(b) - severityRank(a));
  for (const f of ordered) {
    const file = fileOf(f);
    // beta.116: was `!isDiffAddressable(f)`, which excluded `fit` -- and so
    // excluded `src/lib/help/help-content.ts`, the very finding this function's
    // doc comment cites as the case it exists to solve. b107 could not fix its
    // own worked example.
    if (!isRoutable(f)) continue;
    // beta.108: `info` is the adversary's ACKNOWLEDGEMENT severity, not a
    // request. The b106 revise (session 21c9c44e) closed with seven of eighteen
    // findings reading like "Findings 2, 3, 4, 5, 7 verified resolved (no
    // action)" -- adopting one of those puts a worker on a finding that says the
    // code is already correct, which is worse than leaving it unmapped.
    if (!ADOPTABLE_SEVERITIES.has((f.severity ?? "").toLowerCase())) continue;
    // beta.108: a cap, because adoption widens scope and scope is what revise
    // cycles cost. That same revise fired TWENTY-ONE mapping misses across two
    // cycles against the original smoke's two: the adversary reviews the whole
    // branch every cycle and keeps finding adjacent issues, so an uncapped
    // adopter would drag most of the branch back into every cycle and undo the
    // targeting that makes revise cheap. Severity-ordered, so the cap drops the
    // least important ones.
    if (adoptions.length >= (limits.maxPerCycle ?? Infinity)) break;
    const text = `${f.title ?? ""}\n${f.detail ?? ""}`;
    let best: OrphanAdoption | undefined;
    for (const st of subTasks) {
      const owned = ownedOf(st);
      if (owned.length === 0) continue;
      // A path the finding itself names beats mere directory adjacency: the
      // b106 finding's title is "New page ... without the mandatory
      // help-content.ts update", which names the page, not the schema.
      const mentioned = owned.some((p) => findingMentions(text, p));
      const depth = Math.max(0, ...owned.map((p) => sharedPrefixDepth(p, file)));
      // beta.118: a bare source-root match is not a claim. Below the threshold
      // the sub-task is not a candidate at all, so a run of equally-unrelated
      // sub-tasks can no longer be decided by which happens to be numbered
      // lowest. A path the finding NAMES still qualifies at any depth -- that
      // signal is explicit, not inferred from the tree.
      const score = mentioned ? 1000 + depth : depth >= MIN_NEAREST_PATH_DEPTH ? depth : 0;
      if (score <= 0) continue;
      // Strictly-greater keeps ties on the lowest seq, so adoption is stable
      // across cycles and a re-run maps the same finding to the same worker.
      // Two sub-tasks sharing a DEEP directory with the file are both plausible
      // owners; picking the lower is arbitrary but harmless, and stable.
      if (!best || score > best.score) {
        best = { finding: f, file, seq: st.seq, reason: mentioned ? "mentioned_in_finding" : "nearest_path", score };
      }
    }
    if (!best) {
      // Distinguish "somebody was adjacent but too weakly to own it" from "no
      // candidate at all": only the former is fixed by the adversary naming the
      // trigger, which is the other half of b118.
      const bestDepth = Math.max(
        0,
        ...subTasks.flatMap((st) => ownedOf(st).map((p) => sharedPrefixDepth(p, file))),
      );
      if (bestDepth > 0) {
        const seqs = subTasks
          .filter((st) => ownedOf(st).some((p) => sharedPrefixDepth(p, file) === bestDepth))
          .map((st) => st.seq);
        refusals?.push({ finding: f, file, reason: "prefix_too_shallow", score: bestDepth, seqs });
      }
      continue;
    }
    adoptions.push(best);
  }
  return adoptions;
}

/**
 * Deterministically map the previous review's findings onto the plan sub-tasks.
 *
 * @param subTasks    cycle-2 plan sub-tasks (raw lead plan; NO LLM refresh)
 * @param findings    the previous review's findings
 * @param match       injected strict structural matcher (resolveContractPath)
 */
export function mapFindingsToSubTasks(
  subTasks: MapSubTask[],
  findings: MapFinding[] | undefined,
  match: StructuralMatch,
  // beta.107: opt-in so every pre-b107 caller and test keeps byte-identical
  // behaviour; the loop turns it on from `revise_adopt_orphan_findings`.
  opts: { adoptOrphans?: boolean; maxAdoptionsPerCycle?: number } = {},
): ReviseMappingResult {
  const list = findings ?? [];
  const assignments: SubTaskAssignment[] = subTasks.map((s) => ({
    seq: s.seq,
    targeted: [],
    broadcast: [],
    targetedFiles: [],
  }));
  const bySeq = new Map(assignments.map((a) => [a.seq, a] as const));

  const meta: MapFinding[] = [];
  const misses: MapFinding[] = [];
  let anyTargeted = false;

  for (const f of list) {
    // Meta findings (fit|runtime) always broadcast, regardless of `.file`.
    if (isMetaFinding(f)) {
      meta.push(f);
      continue;
    }
    // beta.116: routable == it names a file (and is not `runtime`). Previously
    // this asked `isDiffAddressable`, so a `codebase-fit` finding naming a file
    // a sub-task had just written skipped targeting entirely and went straight
    // to the unowned pile -- twice in the b115 run, on the two API route files
    // the plan itself created.
    const file = fileOf(f);
    if (isRoutable(f)) {
      const owners: number[] = [];
      for (const st of subTasks) {
        const owned = [
          ...((st.filesLikelyTouched ?? []) as string[]),
          ...((st.contextPaths ?? []) as string[]),
        ]
          .map((p) => (typeof p === "string" ? p.trim() : ""))
          .filter(Boolean);
        if (owned.length === 0) continue;
        if (match(owned, file)) owners.push(st.seq);
      }
      if (owners.length > 0) {
        anyTargeted = true;
        for (const seq of owners) {
          const a = bySeq.get(seq);
          if (a) {
            a.targeted.push(f);
            if (!a.targetedFiles.includes(file)) a.targetedFiles.push(file);
          }
        }
        continue;
      }
      // MAPPING MISS: a filed diff-addressable finding matched NO sub-task.
      // Never drop it -> attach to every sub-task as broadcast context.
      misses.push(f);
      continue;
    }
    // File-less, or `runtime` -> broadcast (safe: it reaches every worker as
    // context, never dropped). There is no file to route it to.
    misses.push(f);
  }

  // beta.107: an orphan finding stays broadcast to everyone (never dropped) AND
  // becomes TARGETED on its adopting sub-task, so someone is actually asked to
  // fix it and b91 scoping cannot skip the one worker who could.
  const orphanRefusals: OrphanAdoptionRefusal[] = [];
  const orphanAdoptions = opts.adoptOrphans
    ? adoptOrphanFindings(subTasks, misses, (st) =>
        [...((st.filesLikelyTouched ?? []) as string[]), ...((st.contextPaths ?? []) as string[])]
          .map((p) => (typeof p === "string" ? p.trim() : ""))
          .filter(Boolean),
        { maxPerCycle: opts.maxAdoptionsPerCycle },
        orphanRefusals,
      )
    : [];
  for (const ad of orphanAdoptions) {
    const a = bySeq.get(ad.seq);
    if (!a) continue;
    anyTargeted = true;
    if (!a.targeted.includes(ad.finding)) a.targeted.push(ad.finding);
    if (!a.targetedFiles.includes(ad.file)) a.targetedFiles.push(ad.file);
  }

  // Broadcast meta + misses to every sub-task.
  const broadcastAll = [...meta, ...misses];
  for (const a of assignments) a.broadcast = broadcastAll;

  return { assignments, mappingMisses: misses, metaBroadcast: meta, anyTargeted, orphanAdoptions, orphanRefusals };
}

/**
 * Build the per-sub-task revise dispatch hint from a deterministic assignment.
 * Replaces the reviseSpecApplied warm-context render + the raw-dump fallback:
 * each worker now sees ONLY the findings that target its files, plus the
 * cross-cutting broadcast guidance -- never the full untargeted 10-finding dump.
 */
export function buildScopedReviseHint(
  verdict: string,
  summary: string | undefined,
  a: SubTaskAssignment,
): string {
  const targetedLines = a.targeted.map(renderFindingLine);
  const broadcastLines = a.broadcast.map(renderFindingLine);
  const parts: string[] = [
    `REVISION CYCLE: an adversarial reviewer examined the previous cycle's diff and returned verdict "${verdict}".`,
    `Reviewer summary: ${(summary ?? "").slice(0, 800)}`,
  ];
  if (targetedLines.length > 0) {
    parts.push(`Findings that target THIS sub-task's files (fix these):`, ...targetedLines);
  } else {
    parts.push(`No finding targets this sub-task's files directly.`);
  }
  if (broadcastLines.length > 0) {
    parts.push(
      ``,
      `Cross-cutting guidance (applies across the change; apply the parts that fall in THIS sub-task's files):`,
      ...broadcastLines,
    );
  }
  parts.push(
    ``,
    `Address ONLY the findings above that fall inside THIS sub-task's files/scope. If none of them apply to this sub-task, make NO changes and end your turn -- do not redo work that is already correct.`,
  );
  return parts.join("\n");
}
