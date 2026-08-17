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
 * Rounding to whole hours only ever reads correctly for the 2h default. A
 * 50-minute ceiling rendered as "1h" on the first local b129 run, and anything
 * under half an hour renders as "0h" -- a number that invites the operator to
 * ignore a limit that is about to stop their run.
 */
function describeWallClock(seconds) {
    const totalMinutes = Math.max(1, Math.round(seconds / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (!hours)
        return `${minutes}m`;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
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
    // beta.122: the cap is the one number an operator most often wants to change
    // at this moment, and until now saying so did nothing -- "Confirm, Budget
    // $40" was filed as a correction to the SPEC and the run started at $10.
    // beta.129: the time half of this has been parsed since b123 and advertised
    // never, so nobody used it. Session d48ba433 was killed by the 2-hour default
    // with $18 of its $40 unspent; "with a time budget of 4 hours" was accepted
    // syntax at that moment and no message anywhere said so. A capability the
    // operator cannot discover is a capability that does not exist.
    lines.push(`To change the cap or the clock at the same time, say it in the reply — e.g. "confirm, budget $30" or ` +
        `"confirm, budget $40 with a time budget of 4 hours" — and the run starts at those numbers. ` +
        `The default wall clock is ${describeWallClock(input.hardTimeoutSeconds ?? 7200)}, and a run that hits it stops whether or not the budget is spent.`);
    if (input.sessionId) {
        lines.push("");
        lines.push(`Session \`${input.sessionId}\`.`);
    }
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
/**
 * beta.123: the TIME half of the same sentence.
 *
 * b122 shipped the money parser and the very next reply was "confirm, set the
 * Budget to $40 with a time budget of 3 hours". Two things went wrong at once.
 * The money regex matches `\bbudget\b` followed by a number, and "time budget
 * of 3 hours" is exactly that shape -- reorder the clauses and the run would
 * have been capped at $3. And the time clause it left behind meant the
 * remainder was never empty, so a plain approval was filed as a spec
 * correction for the second release running.
 *
 * So time is parsed FIRST and cut out of the string, and money is matched on
 * what remains. A unit is required, which is what keeps this away from money:
 * no bare number is ever read as a duration.
 */
const TIME_CLAUSE = new RegExp([
    String.raw `(?:\b(?:set|make|change|raise|bump|increase|extend|put|give|allow|with|and)\b\s+)?`,
    // "give IT A time budget" stacks two of these, so repeat rather than allow one.
    String.raw `(?:\b(?:the|a|an|it|us|my|this)\b\s+)*`,
    String.raw `(?:time\s*(?:budget|limit|cap|box|out)|wall[-\s]?clock(?:\s+(?:budget|limit|cap))?|timebox|deadline)`,
    String.raw `\s*(?:to|of|is|=|:|at)?\s*`,
    String.raw `(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b`,
].join(""), "i");
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
/**
 * The precision here is deliberately lopsided.
 *
 * Missing a budget costs what b121 cost: the reply is filed as a correction and
 * the run uses the default cap. Inventing one is worse -- it would both set a
 * wrong cap and DELETE the matched words from the operator's correction. So
 * every form needs an explicit money marker, except the word "budget" itself,
 * which in a reply to a prompt about the budget cannot mean anything else.
 * "set the retry limit to 3" therefore stays entirely in the correction.
 */
// beta.123: swallow the imperative that introduces the clause. Without this,
// "confirm, set the Budget to $40" leaves "confirm, set the" behind -- not an
// affirmation by any reading, so the approval was lost even once the money was
// understood.
const BUDGET_VERB = String.raw `(?:\b(?:set|make|change|raise|bump|increase|put|use|give)\b\s+(?:\b(?:the|a|an|it|us|my|this)\b\s+)*)?`;
const BUDGET_CLAUSE = new RegExp(BUDGET_VERB +
    "(?:" +
    [
        // "budget $40", "budget: 40", "budget of 40 usd" -- bare number allowed.
        String.raw `\bbudget\b\s*(?:to|of|is|=|:)?\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?`,
        // "cap $30", "ceiling of 30 dollars" -- these words have domain meanings,
        // so a currency marker is required.
        String.raw `\b(?:cap|limit|ceiling)\b\s*(?:to|of|is|=|:)?\s*(?:\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?))`,
        // "$30 budget".
        String.raw `\$\s*(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?\s*(?:budget|cap|limit)\b`,
        // "bump to $40".
        String.raw `\b(?:bump|raise|increase)\b[^.,;]*?\$\s*(\d+(?:\.\d{1,2})?)`,
    ].join("|") +
    ")", "i");
/** Tidy the sentence left behind once a clause has been cut out of it. */
function tidyRemainder(text) {
    return text
        // The conjunction that joined the two clauses is now dangling.
        .replace(/\s*(?:,|;|\band\b|\bbut\b|\bwith\b)\s*$/i, "")
        .replace(/^\s*(?:,|;|\band\b|\bbut\b|\bwith\b)\s*/i, "")
        .replace(/\s+([,.;])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
}
export function parseConfirmationReply(answer) {
    const raw = (answer ?? "").trim();
    // Time first, and cut it out before money is looked for: "a time budget of 3
    // hours" is `budget`-followed-by-a-number, and would otherwise be read as $3.
    let working = raw;
    let timeoutSeconds;
    const t = TIME_CLAUSE.exec(working);
    if (t) {
        const qty = Number(t[1]);
        const unit = (t[2] ?? "").toLowerCase();
        const seconds = Math.round(qty * (unit.startsWith("h") ? 3600 : 60));
        // A duration that is zero, negative, absurd or unparseable is not an
        // instruction we can act on -- leave the words in the correction rather
        // than silently applying a nonsense ceiling.
        if (Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS) {
            timeoutSeconds = seconds;
            working = tidyRemainder(working.replace(t[0], " "));
        }
    }
    const m = BUDGET_CLAUSE.exec(working);
    const captured = m ? m.slice(1).find((g) => typeof g === "string" && g.length > 0) : undefined;
    const value = Number(captured);
    let budgetUsd;
    // A nonsense or non-positive number is not a budget; leave the reply alone
    // and let it be treated as an ordinary correction.
    if (m && Number.isFinite(value) && value > 0) {
        budgetUsd = value;
        working = tidyRemainder(working.replace(m[0], " "));
    }
    const remainder = working === raw ? raw : tidyRemainder(working);
    return {
        budgetUsd,
        timeoutSeconds,
        remainder,
        // Nothing left, or only an affirmation left, means those clauses were the
        // entire qualification -- so this IS an approval.
        approves: remainder.length === 0 || isBriefConfirmation(remainder),
    };
}
//# sourceMappingURL=brief-confirmation.js.map