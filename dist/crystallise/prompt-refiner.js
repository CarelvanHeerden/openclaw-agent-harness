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
 *   2. If dev_task: Fable-5 crystalliser produces a strict-schema brief:
 *      { title, motivation, acceptanceCriteria[], filesLikelyTouched[],
 *        outOfScope[], repoHint, riskLevel }.
 *
 * The brief is stored on `sessions.crystallised_prompt` before the loop
 * starts. Users see it as a Slack thread reply and can react with a
 * confirming emoji before execution begins.
 */
import { detectApiExecutionBrief, buildApiExecutionClarification } from "./api-execution-detect.js";
/**
 * The pure orchestration -- takes injected callables so unit tests never
 * hit the network.
 */
export async function crystallisePrompt(userText, deps, 
/** beta.21: OKF concepts pre-attached by the caller (typically the OpenClaw agent's context enrichment). Pass-through only — crystalliser does not crawl OKF itself. */
concepts) {
    const cls = await deps.callClassifier(userText);
    deps.logger.info("[crystalliser] classifier", cls);
    if (cls.intent === "clarify") {
        return {
            kind: "clarify",
            question: cls.suggestedClarification ?? "Could you say a bit more about what you'd like me to do?",
        };
    }
    if (cls.intent === "not_dev" || cls.intent === "unsafe") {
        return { kind: "reject", reason: cls.reason, intent: cls.intent };
    }
    const brief = await deps.callCrystalliser(userText, cls, concepts);
    // beta.21: guarantee concepts land on the brief even if the SDK-side
    // crystalliser silently drops the field (e.g. pre-beta.21 model version).
    // The caller's concept list is authoritative when the SDK produces none.
    if (concepts && concepts.length > 0 && (!brief.relevantConcepts || brief.relevantConcepts.length === 0)) {
        brief.relevantConcepts = concepts;
    }
    // beta.79 (F1): API-execution detection. The DR/BCP smoke (session 95b341cb)
    // proved the lead silently pivots an API-EXECUTION task (every AC a live-
    // system side-effect) into markdown docs, because it has no execute-against-
    // external-API mode. Detect that class on the CRYSTALLISED brief (ACs are
    // structured here) and return a `clarify` (reusing the existing human-in-loop
    // entry) rather than proceeding to plan docs-about-the-procedure. Master
    // switch + thresholds are config-tunable; detection biases false-NEGATIVE so
    // a normal repo task that merely mentions an endpoint is not blocked.
    // Defensive: a partial test config (or a pre-beta.79 config object) may omit
    // the `brief` block entirely. Treat a missing block as "detection on with
    // defaults" only when the block exists; when the whole config.brief is absent
    // (unit tests passing `config: {}`), fall back to the module defaults inside
    // detectApiExecutionBrief by passing undefined thresholds (enabled defaults
    // true). This never throws on a missing field.
    const apiCfg = (deps.config?.brief ?? {});
    const apiDetection = detectApiExecutionBrief(brief, {
        enabled: apiCfg.api_execution_detection,
        minCriteria: apiCfg.api_execution_min_criteria,
        minRatio: apiCfg.api_execution_min_ratio,
    });
    if (apiDetection.isApiExecution) {
        deps.logger.info("[crystalliser] api-execution brief detected -> clarify", {
            matched: apiDetection.matchedCriteria.length,
            ratio: apiDetection.ratio,
            reason: apiDetection.reason,
        });
        return { kind: "clarify", question: buildApiExecutionClarification(apiDetection) };
    }
    validateBrief(brief);
    return { kind: "brief", brief, classification: cls };
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