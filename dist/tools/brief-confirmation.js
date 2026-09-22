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
    lines.push("");
    lines.push("Files it expects to touch:");
    lines.push(...(bullets(b.filesLikelyTouched, MAX_LIST_SHOWN, 160).length
        ? bullets(b.filesLikelyTouched, MAX_LIST_SHOWN, 160)
        : ["  - (none specified)"]));
    lines.push("");
    lines.push("Explicitly out of scope:");
    lines.push(...(bullets(b.outOfScope, MAX_LIST_SHOWN, 200).length
        ? bullets(b.outOfScope, MAX_LIST_SHOWN, 200)
        : ["  - (none specified)"]));
    lines.push("");
    lines.push(`Repository ${b.repoHint ?? "(not specified)"}. Risk ${b.riskLevel ?? "unknown"}. ` +
        `Estimated ~$${input.estimatedUsd.toFixed(2)}, cap $${input.effectiveBudget.toFixed(2)}.`);
    lines.push(input.sourcePath
        ? `Source: read verbatim from ${input.sourcePath}.`
        : `Source: the request text as the calling agent supplied it — if you gave it a spec file, check nothing was paraphrased away.`);
    lines.push("");
    lines.push(`In the direct answer command, use "confirm" to start. To propose a correction, use "revise brief: <what to change>". ` +
        `A revision stays paused until you review and explicitly confirm its complete stored proposal. Other replies do not start work.`);
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
        lines.push(`Human approval requires a direct command: /harness-answer ${input.sessionId}. Review its complete state and send the one-use command yourself. Agent-tool relays cannot approve.`);
    }
    return lines.join("\n");
}
/**
 * Recognise a plain, UNQUALIFIED go-ahead.
 *
 * The asymmetry matters: reading "confirm, but use performedAt not scheduledAt"
 * as approval would start a run that ignores the correction -- exactly the
 * failure this whole gate exists to prevent. This matches the WHOLE answer
 * or nothing; a correction is proposed separately and cannot start work.
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
    "continue",
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
const TIME_UNIT = String.raw `(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)`;
/**
 * rc.6: the cue can follow the number as easily as precede it. "Confirm, Budget
 * $50 with a 10 hour budget" is one of the replies this gate actually received,
 * and `TIME_CLAUSE` reads cue-then-number only, so the ten hours were lost while
 * the fifty dollars landed.
 */
const TIME_CLAUSE_TRAILING = new RegExp([
    String.raw `(?:\b(?:with|and|for|within|give|allow|in)\b\s+)?`,
    String.raw `(?:\b(?:a|an|the|it|us|my|this)\b\s+)*`,
    String.raw `(\d+(?:\.\d+)?)\s*` + TIME_UNIT,
    String.raw `\s*(?:time\s*)?(?:budget|limit|cap|box)\b`,
].join(""), "i");
/**
 * rc.6: "budget of 10 hours" is the trap the b123 comment names from the other
 * direction. `BUDGET_CLAUSE` matches `budget`-then-number and would cap the run
 * at $10; the unit says plainly that this is a clock. Time is parsed first, so
 * matching it here is what stops the money regex ever seeing it.
 */
const BUDGET_OF_DURATION = new RegExp(String.raw `\bbudget\b\s*(?:to|of|is|=|:|at)?\s*(\d+(?:\.\d+)?)\s*` + TIME_UNIT + String.raw `\b`, "i");
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
const CURRENCY_FIRST_BUDGET = new RegExp(String.raw `\$\s*(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?\s*(?:budget|cap|limit)\b`, "i");
const PRESERVATION_CLAUSE = /(?:^|[\n.;])\s*((?:please\s+)?(?:preserve|keep|retain)\s+(?:(?:all|the|existing|current)\s+(?:restrictions|requirements|scope|boundaries|controls|limits)|everything(?:\s+else)?)(?:\s+unchanged)?)\s*(?=$|[\n.;])/gi;
/**
 * rc.6: the shorthand, with no cue word at all.
 *
 * These are deliberately NOT part of the clauses above, and they are only ever
 * consulted under the affirmation-only gate in `parseConfirmationReply`. A bare
 * number is the one shape that can equally well belong to the feature ("the
 * price threshold should be $60"), so the only safe licence to read it as a
 * limit is that there is no feature text for it to belong to.
 */
const BARE_MONEY = /(?:\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b)/i;
const BARE_DURATION = new RegExp(String.raw `(\d+(?:\.\d+)?)\s*` + TIME_UNIT + String.raw `\b`, "i");
/**
 * rc.6: text that names a control and still has no number we can use.
 *
 * Scanned over what is LEFT once every clause above has been cut out, so a
 * budget that parsed cleanly can never trip it. The windows are short and stop
 * at clause punctuation on purpose: "confirm but set the retry limit to 3" has
 * to stay an ordinary correction, and so does "the budget column should be an
 * integer". What must not stay an ordinary correction is "budget -$50", where
 * the operator plainly meant a cap and no cap was read.
 */
const MONEY_CUE_RESIDUE = /\bbudget\b[^.,;]{0,16}?(?:\d|\$)/i;
const CURRENCY_CUE_RESIDUE = /\b(?:cap|ceiling|limit)\b[^.,;]{0,16}?(?:\$|\busd\b|\bdollars?\b)/i;
const TIME_CUE_RESIDUE = /\b(?:time\s*(?:budget|limit|cap|box|out)|timebox|wall[-\s]?clock|deadline|timeout)\b[^.,;]{0,16}?\d/i;
/** Tidy the sentence left behind once a clause has been cut out of it. */
function tidyRemainder(text) {
    return text
        // rc.6: a clause cut out of the MIDDLE leaves orphaned punctuation behind.
        // "yes — $60, 10 hrs, please" reduces to "yes — , , please", which is the
        // affirmation it always was and no longer looks like one.
        .replace(/\s*[—–-]+\s*(?=[,;]|\s*$)/g, "")
        .replace(/(?:\s*,\s*){2,}/g, ", ")
        // The conjunction that joined the two clauses is now dangling.
        .replace(/\s*(?:,|;|\band\b|\bbut\b|\bwith\b)\s*$/i, "")
        .replace(/^\s*(?:,|;|\band\b|\bbut\b|\bwith\b)\s*/i, "")
        .replace(/\s+([,.;])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
}
const HOLD_CLAUSE = /\b(?:do\s+not|don't|dont|must\s+not|cannot|can't)\s+(?:start|begin|run|proceed|continue)\b|\b(?:wait|hold|pause|not\s+yet)\b|\b(?:start|begin|run|proceed|continue)\s+only\s+after\b|\buntil\s+(?:i|we)\s+(?:approve|confirm|review)\b/i;
const CONTROL_CUE = /\b(?:budget|cap|ceiling|time\s*(?:budget|limit|cap|box|out)|timebox|wall[- ]?clock|deadline|timeout)\b/i;
const CONTROL_REFERENCE = /\b(?:budget|cap|ceiling|time\s*(?:budget|limit|cap|box|out)|timebox|wall[- ]?clock|deadline|timeout)\b|\$\s*\d/i;
const CONDITIONAL_OR_HISTORICAL = /\b(?:if|unless|provided|assuming|when)\b|\b(?:previous|prior|earlier|last)\s+(?:message|reply|plan|answer)\b|\b(?:said|quoted|mentioned|referred to)\b/i;
const ALTERNATIVE_OR_RANGE = /(?:\$\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:usd|dollars?|hours?|hrs?|minutes?|mins?))\s*(?:or|to|through|-)\s*(?:\$\s*)?\d/i;
const PARTIAL_CONTROL_NUMBER = /\$\s*\d+\.\d{3,}|\bbudget\b[^;\n]*\d+\.\d{3,}/i;
const PRESERVATION_WHOLE = /^(?:please\s+)?(?:preserve|keep|retain|honou?r|respect|maintain)\s+(?:(?:all|the|existing|current)\s+)?(?:restrictions|requirements|scope|boundaries|controls|limits|budget\s+and\s+time\s+limits|time\s+and\s+budget\s+limits|everything(?:\s+else)?)(?:\s+unchanged)?[.!]?$/i;
const AFFIRMATION_PREFIX = /^(?:please\s+)?(?:confirm(?:ed)?|yes|y|go(?:\s+ahead)?|proceed|approved?|lgtm|ok(?:ay)?|do\s+it|start|run\s+it|continue|correct|looks\s+(?:good|right)|that'?s\s+right)\s*[,.:—–-]\s*/i;
const BARE_BUDGET_WHOLE = /^(?:budget\s*(?:to|of|is|=|:)?\s*)?(?:\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?))(?:\s*(?:budget|cap|limit))?[.!]?$/i;
const BARE_TIME_WHOLE = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?:\s*(?:time\s*)?(?:budget|limit|cap|box))?[.!]?$/i;
function addControlValue(values, value, control, text, ambiguities) {
    const valid = Number.isFinite(value) && value > 0 && (control !== "timeout" || value <= MAX_TIMEOUT_SECONDS);
    if (!valid) {
        ambiguities.push({ control, kind: "out_of_range", text });
        return;
    }
    values.push(value);
}
/**
 * rc.6 (#1184): the same sentence, one release later, and the third distinct
 * way this gate has mishandled it.
 *
 * The operator was invited to name a cap in his reply. He replied:
 *
 *     Confirm, $60, 10 hours
 *
 * Neither clause carries a cue word, so neither parsed, so the reply was not an
 * approval -- and `registration.ts` does one thing with a non-approval: it
 * files the WHOLE STRING as an authoritative acceptance criterion and starts
 * the run anyway. "$60, 10 hours" became a stated requirement of a compliance
 * calendar, and the session began at the $50 and five hours nobody had asked
 * for. Three hours later it declined the CI repair that would have made the
 * branch green, because it had spent $53.81 against the $50 it was never told
 * to raise. Both halves of that outcome trace to this function returning
 * `approves: false` with no limits.
 *
 * Two changes, pulling deliberately in opposite directions:
 *
 *  1. READ THE SHORTHAND. A bare "$60" or "10 hours" in a reply that is
 *     otherwise nothing but "confirm" cannot mean anything except the limits,
 *     because there is no other content for it to belong to. That gate -- the
 *     leftovers must reduce to an affirmation -- is exactly what keeps
 *     "confirm, but the price threshold should be $60" a feature correction.
 *
 *  2. FAIL CLOSED ON THE REST. Anything that names a control and still yields
 *     no usable number ("budget of 0", "time budget of 400 hours", "budget
 *     -$50") now stops the run and asks. Until rc.6 these fell through to
 *     prose, which ignored the instruction AND pasted it into the spec. One
 *     extra message is cheap; the alternative cost a session.
 *
 * The b122 asymmetry underneath is unchanged: inventing a cap is worse than
 * missing one, because it sets a wrong ceiling AND deletes the operator's
 * words from their correction.
 */
export function parseConfirmationReply(answer) {
    const raw = (answer ?? "").trim();
    const ambiguities = [];
    const preservationClauses = [];
    const budgetValues = [];
    const timeoutValues = [];
    const corrections = [];
    let sawApproval = false;
    for (const originalClause of raw.split(/[\n;,]+/)) {
        const clause = originalClause.trim();
        if (!clause)
            continue;
        if (/^(?:please|thanks|thank you|ta)[.!]?$/i.test(clause))
            continue;
        if (HOLD_CLAUSE.test(clause)) {
            ambiguities.push({ control: "approval", kind: "hold", text: clause });
            continue;
        }
        if (PRESERVATION_WHOLE.test(clause)) {
            preservationClauses.push(clause);
            continue;
        }
        if (/\b(?:preserve|keep|retain|honou?r|respect|maintain)\b/i.test(clause) && /\b(?:except|unless|but)\b/i.test(clause)) {
            ambiguities.push({ control: "approval", kind: "ambiguous_alternative", text: clause });
            continue;
        }
        if (isBriefConfirmation(clause)) {
            sawApproval = true;
            continue;
        }
        if (CONTROL_REFERENCE.test(clause) && CONDITIONAL_OR_HISTORICAL.test(clause)) {
            ambiguities.push({ control: "approval", kind: "conditional_or_historical", text: clause });
            continue;
        }
        if (/^(?:if|unless|provided|assuming|when)\b/i.test(clause)) {
            ambiguities.push({ control: "approval", kind: "conditional_or_historical", text: clause });
            continue;
        }
        if (ALTERNATIVE_OR_RANGE.test(clause)) {
            ambiguities.push({ control: CONTROL_CUE.test(clause) || /\$/.test(clause) ? "budget" : "timeout", kind: "ambiguous_alternative", text: clause });
            continue;
        }
        if (PARTIAL_CONTROL_NUMBER.test(clause)) {
            ambiguities.push({ control: "budget", kind: "partial_amount", text: clause });
            continue;
        }
        const correctionAfterApproval = /^(?:please\s+)?(?:confirm(?:ed)?|yes|y|go(?:\s+ahead)?|proceed|approved?|lgtm|ok(?:ay)?|do\s+it|start|run\s+it|continue)\s*,\s*but\b/i.test(clause);
        let working = correctionAfterApproval
            ? clause
            : clause.replace(AFFIRMATION_PREFIX, () => {
                sawApproval = true;
                return "";
            });
        working = tidyRemainder(working);
        const bareBudget = BARE_BUDGET_WHOLE.exec(working);
        if (bareBudget) {
            const value = Number(bareBudget[1] ?? bareBudget[2]);
            addControlValue(budgetValues, value, "budget", clause, ambiguities);
            continue;
        }
        const bareTime = BARE_TIME_WHOLE.exec(working);
        if (bareTime) {
            const qty = Number(bareTime[1]);
            const seconds = Math.round(qty * ((bareTime[2] ?? "").toLowerCase().startsWith("h") ? 3600 : 60));
            addControlValue(timeoutValues, seconds, "timeout", clause, ambiguities);
            continue;
        }
        for (const re of [TIME_CLAUSE, BUDGET_OF_DURATION, TIME_CLAUSE_TRAILING]) {
            const match = re.exec(working);
            if (!match)
                continue;
            const qty = Number(match[1]);
            const seconds = Math.round(qty * ((match[2] ?? "").toLowerCase().startsWith("h") ? 3600 : 60));
            addControlValue(timeoutValues, seconds, "timeout", match[0].trim(), ambiguities);
            working = tidyRemainder(working.replace(match[0], " "));
            break;
        }
        for (const re of [CURRENCY_FIRST_BUDGET, BUDGET_CLAUSE]) {
            const match = re.exec(working);
            if (!match)
                continue;
            const captured = match.slice(1).find((part) => typeof part === "string" && part.length > 0);
            addControlValue(budgetValues, Number(captured), "budget", match[0].trim(), ambiguities);
            working = tidyRemainder(working.replace(match[0], " "));
            break;
        }
        // Comma-separated shorthand is actionable only when every remaining token
        // is an approval or a complete control. Otherwise the numbers stay in the
        // feature correction verbatim.
        {
            let trial = working;
            const trialBudgets = [];
            const trialTimeouts = [];
            const duration = BARE_DURATION.exec(trial);
            if (duration) {
                const qty = Number(duration[1]);
                trialTimeouts.push(Math.round(qty * ((duration[2] ?? "").toLowerCase().startsWith("h") ? 3600 : 60)));
                trial = tidyRemainder(trial.replace(duration[0], " "));
            }
            const money = BARE_MONEY.exec(trial);
            if (money) {
                trialBudgets.push(Number(money[1] ?? money[2]));
                trial = tidyRemainder(trial.replace(money[0], " "));
            }
            if ((duration || money) && (!trial || isBriefConfirmation(trial))) {
                if (isBriefConfirmation(trial))
                    sawApproval = true;
                for (const value of trialBudgets)
                    addControlValue(budgetValues, value, "budget", clause, ambiguities);
                for (const value of trialTimeouts)
                    addControlValue(timeoutValues, value, "timeout", clause, ambiguities);
                continue;
            }
        }
        if (!working || isBriefConfirmation(working)) {
            if (isBriefConfirmation(working))
                sawApproval = true;
            continue;
        }
        if (MONEY_CUE_RESIDUE.test(working) || CURRENCY_CUE_RESIDUE.test(working)) {
            ambiguities.push({ control: "budget", kind: "unreadable_amount", text: working });
            continue;
        }
        if (TIME_CUE_RESIDUE.test(working)) {
            ambiguities.push({ control: "timeout", kind: "unreadable_amount", text: working });
            continue;
        }
        corrections.push(working);
    }
    const uniqueBudgets = [...new Set(budgetValues)];
    const uniqueTimeouts = [...new Set(timeoutValues)];
    if (uniqueBudgets.length > 1) {
        ambiguities.push({ control: "budget", kind: "conflicting_values", text: uniqueBudgets.join(", ") });
    }
    if (uniqueTimeouts.length > 1) {
        ambiguities.push({ control: "timeout", kind: "conflicting_values", text: uniqueTimeouts.join(", ") });
    }
    const budgetUsd = uniqueBudgets.length === 1 ? uniqueBudgets[0] : undefined;
    const timeoutSeconds = uniqueTimeouts.length === 1 ? uniqueTimeouts[0] : undefined;
    const featureRemainder = corrections.length > 0 &&
        budgetUsd === undefined &&
        timeoutSeconds === undefined &&
        preservationClauses.length === 0
        ? raw
        : corrections.join("\n").trim();
    const remainder = featureRemainder || (sawApproval ? "confirm" : "");
    return {
        budgetUsd,
        timeoutSeconds,
        remainder,
        ambiguities,
        preservationClauses,
        // Nothing left, or only an affirmation left, means those clauses were the
        // entire qualification -- so this IS an approval.
        approves: ambiguities.length === 0 &&
            featureRemainder.length === 0 &&
            sawApproval,
    };
}
/**
 * The narrow question to put back to the operator when a control could not be
 * read. Deliberately quotes their own words and asks for one thing.
 */
export function describeControlAmbiguities(ambiguities) {
    const lines = [];
    lines.push(`I have not started the run, because part of that reply looks like a limit and I could not read it as one. ` +
        `Guessing would either spend money you did not authorise or quietly keep a default you meant to change.`);
    lines.push("");
    for (const a of ambiguities) {
        if (a.control === "approval") {
            const why = a.kind === "hold"
                ? "tells the harness not to start yet"
                : a.kind === "conditional_or_historical"
                    ? "does not provide present, unconditional authorization"
                    : "has more than one possible instruction";
            lines.push(`  - "${a.text}" ${why}.`);
            continue;
        }
        const name = a.control === "budget" ? "budget" : "wall clock";
        const why = a.kind === "out_of_range"
            ? `is not a ${name} the harness can run under`
            : a.kind === "conflicting_values"
                ? `gives the ${name} a second, different value`
                : `names a ${name} but no amount I can read`;
        lines.push(`  - "${a.text}" ${why}.`);
    }
    lines.push("");
    lines.push(`Reply with the limits stated plainly and nothing else — for example "confirm, budget $60, 10 hours" — ` +
        `or "confirm" on its own to start at the current limits.`);
    return lines.join("\n");
}
/**
 * rc.6: the receipt.
 *
 * The gate used to answer "Brief confirmed; session is running" whatever it had
 * actually persisted, so an operator who set a cap and an operator whose cap was
 * silently dropped read the same sentence. This states the numbers the run will
 * be governed by, and its caller builds it from a re-read of the row rather than
 * from what it intended to write.
 */
export function renderLimitsReceipt(limits) {
    const clamped = typeof limits.requestedBudgetUsd === "number" && limits.requestedBudgetUsd > limits.budgetUsd
        ? ` (you asked for $${limits.requestedBudgetUsd.toFixed(2)}; the operator ceiling is $${limits.budgetUsd.toFixed(2)})`
        : "";
    // rc.6: "a run that hits either stops" was true of the clock and false of the
    // money, and the money half is RC-2 of the #1184 postmortem in one sentence.
    // Spend is soft; the wall is the daily cap. Saying otherwise is what left an
    // operator unable to predict either behaviour.
    const reserve = typeof limits.repairReserveUsd === "number" && limits.repairReserveUsd > 0
        ? ` Of that, $${limits.repairReserveUsd.toFixed(2)} is held back for CI repair, so a red build can still be fixed.`
        : "";
    return (`Running under budget $${limits.budgetUsd.toFixed(2)}${clamped} and a wall clock of ` +
        `${describeWallClock(limits.hardTimeoutSeconds)}. The clock is a hard stop; the budget is a target ` +
        `— spend past it warns and the run continues, and your daily cap is what actually stops it.${reserve}`);
}
//# sourceMappingURL=brief-confirmation.js.map