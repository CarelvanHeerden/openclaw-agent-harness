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
import { guardClarification, } from "./clarification-guard.js";
import { renderRepoAmbiguityQuestion, resolveRepoAlias } from "./repo-alias.js";
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
 * rc.2: assemble the facts a clarification is allowed to rest on.
 *
 * Everything here comes from operator config or from state the caller checked.
 * Nothing is inferred from model output, per the brief's rule that a
 * model-generated claim is not evidence of repository or worktree state.
 */
export function groundingFrom(config, continuation) {
    const repos = (config?.repos ?? {});
    return {
        allowedRepos: Array.isArray(repos.allowed) ? repos.allowed : [],
        defaultBaseBranch: repos.default_base_branch,
        continuation,
    };
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
    const grounding = groundingFrom(deps.config, deps.continuation);
    const audit = (event, payload) => {
        try {
            deps.audit?.(event, payload);
        }
        catch {
            /* an audit write must never fail crystallisation */
        }
    };
    const cls = await deps.callClassifier(userText);
    addSpend(spend, cls);
    deps.logger.info("[crystalliser] classifier", cls);
    // rc.2: what the run proceeds AS, once an ungrounded clarify is withheld.
    // The raw verdict stays in the audit trail; this is the one the brief carries,
    // so a brief never reports that it was classified as needing clarification.
    let effectiveCls = cls;
    if (cls.intent === "clarify") {
        const proposed = cls.suggestedClarification ?? "Could you say a bit more about what you'd like me to do?";
        const verdict = guardClarification(proposed, grounding, "substantive_ambiguity");
        if (verdict.action === "ask") {
            audit("crystallise.clarification_asked", { role: "classifier", reason: verdict.reason, question: verdict.question });
            return { kind: "clarify", question: verdict.question, reason: verdict.reason, spend };
        }
        // rc.2: the classifier asked about state it was never shown. Withholding
        // is not the same as ignoring the ambiguity -- the request continues to the
        // crystalliser, which is the role that can actually name a fork in what
        // gets BUILT, and which re-raises one below if a real fork exists.
        deps.logger.warn("[crystalliser] classifier clarification withheld as ungrounded", {
            suppressed: verdict.suppressed,
            question: verdict.question,
        });
        audit("crystallise.clarification_withheld", {
            role: "classifier",
            suppressed: verdict.suppressed,
            question: verdict.question,
        });
        effectiveCls = { ...cls, intent: "dev_task", reason: `${cls.reason} (ungrounded clarification withheld)` };
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
    // rc.2: settle repository identity deterministically, before any question
    // about it can be asked. A bare "StitchGuard" that matches exactly one
    // allowed entry is not missing information -- it is a name the harness can
    // look up. Only a genuine collision reaches the human, and then the question
    // is ONLY which repository: no path, no worktree, nothing the harness owns.
    const repoResolution = resolveRepoAlias(brief.repoHint, grounding.allowedRepos);
    if (repoResolution.kind === "ambiguous") {
        const question = renderRepoAmbiguityQuestion(repoResolution.hint, repoResolution.candidates);
        audit("crystallise.clarification_asked", {
            role: "harness",
            reason: "repository_ambiguous",
            hint: repoResolution.hint,
            candidates: repoResolution.candidates,
            question,
        });
        return { kind: "clarify", question, reason: "repository_ambiguous", spend };
    }
    if (repoResolution.kind === "resolved" && repoResolution.via === "alias") {
        deps.logger.info("[crystalliser] repo alias resolved", { hint: brief.repoHint, repo: repoResolution.repo });
        audit("crystallise.repo_alias_resolved", { hint: brief.repoHint, repo: repoResolution.repo });
        brief.repoHint = repoResolution.repo;
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
            // rc.2: the same grounding rule applies to the crystalliser's fork. A
            // "fork" between basing on latest main and opening a PR against main is
            // not a fork, and one whose options quote a filesystem path is describing
            // something the crystalliser cannot see.
            const verdict = guardClarification(question, grounding, "substantive_ambiguity");
            if (verdict.action === "ask") {
                deps.logger.info("[crystalliser] bimodal brief -> clarify (pause-and-wait)", {
                    interpretations: interpretations.length,
                    explicit: Boolean(explicit),
                    question,
                });
                audit("crystallise.clarification_asked", {
                    role: "crystalliser",
                    reason: verdict.reason,
                    interpretations: interpretations.length,
                    question: verdict.question,
                });
                return { kind: "clarify", question: verdict.question, reason: verdict.reason, spend };
            }
            deps.logger.warn("[crystalliser] bimodal clarification withheld as ungrounded", {
                suppressed: verdict.suppressed,
                question,
            });
            audit("crystallise.clarification_withheld", {
                role: "crystalliser",
                suppressed: verdict.suppressed,
                question,
            });
        }
    }
    validateBrief(brief);
    return { kind: "brief", brief, classification: effectiveCls, spend };
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