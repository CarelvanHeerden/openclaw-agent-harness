/**
 * rc.3: a finding has an identity, and it keeps it across chunks and cycles.
 *
 * Before this, a finding was a bare object in an array. Two consequences, both
 * visible on StitchGuard PR #1168:
 *
 * The chunked adversary path (`runAdversarySdk`, for a diff too large to review
 * in one call) does `findings.push(...)` per chunk with no dedup at all. Each
 * chunk is shown the prior chunks' findings and asked not to repeat them, which
 * is a request, not a mechanism -- so the same schema/migration complaint, the
 * same request-race, the same validation gap and the same credential-scope
 * concern each arrived two or three times, and each copy was counted as a
 * separate blocker and routed to a separate worker.
 *
 * And every cycle re-derived its finding set from nothing. A defect fixed in
 * cycle 2 could be re-raised in cycle 3 by a differently-worded finding, while
 * the run had no record that it had ever been closed. Later cycles kept
 * discovering new medium concerns in feature code nobody had touched since
 * cycle 1, so the loop chased a target that grew as fast as it was hit.
 *
 * Identity here is deliberately two-tier. An exact fingerprint over the
 * normalised (source, dimension, file, relatedFiles, title, detail) catches the
 * literal repeats. Equivalence -- same dimension, same primary file, strong
 * distinctive-token overlap in the title -- catches the rewordings, which is
 * most of what a chunked review produces. Both require the FILE to agree, which
 * is the property `isRecycledFinding` lacks and must not pass on: a matcher
 * that ignores the file will happily call two different defects the same one.
 */

import type { ReviewFinding } from "./adversary.js";
import { detectVerificationBlocker } from "./verification-blocker.js";

/**
 * Where a finding is in its life.
 *
 *  - `open`               live defect, drives repair cycles and blocks merge
 *  - `late_discovery`     open, but first raised after cycle 1 against code
 *                         this run had not changed; admitted under the policy
 *                         below and carrying the reason it qualified
 *  - `resolved`           seen in an earlier cycle, absent now, and the file
 *                         has not changed since -- it stays closed
 *  - `stale`              raised again but not admissible: a re-raise of a
 *                         resolved finding with no regression behind it, or a
 *                         late discovery that did not meet the bar. Still shown
 *                         on the PR; no longer drives cycles
 *  - `accepted`           a human decided to ship with it
 *  - `dispositioned`      answered some other way (skipped sub-task, scope call)
 *  - `environment_blocked` nothing a worker can edit will fix it
 */
export type FindingLifecycleState =
  | "open"
  | "resolved"
  | "stale"
  | "accepted"
  | "dispositioned"
  | "environment_blocked"
  | "late_discovery";

/** States in which a finding still argues for another repair cycle. */
export const CYCLE_DRIVING_STATES: ReadonlySet<FindingLifecycleState> = new Set<FindingLifecycleState>([
  "open",
  "late_discovery",
]);

export interface FindingRecord {
  fingerprint: string;
  state: FindingLifecycleState;
  severity: string;
  dimension: string;
  source?: string | null;
  file?: string | null;
  relatedFiles: string[];
  title: string;
  detail: string;
  firstSeenCycle: number;
  lastSeenCycle: number;
  resolvedCycle?: number | null;
  lateDiscoveryReason?: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation and identity
// ---------------------------------------------------------------------------

/**
 * Text reduced to what two people describing the same defect would agree on.
 *
 * Digits go because a finding that names a line number is the same finding when
 * the line moves; back-ticks and quotes go because a model fences identifiers
 * inconsistently between calls.
 */
export function normaliseFindingText(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^a-z0-9/_.\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A repo-relative path reduced to a comparable form. */
export function normaliseFindingPath(p: string | null | undefined): string {
  return (p ?? "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "from",
  "is", "are", "was", "were", "be", "been", "this", "that", "it", "its", "as", "at",
  "by", "into", "not", "no", "can", "will", "should", "must", "may", "does", "do",
  "issue", "problem", "bug", "defect", "finding", "code", "file", "missing", "incorrect",
]);

/** Distinctive words in a title, used for the equivalence tier. */
export function titleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normaliseFindingText(title).split(" ")) {
    if (raw.length >= 4 && !TITLE_STOPWORDS.has(raw)) out.add(raw);
    if (raw.includes("/") || raw.includes(".")) {
      for (const seg of raw.split(/[/.]+/)) {
        if (seg.length >= 4 && !TITLE_STOPWORDS.has(seg)) out.add(seg);
      }
    }
  }
  return out;
}

/**
 * A short stable hash of everything that makes this finding this finding.
 *
 * Deliberately not a cryptographic identity -- it is a dictionary key, and a
 * collision costs one merged finding, not a security property. FNV-1a keeps it
 * dependency-free and stable across processes, which `Math.random`-seeded or
 * insertion-ordered alternatives are not.
 */
export function findingFingerprint(f: ReviewFinding): string {
  const related = [...(f.relatedFiles ?? [])]
    .map(normaliseFindingPath)
    .filter(Boolean)
    .sort()
    .join(",");
  const parts = [
    f.source ?? "adversary",
    f.dimension ?? "",
    normaliseFindingPath(f.file),
    related,
    normaliseFindingText(f.title),
    normaliseFindingText(f.detail),
  ].join("\u0000");

  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i += 1) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // A second pass over the reversed string widens the space enough that a
  // realistic review (tens of findings) will not collide.
  let g = 0x811c9dc5;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    g ^= parts.charCodeAt(i);
    g = Math.imul(g, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, "0")}${g.toString(16).padStart(8, "0")}`;
}

/**
 * Two findings that a reviewer would call the same complaint.
 *
 * Same dimension, same primary file, and enough shared distinctive title
 * tokens. The file agreement is not negotiable: "missing tenant scope" in the
 * credentials route and "missing tenant scope" in the connections route are two
 * defects and two repairs.
 */
export function findingsAreEquivalent(a: ReviewFinding, b: ReviewFinding): boolean {
  if ((a.dimension ?? "") !== (b.dimension ?? "")) return false;
  const fa = normaliseFindingPath(a.file);
  const fb = normaliseFindingPath(b.file);
  // A file-less (META) finding only matches another file-less one; there is no
  // location to agree on, so the title has to carry the whole comparison.
  if (fa !== fb) return false;
  const ta = titleTokens(a.title);
  const tb = titleTokens(b.title);
  if (ta.size === 0 || tb.size === 0) return normaliseFindingText(a.title) === normaliseFindingText(b.title);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  // Jaccard over distinctive tokens, with an absolute floor so a two-word title
  // cannot match on one incidental word.
  const union = new Set([...ta, ...tb]).size;
  return shared >= 2 && shared / union >= 0.5;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0, low: 1, medium: 2, unknown: 3, high: 4, critical: 5,
};

function moreSevere(a: ReviewFinding, b: ReviewFinding): ReviewFinding {
  return (SEVERITY_RANK[b.severity] ?? 3) > (SEVERITY_RANK[a.severity] ?? 3) ? b : a;
}

export interface DuplicateRecord {
  fingerprint: string;
  duplicateOfFingerprint: string;
  title: string;
  file: string | null;
  dimension: string;
  reason: "identical" | "equivalent";
}

/**
 * Collapse equivalent findings into one, keeping the most severe reading.
 *
 * Order is preserved: the surviving finding sits where the first of its group
 * sat, so a report does not reshuffle itself because a later chunk repeated
 * something. `relatedFiles` are unioned -- a duplicate that named one more file
 * the fix needs is the reason to merge rather than discard.
 */
export function dedupeFindings(findings: ReviewFinding[]): {
  kept: ReviewFinding[];
  duplicates: DuplicateRecord[];
} {
  const kept: ReviewFinding[] = [];
  const keptFingerprints: string[] = [];
  const duplicates: DuplicateRecord[] = [];

  for (const raw of findings ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as ReviewFinding;
    const fp = findingFingerprint(f);
    let matchedAt = keptFingerprints.indexOf(fp);
    let reason: DuplicateRecord["reason"] = "identical";
    if (matchedAt < 0) {
      matchedAt = kept.findIndex((k) => findingsAreEquivalent(k, f));
      reason = "equivalent";
    }
    if (matchedAt < 0) {
      kept.push({ ...f, fingerprint: fp });
      keptFingerprints.push(fp);
      continue;
    }
    const winner = moreSevere(kept[matchedAt]!, f);
    const related = new Set<string>([
      ...(kept[matchedAt]!.relatedFiles ?? []),
      ...(f.relatedFiles ?? []),
    ]);
    kept[matchedAt] = {
      ...kept[matchedAt]!,
      severity: winner.severity,
      // A finding the harness itself authored outranks one the model argued;
      // see the `source` doc on ReviewFinding.
      source: kept[matchedAt]!.source ?? f.source,
      relatedFiles: related.size > 0 ? [...related] : kept[matchedAt]!.relatedFiles,
      fingerprint: keptFingerprints[matchedAt],
    };
    duplicates.push({
      fingerprint: fp,
      duplicateOfFingerprint: keptFingerprints[matchedAt]!,
      title: f.title,
      file: f.file ?? null,
      dimension: f.dimension,
      reason,
    });
  }
  return { kept, duplicates };
}

// ---------------------------------------------------------------------------
// Late-discovery policy
// ---------------------------------------------------------------------------

const SECURITY_DIMENSIONS = new Set(["security"]);

/**
 * Whether a finding first raised after cycle 1, against code this run has not
 * changed, is admissible -- and if so, why.
 *
 * Cycle 1 is the full baseline review. After it, later cycles are for verifying
 * the previous cycle's fixes and reviewing what changed. A new medium concern
 * about untouched feature code is how a repair loop turns into whack-a-mole:
 * on #1168 each cycle found a few more, and the count of things to fix never
 * fell. High, critical and security findings are always admitted, because
 * "we did not notice it in cycle 1" is not a reason to ship a vulnerability.
 */
export function lateDiscoveryReason(f: ReviewFinding, exposedByPreviousFix: boolean): string | null {
  if (exposedByPreviousFix) return "exposed by a fix made in a previous cycle";
  if (f.severity === "high" || f.severity === "critical") return `severity ${f.severity} is admitted regardless of when it was found`;
  if (SECURITY_DIMENSIONS.has(f.dimension)) return "security-significant, admitted regardless of when it was found";
  if (f.source === "ci" || f.source === "harness_env" || f.source === "deterministic_scope") {
    return `raised by the harness itself (${f.source}), not by an expanding review surface`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileInput {
  cycle: number;
  /** The deduped findings this cycle produced. */
  current: ReviewFinding[];
  /** Everything already known about this session, keyed by fingerprint. */
  prior: FindingRecord[];
  /** Repo-relative files this cycle's workers actually committed. */
  changedThisCycle: string[];
}

export interface ReconcileResult {
  /** The findings as the run should now see them, each carrying its state. */
  findings: ReviewFinding[];
  /** Rows to write back, including prior findings that just closed. */
  records: FindingRecord[];
  /** State transitions worth an audit line. */
  transitions: Array<{
    fingerprint: string;
    title: string;
    file: string | null;
    from: FindingLifecycleState | "new";
    to: FindingLifecycleState;
    reason: string;
  }>;
  /** Late discoveries, admitted or not. */
  lateDiscoveries: Array<{
    fingerprint: string;
    title: string;
    file: string | null;
    severity: string;
    admitted: boolean;
    reason: string;
  }>;
}

/**
 * Fold this cycle's findings into what the session already knows.
 *
 * The two rules that matter: a finding the adversary stopped raising is
 * resolved, and a resolved finding is only reopened when the file it names has
 * actually changed since. Without the second, one re-worded re-raise undoes a
 * fix that is still in the tree, and the run is back where cycle 2 started.
 */
export function reconcileFindings(input: ReconcileInput): ReconcileResult {
  const { cycle, current, prior, changedThisCycle } = input;
  const changed = new Set(changedThisCycle.map(normaliseFindingPath).filter(Boolean));
  const priorByFp = new Map(prior.map((p) => [p.fingerprint, p]));
  const seen = new Set<string>();

  const findings: ReviewFinding[] = [];
  const records: FindingRecord[] = [];
  const transitions: ReconcileResult["transitions"] = [];
  const lateDiscoveries: ReconcileResult["lateDiscoveries"] = [];

  for (const f of current) {
    const fp = f.fingerprint ?? findingFingerprint(f);
    const existing =
      priorByFp.get(fp) ??
      prior.find((p) => findingsAreEquivalent(recordAsFinding(p), f));
    const file = normaliseFindingPath(f.file);
    const fileChangedThisCycle = file.length > 0 && changed.has(file);

    // rc.3: nothing a worker edits will fix a missing binary, an uninstalled
    // dependency or a network fault, so it never enters the open population at
    // all. It still holds the merge (`env` is merge-blocking), it is never
    // routed to a worker, and it does not buy repair cycles.
    const blocker = detectVerificationBlocker(f);
    if (blocker) {
      const fingerprint = existing?.fingerprint ?? fp;
      const reason = `${blocker.kind}: ${blocker.humanAction}`;
      seen.add(fingerprint);
      records.push({
        ...(existing ?? newRecord(f, fingerprint, cycle, "environment_blocked")),
        state: "environment_blocked",
        severity: f.severity,
        lastSeenCycle: cycle,
        lateDiscoveryReason: reason,
      });
      findings.push({ ...f, fingerprint, lifecycleState: "environment_blocked" });
      if (!existing || existing.state !== "environment_blocked") {
        transitions.push({
          fingerprint,
          title: f.title,
          file: f.file ?? null,
          from: existing?.state ?? "new",
          to: "environment_blocked",
          reason,
        });
      }
      continue;
    }

    // A human or the operator already settled this one. Their answer outranks
    // the adversary raising it again.
    if (existing && (existing.state === "accepted" || existing.state === "dispositioned")) {
      seen.add(existing.fingerprint);
      records.push({ ...existing, lastSeenCycle: cycle });
      findings.push({ ...f, fingerprint: existing.fingerprint, lifecycleState: existing.state });
      continue;
    }

    if (existing && existing.state === "resolved") {
      // Re-raised. Only a change to the file it names counts as the defect
      // visibly regressing; anything else is the adversary rediscovering
      // something that is already fixed in the tree.
      const regressed = fileChangedThisCycle;
      const state: FindingLifecycleState = regressed ? "open" : "stale";
      seen.add(existing.fingerprint);
      records.push({
        ...existing,
        state,
        lastSeenCycle: cycle,
        resolvedCycle: regressed ? null : existing.resolvedCycle,
      });
      findings.push({ ...f, fingerprint: existing.fingerprint, lifecycleState: state });
      transitions.push({
        fingerprint: existing.fingerprint,
        title: f.title,
        file: f.file ?? null,
        from: "resolved",
        to: state,
        reason: regressed
          ? `the file changed again in cycle ${cycle}, so the defect can genuinely have come back`
          : `resolved in cycle ${existing.resolvedCycle ?? "?"} and nothing has touched ${f.file ?? "the file"} since`,
      });
      continue;
    }

    if (existing) {
      seen.add(existing.fingerprint);
      const state = existing.state === "stale" ? "stale" : existing.state;
      records.push({ ...existing, state, severity: f.severity, lastSeenCycle: cycle });
      findings.push({
        ...f,
        fingerprint: existing.fingerprint,
        lifecycleState: state,
        ...(existing.lateDiscoveryReason ? { lateDiscoveryReason: existing.lateDiscoveryReason } : {}),
      });
      continue;
    }

    // Genuinely new to this session.
    const againstUnchangedCode = cycle > 1 && !fileChangedThisCycle;
    if (!againstUnchangedCode) {
      seen.add(fp);
      records.push(newRecord(f, fp, cycle, "open"));
      findings.push({ ...f, fingerprint: fp, lifecycleState: "open" });
      transitions.push({ fingerprint: fp, title: f.title, file: f.file ?? null, from: "new", to: "open", reason: cycle === 1 ? "baseline review" : "against code this cycle changed" });
      continue;
    }

    // After cycle 1, against code nothing has touched: the late-discovery bar.
    const exposedByPreviousFix = (f.relatedFiles ?? []).some((r) => changed.has(normaliseFindingPath(r)));
    const reason = lateDiscoveryReason(f, exposedByPreviousFix);
    const admitted = reason !== null;
    const state: FindingLifecycleState = admitted ? "late_discovery" : "stale";
    seen.add(fp);
    records.push({
      ...newRecord(f, fp, cycle, state),
      lateDiscoveryReason: admitted
        ? reason
        : `first raised in cycle ${cycle} against unchanged code, below the late-discovery bar (needs high/critical, security, or a previous fix that exposed it)`,
    });
    findings.push({
      ...f,
      fingerprint: fp,
      lifecycleState: state,
      lateDiscoveryReason: admitted ? reason! : undefined,
    });
    lateDiscoveries.push({
      fingerprint: fp,
      title: f.title,
      file: f.file ?? null,
      severity: f.severity,
      admitted,
      reason:
        reason ??
        `${f.severity} ${f.dimension} finding first raised in cycle ${cycle} against code this run has not changed`,
    });
    transitions.push({ fingerprint: fp, title: f.title, file: f.file ?? null, from: "new", to: state, reason: reason ?? "below the late-discovery bar" });
  }

  // Anything open that the adversary stopped raising is fixed.
  for (const p of prior) {
    if (seen.has(p.fingerprint)) continue;
    if (p.state === "open" || p.state === "late_discovery") {
      records.push({ ...p, state: "resolved", resolvedCycle: cycle });
      transitions.push({
        fingerprint: p.fingerprint,
        title: p.title,
        file: p.file ?? null,
        from: p.state,
        to: "resolved",
        reason: `not raised in cycle ${cycle}`,
      });
      continue;
    }
    records.push(p);
  }

  return { findings, records, transitions, lateDiscoveries };
}

function newRecord(f: ReviewFinding, fingerprint: string, cycle: number, state: FindingLifecycleState): FindingRecord {
  return {
    fingerprint,
    state,
    severity: f.severity,
    dimension: f.dimension,
    source: f.source ?? null,
    file: f.file ?? null,
    relatedFiles: [...(f.relatedFiles ?? [])],
    title: f.title,
    detail: f.detail ?? "",
    firstSeenCycle: cycle,
    lastSeenCycle: cycle,
    resolvedCycle: null,
    lateDiscoveryReason: null,
  };
}

/** A stored row read back as a finding, so the equivalence test can take it. */
export function recordAsFinding(r: FindingRecord): ReviewFinding {
  return {
    source: (r.source ?? undefined) as ReviewFinding["source"],
    dimension: r.dimension as ReviewFinding["dimension"],
    severity: r.severity as ReviewFinding["severity"],
    title: r.title,
    detail: r.detail,
    file: r.file ?? null,
    relatedFiles: r.relatedFiles,
    fingerprint: r.fingerprint,
    lifecycleState: r.state,
  };
}
