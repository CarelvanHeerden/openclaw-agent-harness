/**
 * Marker stored in `sessions.clarification_subtask` so a resume can tell a
 * brief-confirmation pause (nothing has run; no worktree exists) apart from a
 * mid-run sub-task pause (commits may exist and must be preserved). Reuses the
 * existing column rather than migrating the schema for one flag.
 */
export const BRIEF_CONFIRMATION_KIND = "brief_confirmation";
/** Sentinel `clarification_seq`: this pause belongs to no sub-task. */
export const BRIEF_CONFIRMATION_SEQ = -2;
export function isBriefConfirmationPause(clarificationSubtask) {
    if (!clarificationSubtask)
        return false;
    try {
        const parsed = JSON.parse(clarificationSubtask);
        return parsed?.kind === BRIEF_CONFIRMATION_KIND;
    }
    catch {
        return false;
    }
}
const RISK_ORDER = { low: 0, medium: 1, high: 2 };
export function riskRank(level) {
    const key = (level ?? "").trim().toLowerCase();
    return key in RISK_ORDER ? RISK_ORDER[key] : RISK_ORDER.medium;
}
/**
 * Decide whether this run pauses for a human to eyeball the brief.
 *
 * Deliberately NOT waived by a file-sourced request: reading the right file does
 * not prove the crystalliser read it the way the user meant. `waived` exists for
 * an explicit operator override only.
 */
export function decideBriefConfirmation(input) {
    if (input.waived === true)
        return { confirm: false, reason: "" };
    if (input.mode === "off")
        return { confirm: false, reason: "" };
    if (input.mode === "always")
        return { confirm: true, reason: "mode_always" };
    // mode === "high_risk"
    return riskRank(input.riskLevel) >= riskRank(input.minRisk)
        ? { confirm: true, reason: "risk_at_or_above_threshold" }
        : { confirm: false, reason: "" };
}
const MAX_CRITERIA_SHOWN = 14;
const MAX_LIST_SHOWN = 12;
const MAX_CRITERION_CHARS = 400;
function bullets(items, max, perItem = MAX_CRITERION_CHARS) {
    const list = (items ?? []).filter((s) => typeof s === "string" && s.trim().length > 0);
    const shown = list.slice(0, max).map((s) => {
        const t = s.trim();
        return `  - ${t.length > perItem ? `${t.slice(0, perItem - 1)}…` : t}`;
    });
    if (list.length > max)
        shown.push(`  - …and ${list.length - max} more`);
    return shown;
}
/**
 * The text a human reads before any money is spent. Leads with the fields that
 * actually catch drift -- the acceptance criteria and the files -- because that
 * is where `scheduledAt` would have stood out.
 */
export function renderBriefConfirmation(input) {
    const b = input.brief;
    const lines = [];
    lines.push(`Before I spend anything, confirm this is what you want built.`);
    lines.push("");
    lines.push(`**${b.title}**`);
    if (b.motivation?.trim()) {
        const m = b.motivation.trim();
        lines.push("");
        lines.push(m.length > 600 ? `${m.slice(0, 599)}…` : m);
    }
    lines.push("");
    lines.push(`Acceptance criteria (${(b.acceptanceCriteria ?? []).length}):`);
    lines.push(...bullets(b.acceptanceCriteria, MAX_CRITERIA_SHOWN));
    if ((b.filesLikelyTouched ?? []).length > 0) {
        lines.push("");
        lines.push("Files it expects to touch:");
        lines.push(...bullets(b.filesLikelyTouched, MAX_LIST_SHOWN, 160));
    }
    if ((b.outOfScope ?? []).length > 0) {
        lines.push("");
        lines.push("Explicitly out of scope:");
        lines.push(...bullets(b.outOfScope, MAX_LIST_SHOWN, 200));
    }
    lines.push("");
    const repo = b.repoHint ? ` in ${b.repoHint}` : "";
    lines.push(`Risk ${b.riskLevel ?? "unknown"}${repo}. Estimated ~$${input.estimatedUsd.toFixed(2)}, cap $${input.effectiveBudget.toFixed(2)}.`);
    lines.push(input.sourcePath
        ? `Source: read verbatim from ${input.sourcePath}.`
        : `Source: the request text as the calling agent supplied it — if you gave it a spec file, check nothing was paraphrased away.`);
    lines.push("");
    lines.push(`Reply "confirm" to start, or tell me what to change (your reply is folded into the brief and the corrected version runs).`);
    return lines.join("\n");
}
/**
 * Recognise a plain, UNQUALIFIED go-ahead.
 *
 * The asymmetry matters: reading "confirm, but use performedAt not scheduledAt"
 * as approval would start a run that ignores the correction -- exactly the
 * failure this whole gate exists to prevent. Reading a bare "confirm" as a
 * correction merely appends a no-op acceptance criterion. So this matches the
 * WHOLE answer or nothing, and every qualified reply is treated as a change.
 */
const AFFIRMATIONS = new Set([
    "confirm",
    "confirmed",
    "yes",
    "y",
    "go",
    "go ahead",
    "proceed",
    "ship it",
    "shipit",
    "approved",
    "approve",
    "lgtm",
    "ok",
    "okay",
    "do it",
    "start",
    "run it",
    "correct",
    "looks good",
    "looks right",
    "that's right",
    "thats right",
]);
export function isBriefConfirmation(answer) {
    const a = (answer ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        // Trailing politeness only -- never a clause that could carry meaning.
        .replace(/[\s,]*(please|thanks|thank you|ta)\b/g, "")
        .replace(/[.!,;:\s]+$/g, "")
        .trim();
    return a.length > 0 && AFFIRMATIONS.has(a);
}
//# sourceMappingURL=brief-confirmation.js.map