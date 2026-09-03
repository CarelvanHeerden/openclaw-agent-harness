/**
 * Prompt crystallisation.
 *
 * Rough user request in Slack -> structured, well-scoped brief that a lead
 * agent can plan against. Two-step:
 *
 *   1. Classifier (Haiku) decides intent:
 *      - "dev_task"     : real dev work, proceed to crystallisation.
 *      - "clarify"      : ambiguous, ask the user a question.
 *      - "not_dev"      : chat / non-dev request, decline politely.
 *      - "unsafe"       : mentions secrets, deletion, etc.; refuse.
 *
 *   2. If dev_task: the crystalliser produces a strict-schema brief:
 *      { title, motivation, acceptanceCriteria[], filesLikelyTouched[],
 *        outOfScope[], repoHint, riskLevel }.
 *
 * The brief is stored on `sessions.crystallised_prompt` before the loop
 * starts. Users see it as a Slack thread reply and can react with a
 * confirming emoji before execution begins.
 */
function addSpend(into, from) {
    if (!from)
        return;
    if (typeof from.tokensIn === "number")
        into.tokensIn += from.tokensIn;
    if (typeof from.tokensOut === "number")
        into.tokensOut += from.tokensOut;
    if (typeof from.costUsd === "number")
        into.costUsd += from.costUsd;
    else if (typeof from.tokensIn === "number" || typeof from.tokensOut === "number")
        into.partial = true;
}
/**
 * The pure orchestration -- takes injected callables so unit tests never
 * hit the network.
 */
export async function crystallisePrompt(userText, deps, 
/** beta.21: OKF concepts pre-attached by the caller (typically the OpenClaw agent's context enrichment). Pass-through only — crystalliser does not crawl OKF itself. */
concepts) {
    // v2.0.0-beta.1: every exit carries what it spent. The early `clarify` and
    // `reject` returns are the reason this matters — they still ran a classifier
    // call, and reporting zero for them made rejected requests look free. A
    // channel that rejects a hundred prompts a day was invisible in the ledger.
    const spend = { costUsd: 0, tokensIn: 0, tokensOut: 0, partial: false };
    const cls = await deps.callClassifier(userText);
    addSpend(spend, cls);
    deps.logger.info("[crystalliser] classifier", cls);
    if (cls.intent === "clarify") {
        return {
            kind: "clarify",
            question: cls.suggestedClarification ?? "Could you say a bit more about what you'd like me to do?",
            spend,
        };
    }
    if (cls.intent === "not_dev" || cls.intent === "unsafe") {
        return { kind: "reject", reason: cls.reason, intent: cls.intent, spend };
    }
    const brief = await deps.callCrystalliser(userText, cls, concepts);
    addSpend(spend, brief);
    // beta.21: guarantee concepts land on the brief even if the SDK-side
    // crystalliser silently drops the field (e.g. pre-beta.21 model version).
    // The caller's concept list is authoritative when the SDK produces none.
    if (concepts && concepts.length > 0 && (!brief.relevantConcepts || brief.relevantConcepts.length === 0)) {
        brief.relevantConcepts = concepts;
    }
    // beta.80 (F2): planning-time bimodality gate. The crystalliser self-reports
    // competing readings that would produce materially different diffs. When it
    // does (or explicitly asks), PAUSE-AND-WAIT: return a `clarify` (which starts
    // NO session) instead of guessing one reading. Carel's rule: assumptions
    // cause delays -- ask up front. This is the 77-beta gap (nothing ever routed
    // into clarify on a bimodal brief); the crystalliser previously invented one
    // reading and committed to it.
    const briefCfg = (deps.config?.brief ?? {});
    if (briefCfg.bimodal_clarify !== false) {
        const minInterp = typeof briefCfg.bimodal_min_interpretations === "number" ? briefCfg.bimodal_min_interpretations : 2;
        const interpretations = Array.isArray(brief.interpretations) ? brief.interpretations : [];
        const explicit = brief.clarificationNeeded?.question?.trim();
        if (explicit || interpretations.length >= minInterp) {
            const question = renderBimodalClarification(brief, interpretations);
            deps.logger.info("[crystalliser] bimodal brief -> clarify (pause-and-wait)", {
                interpretations: interpretations.length,
                explicit: Boolean(explicit),
                question,
            });
            return { kind: "clarify", question, spend };
        }
    }
    validateBrief(brief);
    return { kind: "brief", brief, classification: cls, spend };
}
/**
 * beta.80 (F2): render the fork the crystalliser found into a single
 * pause-and-wait question. Prefers the crystalliser's own explicit
 * clarificationNeeded (question + options); falls back to enumerating the
 * distinct interpretations.
 */
function renderBimodalClarification(brief, interpretations) {
    const cn = brief.clarificationNeeded;
    if (cn?.question?.trim()) {
        const opts = (cn.options ?? []).filter((o) => typeof o === "string" && o.trim().length > 0);
        if (opts.length > 0) {
            const lettered = opts.map((o, i) => `(${String.fromCharCode(97 + i)}) ${o}`).join("  ");
            return `${cn.question.trim()}  Options: ${lettered}`;
        }
        return cn.question.trim();
    }
    const lines = interpretations
        .map((it, i) => `(${String.fromCharCode(97 + i)}) ${it.reading}${it.whatDiffers ? ` — ${it.whatDiffers}` : ""}`)
        .join("  ");
    return `This request has more than one valid interpretation that would produce different changes. Which do you want?  ${lines}`;
}
function validateBrief(brief) {
    if (!brief.title || brief.title.length < 3)
        throw new Error("brief.title too short");
    if (!brief.motivation || brief.motivation.length < 10) {
        throw new Error("brief.motivation too short");
    }
    if (!Array.isArray(brief.acceptanceCriteria) || brief.acceptanceCriteria.length === 0) {
        throw new Error("brief.acceptanceCriteria must be non-empty");
    }
    if (!["low", "medium", "high"].includes(brief.riskLevel)) {
        throw new Error(`brief.riskLevel invalid: ${brief.riskLevel}`);
    }
}
//# sourceMappingURL=prompt-refiner.js.map