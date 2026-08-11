/**
 * beta.119: A FINDING WHOSE FIX NO SINGLE SUB-TASK CAN MAKE.
 *
 * The b118 OpenClaw smoke (session 4c6b04e9, ProjectThanos PR #986) raised the
 * same finding in all three cycles and never fixed it:
 *
 *   "Upload route discards the `kind` and `title` form fields the drawer sends"
 *   file: src/app/api/grc/continuity-exercises/[id]/files/route.ts
 *
 * Routing worked perfectly. The file belongs to sub-task 5 (the file routes),
 * the finding was targeted there, and sub-task 5 ran in both revise cycles. It
 * reported `no-change` both times -- and it was RIGHT to. The adversary's own
 * remedy was "either drop the kind/title UI from the drawer, or add kind/title
 * columns to ContinuityExerciseFile and persist them". The drawer belongs to
 * sub-task 8. The Prisma model belongs to sub-task 1 and its migration to
 * sub-task 2. Sub-task 5 owns the one file that CANNOT be changed alone: there
 * is no column to persist into and no way to remove a dropdown it does not own.
 *
 * So the worker declined, the loop read that as "already correct", the
 * adversary re-raised it, and three cycles bought nothing. This is a different
 * failure from b107/b116/b118 -- those were all MISROUTING, where the finding
 * reached the wrong owner or none. Here it reached exactly the right owner and
 * the owner was structurally incapable of acting alone.
 *
 * Two mechanisms close it:
 *
 *   1. CO-FIX FILES. The adversary now declares `relatedFiles` -- the other
 *      paths that must change for the fix to be complete. Routing targets the
 *      owners of `file` AND of every co-fix path, so the whole set of workers
 *      needed for the change is asked in the same cycle. `relatedFiles` is
 *      advisory from a model, so prose extraction backstops it: any repo path
 *      the finding's own text names is treated as a co-fix candidate.
 *
 *   2. STUCK DETECTION. A finding that survives a cycle in which its owner was
 *      asked to fix it is stuck. Stuck findings widen aggressively on the next
 *      cycle, and one that cannot be widened at all is surfaced on the PR
 *      rather than silently re-raised until the cycle ceiling.
 *
 * Pure and deterministic: no fs, no git, no SDK.
 */

/** The finding shape this module reads (structural, avoids a hard type import). */
export interface CcFinding {
  dimension?: string;
  severity?: string;
  title?: string;
  detail?: string;
  file?: string | null;
  /** beta.119: other paths that must ALSO change for the fix to be complete. */
  relatedFiles?: string[] | null;
}

/**
 * A repo-relative source path inside prose. Requires at least one directory
 * separator and a file extension, so a bare `route.ts` (which matches dozens of
 * files in a Next.js app) is deliberately NOT extracted -- only a path specific
 * enough to identify one file. Bracketed Next.js dynamic segments (`[id]`) and
 * parenthesised route groups (`(portal)`) are part of real paths here.
 */
const PATH_RE = /(?:[\w.@()[\]-]+\/)+[\w.@()[\]-]+\.[a-zA-Z]\w{0,9}/g;
/** A URL, so its path component is not mistaken for a repo path. */
const URL_RE = /\b[a-z][\w+.-]*:\/\/\S+/gi;

/** Pull every plausible repo-relative path out of a finding's prose. */
export function extractRepoPaths(text: string | undefined | null): string[] {
  if (!text) return [];
  // Strip URLs FIRST: `https://github.com/o/r/blob/main/x.ts` contains a
  // perfectly path-shaped tail, and testing the match in isolation cannot see
  // the scheme that precedes it.
  const prose = String(text).replace(URL_RE, " ");
  const out: string[] = [];
  for (const m of prose.matchAll(PATH_RE)) {
    const p = m[0].replace(/^\.\//, "").replace(/[.,;:)]+$/, "");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Every path that must change for this finding to be resolved, EXCLUDING the
 * finding's own `file`. Declared `relatedFiles` first (the model was asked
 * directly), then anything its prose names.
 */
export function coFixFiles(f: CcFinding): string[] {
  const own = (f.file ?? "").trim();
  const declared = (Array.isArray(f.relatedFiles) ? f.relatedFiles : [])
    .map((p) => (typeof p === "string" ? p.trim().replace(/^\.\//, "") : ""))
    .filter(Boolean);
  const fromProse = extractRepoPaths(`${f.title ?? ""}\n${f.detail ?? ""}`);
  const out: string[] = [];
  for (const p of [...declared, ...fromProse]) {
    if (!p || p === own) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Filler and the editorialising vocabulary the adversary adds when it re-raises
 * something ("STILL discards", "prior finding not addressed"). Dropping these
 * is what lets the same defect be recognised through a rewrite.
 */
const TITLE_NOISE = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "that", "this",
  "it", "its", "as", "not", "no", "any", "all", "so", "then", "than",
  "still", "again", "prior", "previously", "remain", "remains", "remaining",
  "unaddressed", "addressed", "repeat", "repeated", "twice", "incomplete",
  "finding", "findings", "issue", "bug", "new", "now",
]);

function titleTokens(title: string | undefined): string[] {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !TITLE_NOISE.has(t));
}

/**
 * A stable identity string for a finding, used for audit records and for
 * set membership WITHIN one cycle. Note this is deliberately NOT the
 * cross-cycle matcher -- see `isSameFinding`, which the adversary's rewording
 * defeats any exact-string key.
 */
export function findingKey(f: CcFinding): string {
  return `${(f.dimension ?? "").toLowerCase().trim()}|${(f.file ?? "").trim()}|${titleTokens(f.title).join(" ")}`;
}

/**
 * The minimum share of the shorter title's significant tokens that must appear
 * in the longer one. The three real b118 titles for one defect were:
 *
 *   c1 "Upload route silently discards `kind` and `title` form fields sent by uploader"
 *   c2 "Upload route STILL discards `kind`/`title` (prior finding not addressed)"
 *   c3 "Upload route STILL discards `kind`/`title` — drawer's kind dropdown is dead UI"
 *
 * They share {upload, route, discards, kind, title} and little else, so the
 * pairwise overlap coefficients are 0.62, 0.55 and 0.62. Jaccard would score
 * these 0.38 and miss them, because each rewrite brings new words rather than
 * dropping old ones.
 */
const SAME_FINDING_OVERLAP = 0.5;
/** Below this, a short title can clear the ratio on coincidence alone. */
const MIN_SHARED_TOKENS = 2;

/**
 * Are these the same defect raised in two different cycles? Same dimension and
 * same file is necessary but nowhere near sufficient -- b118's upload route
 * carried three unrelated findings at once -- so the titles must also overlap
 * substantially.
 */
export function isSameFinding(a: CcFinding, b: CcFinding): boolean {
  if ((a.dimension ?? "").toLowerCase().trim() !== (b.dimension ?? "").toLowerCase().trim()) return false;
  if ((a.file ?? "").trim() !== (b.file ?? "").trim()) return false;
  const ta = new Set(titleTokens(a.title));
  const tb = new Set(titleTokens(b.title));
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  if (shared < MIN_SHARED_TOKENS) return false;
  return shared / Math.min(ta.size, tb.size) >= SAME_FINDING_OVERLAP;
}

/** A finding the previous cycle also raised. */
export interface StuckFinding {
  finding: CcFinding;
  key: string;
  /** How many consecutive cycles it has now been raised in (>= 2). */
  occurrences: number;
}

/**
 * Findings in `current` that were also present in the previous cycle(s).
 *
 * `history` is the per-cycle findings list in cycle order, EXCLUDING `current`.
 * A finding is stuck once it appears in `current` and in the immediately
 * preceding cycle: the loop already ran a revise cycle against it and it
 * survived.
 */
export function detectStuckFindings(history: CcFinding[][], current: CcFinding[]): StuckFinding[] {
  if (history.length === 0) return [];
  const previous = history[history.length - 1] ?? [];
  const out: StuckFinding[] = [];
  for (const f of current) {
    if (!previous.some((p) => isSameFinding(p, f))) continue;
    // Count back through history for the run of consecutive cycles.
    let occurrences = 1;
    for (let i = history.length - 1; i >= 0; i--) {
      if ((history[i] ?? []).some((p) => isSameFinding(p, f))) occurrences += 1;
      else break;
    }
    out.push({ finding: f, key: findingKey(f), occurrences });
  }
  return out;
}

/** A finding that has been raised repeatedly and that nobody could act on. */
export interface UnresolvableFinding {
  key: string;
  title: string;
  file: string;
  severity: string;
  occurrences: number;
  /** Paths the fix also needs, if the finding named any. */
  coFixFiles: string[];
}

/**
 * Render the operator-facing note for findings that survived every cycle. This
 * goes on the PR so a repeated-and-never-fixed finding is stated plainly rather
 * than being buried in a finding list that looks the same as cycle 1's.
 */
export function describeUnresolvable(items: UnresolvableFinding[]): string {
  if (items.length === 0) return "";
  const lines = items.map((u) => {
    const also = u.coFixFiles.length > 0 ? ` The fix also needs: ${u.coFixFiles.join(", ")}.` : "";
    return `- [${u.severity}] ${u.title} (${u.file || "no file"}) — raised in ${u.occurrences} cycles and never resolved.${also}`;
  });
  return [
    `REPEATEDLY UNRESOLVED (${items.length}): the reviewer raised these in consecutive cycles and the assigned worker did not resolve them.`,
    `This usually means the fix spans several sub-tasks, so no single worker could make it alone — the change likely needs to be done by hand, or the scope re-planned.`,
    ...lines,
  ].join("\n");
}
