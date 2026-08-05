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

/** Diff-addressable dimensions (must carry a `.file` per beta.91). */
export const DIFF_ADDRESSABLE = new Set(["spec", "quality", "security"]);
/** Meta dimensions: cross-cutting, `.file` optional, broadcast to all. */
export const META_DIMENSIONS = new Set(["fit", "runtime"]);

function dim(f: MapFinding): string {
  return (f.dimension ?? "").toLowerCase();
}
function fileOf(f: MapFinding): string {
  return (f.file ?? "").trim();
}

/** Is this a diff-addressable finding (spec|quality|security)? */
export function isDiffAddressable(f: MapFinding): boolean {
  return DIFF_ADDRESSABLE.has(dim(f));
}
/** Is this a meta finding (fit|runtime) -> broadcast, exempt from unscopable gate? */
export function isMetaFinding(f: MapFinding): boolean {
  return META_DIMENSIONS.has(dim(f));
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
 */
export function adoptOrphanFindings(
  subTasks: MapSubTask[],
  misses: MapFinding[],
  ownedOf: (st: MapSubTask) => string[],
): OrphanAdoption[] {
  const adoptions: OrphanAdoption[] = [];
  for (const f of misses) {
    const file = fileOf(f);
    if (!file || !isDiffAddressable(f)) continue;
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
      const score = (mentioned ? 1000 : 0) + depth;
      if (score <= 0) continue;
      // Strictly-greater keeps ties on the lowest seq, so adoption is stable
      // across cycles and a re-run maps the same finding to the same worker.
      if (!best || score > best.score) {
        best = { finding: f, file, seq: st.seq, reason: mentioned ? "mentioned_in_finding" : "nearest_path", score };
      }
    }
    if (best) adoptions.push(best);
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
  opts: { adoptOrphans?: boolean } = {},
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
    // Diff-addressable: need a file to structurally target.
    const file = fileOf(f);
    if (isDiffAddressable(f) && file) {
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
    // Diff-addressable but file-less, or an unknown dimension -> treat as
    // broadcast (safe: it reaches every worker as context, never dropped).
    misses.push(f);
  }

  // beta.107: an orphan finding stays broadcast to everyone (never dropped) AND
  // becomes TARGETED on its adopting sub-task, so someone is actually asked to
  // fix it and b91 scoping cannot skip the one worker who could.
  const orphanAdoptions = opts.adoptOrphans
    ? adoptOrphanFindings(subTasks, misses, (st) =>
        [...((st.filesLikelyTouched ?? []) as string[]), ...((st.contextPaths ?? []) as string[])]
          .map((p) => (typeof p === "string" ? p.trim() : ""))
          .filter(Boolean),
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

  return { assignments, mappingMisses: misses, metaBroadcast: meta, anyTargeted, orphanAdoptions };
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
