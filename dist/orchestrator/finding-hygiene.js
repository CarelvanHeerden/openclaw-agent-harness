/**
 * beta.49 (C): revise-brief finding hygiene.
 *
 * `harness_revise` builds its brief from the prior session's STORED adversary
 * findings (reviews table) verbatim -- it never re-runs the adversary, so a
 * finding emitted before C3 (beta.48 adversary discipline) survives forever.
 * Session 21da9f9c's finding 10 ("rename grc/ -> governance-risk/ IF no
 * existing grc dir exists") was exactly this: a CONDITIONAL premise that was
 * factually false (91 grc files already existed), replayed into every
 * revise-of-21da9f9c and refused every time.
 *
 * A CONDITIONAL finding is one whose stated action depends on an unverified
 * claim about repo state. We can't reliably re-verify arbitrary prose against
 * the repo at brief-build time (no worktree yet), so instead we DEMOTE it: the
 * finding is rewritten so the lead emits a premise-check observe sub-task
 * first and only mutates if the premise holds. Combined with beta.48 C1/C2, a
 * contradicted premise now produces a visible, non-fatal skip instead of a
 * hard worker refusal that kills the run.
 *
 * This module is a pure, exported helper so the detection is unit-testable
 * (the buildReviseBrief closure in registration.ts is not importable).
 */
/**
 * Matches unresolved repo-state conditionals: "if no X", "unless Y",
 * "assuming Z", "if ... exist(s)", "provided that", "only if", etc.
 */
export const CONDITIONAL_FINDING_RE = /\b(if\s+no\b|if\s+there\s+(is|are)\s+no\b|if\s+.*\bdoes\s+not\s+exist|assuming\b|unless\b|provided\s+that\b|so\s+long\s+as\b|only\s+if\b|when\s+no\b|if\s+.*\bexist)/i;
/** Extract the human-readable text of a stored finding (schema is loose). */
export function findingText(f) {
    const o = (f ?? {});
    return String(o.message ?? o.finding ?? o.detail ?? o.description ?? "");
}
/** True when the finding's action depends on an unresolved repo-state premise. */
export function isConditionalFinding(f) {
    return CONDITIONAL_FINDING_RE.test(findingText(f));
}
// ---------------------------------------------------------------------------
// beta.58 (D1/D2): durable skip -- strip the owning finding line from a revise
// brief's acceptanceCriteria when the operator skips the paused sub-task.
// ---------------------------------------------------------------------------
// Numbered finding line as emitted by buildReviseBrief: "10. [high] rename ...".
const FINDING_LINE_RE = /^\s*\d+\.\s*(\[[^\]]*\]\s*)?/;
const STOPWORDS = new Set([
    "the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "is", "are",
    "be", "this", "that", "it", "as", "at", "by", "from", "into", "per", "finding",
    "conditional", "premise", "repo", "file", "files", "do", "not", "make", "change",
]);
function contentTokens(s) {
    const out = new Set();
    for (const raw of (s ?? "").toLowerCase().replace(/[^a-z0-9/_.-]+/g, " ").split(/\s+/)) {
        if (raw.length >= 3 && !STOPWORDS.has(raw))
            out.add(raw);
        // Decompose path-shaped tokens (src/lib/grc/taxonomy-tree.ts) into their
        // segments too, so a path in the sub-task intent overlaps a bare dir name
        // (grc) in the finding line.
        if (/[/.]/.test(raw)) {
            for (const seg of raw.split(/[/.]+/)) {
                if (seg.length >= 3 && !STOPWORDS.has(seg))
                    out.add(seg);
            }
        }
    }
    return out;
}
/**
 * Drop the numbered finding line(s) from `lines` whose content strongly
 * overlaps the paused sub-task's title/intent (the finding that sub-task was
 * addressing). Conservative: ONLY numbered finding-shaped lines are eligible
 * (structural lines like "Address each adversary finding..." or original
 * acceptance criteria are never touched), and a line is dropped only when the
 * distinctive-token overlap clears a threshold. A false NEGATIVE (nothing
 * stripped) is safe -- the content-keyed outOfScope prohibition still tells the
 * lead not to do the work; a false POSITIVE would silently drop a real finding,
 * so we err toward keeping.
 */
export function removeOwningFindingLines(lines, pausedTitle, pausedIntent) {
    const want = new Set([...contentTokens(pausedTitle), ...contentTokens(pausedIntent)]);
    if (want.size === 0)
        return { kept: lines, dropped: [] };
    const kept = [];
    const dropped = [];
    for (const line of lines) {
        if (!FINDING_LINE_RE.test(line)) {
            kept.push(line);
            continue;
        }
        const lineToks = contentTokens(line.replace(FINDING_LINE_RE, ""));
        if (lineToks.size === 0) {
            kept.push(line);
            continue;
        }
        let hits = 0;
        for (const t of lineToks)
            if (want.has(t))
                hits++;
        // Require BOTH an absolute floor (>=2 distinctive shared tokens) and that a
        // meaningful fraction of the finding line's tokens are shared, so an
        // incidental single-word overlap doesn't nuke an unrelated finding. The
        // ratio floor is deliberately modest (0.3) because a real revise finding
        // line is verbose (severity, location, the CONDITIONAL PREMISE annotation)
        // -- the >=2-hit floor is the true incidental-match guard.
        const ratio = hits / lineToks.size;
        if (hits >= 2 && ratio >= 0.3)
            dropped.push(line);
        else
            kept.push(line);
    }
    return { kept, dropped };
}
//# sourceMappingURL=finding-hygiene.js.map